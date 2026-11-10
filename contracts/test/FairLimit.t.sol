// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {Currency, CurrencyLibrary} from "v4-core/types/Currency.sol";
import {IHooks} from "v4-core/interfaces/IHooks.sol";
import {Hooks} from "v4-core/libraries/Hooks.sol";
import {LPFeeLibrary} from "v4-core/libraries/LPFeeLibrary.sol";
import {TickMath} from "v4-core/libraries/TickMath.sol";
import {Deployers} from "../lib/v4-core/test/utils/Deployers.sol";
import {IERC20} from "openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
import {SlipNopeV3} from "../src/SlipNopeV3.sol";
import {BandRegistry} from "../src/BandRegistry.sol";
import {GuardedSwapRouter} from "../src/GuardedSwapRouter.sol";
import {FairLimit} from "../src/FairLimit.sol";
import {MockToken, MockFeed, MockStockToken} from "../src/mocks/MockTokens.sol";

/// @notice A blocked buy can be parked as a resting order and filled later when
///         the book returns to fair — with the owner able to walk away at any time.
contract FairLimitTest is Test, Deployers {
    using CurrencyLibrary for Currency;

    SlipNopeV3 hook;
    BandRegistry registry;
    GuardedSwapRouter router;
    FairLimit limit;
    MockStockToken stock;
    MockToken quote;
    MockFeed feed;

    PoolKey poolKey;
    address buyer = address(0xB0B);
    address filler = address(0xF111E4);

    function setUp() public {
        deployFreshManagerAndRouters();
        registry = new BandRegistry(address(this));

        uint160 flags = uint160(Hooks.BEFORE_SWAP_FLAG | Hooks.AFTER_SWAP_FLAG);
        bytes memory creationCode = type(SlipNopeV3).creationCode;
        bytes memory ctorArgs = abi.encode(manager, address(registry), address(this));
        (address hookAddr, bytes32 salt) = _mine(address(this), flags, creationCode, ctorArgs);
        hook = new SlipNopeV3{salt: salt}(manager, registry, address(this));
        require(address(hook) == hookAddr, "mine mismatch");

        stock = new MockStockToken("NVIDIA (mock)", "NVDA", 18);
        quote = new MockToken("USD Coin (mock)", "USDC", 18);
        feed = new MockFeed(8, 1e8); // fair = $1.00

        (Currency c0, Currency c1) = address(stock) < address(quote)
            ? (Currency.wrap(address(stock)), Currency.wrap(address(quote)))
            : (Currency.wrap(address(quote)), Currency.wrap(address(stock)));

        poolKey = PoolKey({
            currency0: c0,
            currency1: c1,
            fee: LPFeeLibrary.DYNAMIC_FEE_FLAG,
            tickSpacing: 60,
            hooks: IHooks(address(hook))
        });
        hook.configurePool(poolKey, address(feed), address(stock), 4 days);
        manager.initialize(poolKey, TickMath.getSqrtPriceAtTick(0));

        router = new GuardedSwapRouter(manager);
        limit = new FairLimit(IERC20(address(quote)), IERC20(address(stock)), hook, router, poolKey);

        // seed liquidity
        stock.mint(address(this), 1_000_000 ether);
        quote.mint(address(this), 1_000_000 ether);
        stock.approve(address(modifyLiquidityRouter), type(uint256).max);
        quote.approve(address(modifyLiquidityRouter), type(uint256).max);
        modifyLiquidityRouter.modifyLiquidity(
            poolKey,
            IPoolManager.ModifyLiquidityParams({tickLower: -6000, tickUpper: 6000, liquidityDelta: 1_000_000 ether, salt: 0}),
            ZERO_BYTES
        );

        // fund buyer and approvals for the queue
        quote.mint(buyer, 1_000 ether);
        vm.prank(buyer);
        quote.approve(address(limit), type(uint256).max);
    }

    function _mine(address deployer, uint160 flags, bytes memory creationCode, bytes memory args)
        internal
        pure
        returns (address, bytes32)
    {
        bytes memory code = abi.encodePacked(creationCode, args);
        for (uint256 i = 0; i < 500_000; i++) {
            bytes32 salt = bytes32(i);
            address a = address(uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), deployer, salt, keccak256(code))))));
            if (uint160(a) & Hooks.ALL_HOOK_MASK == flags) return (a, salt);
        }
        revert("no salt");
    }

    function _buyDirection() internal view returns (bool) {
        return Currency.unwrap(poolKey.currency0) == address(quote);
    }

    function test_placeAndCancel_refunds() public {
        vm.startPrank(buyer);
        uint256 id = limit.place(100 ether, 100, uint64(block.timestamp + 1 days));
        assertEq(quote.balanceOf(address(limit)), 100 ether);
        limit.cancel(id);
        vm.stopPrank();
        assertEq(quote.balanceOf(buyer), 1_000 ether);
        assertEq(quote.balanceOf(address(limit)), 0);
    }

    function test_fill_onlyWhenFairEnough() public {
        vm.prank(buyer);
        uint256 id = limit.place(100 ether, 100, uint64(block.timestamp + 1 days)); // max +1%

        // Book dislocated +20%: the hook blocks it, so the fill must refuse.
        feed.setAnswer(0.833e8); // pool $1.00 vs fair $0.833 => +20% premium
        vm.prank(filler);
        vm.expectRevert();
        limit.fill(id, TickMath.MAX_SQRT_PRICE - 1);

        // Book returns to fair: the same order fills.
        feed.setAnswer(1e8);
        vm.prank(filler);
        uint256 out = limit.fill(id, TickMath.MAX_SQRT_PRICE - 1);
        assertGt(out, 0);
        assertGt(stock.balanceOf(buyer), 0);
        assertEq(quote.balanceOf(address(limit)), 0);
        assertEq(limit.filledOrders(), 1);
    }

    function test_premiumCap_isEnforcedEvenWhenGuardAllows() public {
        // Order only accepts +0.5%, but the guard would allow up to 3%.
        vm.prank(buyer);
        uint256 id = limit.place(10 ether, 50, uint64(block.timestamp + 1 days));
        feed.setAnswer(0.98e8); // ~+2.04%: inside the guard band, outside this order
        vm.expectRevert();
        limit.fill(id, TickMath.MAX_SQRT_PRICE - 1);
    }

    function test_expiryRefund_goesToOwnerOnly() public {
        vm.prank(buyer);
        uint256 id = limit.place(10 ether, 100, uint64(block.timestamp + 1 hours));
        vm.warp(block.timestamp + 2 hours);
        uint256 before = quote.balanceOf(buyer);
        vm.prank(filler); // anyone may trigger, money still goes to the buyer
        limit.refundExpired(id);
        assertEq(quote.balanceOf(buyer), before + 10 ether);
        assertEq(quote.balanceOf(filler), 0);
    }

    function test_cannotFillExpired() public {
        vm.prank(buyer);
        uint256 id = limit.place(10 ether, 100, uint64(block.timestamp + 1 hours));
        vm.warp(block.timestamp + 2 hours);
        vm.expectRevert();
        limit.fill(id, TickMath.MAX_SQRT_PRICE - 1);
    }

    function test_orderPremiumCappedAtWidestBand() public {
        vm.prank(buyer);
        vm.expectRevert();
        limit.place(10 ether, 801, uint64(block.timestamp + 1 days));
    }

    function test_statusReportsFillable() public {
        vm.prank(buyer);
        uint256 id = limit.place(10 ether, 100, uint64(block.timestamp + 1 days));
        (bool open, uint256 adverse, bool fillable) = limit.status(id);
        assertTrue(open);
        assertEq(adverse, 0);
        assertTrue(fillable);
    }
}
