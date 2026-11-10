// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20} from "openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "openzeppelin-contracts/contracts/token/ERC20/utils/SafeERC20.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {SlipNopeV3} from "./SlipNopeV3.sol";
import {GuardedSwapRouter} from "./GuardedSwapRouter.sol";

/// @title FairLimit
/// @notice A blocked buy becomes a resting order instead of a dead end.
///
///         The hook refuses to let anyone overpay. FairLimit lets the buyer say
///         "I still want it, but no worse than +X% over Chainlink fair" and
///         parks the money until the book comes back to them. Anyone can fill
///         the order; the contract asks the hook itself before spending a cent.
///
///         Funds are held only while an order is open and are refundable by the
///         owner at any moment. No admin withdrawal, no upgrade path, no fee.
contract FairLimit {
    using SafeERC20 for IERC20;

    struct Order {
        address owner;
        uint96 amountIn; // quote tokens escrowed
        uint16 maxPremiumBps; // never fill worse than this adverse deviation
        uint64 expiresAt;
        uint64 createdAt;
        bool open;
    }

    /// @notice An order can never be looser than the hook's widest band.
    uint16 public constant MAX_ORDER_PREMIUM_BPS = 800;
    /// @notice Refuse dust orders that cost more gas than they move.
    uint96 public constant MIN_AMOUNT = 1e6; // 1 USDC (6dp)

    IERC20 public immutable quote;
    IERC20 public immutable stock;
    SlipNopeV3 public immutable hook;
    GuardedSwapRouter public immutable router;
    PoolKey public poolKey;

    mapping(uint256 => Order) public orders;
    uint256 public nextOrderId = 1;
    uint256 public openOrders;
    uint256 public filledOrders;
    uint256 public expiredRefunds;

    event OrderPlaced(
        uint256 indexed id, address indexed owner, uint96 amountIn, uint16 maxPremiumBps, uint64 expiresAt
    );
    event OrderCancelled(uint256 indexed id, address indexed owner, uint96 refunded);
    event OrderFilled(
        uint256 indexed id,
        address indexed owner,
        address indexed filler,
        uint256 amountIn,
        uint256 stockOut,
        uint256 adverseBps
    );

    error NotOwner();
    error OrderClosed();
    error Expired();
    error NotExpired();
    error AmountTooSmall();
    error PremiumTooLoose();
    error PremiumTooHigh(uint256 adverseBps, uint16 maxPremiumBps);
    error NothingOut();

    constructor(IERC20 quote_, IERC20 stock_, SlipNopeV3 hook_, GuardedSwapRouter router_, PoolKey memory key) {
        quote = quote_;
        stock = stock_;
        hook = hook_;
        router = router_;
        poolKey = key;
    }

    /// @notice Park quote tokens until the book is fair enough to buy.
    function place(uint96 amountIn, uint16 maxPremiumBps, uint64 expiresAt) external returns (uint256 id) {
        if (amountIn < MIN_AMOUNT) revert AmountTooSmall();
        if (maxPremiumBps > MAX_ORDER_PREMIUM_BPS) revert PremiumTooLoose();
        if (expiresAt <= block.timestamp) revert Expired();

        quote.safeTransferFrom(msg.sender, address(this), amountIn);
        id = nextOrderId++;
        orders[id] = Order({
            owner: msg.sender,
            amountIn: amountIn,
            maxPremiumBps: maxPremiumBps,
            expiresAt: expiresAt,
            createdAt: uint64(block.timestamp),
            open: true
        });
        openOrders += 1;
        emit OrderPlaced(id, msg.sender, amountIn, maxPremiumBps, expiresAt);
    }

    /// @notice Take the money back. Owner-only, any time, even mid-fill.
    function cancel(uint256 id) external {
        Order storage o = orders[id];
        if (o.owner != msg.sender) revert NotOwner();
        if (!o.open) revert OrderClosed();
        uint96 amount = o.amountIn;
        o.open = false;
        o.amountIn = 0;
        openOrders -= 1;
        quote.safeTransfer(o.owner, amount);
        emit OrderCancelled(id, o.owner, amount);
    }

    /// @notice Anyone may fill once the hook itself says the buy is fair enough.
    /// @dev Reads `previewGuard` — the same onchain function the UI renders. If
    ///      the reference is stale that call reverts, so the order stays parked
    ///      rather than executing blind.
    function fill(uint256 id, uint160 sqrtPriceLimitX96) external returns (uint256 stockOut) {
        Order storage o = orders[id];
        if (!o.open) revert OrderClosed();
        if (block.timestamp > o.expiresAt) revert Expired();

        bool zeroForOne = buyDirection();
        (uint256 adverseBps,,, bool blocked,,) = hook.previewGuard(poolKey, zeroForOne, o.owner);
        if (blocked || adverseBps > o.maxPremiumBps) revert PremiumTooHigh(adverseBps, o.maxPremiumBps);

        uint96 amountIn = o.amountIn;
        o.open = false;
        o.amountIn = 0;
        openOrders -= 1;

        quote.forceApprove(address(router), amountIn);
        stockOut = router.swapExactInput(poolKey, zeroForOne, amountIn, sqrtPriceLimitX96);
        quote.forceApprove(address(router), 0);
        if (stockOut == 0) revert NothingOut();

        stock.safeTransfer(o.owner, stockOut);
        filledOrders += 1;
        emit OrderFilled(id, o.owner, msg.sender, amountIn, stockOut, adverseBps);
    }

    /// @notice Refund after expiry. Callable by anyone; funds always go to the
    ///         owner, never the caller.
    function refundExpired(uint256 id) external {
        Order storage o = orders[id];
        if (!o.open) revert OrderClosed();
        if (block.timestamp <= o.expiresAt) revert NotExpired();
        uint96 amount = o.amountIn;
        o.open = false;
        o.amountIn = 0;
        openOrders -= 1;
        expiredRefunds += 1;
        quote.safeTransfer(o.owner, amount);
        emit OrderCancelled(id, o.owner, amount);
    }

    /// @notice Buying the stock means paying the quote token.
    function buyDirection() public view returns (bool) {
        return Currency.unwrap(poolKey.currency0) == address(quote);
    }

    /// @notice One order's live status, including whether the hook would fill it now.
    function status(uint256 id)
        external
        view
        returns (bool open, uint256 adverseBpsNow, bool fillableNow)
    {
        Order memory o = orders[id];
        open = o.open;
        if (!o.open) return (false, 0, false);
        try hook.previewGuard(poolKey, buyDirection(), o.owner) returns (
            uint256 adverse,
            uint24,
            uint24,
            bool blocked,
            uint256,
            uint256
        ) {
            adverseBpsNow = adverse;
            fillableNow = !blocked && adverse <= o.maxPremiumBps && block.timestamp <= o.expiresAt;
        } catch {
            return (true, 0, false);
        }
    }
}
