// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @notice Minimal Chainlink AggregatorV3 interface (Robinhood Chain stock + crypto feeds).
interface IAggregatorV3 {
    function latestRoundData()
        external
        view
        returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound);
    function decimals() external view returns (uint8);
}

/// @notice ERC-8056 stock tokens expose an oracle pause flag around corporate actions.
interface IOraclePaused {
    function oraclePaused() external view returns (bool);
}
