// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script, console2} from "forge-std/Script.sol";
import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {IHooks} from "v4-core/interfaces/IHooks.sol";
import {LPFeeLibrary} from "v4-core/libraries/LPFeeLibrary.sol";
import {TickMath} from "v4-core/libraries/TickMath.sol";
import {IERC20} from "openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
import {SlipNope} from "../src/SlipNope.sol";
import {GuardedSwapRouter} from "../src/GuardedSwapRouter.sol";

/// @notice Configures + initialises + seeds one SlipNope guarded pool.
/// @dev Env:
///        SLIPNOPE, ROUTER            deployed core addresses
///        STOCK, FEED, QUOTE           guarded asset, Chainlink feed, quote token
///        MAX_STALE                    seconds (default 345600 = 4 days)
///        INIT_TICK                    initial pool tick (align to live market!)
///        TICK_SPACING                 default 60
///        SEED_LOWER, SEED_UPPER       liquidity tick range (default -6000..6000 around 0;
///                                     for stock pools pass a range around INIT_TICK)
///        SEED_LIQUIDITY               liquidity delta (uint, default 0 = skip seeding)
///      The broadcaster must hold + approve STOCK and QUOTE for ROUTER before seeding.
///      Run: forge script script/CreateGuardedPool.s.sol --rpc-url $RH_RPC --broadcast --private-key $PRIVATE_KEY
contract CreateGuardedPool is Script {
    address constant BASE_MAINNET_MANAGER = 0x498581fF718922c3f8e6A244956aF099B2652b2b;

    function run() external {
        IPoolManager manager =
            IPoolManager(vm.envOr("MANAGER_ADDRESS", address(BASE_MAINNET_MANAGER)));
        SlipNope hook = SlipNope(vm.envAddress("SLIPNOPE"));
        GuardedSwapRouter router = GuardedSwapRouter(vm.envAddress("ROUTER"));
        address stock = vm.envAddress("STOCK");
        address feed = vm.envAddress("FEED");
        address quote = vm.envAddress("QUOTE");
        uint256 maxStale = vm.envOr("MAX_STALE", uint256(4 days));
        int24 initTick = int24(vm.envInt("INIT_TICK"));
        int24 spacing = int24(vm.envOr("TICK_SPACING", int256(60)));
        int24 lower = int24(vm.envOr("SEED_LOWER", int256(-6000)));
        int24 upper = int24(vm.envOr("SEED_UPPER", int256(6000)));
        uint256 seedLiquidity = vm.envOr("SEED_LIQUIDITY", uint256(0));

        (address t0, address t1) = stock < quote ? (stock, quote) : (quote, stock);
        PoolKey memory key = PoolKey({
            currency0: Currency.wrap(t0),
            currency1: Currency.wrap(t1),
            fee: LPFeeLibrary.DYNAMIC_FEE_FLAG,
            tickSpacing: spacing,
            hooks: IHooks(address(hook))
        });

        vm.startBroadcast();
        hook.configurePool(key, feed, stock, maxStale);
        manager.initialize(key, TickMath.getSqrtPriceAtTick(initTick));
        console2.log("POOL_INITIALIZED tick=%s", vm.toString(initTick));

        if (seedLiquidity > 0) {
            IERC20(stock).approve(address(router), type(uint256).max);
            IERC20(quote).approve(address(router), type(uint256).max);
            router.modifyLiquidity(
                key,
                IPoolManager.ModifyLiquidityParams({
                    tickLower: lower,
                    tickUpper: upper,
                    liquidityDelta: int256(seedLiquidity),
                    salt: 0
                })
            );
            console2.log("POOL_SEEDED liquidity=%s", seedLiquidity);
        }
        vm.stopBroadcast();

        console2.log("fairE18=%s", hook.fairPriceE18(key));
        console2.log("poolE18=%s", hook.poolPriceE18(key));
    }
}
