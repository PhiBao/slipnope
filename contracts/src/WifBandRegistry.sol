// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20} from "openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "openzeppelin-contracts/contracts/token/ERC20/utils/SafeERC20.sol";

/// @title WifBandRegistry
/// @notice Stake $WIF (World is Flat, Robinhood Chain) to unlock a custom max-premium
///         band in the RobinHook guard. Free tier uses the hook default (300 bps).
///         Your band can only ever be TIGHTER than the default — staking buys you
///         stricter protection, never weaker protection.
/// @dev No rewards, no emissions, no admin keys. Stake is fully withdrawable;
///      withdrawing below MIN_STAKE immediately restores the default band.
contract WifBandRegistry {
    using SafeERC20 for IERC20;

    IERC20 public immutable wif;

    uint256 public constant MIN_STAKE = 1_000 ether; // 1,000 WIF (18 decimals)
    uint24 public constant DEFAULT_BAND_BPS = 300; // mirrors RobinHook default
    uint24 public constant MIN_BAND_BPS = 25; // 0.25% tightest selectable band

    mapping(address => uint256) public staked;
    mapping(address => uint24) public bandBps; // 0 = no custom band

    event Staked(address indexed user, uint256 amount, uint256 totalStaked);
    event Unstaked(address indexed user, uint256 amount, uint256 totalStaked);
    event BandSet(address indexed user, uint24 bps);

    error InsufficientStake(uint256 have, uint256 need);
    error BandOutOfRange(uint24 bps);
    error ZeroAmount();

    constructor(address wif_) {
        require(wif_ != address(0), "wif=0");
        wif = IERC20(wif_);
    }

    function stake(uint256 amount) external {
        if (amount == 0) revert ZeroAmount();
        staked[msg.sender] += amount;
        wif.safeTransferFrom(msg.sender, address(this), amount);
        emit Staked(msg.sender, amount, staked[msg.sender]);
    }

    function unstake(uint256 amount) external {
        if (amount == 0) revert ZeroAmount();
        uint256 bal = staked[msg.sender];
        if (amount > bal) revert InsufficientStake(bal, amount);
        uint256 remaining = bal - amount;
        staked[msg.sender] = remaining;
        if (remaining < MIN_STAKE && bandBps[msg.sender] != 0) {
            bandBps[msg.sender] = 0;
            emit BandSet(msg.sender, 0);
        }
        wif.safeTransfer(msg.sender, amount);
        emit Unstaked(msg.sender, amount, remaining);
    }

    /// @notice Select a custom band. Must be tighter than (or equal to) the default.
    function setBand(uint24 bps) external {
        if (staked[msg.sender] < MIN_STAKE) revert InsufficientStake(staked[msg.sender], MIN_STAKE);
        if (bps < MIN_BAND_BPS || bps > DEFAULT_BAND_BPS) revert BandOutOfRange(bps);
        bandBps[msg.sender] = bps;
        emit BandSet(msg.sender, bps);
    }

    /// @notice Band the hook should enforce for `user`; 0 means "use hook default".
    function getBandBps(address user) external view returns (uint24) {
        if (staked[user] < MIN_STAKE) return 0;
        return bandBps[user];
    }
}
