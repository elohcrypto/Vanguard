// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

/**
 * @title IClaimTopicsRegistry Interface
 * @dev Interface for managing required claim topics in ERC-3643 ecosystem
 */
interface IClaimTopicsRegistry {
    // Events
    event ClaimTopicAdded(uint indexed claimTopic);
    event ClaimTopicRemoved(uint indexed claimTopic);

    // Claim topic management
    function addClaimTopic(uint _claimTopic) external;

    function removeClaimTopic(uint _claimTopic) external;

    // Queries
    function getClaimTopics() external view returns (uint[] memory);

    function isClaimTopicRequired(uint _claimTopic) external view returns (bool);
}
