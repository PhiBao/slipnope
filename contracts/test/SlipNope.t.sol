// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "v4-core/types/PoolId.sol";
import {Currency, CurrencyLibrary} from "v4-core/types/Currency.sol";
import {IHooks} from "v4-core/interfaces/IHooks.sol";
import {Hooks} from "v4-core/libraries/Hooks.sol";
import {LPFeeLibrary} from "v4-core/libraries/LPFeeLibrary.sol";
import {TickMath} from "v4-core/libraries/TickMath.sol";
import {PoolSwapTest} from "v4-core/test/PoolSwapTest.sol";
import {Deployers} from "../lib/v4-core/test/utils/Deployers.sol";
import {SlipNope} from "../src/SlipNope.sol";
import {GuardedSwapRouter} from "../src/GuardedSwapRouter.sol";
import {MockToken, MockFeed, MockStockToken} from "../src/mocks/MockTokens.sol";

/// @dev End-to-end guard tests against a real local PoolManager.
///      Pool initialised at price 1.0 (tick 0, both tokens 18dp) so the
///      Chainlink mock feed fully controls perceived deviation:
///        feed = $1.00 -> fair, feed = $0.50 -> pool is +100% over fair, etc.
contract SlipNopeTest is Test, Deployers {
    using PoolIdLibrary for PoolKey;
    using CurrencyLibrary for Currency;

    SlipNope hook;
    GuardedSwapRouter router;
    MockStockToken stock;
    MockToken quote;
    MockFeed feed;

    PoolKey poolKey;
    address trader = address(0xBEEF);

    function setUp() public {
        deployFreshManagerAndRouters();

        // Mine a hook address with only the beforeSwap flag (1 << 7).
        uint160 flags = uint160(Hooks.BEFORE_SWAP_FLAG | Hooks.AFTER_SWAP_FLAG);
        bytes memory creationCode = type(SlipNope).creationCode;
        bytes memory ctorArgs = abi.encode(manager, address(this));
        (address hookAddr, bytes32 salt) = _mineHook(address(this), flags, creationCode, ctorArgs);
        hook = new SlipNope{salt: salt}(manager, address(this));
        require(address(hook) == hookAddr, "mined address mismatch");

        stock = new MockStockToken("NVIDIA (mock)", "NVDA", 18);
        quote = new MockToken("USD Coin (mock)", "USDC", 18);
        feed = new MockFeed(8, 1e8); // $1.00

        Currency cStock = Currency.wrap(address(stock));
        Currency cQuote = Currency.wrap(address(quote));
        (Currency c0, Currency c1) = address(stock) < address(quote) ? (cStock, cQuote) : (cQuote, cStock);

        poolKey = PoolKey({
            currency0: c0,
            currency1: c1,
            fee: LPFeeLibrary.DYNAMIC_FEE_FLAG,
            tickSpacing: 60,
            hooks: IHooks(address(hook))
        });

        router = new GuardedSwapRouter(manager);
        hook.configurePool(poolKey, address(feed), address(stock), 4 days);

        manager.initialize(poolKey, TickMath.getSqrtPriceAtTick(0)); // price = 1.0

        // Fund + approve everyone relevant.
        stock.mint(address(this), 1_000_000 ether);
        quote.mint(address(this), 1_000_000 ether);
        stock.mint(trader, 10_000 ether);
        quote.mint(trader, 10_000 ether);

        _approveAll(address(this));
        vm.startPrank(trader);
        _approveAll(trader);
        vm.stopPrank();

        // Seed full-range-ish liquidity around price 1.0.
        modifyLiquidityRouter.modifyLiquidity(
            poolKey,
            IPoolManager.ModifyLiquidityParams({tickLower: -6000, tickUpper: 6000, liquidityDelta: 100_000 ether, salt: 0}),
            ZERO_BYTES
        );
    }

    // ------------------------------------------------------------ helpers

    function _approveAll(address who) internal {
        stock.approve(address(swapRouter), type(uint256).max);
        quote.approve(address(swapRouter), type(uint256).max);
        stock.approve(address(modifyLiquidityRouter), type(uint256).max);
        quote.approve(address(modifyLiquidityRouter), type(uint256).max);
        stock.approve(address(router), type(uint256).max);
        quote.approve(address(router), type(uint256).max);
        who;
    }

    function _mineHook(address deployer, uint160 flags, bytes memory creationCode, bytes memory ctorArgs)
        internal
        pure
        returns (address, bytes32)
    {
        bytes memory bytecode = abi.encodePacked(creationCode, ctorArgs);
        uint256 start = uint256(keccak256(abi.encodePacked(deployer, bytecode))) % 100_000;
        for (uint256 i = start; i < start + 500_000; i++) {
            bytes32 salt = bytes32(i);
            address addr = address(
                uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), deployer, salt, keccak256(bytecode)))))
            );
            if (uint160(addr) & Hooks.ALL_HOOK_MASK == flags) return (addr, salt);
        }
        revert("no salt found");
    }

    function _buyStock(uint256 quoteIn) internal {
        bool zeroForOne = Currency.unwrap(poolKey.currency0) == address(quote);
        swapRouter.swap(
            poolKey,
            IPoolManager.SwapParams({
                zeroForOne: zeroForOne,
                amountSpecified: -int256(quoteIn),
                sqrtPriceLimitX96: zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
            }),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            abi.encode(trader)
        );
    }

    function _sellStock(uint256 stockIn) internal {
        bool zeroForOne = Currency.unwrap(poolKey.currency0) == address(stock);
        swapRouter.swap(
            poolKey,
            IPoolManager.SwapParams({
                zeroForOne: zeroForOne,
                amountSpecified: -int256(stockIn),
                sqrtPriceLimitX96: zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
            }),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            abi.encode(trader)
        );
    }

    // -------------------------------------------------------------- tests

    function test_fairPrice_swapAllowed() public {
        (uint256 adverse, uint24 band, uint24 fee, bool blocked,,) = hook.previewGuard(
            poolKey, Currency.unwrap(poolKey.currency0) == address(quote), trader
        );
        assertEq(adverse, 0);
        assertEq(uint256(band), 300);
        assertEq(uint256(fee), 500);
        assertFalse(blocked);

        uint256 balBefore = stock.balanceOf(trader);
        vm.prank(trader);
        _buyStock(100 ether);
        assertGt(stock.balanceOf(trader), balBefore);
    }

    function test_buyAboveBand_blocked() public {
        feed.setAnswer(0.5e8); // pool 1.0 vs fair 0.50 -> buying overpays +100%
        (,,, bool blocked,,) =
            hook.previewGuard(poolKey, Currency.unwrap(poolKey.currency0) == address(quote), trader);
        assertTrue(blocked);
        vm.expectRevert();
        _buyStock(100 ether);
    }

    function test_sellBelowBand_blocked() public {
        feed.setAnswer(2e8); // pool 1.0 vs fair 2.0 -> selling receives -50%
        vm.expectRevert();
        _sellStock(100 ether);
    }

    function test_warnTier_allowedWithHigherFee() public {
        feed.setAnswer(0.98e8); // buying premium ~2.04% < 3% band, > band/2
        (uint256 adverse,, uint24 fee, bool blocked,,) =
            hook.previewGuard(poolKey, Currency.unwrap(poolKey.currency0) == address(quote), trader);
        assertGt(adverse, 150);
        assertLe(adverse, 300);
        assertGt(uint256(fee), 500);
        assertFalse(blocked);
        _buyStock(10 ether); // must not revert
    }

    function test_staleFeed_blocksEverything() public {
        vm.warp(block.timestamp + 5 days); // beyond 4-day maxStale
        vm.expectRevert();
        _buyStock(10 ether);
        vm.expectRevert();
        _sellStock(10 ether);
    }

    function test_frozenFeed_blocksLikeStale() public {
        // Base Chainlink equity feeds freeze during corporate actions and
        // off-hours: updatedAt stops advancing. After maxStale, the guard
        // must fail closed exactly like any stale feed.
        feed.setUpdatedAt(block.timestamp);
        vm.warp(block.timestamp + 5 days);
        vm.expectRevert();
        _buyStock(10 ether);
    }

    function test_postSwap_outOfBandReverts() public {
        // One huge buy into a thin book: the pre-swap price is fair, so
        // beforeSwap allows it — afterSwap must revert because the resulting
        // price would sit outside the band. The whole swap unwinds.
        uint256 bigIn = 60_000 ether; // 60% of the seeded liquidity range
        vm.expectRevert(); // PostSwapOutOfBand
        _buyStock(bigIn);
    }

    function test_postSwap_smallSwapStaysInBand() public {
        // A modest swap must still settle: guard does not block normal trading.
        _buyStock(5 ether);
        (uint256 adverse,,,,, ) = hook.previewGuard(
            poolKey, Currency.unwrap(poolKey.currency0) == address(quote), trader
        );
        assertLe(adverse, 300);
    }

    function test_guardedRouter_swapAndBandEnforced() public {
        bool zeroForOne = Currency.unwrap(poolKey.currency0) == address(quote);
        vm.startPrank(trader);
        uint256 out = router.swapExactInput(
            poolKey,
            zeroForOne,
            100 ether,
            zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
        );
        vm.stopPrank();
        assertGt(out, 0);

        feed.setAnswer(0.5e8);
        vm.prank(trader);
        vm.expectRevert();
        router.swapExactInput(
            poolKey,
            zeroForOne,
            100 ether,
            zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
        );
    }
}
