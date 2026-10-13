// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "./interfaces/IOnchainID.sol";
import "./interfaces/IClaimIssuer.sol";
import "./ClaimIssuerKeys.sol";

/**
 * @title ClaimIssuer
 * @dev Contract for issuing and verifying claims for OnchainID contracts
 * @author CMTA UTXO Compliance Team
 */
/// @dev Two-step ownership per plan 2C.3 / D18: transferOwnership only nominates, acceptOwnership finalizes.
contract ClaimIssuer is IClaimIssuer, ClaimIssuerKeys, ReentrancyGuard {
    using ECDSA for bytes32;
    using MessageHashUtils for bytes32;

    // Events
    event ClaimIssued(
        address indexed identity,
        uint256 indexed topic,
        bytes32 indexed claimId,
        address issuer,
        bytes signature,
        bytes data
    );

    event ClaimRevoked(address indexed identity, bytes32 indexed claimId, uint256 indexed topic);
    /// @notice revokeClaim could not remove the identity-side copy (already
    ///         removed by the holder, or not an OnchainID). The claim is
    ///         revoked here either way and no longer verifies.
    event ClaimRemovalFailed(address indexed identity, bytes32 indexed identityClaimId);

    // Structs
    struct IssuedClaim {
        address identity;
        uint256 topic;
        uint256 scheme;
        bytes signature;
        bytes data;
        string uri;
        uint256 issuedAt;
        uint256 validTo;
        bool revoked;
        uint256 revokedAt;
    }

    // State variables
    mapping(bytes32 => IssuedClaim) public issuedClaims;
    mapping(address => bytes32[]) public claimsByIdentity;
    mapping(uint256 => bytes32[]) public claimsByTopic;
    /// @notice This issuer's latest claim per (identity, topic); it alone
    ///         decides hasValidClaim (2F.2 review, F1).
    mapping(address => mapping(uint256 => bytes32)) public latestClaimId;

    bytes32[] public allClaims;

    /**
     * @dev Constructor
     * @param _owner Initial owner of the claim issuer
     * @param _name Name of the issuer
     * @param _description Description of the issuer
     */
    constructor(
        address _owner,
        string memory _name,
        string memory _description
    ) ClaimIssuerKeys(_owner, _name, _description) {}

    /**
     * @dev Issue a claim to an OnchainID
     * @param _identity The OnchainID contract address
     * @param _topic The claim topic
     * @param _scheme The signature scheme
     * @param _data The claim data
     * @param _uri The claim URI
     * @param _validTo Expiry timestamp (0 for no expiry)
     * @param _signature EIP-191 signature over keccak256(abi.encodePacked(identity, topic, data))
     *        by a claim-signer or management key (or the owner); stored and passed to the OnchainID
     * @return claimId The ID of the issued claim
     */
    function issueClaim(
        address _identity,
        uint256 _topic,
        uint256 _scheme,
        bytes calldata _data,
        string calldata _uri,
        uint256 _validTo,
        bytes calldata _signature
    ) external onlyClaimSigner whenActive nonReentrant returns (bytes32 claimId) {
        return _issue(_identity, _topic, _scheme, _data, _uri, _validTo, _signature);
    }

    /**
     * @dev Batch issue multiple claims, each through issueClaim's path
     *      (Task 5.2, L-C): one claim the identity refuses reverts the batch.
     * @param _identities Array of OnchainID addresses
     * @param _topics Array of claim topics
     * @param _schemes Array of signature schemes
     * @param _data Array of claim data
     * @param _uris Array of claim URIs
     * @param _validTos Array of expiry timestamps
     * @param _signatures Array of signatures, one per claim, same rule as `issueClaim`
     * @return claimIds Array of issued claim IDs
     */
    function batchIssueClaims(
        address[] calldata _identities,
        uint256[] calldata _topics,
        uint256[] calldata _schemes,
        bytes[] calldata _data,
        string[] calldata _uris,
        uint256[] calldata _validTos,
        bytes[] calldata _signatures
    ) external onlyClaimSigner whenActive nonReentrant returns (bytes32[] memory claimIds) {
        require(
            _identities.length == _topics.length &&
                _topics.length == _schemes.length &&
                _schemes.length == _data.length &&
                _data.length == _uris.length &&
                _uris.length == _validTos.length &&
                _validTos.length == _signatures.length,
            "ClaimIssuer: Array length mismatch"
        );

        claimIds = new bytes32[](_identities.length);
        for (uint256 i = 0; i < _identities.length; i++) {
            claimIds[i] = _issue(
                _identities[i],
                _topics[i],
                _schemes[i],
                _data[i],
                _uris[i],
                _validTos[i],
                _signatures[i]
            );
        }
    }

    /// @dev The one issuing path: the signature is checked, the claim is
    ///      recorded here and written to the identity. The identity refusing
    ///      the write reverts the whole call, which is the rollback: nothing
    ///      the registry relies on (latestClaimId) outlives a failed addClaim.
    function _issue(
        address _identity,
        uint256 _topic,
        uint256 _scheme,
        bytes calldata _data,
        string calldata _uri,
        uint256 _validTo,
        bytes calldata _signature
    ) private returns (bytes32 claimId) {
        require(_identity != address(0), "ClaimIssuer: Invalid identity");
        require(_data.length > 0, "ClaimIssuer: Empty claim data");
        _requireTrustedSignature(keccak256(abi.encodePacked(_identity, _topic, _data)), _signature);

        claimId = keccak256(abi.encodePacked(address(this), _identity, _topic, _data));
        issuedClaims[claimId] = IssuedClaim({
            identity: _identity,
            topic: _topic,
            scheme: _scheme,
            signature: _signature,
            data: _data,
            uri: _uri,
            issuedAt: block.timestamp,
            validTo: _validTo,
            revoked: false,
            revokedAt: 0
        });
        claimsByIdentity[_identity].push(claimId);
        claimsByTopic[_topic].push(claimId);
        allClaims.push(claimId);

        try IOnchainID(_identity).addClaim(_topic, _scheme, address(this), _signature, _data, _uri) {} catch {
            revert("ClaimIssuer: Failed to add claim to OnchainID");
        }
        latestClaimId[_identity][_topic] = claimId;
        emit ClaimIssued(_identity, _topic, claimId, address(this), _signature, _data);
    }

    /**
     * @dev Revoke an issued claim
     * @param _claimId The claim ID to revoke
     */
    function revokeClaim(bytes32 _claimId) external onlyClaimSigner {
        require(issuedClaims[_claimId].identity != address(0), "ClaimIssuer: Claim does not exist");
        require(!issuedClaims[_claimId].revoked, "ClaimIssuer: Claim already revoked");

        IssuedClaim storage claim = issuedClaims[_claimId];
        claim.revoked = true;
        claim.revokedAt = block.timestamp;

        // Remove our copy from the identity: OnchainID ids are
        // keccak256(issuer, topic, data), and an issuer may remove its own.
        // Verification does not depend on it (it asks hasValidClaim below).
        bytes32 sideId = keccak256(abi.encodePacked(address(this), claim.topic, claim.data));
        try IOnchainID(claim.identity).removeClaim(sideId) {} catch {
            emit ClaimRemovalFailed(claim.identity, sideId);
        }

        emit ClaimRevoked(claim.identity, _claimId, claim.topic);
    }

    /**
     * @notice True if this issuer's latest claim on `_topic` for `_identity`
     *         is live (not revoked, not expired). IdentityRegistry asks this
     *         instead of reading the identity's claim list, which anyone can
     *         pad (2F.2, H2).
     * @dev The latest claim supersedes older ones: revoking it unverifies
     *      the holder even if an older claim is unrevoked, and revoking a
     *      superseded claim has no effect. To restore a holder the issuer
     *      issues a new claim; a renewal issued before expiry moves the
     *      pointer with no gap. Claims on other topics never interfere.
     */
    function hasValidClaim(address _identity, uint256 _topic) external view returns (bool) {
        return isClaimValid(latestClaimId[_identity][_topic]);
    }

    /// @inheritdoc IClaimIssuer
    function claimValidTo(address _identity, uint256 _topic) external view returns (uint256) {
        return issuedClaims[latestClaimId[_identity][_topic]].validTo;
    }

    /**
     * @dev Verify a claim signature
     * @param _identity The OnchainID address
     * @param _topic The claim topic
     * @param _data The claim data
     * @param _signature The signature to verify
     * @return valid True if the signature is valid
     */
    function verifyClaim(
        address _identity,
        uint256 _topic,
        bytes calldata _data,
        bytes calldata _signature
    ) external view returns (bool valid) {
        bytes32 dataHash = keccak256(abi.encodePacked(_identity, _topic, _data));
        bytes32 ethSignedMessageHash = MessageHashUtils.toEthSignedMessageHash(dataHash);

        address signer = ECDSA.recover(ethSignedMessageHash, _signature);
        bytes32 signerKey = keccak256(abi.encodePacked(signer));

        return _hasKeyPurpose(signerKey, CLAIM_SIGNER_KEY) || _hasKeyPurpose(signerKey, MANAGEMENT_KEY);
    }

    /**
     * @dev Get claim details
     * @param _claimId The claim ID
     * @return claim The claim details
     */
    function getClaim(bytes32 _claimId) external view returns (IssuedClaim memory claim) {
        return issuedClaims[_claimId];
    }

    /**
     * @dev Get claims by identity
     * @param _identity The OnchainID address
     * @return claimIds Array of claim IDs
     */
    function getClaimsByIdentity(address _identity) external view returns (bytes32[] memory claimIds) {
        return claimsByIdentity[_identity];
    }

    /**
     * @dev Get claims by topic
     * @param _topic The claim topic
     * @return claimIds Array of claim IDs
     */
    function getClaimsByTopic(uint256 _topic) external view returns (bytes32[] memory claimIds) {
        return claimsByTopic[_topic];
    }

    /**
     * @dev Check if a claim is valid (not revoked and not expired), and
     *      the issuer active: D43 (a), setActive(false) suspends reliance
     *      on every claim it issued, reversibly (setActive(true)).
     * @param _claimId The claim ID
     * @return valid True if the claim is valid
     */
    function isClaimValid(bytes32 _claimId) public view returns (bool valid) {
        IssuedClaim storage claim = issuedClaims[_claimId];
        return
            isActive &&
            claim.identity != address(0) &&
            !claim.revoked &&
            (claim.validTo == 0 || claim.validTo > block.timestamp);
    }
    /**
     * @dev Get issuer statistics
     * @return totalClaims Total number of issued claims
     * @return activeClaims Number of active (non-revoked) claims
     * @return totalKeys Total number of keys
     * @return active Whether the issuer is active
     */
    function getIssuerStats()
        external
        view
        returns (uint256 totalClaims, uint256 activeClaims, uint256 totalKeys, bool active)
    {
        uint256 activeCount = 0;
        for (uint256 i = 0; i < allClaims.length; i++) {
            if (!issuedClaims[allClaims[i]].revoked) {
                activeCount++;
            }
        }

        return (allClaims.length, activeCount, allKeys.length, isActive);
    }
}
