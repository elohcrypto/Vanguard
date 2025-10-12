// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "@openzeppelin/contracts/access/Ownable.sol";
import "./interfaces/IClaimTopicsRegistry.sol";

/**
 * @title ClaimTopicsRegistry
 * @dev Implementation of claim topics registry for ERC-3643 ecosystem
 */
contract ClaimTopicsRegistry is IClaimTopicsRegistry, Ownable {
    // Array of required claim topics
    uint[] private _claimTopics;

    // Mapping to check if claim topic is required
    mapping(uint => bool) private _isClaimTopicRequired;

    constructor() Ownable(msg.sender) {}

    function addClaimTopic(uint _claimTopic) external override onlyOwner {
        require(!_isClaimTopicRequired[_claimTopic], "Claim topic already required");

        _claimTopics.push(_claimTopic);
        _isClaimTopicRequired[_claimTopic] = true;

        emit ClaimTopicAdded(_claimTopic);
    }

    function removeClaimTopic(uint _claimTopic) external override onlyOwner {
        require(_isClaimTopicRequired[_claimTopic], "Claim topic not required");

        // Remove from array
        for (uint i = 0; i < _claimTopics.length; i++) {
            if (_claimTopics[i] == _claimTopic) {
                _claimTopics[i] = _claimTopics[_claimTopics.length - 1];
                _claimTopics.pop();
                break;
            }
        }

        _isClaimTopicRequired[_claimTopic] = false;

        emit ClaimTopicRemoved(_claimTopic);
    }

    function getClaimTopics() external view override returns (uint[] memory) {
        return _claimTopics;
    }

    function isClaimTopicRequired(uint _claimTopic) external view override returns (bool) {
        return _isClaimTopicRequired[_claimTopic];
    }

    // Additional utility functions
    function getClaimTopicsCount() external view returns (uint) {
        return _claimTopics.length;
    }

    function getClaimTopicByIndex(uint _index) external view returns (uint) {
        require(_index < _claimTopics.length, "Index out of bounds");
        return _claimTopics[_index];
    }
}
