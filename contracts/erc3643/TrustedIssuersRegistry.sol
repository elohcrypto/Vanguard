// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "@openzeppelin/contracts/access/Ownable.sol";
import "./interfaces/ITrustedIssuersRegistry.sol";

/**
 * @title TrustedIssuersRegistry
 * @dev Implementation of trusted issuers registry for ERC-3643 ecosystem
 */
contract TrustedIssuersRegistry is ITrustedIssuersRegistry, Ownable {
    // Array of trusted issuers
    address[] private _trustedIssuers;

    // Mapping to check if issuer is trusted
    mapping(address => bool) private _isTrustedIssuer;

    // Mapping from issuer to their claim topics
    mapping(address => uint[]) private _issuerClaimTopics;

    // Mapping for quick lookup of claim topics per issuer
    mapping(address => mapping(uint => bool)) private _issuerHasClaimTopic;

    constructor() Ownable(msg.sender) {}

    function addTrustedIssuer(address _trustedIssuer, uint[] calldata _claimTopics) external override onlyOwner {
        require(_trustedIssuer != address(0), "Invalid issuer address");
        require(!_isTrustedIssuer[_trustedIssuer], "Issuer already trusted");
        require(_claimTopics.length > 0, "Must specify at least one claim topic");

        _trustedIssuers.push(_trustedIssuer);
        _isTrustedIssuer[_trustedIssuer] = true;

        // Set claim topics
        for (uint i = 0; i < _claimTopics.length; i++) {
            _issuerClaimTopics[_trustedIssuer].push(_claimTopics[i]);
            _issuerHasClaimTopic[_trustedIssuer][_claimTopics[i]] = true;
        }

        emit TrustedIssuerAdded(_trustedIssuer, _claimTopics);
    }

    function removeTrustedIssuer(address _trustedIssuer) external override onlyOwner {
        require(_isTrustedIssuer[_trustedIssuer], "Issuer not trusted");

        // Remove from array
        for (uint i = 0; i < _trustedIssuers.length; i++) {
            if (_trustedIssuers[i] == _trustedIssuer) {
                _trustedIssuers[i] = _trustedIssuers[_trustedIssuers.length - 1];
                _trustedIssuers.pop();
                break;
            }
        }

        // Clear claim topics
        uint[] memory claimTopics = _issuerClaimTopics[_trustedIssuer];
        for (uint i = 0; i < claimTopics.length; i++) {
            _issuerHasClaimTopic[_trustedIssuer][claimTopics[i]] = false;
        }
        delete _issuerClaimTopics[_trustedIssuer];

        _isTrustedIssuer[_trustedIssuer] = false;

        emit TrustedIssuerRemoved(_trustedIssuer);
    }

    function updateIssuerClaimTopics(address _trustedIssuer, uint[] calldata _claimTopics) external override onlyOwner {
        require(_isTrustedIssuer[_trustedIssuer], "Issuer not trusted");
        require(_claimTopics.length > 0, "Must specify at least one claim topic");

        // Clear existing claim topics
        uint[] memory oldClaimTopics = _issuerClaimTopics[_trustedIssuer];
        for (uint i = 0; i < oldClaimTopics.length; i++) {
            _issuerHasClaimTopic[_trustedIssuer][oldClaimTopics[i]] = false;
        }
        delete _issuerClaimTopics[_trustedIssuer];

        // Set new claim topics
        for (uint i = 0; i < _claimTopics.length; i++) {
            _issuerClaimTopics[_trustedIssuer].push(_claimTopics[i]);
            _issuerHasClaimTopic[_trustedIssuer][_claimTopics[i]] = true;
        }

        emit ClaimTopicsUpdated(_trustedIssuer, _claimTopics);
    }

    function getTrustedIssuers() external view override returns (address[] memory) {
        return _trustedIssuers;
    }

    function isTrustedIssuer(address _issuer) external view override returns (bool) {
        return _isTrustedIssuer[_issuer];
    }

    function getTrustedIssuerClaimTopics(address _trustedIssuer) external view override returns (uint[] memory) {
        require(_isTrustedIssuer[_trustedIssuer], "Issuer not trusted");
        return _issuerClaimTopics[_trustedIssuer];
    }

    function hasClaimTopic(address _issuer, uint _claimTopic) external view override returns (bool) {
        return _issuerHasClaimTopic[_issuer][_claimTopic];
    }

    function getTrustedIssuersForClaimTopic(uint _claimTopic) external view override returns (address[] memory) {
        address[] memory issuersWithTopic = new address[](_trustedIssuers.length);
        uint count = 0;

        for (uint i = 0; i < _trustedIssuers.length; i++) {
            if (_issuerHasClaimTopic[_trustedIssuers[i]][_claimTopic]) {
                issuersWithTopic[count] = _trustedIssuers[i];
                count++;
            }
        }

        // Resize array to actual count
        address[] memory result = new address[](count);
        for (uint i = 0; i < count; i++) {
            result[i] = issuersWithTopic[i];
        }

        return result;
    }

    // Additional utility functions
    function getTrustedIssuersCount() external view returns (uint) {
        return _trustedIssuers.length;
    }

    function getTrustedIssuerByIndex(uint _index) external view returns (address) {
        require(_index < _trustedIssuers.length, "Index out of bounds");
        return _trustedIssuers[_index];
    }
}
