// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

/**
 * @title ITrustedIssuersRegistry Interface
 * @dev Interface for managing trusted claim issuers in ERC-3643 ecosystem
 */
interface ITrustedIssuersRegistry {
    // Events
    event TrustedIssuerAdded(address indexed trustedIssuer, uint[] claimTopics);
    event TrustedIssuerRemoved(address indexed trustedIssuer);
    event ClaimTopicsUpdated(address indexed trustedIssuer, uint[] claimTopics);

    // Trusted issuer management
    function addTrustedIssuer(address _trustedIssuer, uint[] calldata _claimTopics) external;

    function removeTrustedIssuer(address _trustedIssuer) external;

    function updateIssuerClaimTopics(address _trustedIssuer, uint[] calldata _claimTopics) external;

    // Queries
    function getTrustedIssuers() external view returns (address[] memory);

    function isTrustedIssuer(address _issuer) external view returns (bool);

    function getTrustedIssuerClaimTopics(address _trustedIssuer) external view returns (uint[] memory);

    function hasClaimTopic(address _issuer, uint _claimTopic) external view returns (bool);

    function getTrustedIssuersForClaimTopic(uint _claimTopic) external view returns (address[] memory);
}
