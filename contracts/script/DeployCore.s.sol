// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script, console2} from "forge-std/Script.sol";
import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {Hooks} from "v4-core/libraries/Hooks.sol";
import {SlipNope} from "../src/SlipNope.sol";
import {GuardedSwapRouter} from "../src/GuardedSwapRouter.sol";

interface ICreate2Deployer {
    function deploy(uint256 value, bytes32 salt, bytes memory code) external returns (address);
}

/// @notice Deploys SlipNope (CREATE2-mined, beforeSwap flag only) +
///         GuardedSwapRouter on Base (mainnet 8453 / Sepolia 84532).
///      Run: forge script script/DeployCore.s.sol --rpc-url $BASE_RPC --broadcast --private-key $PRIVATE_KEY
contract DeployCore is Script {
    address constant CREATE2_DEPLOYER = 0x4e59b44847b379578588920cA78FbF26c0B4956C;
    address constant BASE_MANAGER = 0x498581fF718922c3f8e6A244956aF099B2652b2b; // mainnet

    function run() external {
        // Sepolia has no canonical v4 deployment: set MANAGER_ADDRESS to the
        // self-deployed PoolManager there. Defaults to the Base mainnet manager.
        IPoolManager manager =
            IPoolManager(vm.envOr("MANAGER_ADDRESS", address(BASE_MANAGER)));
        vm.startBroadcast();

        // Mine CREATE2 salt so hook address carries exactly BEFORE_SWAP_FLAG.
        // owner = broadcaster: with CREATE2 the immediate sender is the factory.
        uint160 flags = uint160(Hooks.BEFORE_SWAP_FLAG);
        bytes memory bytecode = abi.encodePacked(type(SlipNope).creationCode, abi.encode(manager, msg.sender));
        bytes32 salt;
        address hookAddr;
        for (uint256 i = 0; i < 2_000_000; i++) {
            salt = bytes32(i);
            hookAddr = address(
                uint160(
                    uint256(keccak256(abi.encodePacked(bytes1(0xff), CREATE2_DEPLOYER, salt, keccak256(bytecode))))
                )
            );
            if (uint160(hookAddr) & Hooks.ALL_HOOK_MASK == flags) break;
        }
        address deployed = ICreate2Deployer(CREATE2_DEPLOYER).deploy(0, salt, bytecode);
        require(deployed == hookAddr, "hook address mismatch");
        console2.log("SLIPNOPE=%s", deployed);

        GuardedSwapRouter router = new GuardedSwapRouter(manager);
        console2.log("ROUTER=%s", address(router));
        console2.log("MANAGER=%s", address(manager));

        vm.stopBroadcast();
    }
}
