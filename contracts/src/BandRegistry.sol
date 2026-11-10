// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @title BandRegistry
/// @notice Live guard band for SlipNope pools, moved by a keeper inside hard
///         bounds. The keeper can widen or tighten the band; it can never
///         disable the guard, change a price, or touch funds.
/// @dev `bandBps` is the only input the hook reads. Bounds are immutable.
contract BandRegistry {
    /// Tightest band the keeper may set (1.00%).
    uint24 public constant MIN_BAND_BPS = 100;
    /// Widest band the keeper may set (8.00%). Beyond this the guard is theatre.
    uint24 public constant MAX_BAND_BPS = 800;
    /// Starting band before the first keeper update (3.00%).
    uint24 public constant DEFAULT_BAND_BPS = 300;

    address public owner;
    address public keeper;
    uint24 public bandBps;
    uint64 public updatedAt;
    /// Human-readable reason for the last move, e.g. "vol7d=42bps".
    string public lastReason;

    event BandUpdated(uint24 previousBps, uint24 newBps, string reason, address indexed by);
    event KeeperChanged(address indexed previous, address indexed next);
    event OwnerChanged(address indexed previous, address indexed next);

    error NotOwner();
    error NotKeeper();
    error BandOutOfBounds(uint24 bps);
    error ZeroAddress();

    constructor(address keeper_) {
        if (keeper_ == address(0)) revert ZeroAddress();
        owner = msg.sender;
        keeper = keeper_;
        bandBps = DEFAULT_BAND_BPS;
        updatedAt = uint64(block.timestamp);
        lastReason = "initial";
    }

    /// @notice Set the live band. Bounded, keeper-only.
    function setBand(uint24 bps, string calldata reason) external {
        if (msg.sender != keeper && msg.sender != owner) revert NotKeeper();
        if (bps < MIN_BAND_BPS || bps > MAX_BAND_BPS) revert BandOutOfBounds(bps);
        uint24 prev = bandBps;
        bandBps = bps;
        updatedAt = uint64(block.timestamp);
        lastReason = reason;
        emit BandUpdated(prev, bps, reason, msg.sender);
    }

    function setKeeper(address next) external {
        if (msg.sender != owner) revert NotOwner();
        if (next == address(0)) revert ZeroAddress();
        emit KeeperChanged(keeper, next);
        keeper = next;
    }

    function transferOwnership(address next) external {
        if (msg.sender != owner) revert NotOwner();
        if (next == address(0)) revert ZeroAddress();
        emit OwnerChanged(owner, next);
        owner = next;
    }

    /// @notice The band the hook must enforce. Never returns 0.
    function currentBandBps() external view returns (uint24) {
        return bandBps;
    }
}
