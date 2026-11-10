// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {PoolKey} from "v4-core/types/PoolKey.sol";

/// @notice The one view FairLimit needs from a SlipNope guard. Declaring it as an
///         interface keeps the queue usable with any guard version (v2, v3, …)
///         without redeploying it when the hook changes.
interface IGuard {
    function previewGuard(PoolKey calldata key, bool zeroForOne, address trader)
        external
        view
        returns (
            uint256 adverseBps,
            uint24 bandBps,
            uint24 fee,
            bool blocked,
            uint256 poolPrice,
            uint256 fairPrice
        );
}
