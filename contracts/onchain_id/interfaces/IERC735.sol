// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title IERC735 - Claim Holder Interface
 * @dev Interface for ERC-735 Claim Holder standard
 * @author CMTA UTXO Compliance Team
 */
interface IERC735 {
    /**
     * @dev Claim structure
     */
    struct Claim {
        uint256 topic;
        uint256 scheme;
        address issuer;
        bytes signature;
        bytes data;
        string uri;
        uint256 issuedAt;
        uint256 validTo;
    }

    /**
     * @dev Events
     */
    event ClaimRequested(
        uint256 indexed claimRequestId,
        uint256 indexed topic,
        uint256 scheme,
        address indexed issuer,
        bytes signature,
        bytes data,
        string uri
    );

    event ClaimAdded(
        bytes32 indexed claimId,
        uint256 indexed topic,
        uint256 scheme,
        address indexed issuer,
        bytes signature,
        bytes data,
        string uri
    );

    event ClaimRemoved(
        bytes32 indexed claimId,
        uint256 indexed topic,
        uint256 scheme,
        address indexed issuer,
        bytes signature,
        bytes data,
        string uri
    );

    event ClaimChanged(
        bytes32 indexed claimId,
        uint256 indexed topic,
        uint256 scheme,
        address indexed issuer,
        bytes signature,
        bytes data,
        string uri
    );

    /**
     * @dev Get a claim by its unique identifier.
     * @param _claimId The claim ID to retrieve.
     * @return topic The claim topic
     * @return scheme The signature scheme
     * @return issuer The claim issuer address
     * @return signature The claim signature
     * @return data The claim data
     * @return uri The claim URI
     */
    function getClaim(
        bytes32 _claimId
    )
        external
        view
        returns (
            uint256 topic,
            uint256 scheme,
            address issuer,
            bytes memory signature,
            bytes memory data,
            string memory uri
        );

    /**
     * @dev Returns an array of claim IDs by topic.
     * @param _topic The topic to filter by.
     * @return claimIds Array of claim IDs
     */
    function getClaimIdsByTopic(uint256 _topic) external view returns (bytes32[] memory claimIds);

    /**
     * @dev Add or update a claim.
     * @param _topic The claim topic.
     * @param _scheme The signature scheme.
     * @param _issuer The claim issuer.
     * @param _signature The claim signature.
     * @param _data The claim data.
     * @param _uri The claim URI.
     * @return claimRequestId The ID of the claim request
     */
    function addClaim(
        uint256 _topic,
        uint256 _scheme,
        address _issuer,
        bytes calldata _signature,
        bytes calldata _data,
        string calldata _uri
    ) external returns (uint256 claimRequestId);

    /**
     * @dev Removes a claim.
     * @param _claimId The claim ID to remove.
     * @return success True if the claim was removed successfully
     */
    function removeClaim(bytes32 _claimId) external returns (bool success);

    /**
     * @dev Check if a claim exists and is valid.
     * @param _topic The claim topic.
     * @param _issuer The claim issuer.
     * @return exists True if a valid claim exists
     */
    function hasValidClaim(uint256 _topic, address _issuer) external view returns (bool exists);

    /**
     * @dev Get all claims for this identity.
     * @return claimIds Array of all claim IDs
     */
    function getAllClaims() external view returns (bytes32[] memory claimIds);

    /**
     * @dev Check if the identity has a specific claim topic.
     * @param _topic The topic to check.
     * @return exists True if the topic exists
     */
    function hasTopic(uint256 _topic) external view returns (bool exists);
}
