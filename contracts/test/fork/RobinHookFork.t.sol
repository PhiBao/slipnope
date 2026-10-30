// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test, console2} from "forge-std/Test.sol";
import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {IHooks} from "v4-core/interfaces/IHooks.sol";
import {Hooks} from "v4-core/libraries/Hooks.sol";
import {LPFeeLibrary} from "v4-core/libraries/LPFeeLibrary.sol";
import {TickMath} from "v4-core/libraries/TickMath.sol";
import {RobinHook} from "../../src/RobinHook.sol";
import {WifBandRegistry} from "../../src/WifBandRegistry.sol";
import {GuardedSwapRouter} from "../../src/GuardedSwapRouter.sol";
import {IAggregatorV3} from "../../src/interfaces/IAggregatorV3.sol";

interface IV3Pool {
    function slot0() external view returns (uint160, int24, uint16, uint16, uint16, uint32, bool);
}

interface IERC20F {
    function balanceOf(address) external view returns (uint256);
    function approve(address, uint256) external returns (bool);
}

/// @notice Fork test against live Robinhood Chain mainnet (chain 4663).
///         Run: forge test --match-contract RobinHookFork --fork-url https://rpc.mainnet.chain.robinhood.com -vv
/// @dev Proves: real Chainlink NVDA feed reads through the hook, pool priced from
///      the live v3 market tick, guard preview live, config irreversibility.
contract RobinHookForkTest is Test {
    address constant MANAGER = 0x8366a39CC670B4001A1121B8F6A443A643e40951;
    address constant NVDA = 0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC;
    address constant NVDA_FEED = 0x379EC4f7C378F34a1B47E4F3cbeBCbAC3E8E9F15;
    address constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
    address constant WIF = 0x5173b8eA6923c2d40267890D45C46a3480954773;
    address constant NVDA_V3_POOL = 0xd4EB21209C4D6093f80B5b84f5C45cc093EA14a3;

    RobinHook hook;
    PoolKey key;

    function setUp() public {
        if (block.chainid != 4663) return; // fork-only suite; skipped in plain `forge test`
        IPoolManager manager = IPoolManager(MANAGER);
        WifBandRegistry registry = new WifBandRegistry(WIF);

        uint160 flags = uint160(Hooks.BEFORE_SWAP_FLAG);
        bytes memory bytecode = abi.encodePacked(type(RobinHook).creationCode, abi.encode(manager, address(registry)));
        bytes32 salt;
        address hookAddr;
        for (uint256 i = 0; i < 500_000; i++) {
            salt = bytes32(i);
            hookAddr = address(
                uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), address(this), salt, keccak256(bytecode)))))
            );
            if (uint160(hookAddr) & Hooks.ALL_HOOK_MASK == flags) break;
        }
        hook = new RobinHook{salt: salt}(manager, address(registry));
        require(address(hook) == hookAddr, "mine mismatch");

        Currency c0 = Currency.wrap(USDG); // 0x5fc5... < 0xd060...
        Currency c1 = Currency.wrap(NVDA);
        require(USDG < NVDA, "ordering assumption");
        key = PoolKey({
            currency0: c0,
            currency1: c1,
            fee: LPFeeLibrary.DYNAMIC_FEE_FLAG,
            tickSpacing: 60,
            hooks: IHooks(address(hook))
        });
        hook.configurePool(key, NVDA_FEED, NVDA, 4 days);

        // Initialise at the live v3 market tick so pool price ~= fair price.
        (, int24 v3Tick,,,,,) = IV3Pool(NVDA_V3_POOL).slot0();
        int24 tick = (v3Tick / 60) * 60;
        manager.initialize(key, TickMath.getSqrtPriceAtTick(tick));
    }

    function test_liveFeedReadsThroughHook() public {
        if (block.chainid != 4663) vm.skip(true);
        uint256 fair = hook.fairPriceE18(key);
        (, int256 answer,,,) = IAggregatorV3(NVDA_FEED).latestRoundData();
        assertEq(fair, uint256(answer) * 1e10);
        assertGt(fair, 100e18); // NVDA > $100 sanity
        assertLt(fair, 500e18);
        console2.log("NVDA fair (e18):", fair);
    }

    function test_liveGuardPreviewNearFair() public {
        if (block.chainid != 4663) vm.skip(true);
        uint256 poolPrice = hook.poolPriceE18(key);
        uint256 fair = hook.fairPriceE18(key);
        console2.log("pool price (e18):", poolPrice);
        console2.log("fair price (e18):", fair);
        // Buying NVDA: zeroForOne = USDG(0) -> NVDA(1) = true
        (uint256 adverseBuy, uint24 band, , bool blockedBuy,,) = hook.previewGuard(key, true, address(this));
        // Selling NVDA: zeroForOne = false
        (uint256 adverseSell,,, bool blockedSell,,) = hook.previewGuard(key, false, address(this));
        console2.log("adverse buy bps:", adverseBuy);
        console2.log("adverse sell bps:", adverseSell);
        assertEq(band, 300);
        // Pool initialised at live market tick: neither direction may be hard-blocked
        // unless the v3 market itself is >3% away from Chainlink (then the guard is right).
        if (adverseBuy <= 300) assertFalse(blockedBuy);
        if (adverseSell <= 300) assertFalse(blockedSell);
    }

    function test_configIsOneTimeWrite() public {
        if (block.chainid != 4663) vm.skip(true);
        vm.expectRevert(RobinHook.AlreadyConfigured.selector);
        hook.configurePool(key, NVDA_FEED, NVDA, 4 days);
    }
}
