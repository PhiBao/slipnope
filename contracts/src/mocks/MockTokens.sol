// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {ERC20} from "openzeppelin-contracts/contracts/token/ERC20/ERC20.sol";
import {IAggregatorV3} from "../interfaces/IAggregatorV3.sol";

/// @notice Test/demo only. Never used with real mainnet assets.
contract MockToken is ERC20 {
    uint8 private immutable _dec;

    constructor(string memory name_, string memory symbol_, uint8 dec_) ERC20(name_, symbol_) {
        _dec = dec_;
    }

    function decimals() public view override returns (uint8) {
        return _dec;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/// @notice Test/demo only Chainlink-shaped feed with settable price + timestamp.
contract MockFeed is IAggregatorV3 {
    uint8 private immutable _dec;
    int256 public answer;
    uint256 public updatedAt;
    bool public paused; // simulates stock-token oraclePaused via separate mock below

    constructor(uint8 dec_, int256 answer_) {
        _dec = dec_;
        answer = answer_;
        updatedAt = block.timestamp;
    }

    function decimals() external view override returns (uint8) {
        return _dec;
    }

    function setAnswer(int256 answer_) external {
        answer = answer_;
        updatedAt = block.timestamp;
    }

    function setUpdatedAt(uint256 updatedAt_) external {
        updatedAt = updatedAt_;
    }

    function latestRoundData() external view override returns (uint80, int256, uint256, uint256, uint80) {
        return (1, answer, updatedAt, updatedAt, 1);
    }
}

/// @notice Mock stock token with an oraclePaused flag, mimicking ERC-8056 tokens.
contract MockStockToken is MockToken {
    bool public oraclePaused;

    constructor(string memory name_, string memory symbol_, uint8 dec_) MockToken(name_, symbol_, dec_) {}

    function setOraclePaused(bool paused_) external {
        oraclePaused = paused_;
    }
}
