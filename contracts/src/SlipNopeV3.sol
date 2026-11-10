// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IHooks} from "v4-core/interfaces/IHooks.sol";
import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "v4-core/types/PoolId.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {BalanceDelta, toBalanceDelta} from "v4-core/types/BalanceDelta.sol";
import {BeforeSwapDelta, BeforeSwapDeltaLibrary} from "v4-core/types/BeforeSwapDelta.sol";
import {StateLibrary} from "v4-core/libraries/StateLibrary.sol";
import {FullMath} from "v4-core/libraries/FullMath.sol";
import {LPFeeLibrary} from "v4-core/libraries/LPFeeLibrary.sol";
import {IERC20Metadata} from "openzeppelin-contracts/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {IAggregatorV3} from "./interfaces/IAggregatorV3.sol";
import {BandRegistry} from "./BandRegistry.sol";

/// @title SlipNopeV3 — never overpay for stocks on Base (volatility-adaptive band)
/// @notice A Uniswap v4 hook that checks every swap in a guarded pool against the
///         asset's Chainlink fair price, atomically inside `beforeSwap`:
///           adverse deviation <= band/2  -> OK   (base fee)
///           adverse deviation <= band    -> WARN (deviation-scaled fee override)
///           adverse deviation >  band    -> BLOCK (revert, swap cannot execute)
///           stale / invalid ref -> BLOCK (fail closed, always)
///         "Adverse" is direction-aware: buying above fair, or selling below fair.
///         The band is 300 bps (3%). Base Chainlink equity feeds run 24/5 and
///         freeze off-hours by design; staleness is the fail-closed signal.
/// @dev Implements IHooks directly (beforeSwap + afterSwap; address flags 0xC0).
///      Pool config is one-time-write by the deployer: feed can never be swapped
///      after configuration, so there is no admin path to weaken a live pool.
contract SlipNopeV3 is IHooks {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    uint24 public constant DEFAULT_BAND_BPS = 300;
    uint24 public constant OK_FEE = 500; // 0.05% in v4 fee units (millionths)
    uint24 public constant MAX_WARN_FEE = 10_000; // 1.00% cap

    IPoolManager public immutable poolManager;
    /// Live band source: a keeper may move the band inside hard bounds, but it
    /// can never disable the guard or change a price. address(0) = fixed default.
    BandRegistry public immutable bandRegistry;
    address public immutable owner;

    struct PoolGuard {
        address feed;
        address stock;
        uint8 feedDecimals;
        uint8 stockDecimals;
        uint8 quoteDecimals;
        uint256 maxStale; // seconds; stock feeds are 24/5, deployer sets ~4 days
        bool configured;
    }

    mapping(PoolId => PoolGuard) public guards;

    event GuardConfigured(PoolId indexed poolId, address stock, address feed, uint256 maxStale);
    event GuardAllowed(
        PoolId indexed poolId,
        address indexed trader,
        uint256 adverseBps,
        uint24 bandBps,
        uint24 fee,
        uint256 poolPriceE18,
        uint256 fairPriceE18,
        bool warn
    );

    error NotPoolManager();
    error NotOwner();
    error AlreadyConfigured();
    error StockNotInPool();
    error NotConfigured();
    error InvalidReference();
    error StaleReference(uint256 updatedAt, uint256 maxStale);
    error OverpayBlocked(uint256 adverseBps, uint24 bandBps, uint256 poolPriceE18, uint256 fairPriceE18);
    error PostSwapOutOfBand(uint256 adverseBps, uint24 bandBps, uint256 poolPriceE18, uint256 fairPriceE18);

    constructor(IPoolManager manager_, BandRegistry registry_, address owner_) {
        poolManager = manager_;
        bandRegistry = registry_;
        owner = owner_; // explicit: with CREATE2 the sender is the factory, not the deployer
    }

    // ------------------------------------------------------------------ admin

    /// @notice One-time guard configuration for a pool. Irreversible by design.
    function configurePool(PoolKey calldata key, address feed, address stock, uint256 maxStale) external {
        if (msg.sender != owner) revert NotOwner();
        PoolId id = key.toId();
        if (guards[id].configured) revert AlreadyConfigured();
        address c0 = Currency.unwrap(key.currency0);
        address c1 = Currency.unwrap(key.currency1);
        if (stock != c0 && stock != c1) revert StockNotInPool();
        address quote = stock == c0 ? c1 : c0;
        guards[id] = PoolGuard({
            feed: feed,
            stock: stock,
            feedDecimals: IAggregatorV3(feed).decimals(),
            stockDecimals: IERC20Metadata(stock).decimals(),
            quoteDecimals: IERC20Metadata(quote).decimals(),
            maxStale: maxStale,
            configured: true
        });
        emit GuardConfigured(id, stock, feed, maxStale);
    }

    // ------------------------------------------------------------------ views

    /// @notice Fair (Chainlink) price of the guarded stock, scaled to 1e18. Reverts if unusable.
    function fairPriceE18(PoolKey calldata key) public view returns (uint256) {
        PoolGuard memory g = guards[key.toId()];
        if (!g.configured) revert NotConfigured();
        return _fairPriceE18(g);
    }

    /// @notice Current pool price (quote per 1 stock), scaled to 1e18.
    function poolPriceE18(PoolKey calldata key) public view returns (uint256) {
        PoolGuard memory g = guards[key.toId()];
        if (!g.configured) revert NotConfigured();
        (uint160 sqrtPriceX96,,,) = poolManager.getSlot0(key.toId());
        return _poolPriceE18(key, g, sqrtPriceX96);
    }

    /// @notice Preview the guard verdict for a swap direction, without executing.
    /// @return adverseBps direction-aware adverse deviation in bps
    /// @return bandBps    band that would be enforced for `trader`
    /// @return fee        LP fee that would be charged (v4 fee units)
    /// @return blocked    true if the swap would revert
    function previewGuard(PoolKey calldata key, bool zeroForOne, address trader)
        external
        view
        returns (uint256 adverseBps, uint24 bandBps, uint24 fee, bool blocked, uint256 poolPrice, uint256 fairPrice)
    {
        PoolGuard memory g = guards[key.toId()];
        if (!g.configured) revert NotConfigured();
        fairPrice = _fairPriceE18(g);
        (uint160 sqrtPriceX96,,,) = poolManager.getSlot0(key.toId());
        poolPrice = _poolPriceE18(key, g, sqrtPriceX96);
        bandBps = _bandFor(trader);
        adverseBps = _adverseBps(key, g, zeroForOne, poolPrice, fairPrice);
        blocked = adverseBps > bandBps;
        fee = _feeFor(adverseBps, bandBps);
    }

    // ------------------------------------------------------------------- hook

    function beforeSwap(address sender, PoolKey calldata key, IPoolManager.SwapParams calldata params, bytes calldata hookData)
        external
        override
        returns (bytes4, BeforeSwapDelta, uint24)
    {
        if (msg.sender != address(poolManager)) revert NotPoolManager();
        PoolId id = key.toId();
        PoolGuard memory g = guards[id];
        if (!g.configured) revert NotConfigured();

        address trader = hookData.length >= 32 ? abi.decode(hookData, (address)) : sender;
        (uint256 adverse, uint24 band, uint24 fee, uint256 poolPrice, uint256 fair) =
            _evaluate(key, g, params.zeroForOne, trader);

        if (adverse > band) revert OverpayBlocked(adverse, band, poolPrice, fair);
        emit GuardAllowed(id, trader, adverse, band, fee, poolPrice, fair, adverse > uint256(band) / 2);
        return (IHooks.beforeSwap.selector, BeforeSwapDeltaLibrary.ZERO_DELTA, fee | LPFeeLibrary.OVERRIDE_FEE_FLAG);
    }

    function _evaluate(PoolKey calldata key, PoolGuard memory g, bool zeroForOne, address trader)
        internal
        view
        returns (uint256 adverse, uint24 band, uint24 fee, uint256 poolPrice, uint256 fair)
    {
        fair = _fairPriceE18(g); // reverts Invalid/Stale -> fail closed
        (uint160 sqrtPriceX96,,,) = poolManager.getSlot0(key.toId());
        poolPrice = _poolPriceE18(key, g, sqrtPriceX96);
        band = _bandFor(trader);
        adverse = _adverseBps(key, g, zeroForOne, poolPrice, fair);
        fee = _feeFor(adverse, band);
    }

    // ------------------------------------------------------------- internals

    function _fairPriceE18(PoolGuard memory g) internal view returns (uint256) {
        (uint80 roundId, int256 answer,, uint256 updatedAt, uint80 answeredInRound) =
            IAggregatorV3(g.feed).latestRoundData();
        if (answer <= 0 || updatedAt == 0 || answeredInRound < roundId) revert InvalidReference();
        if (block.timestamp - updatedAt > g.maxStale) revert StaleReference(updatedAt, g.maxStale);
        uint256 a = uint256(answer);
        if (g.feedDecimals == 18) return a;
        if (g.feedDecimals < 18) return a * (10 ** (18 - g.feedDecimals));
        return a / (10 ** (g.feedDecimals - 18));
    }

    /// @dev quote-per-stock price scaled to 1e18, from pool sqrt price.
    function _poolPriceE18(PoolKey calldata key, PoolGuard memory g, uint160 sqrtPriceX96)
        internal
        pure
        returns (uint256)
    {
        // ratioX96 = (token1 raw per token0 raw) * 2^96
        uint256 ratioX96 = FullMath.mulDiv(uint256(sqrtPriceX96), uint256(sqrtPriceX96), 1 << 96);
        // priceE18 exponent for the decimal correction: 18 + stockDec - quoteDec
        int256 exp = int256(18) + int256(uint256(g.stockDecimals)) - int256(uint256(g.quoteDecimals));
        bool stockIs0 = g.stock == Currency.unwrap(key.currency0);
        if (stockIs0) {
            // price = ratio * 10^(stockDec-quoteDec); scaled: ratioX96 * 10^exp / 2^96
            return _mulPow10Div(ratioX96, exp, 1 << 96);
        } else {
            // price = 10^(stockDec-quoteDec) / ratio; scaled: 10^exp * 2^96 / ratioX96
            if (exp >= 0) return FullMath.mulDiv(10 ** uint256(exp), 1 << 96, ratioX96);
            return FullMath.mulDiv(1 << 96, 1, ratioX96 * (10 ** uint256(-exp)));
        }
    }

    function _mulPow10Div(uint256 value, int256 exp, uint256 divisor) internal pure returns (uint256) {
        if (exp >= 0) return FullMath.mulDiv(value, 10 ** uint256(exp), divisor);
        return FullMath.mulDiv(value, 1, divisor * (10 ** uint256(-exp)));
    }

    function _adverseBps(PoolKey calldata key, PoolGuard memory g, bool zeroForOne, uint256 poolPrice, uint256 fair)
        internal
        pure
        returns (uint256)
    {
        bool stockIs0 = g.stock == Currency.unwrap(key.currency0);
        // buying stock: paying quote, receiving stock
        bool buyingStock = stockIs0 ? !zeroForOne : zeroForOne;
        if (buyingStock) {
            return poolPrice > fair ? ((poolPrice - fair) * 10_000) / fair : 0;
        } else {
            return fair > poolPrice ? ((fair - poolPrice) * 10_000) / fair : 0;
        }
    }

    /// @dev Live band from the registry, bounded by the registry itself.
    ///      Any failure (unset, reverting) falls back to the immutable default,
    ///      so a broken keeper can widen risk but never remove the guard.
    function _bandFor(address) internal view returns (uint24) {
        if (address(bandRegistry) == address(0)) return DEFAULT_BAND_BPS;
        try bandRegistry.currentBandBps() returns (uint24 bps) {
            if (bps == 0) return DEFAULT_BAND_BPS;
            return bps;
        } catch {
            return DEFAULT_BAND_BPS;
        }
    }

    function _feeFor(uint256 adverseBps, uint24 bandBps) internal pure returns (uint24) {
        if (adverseBps <= uint256(bandBps) / 2) return OK_FEE;
        uint256 fee = uint256(OK_FEE) + adverseBps * 10; // +0.1 fee-unit per adverse bp *10
        if (fee > MAX_WARN_FEE) fee = MAX_WARN_FEE;
        return uint24(fee);
    }

    // ------------------------------------------------- unused IHooks surface
    // PoolManager only invokes hooks whose address flags are set (beforeSwap only).
    // The remaining functions must exist for the interface but are never called.

    function beforeInitialize(address, PoolKey calldata, uint160) external pure override returns (bytes4) {
        return IHooks.beforeInitialize.selector;
    }

    function afterInitialize(address, PoolKey calldata, uint160, int24) external pure override returns (bytes4) {
        return IHooks.afterInitialize.selector;
    }

    function beforeAddLiquidity(address, PoolKey calldata, IPoolManager.ModifyLiquidityParams calldata, bytes calldata)
        external
        pure
        override
        returns (bytes4)
    {
        return IHooks.beforeAddLiquidity.selector;
    }

    function afterAddLiquidity(
        address,
        PoolKey calldata,
        IPoolManager.ModifyLiquidityParams calldata,
        BalanceDelta,
        BalanceDelta,
        bytes calldata
    ) external pure override returns (bytes4, BalanceDelta) {
        return (IHooks.afterAddLiquidity.selector, toBalanceDelta(0, 0));
    }

    function beforeRemoveLiquidity(
        address,
        PoolKey calldata,
        IPoolManager.ModifyLiquidityParams calldata,
        bytes calldata
    ) external pure override returns (bytes4) {
        return IHooks.beforeRemoveLiquidity.selector;
    }

    function afterRemoveLiquidity(
        address,
        PoolKey calldata,
        IPoolManager.ModifyLiquidityParams calldata,
        BalanceDelta,
        BalanceDelta,
        bytes calldata
    ) external pure override returns (bytes4, BalanceDelta) {
        return (IHooks.afterRemoveLiquidity.selector, toBalanceDelta(0, 0));
    }

    /// @notice Post-swap guard: a single swap may not leave the pool more than
    ///         `band` away from fair — in **either** direction. The pre-swap
    ///         check only refuses overpaying; without this, one oversized buy
    ///         could crash a thin book far below fair, which is just as broken
    ///         for everyone else in the pool. Reverting here unwinds the swap.
    function afterSwap(
        address,
        PoolKey calldata key,
        IPoolManager.SwapParams calldata,
        BalanceDelta,
        bytes calldata hookData
    ) external override returns (bytes4, int128) {
        if (msg.sender != address(poolManager)) revert NotPoolManager();
        PoolGuard memory g = guards[key.toId()];
        if (!g.configured) return (IHooks.afterSwap.selector, 0);

        (uint160 sqrtPriceX96,,,) = poolManager.getSlot0(key.toId());
        uint256 postPrice = _poolPriceE18(key, g, sqrtPriceX96);
        uint256 fair = _fairPriceE18(g);
        uint256 deviation = postPrice > fair ? ((postPrice - fair) * 10_000) / fair : ((fair - postPrice) * 10_000) / fair;
        uint24 band = _bandFor(address(0));
        if (deviation > band) revert PostSwapOutOfBand(deviation, band, postPrice, fair);
        return (IHooks.afterSwap.selector, 0);
    }

    function beforeDonate(address, PoolKey calldata, uint256, uint256, bytes calldata)
        external
        pure
        override
        returns (bytes4)
    {
        return IHooks.beforeDonate.selector;
    }

    function afterDonate(address, PoolKey calldata, uint256, uint256, bytes calldata)
        external
        pure
        override
        returns (bytes4)
    {
        return IHooks.afterDonate.selector;
    }
}
