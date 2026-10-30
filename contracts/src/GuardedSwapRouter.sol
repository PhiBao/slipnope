// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "v4-core/interfaces/callback/IUnlockCallback.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {BalanceDelta, BalanceDeltaLibrary} from "v4-core/types/BalanceDelta.sol";
import {IERC20} from "openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "openzeppelin-contracts/contracts/token/ERC20/utils/SafeERC20.sol";

/// @title GuardedSwapRouter
/// @notice Minimal exact-input swap + liquidity router for RobinHook guarded pools.
///         Non-custodial: settles inside the PoolManager unlock callback and sweeps
///         any residual router balance back to the caller in the same transaction.
///         hookData always encodes msg.sender, so RobinHook enforces the caller's
///         personal $WIF-staked band even though the router is the swap sender.
/// @dev ERC-20 pairs only (no native ETH currency) for the MVP.
contract GuardedSwapRouter is IUnlockCallback {
    using SafeERC20 for IERC20;
    using BalanceDeltaLibrary for BalanceDelta;

    IPoolManager public immutable poolManager;

    error NotPoolManager();
    error NativeNotSupported();

    uint8 internal constant ACTION_SWAP = 0;
    uint8 internal constant ACTION_LIQUIDITY = 1;

    struct SwapCallback {
        PoolKey key;
        IPoolManager.SwapParams params;
        address payer;
        address recipient;
    }

    struct LiquidityCallback {
        PoolKey key;
        IPoolManager.ModifyLiquidityParams params;
        address payer;
    }

    constructor(IPoolManager manager_) {
        poolManager = manager_;
    }

    /// @notice Exact-input single-pool swap; `amountIn` of the input currency is
    ///         pulled from msg.sender (approve this router first).
    /// @return amountOut output currency amount delivered to msg.sender
    function swapExactInput(PoolKey calldata key, bool zeroForOne, uint256 amountIn, uint160 sqrtPriceLimitX96)
        external
        returns (uint256 amountOut)
    {
        Currency inCur = zeroForOne ? key.currency0 : key.currency1;
        if (inCur.isAddressZero()) revert NativeNotSupported();
        IERC20(Currency.unwrap(inCur)).safeTransferFrom(msg.sender, address(this), amountIn);

        IPoolManager.SwapParams memory params = IPoolManager.SwapParams({
            zeroForOne: zeroForOne,
            amountSpecified: -int256(amountIn),
            sqrtPriceLimitX96: sqrtPriceLimitX96
        });
        bytes memory result = poolManager.unlock(
            abi.encode(
                ACTION_SWAP,
                abi.encode(SwapCallback({key: key, params: params, payer: address(this), recipient: msg.sender}))
            )
        );
        amountOut = abi.decode(result, (uint256));
        _sweep(key.currency0, msg.sender);
        _sweep(key.currency1, msg.sender);
    }

    /// @notice Add/remove liquidity. Negative deltas are pulled from msg.sender
    ///         (approve this router for both currencies); positive deltas are
    ///         delivered to msg.sender.
    function modifyLiquidity(PoolKey calldata key, IPoolManager.ModifyLiquidityParams calldata params)
        external
        returns (BalanceDelta delta)
    {
        bytes memory result = poolManager.unlock(
            abi.encode(ACTION_LIQUIDITY, abi.encode(LiquidityCallback({key: key, params: params, payer: msg.sender})))
        );
        delta = abi.decode(result, (BalanceDelta));
        _sweep(key.currency0, msg.sender);
        _sweep(key.currency1, msg.sender);
    }

    function unlockCallback(bytes calldata data) external override returns (bytes memory) {
        if (msg.sender != address(poolManager)) revert NotPoolManager();
        (uint8 action, bytes memory inner) = abi.decode(data, (uint8, bytes));

        if (action == ACTION_SWAP) {
            SwapCallback memory cb = abi.decode(inner, (SwapCallback));
            BalanceDelta delta = poolManager.swap(cb.key, cb.params, abi.encode(cb.recipient));
            _settleOrTake(cb.key.currency0, delta.amount0(), cb.payer, cb.recipient);
            _settleOrTake(cb.key.currency1, delta.amount1(), cb.payer, cb.recipient);
            int128 outAmt = cb.params.zeroForOne ? delta.amount1() : delta.amount0();
            return abi.encode(uint256(uint128(outAmt)));
        } else {
            LiquidityCallback memory cb = abi.decode(inner, (LiquidityCallback));
            (BalanceDelta delta,) = poolManager.modifyLiquidity(cb.key, cb.params, abi.encode(cb.payer));
            _settleOrTake(cb.key.currency0, delta.amount0(), cb.payer, cb.payer);
            _settleOrTake(cb.key.currency1, delta.amount1(), cb.payer, cb.payer);
            return abi.encode(delta);
        }
    }

    // ------------------------------------------------------------- internal

    function _settleOrTake(Currency currency, int128 amount, address payer, address recipient) internal {
        if (amount < 0) {
            uint256 owed = uint256(uint128(-amount));
            poolManager.sync(currency);
            if (payer == address(this)) {
                IERC20(Currency.unwrap(currency)).safeTransfer(address(poolManager), owed);
            } else {
                IERC20(Currency.unwrap(currency)).safeTransferFrom(payer, address(poolManager), owed);
            }
            poolManager.settle();
        } else if (amount > 0) {
            poolManager.take(currency, recipient, uint256(uint128(amount)));
        }
    }

    function _sweep(Currency currency, address to) internal {
        if (currency.isAddressZero()) return;
        uint256 bal = IERC20(Currency.unwrap(currency)).balanceOf(address(this));
        if (bal > 0) IERC20(Currency.unwrap(currency)).safeTransfer(to, bal);
    }
}
