// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @notice Minimal CREATE2 factory for vanity hook deployment.
///         deploy(salt, initCode) -> the created address.
///         Deterministic: address = keccak(0xff ++ this ++ salt ++ keccak(initCode)).
///         No admin, no storage, no owner — pure pass-through.
contract VanityFactory {
    event Deployed(address indexed created, bytes32 indexed salt);

    function deploy(bytes32 salt, bytes memory initCode) external returns (address created) {
        assembly {
            created := create2(0, add(initCode, 0x20), mload(initCode), salt)
            if iszero(extcodesize(created)) {
                revert(0, 0)
            }
        }
        emit Deployed(created, salt);
    }
}
