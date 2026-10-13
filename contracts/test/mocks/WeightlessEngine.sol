// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

/**
 * @title WeightlessEngine
 * @dev An engine that answers the bar but not weightOf (Task 5.1 review
 *      I5): the ceremony's weight-share row must fail, not read 0.
 */
contract WeightlessEngine {
    uint256 public constant MIN_NODES = 2;
    uint256 public constant consensusThreshold = 66;
}
