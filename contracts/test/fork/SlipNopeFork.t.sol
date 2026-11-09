// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test, console2} from "forge-std/Test.sol";
import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "v4-core/types/PoolId.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {IHooks} from "v4-core/interfaces/IHooks.sol";
import {Hooks} from "v4-core/libraries/Hooks.sol";
import {LPFeeLibrary} from "v4-core/libraries/LPFeeLibrary.sol";
import {TickMath} from "v4-core/libraries/TickMath.sol";
import {SlipNope} from "../../src/SlipNope.sol";
import {IAggregatorV3} from "../../src/interfaces/IAggregatorV3.sol";
import {MockStockToken} from "../../src/mocks/MockTokens.sol";

/// @notice Fork test against live Base mainnet (chain 8453).
///         Run: forge test --match-contract SlipNopeFork --fork-url https://mainnet.base.org -vv
/// @dev Proves: real Chainlink NVDAc feed reads through the hook, pool initialised
///      at a fair tick (~$179), guard preview live, config irreversibility.
///      NOTE: no live NVDAc/USDC v3 pool is assumed; the pool is initialised at the
///      Chainlink fair price, which is exactly the not-overpay baseline.
contract SlipNopeForkTest is Test {
    using PoolIdLibrary for PoolKey;

    address constant MANAGER = 0x498581fF718922c3f8e6A244956aF099B2652b2b;
    address constant NVDA_FEED = 0x04689a41629776563E6822F76f2e57D148d28513;
    address constant USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;
    // NOTE: B20 stocks are native precompiles; Foundry's fork EVM has no B20
    // precompile registered, so decimals() on a real B20 token reverts in-fork
    // (it works on the real node — verified via cast). The fork test therefore
    // uses a mock ERC-20 as the stock leg with the LIVE Chainlink NVDA feed.
    address stock;

    SlipNope hook;
    PoolKey key;

    function setUp() public {
        if (block.chainid != 8453) return;
        IPoolManager manager = IPoolManager(MANAGER);

        uint160 flags = uint160(Hooks.BEFORE_SWAP_FLAG | Hooks.AFTER_SWAP_FLAG);
        bytes memory bytecode = abi.encodePacked(type(SlipNope).creationCode, abi.encode(manager, address(this)));
        bytes32 salt;
        address hookAddr;
        for (uint256 i = 0; i < 500_000; i++) {
            salt = bytes32(i);
            hookAddr = address(
                uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), address(this), salt, keccak256(bytecode)))))
            );
            if (uint160(hookAddr) & Hooks.ALL_HOOK_MASK == flags) break;
        }
        hook = new SlipNope{salt: salt}(manager, address(this));
        require(address(hook) == hookAddr, "mine mismatch");

        MockStockToken mockStock = new MockStockToken("NVIDIA (mock)", "NVDA", 8); // B20 parity: 8dp
        stock = address(mockStock);

        (address t0, address t1) =
            USDC < stock ? (USDC, stock) : (stock, USDC);
        Currency c0 = Currency.wrap(t0);
        Currency c1 = Currency.wrap(t1);
        key = PoolKey({
            currency0: c0,
            currency1: c1,
            fee: LPFeeLibrary.DYNAMIC_FEE_FLAG,
            tickSpacing: 60,
            hooks: IHooks(address(hook))
        });
        hook.configurePool(key, NVDA_FEED, stock, 4 days);

        // Initialise at the live fair tick: mock 8dp / USDC 6dp, same shape as B20/USDC.
        // exp = 18 + 8 - 6 = 20. If stock is currency1 (usual: mock > USDC):
        //   fair = 10^20 * 2^96 / ratioX96  =>  ratioX96 = 10^20 * 2^96 / fair
        // If stock were currency0: ratioX96 = fair * 2^96 / 10^20.
        uint256 fair = hook.fairPriceE18(key);
        uint256 ratioX96 = USDC < stock
            ? (10 ** 20 * (1 << 96)) / fair
            : (fair * (1 << 96)) / (10 ** 20);
        uint160 sqrtPrice = _sqrtX96(ratioX96);
        manager.initialize(key, sqrtPrice);
    }

    function _sqrtX96(uint256 ratioX96) internal pure returns (uint160) {
        // sqrt(ratioX96 * 2^96) via Newton; start ABOVE the root so iterates
        // decrease monotonically and converge.
        uint256 x = ratioX96 * (1 << 96);
        uint256 r = x; // overestimate; converges (may need many iterations from far above)
        for (uint256 i = 0; i < 200; i++) {
            uint256 y = (r + x / r) / 2;
            if (y == r) break;
            r = y;
        }
        return uint160(r);
    }

    function test_liveFeedReadsThroughHook() public {
        if (block.chainid != 8453) vm.skip(true);
        uint256 fair = hook.fairPriceE18(key);
        (, int256 answer,,,) = IAggregatorV3(NVDA_FEED).latestRoundData();
        assertEq(fair, uint256(answer) * 1e10);
        assertGt(fair, 100e18);
        assertLt(fair, 300e18);
        console2.log("NVDAc fair (e18):", fair);
    }

    function test_liveGuardPreviewNearFair() public {
        if (block.chainid != 8453) vm.skip(true);
        uint256 poolPrice = hook.poolPriceE18(key);
        uint256 fair = hook.fairPriceE18(key);
        console2.log("pool price (e18):", poolPrice);
        console2.log("fair price (e18):", fair);
        (uint256 adverseBuy, uint24 band,, bool blockedBuy,,) = hook.previewGuard(key, true, address(this));
        (uint256 adverseSell,,, bool blockedSell,,) = hook.previewGuard(key, false, address(this));
        console2.log("adverse buy bps:", adverseBuy);
        console2.log("adverse sell bps:", adverseSell);
        assertEq(band, 300);
        assertFalse(blockedBuy);
        assertFalse(blockedSell);
    }

    function test_configIsOneTimeWrite() public {
        if (block.chainid != 8453) vm.skip(true);
        vm.expectRevert(SlipNope.AlreadyConfigured.selector);
        hook.configurePool(key, NVDA_FEED, stock, 4 days);
    }
}
