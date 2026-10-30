// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script, console2} from "forge-std/Script.sol";
import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {Hooks} from "v4-core/libraries/Hooks.sol";
import {RobinHook} from "../src/RobinHook.sol";
import {WifBandRegistry} from "../src/WifBandRegistry.sol";
import {GuardedSwapRouter} from "../src/GuardedSwapRouter.sol";
import {MockToken} from "../src/mocks/MockTokens.sol";

interface ICreate2Deployer {
    function deploy(uint256 value, bytes32 salt, bytes memory code) external returns (address);
}

/// @notice Deploys WifBandRegistry + RobinHook (CREATE2-mined, beforeSwap flag only)
///         + GuardedSwapRouter on Robinhood Chain (mainnet 4663 / testnet 46630).
/// @dev Env: WIF_ADDRESS (optional on testnet — a demo mock WIF is deployed instead)
///      Run: forge script script/DeployCore.s.sol --rpc-url $RH_RPC --broadcast --private-key $PRIVATE_KEY
contract DeployCore is Script {
    address constant CREATE2_DEPLOYER = 0x4e59b44847b379578588920cA78FbF26c0B4956C;
    address constant MAINNET_MANAGER = 0x8366a39CC670B4001A1121B8F6A443A643e40951;
    address constant MAINNET_WIF = 0x5173b8eA6923c2d40267890D45C46a3480954773;

    function run() external {
        IPoolManager manager = IPoolManager(MAINNET_MANAGER); // same address on testnet (verified)
        vm.startBroadcast();

        address wif = vm.envOr("WIF_ADDRESS", address(0));
        if (wif == address(0)) {
            if (block.chainid == 4663) {
                wif = MAINNET_WIF;
            } else {
                MockToken mockWif = new MockToken("World is Flat (testnet demo)", "WIF", 18);
                mockWif.mint(msg.sender, 1_000_000 ether);
                wif = address(mockWif);
                console2.log("MOCK_WIF=%s", wif);
            }
        }

        WifBandRegistry registry = new WifBandRegistry(wif);
        console2.log("REGISTRY=%s", address(registry));

        // Mine CREATE2 salt so hook address carries exactly BEFORE_SWAP_FLAG.
        uint160 flags = uint160(Hooks.BEFORE_SWAP_FLAG);
        bytes memory bytecode =
            abi.encodePacked(type(RobinHook).creationCode, abi.encode(manager, address(registry)));
        bytes32 salt;
        address hookAddr;
        for (uint256 i = 0; i < 2_000_000; i++) {
            salt = bytes32(i);
            hookAddr = address(
                uint160(
                    uint256(
                        keccak256(abi.encodePacked(bytes1(0xff), CREATE2_DEPLOYER, salt, keccak256(bytecode)))
                    )
                )
            );
            if (uint160(hookAddr) & Hooks.ALL_HOOK_MASK == flags) break;
        }
        address deployed = ICreate2Deployer(CREATE2_DEPLOYER).deploy(0, salt, bytecode);
        require(deployed == hookAddr, "hook address mismatch");
        console2.log("ROBINHOOK=%s", deployed);

        GuardedSwapRouter router = new GuardedSwapRouter(manager);
        console2.log("ROUTER=%s", address(router));
        console2.log("WIF=%s", wif);
        console2.log("MANAGER=%s", address(manager));

        vm.stopBroadcast();
    }
}
