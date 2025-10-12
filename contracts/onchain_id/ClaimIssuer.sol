// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "./interfaces/IOnchainID.sol";
import "./interfaces/IERC735.sol";

/**
 * @title ClaimIssuer
 * @dev Contract for issuing and verifying claims for OnchainID contracts
 * @author CMTA UTXO Compliance Team
 */
contract ClaimIssuer is Ownable, ReentrancyGuard {
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

    event IssuerKeyAdded(bytes32 indexed key, uint256 indexed purpose);
    event IssuerKeyRevoked(bytes32 indexed key, uint256 indexed purpose);
    event TrustedIssuerAdded(address indexed issuer, uint256[] topics);
    event TrustedIssuerRemoved(address indexed issuer);

    // Structs
    struct IssuerKey {
        bytes32 key;
        uint256 purpose;
        uint256 keyType;
        bool revoked;
        uint256 revokedAt;
    }

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
    mapping(bytes32 => IssuerKey) public issuerKeys;
    mapping(uint256 => bytes32[]) public keysByPurpose;
    mapping(bytes32 => IssuedClaim) public issuedClaims;
    mapping(address => bytes32[]) public claimsByIdentity;
    mapping(uint256 => bytes32[]) public claimsByTopic;

    bytes32[] public allKeys;
    bytes32[] public allClaims;
    uint256 private claimRequestNonce;

    // Trusted issuers for delegation
    mapping(address => uint256[]) public trustedIssuers;
    address[] public trustedIssuersList;

    // Issuer configuration
    string public issuerName;
    string public issuerDescription;
    string public issuerWebsite;
    bool public isActive;

    // Key purposes (same as ERC-734)
    uint256 public constant MANAGEMENT_KEY = 1;
    uint256 public constant CLAIM_SIGNER_KEY = 3;

    // Key types
    uint256 public constant ECDSA_TYPE = 1;

    /**
     * @dev Constructor
     * @param _owner Initial owner of the claim issuer
     * @param _name Name of the issuer
     * @param _description Description of the issuer
     */
    constructor(address _owner, string memory _name, string memory _description) Ownable(_owner) {
        issuerName = _name;
        issuerDescription = _description;
        isActive = true;

        // Add owner's address as management key
        bytes32 ownerKey = keccak256(abi.encodePacked(_owner));
        _addIssuerKey(ownerKey, MANAGEMENT_KEY, ECDSA_TYPE);
    }

    /**
     * @dev Modifier to check if sender has management key
     */
    modifier onlyManagementKey() {
        require(
            _hasKeyPurpose(keccak256(abi.encodePacked(msg.sender)), MANAGEMENT_KEY) || msg.sender == owner(),
            "ClaimIssuer: Sender does not have management key"
        );
        _;
    }

    /**
     * @dev Modifier to check if sender has claim signer key
     */
    modifier onlyClaimSigner() {
        require(
            _hasKeyPurpose(keccak256(abi.encodePacked(msg.sender)), CLAIM_SIGNER_KEY) ||
                _hasKeyPurpose(keccak256(abi.encodePacked(msg.sender)), MANAGEMENT_KEY) ||
                msg.sender == owner(),
            "ClaimIssuer: Sender does not have claim signer key"
        );
        _;
    }

    /**
     * @dev Modifier to check if issuer is active
     */
    modifier whenActive() {
        require(isActive, "ClaimIssuer: Issuer is not active");
        _;
    }

    /**
     * @dev Issue a claim to an OnchainID
     * @param _identity The OnchainID contract address
     * @param _topic The claim topic
     * @param _scheme The signature scheme
     * @param _data The claim data
     * @param _uri The claim URI
     * @param _validTo Expiry timestamp (0 for no expiry)
     * @return claimId The ID of the issued claim
     */
    function issueClaim(
        address _identity,
        uint256 _topic,
        uint256 _scheme,
        bytes calldata _data,
        string calldata _uri,
        uint256 _validTo
    ) external onlyClaimSigner whenActive nonReentrant returns (bytes32 claimId) {
        require(_identity != address(0), "ClaimIssuer: Invalid identity");
        require(_data.length > 0, "ClaimIssuer: Empty claim data");

        // Generate claim signature
        bytes32 dataHash = keccak256(abi.encodePacked(_identity, _topic, _data));
        bytes memory signature = _signClaim(dataHash);

        // Generate claim ID
        claimId = keccak256(abi.encodePacked(address(this), _identity, _topic, _data));

        // Store issued claim
        issuedClaims[claimId] = IssuedClaim({
            identity: _identity,
            topic: _topic,
            scheme: _scheme,
            signature: signature,
            data: _data,
            uri: _uri,
            issuedAt: block.timestamp,
            validTo: _validTo,
            revoked: false,
            revokedAt: 0
        });

        // Update indexes
        claimsByIdentity[_identity].push(claimId);
        claimsByTopic[_topic].push(claimId);
        allClaims.push(claimId);

        // Add claim to the OnchainID contract
        try IOnchainID(_identity).addClaim(_topic, _scheme, address(this), signature, _data, _uri) {
            emit ClaimIssued(_identity, _topic, claimId, address(this), signature, _data);
        } catch {
            // Revert the storage changes if adding to OnchainID fails
            delete issuedClaims[claimId];
            claimsByIdentity[_identity].pop();
            claimsByTopic[_topic].pop();
            allClaims.pop();
            revert("ClaimIssuer: Failed to add claim to OnchainID");
        }

        return claimId;
    }

    /**
     * @dev Batch issue multiple claims
     * @param _identities Array of OnchainID addresses
     * @param _topics Array of claim topics
     * @param _schemes Array of signature schemes
     * @param _data Array of claim data
     * @param _uris Array of claim URIs
     * @param _validTos Array of expiry timestamps
     * @return claimIds Array of issued claim IDs
     */
    function batchIssueClaims(
        address[] calldata _identities,
        uint256[] calldata _topics,
        uint256[] calldata _schemes,
        bytes[] calldata _data,
        string[] calldata _uris,
        uint256[] calldata _validTos
    ) external onlyClaimSigner whenActive nonReentrant returns (bytes32[] memory claimIds) {
        require(
            _identities.length == _topics.length &&
                _topics.length == _schemes.length &&
                _schemes.length == _data.length &&
                _data.length == _uris.length &&
                _uris.length == _validTos.length,
            "ClaimIssuer: Array length mismatch"
        );

        claimIds = new bytes32[](_identities.length);

        for (uint256 i = 0; i < _identities.length; i++) {
            require(_identities[i] != address(0), "ClaimIssuer: Invalid identity");
            require(_data[i].length > 0, "ClaimIssuer: Empty claim data");

            // Check authorization for each claim
            require(
                msg.sender == owner() ||
                    _hasKeyPurpose(keccak256(abi.encodePacked(msg.sender)), MANAGEMENT_KEY) ||
                    _hasKeyPurpose(keccak256(abi.encodePacked(msg.sender)), CLAIM_SIGNER_KEY),
                "ClaimIssuer: Sender does not have claim signer key"
            );

            claimRequestNonce++;
            bytes32 claimId = keccak256(abi.encodePacked(address(this), _identities[i], _topics[i], _data[i]));
            claimIds[i] = claimId;

            // Generate claim signature
            bytes32 dataHash = keccak256(abi.encodePacked(_identities[i], _topics[i], _data[i]));
            bytes memory signature = _signClaim(dataHash);

            issuedClaims[claimId] = IssuedClaim({
                identity: _identities[i],
                topic: _topics[i],
                scheme: _schemes[i],
                signature: signature,
                data: _data[i],
                uri: _uris[i],
                issuedAt: block.timestamp,
                validTo: _validTos[i],
                revoked: false,
                revokedAt: 0
            });

            claimsByIdentity[_identities[i]].push(claimId);
            claimsByTopic[_topics[i]].push(claimId);
            allClaims.push(claimId);

            emit ClaimIssued(_identities[i], _topics[i], claimId, address(this), signature, _data[i]);
        }

        return claimIds;
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

        // Try to remove from OnchainID (may fail if not authorized)
        try IOnchainID(claim.identity).removeClaim(_claimId) {
            // Claim removed successfully
        } catch {
            // Continue even if removal fails - claim is still marked as revoked
        }

        emit ClaimRevoked(claim.identity, _claimId, claim.topic);
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
     * @dev Check if a claim is valid (not revoked and not expired)
     * @param _claimId The claim ID
     * @return valid True if the claim is valid
     */
    function isClaimValid(bytes32 _claimId) external view returns (bool valid) {
        IssuedClaim memory claim = issuedClaims[_claimId];

        if (claim.identity == address(0) || claim.revoked) {
            return false;
        }

        if (claim.validTo != 0 && claim.validTo <= block.timestamp) {
            return false;
        }

        return true;
    }

    // Key management functions

    /**
     * @dev Add an issuer key
     * @param _key The key to add
     * @param _purpose The key purpose
     * @param _keyType The key type
     */
    function addIssuerKey(bytes32 _key, uint256 _purpose, uint256 _keyType) external onlyManagementKey {
        _addIssuerKey(_key, _purpose, _keyType);
    }

    /**
     * @dev Revoke an issuer key
     * @param _key The key to revoke
     */
    function revokeIssuerKey(bytes32 _key) external onlyManagementKey {
        require(issuerKeys[_key].key != bytes32(0), "ClaimIssuer: Key does not exist");
        require(!issuerKeys[_key].revoked, "ClaimIssuer: Key already revoked");

        issuerKeys[_key].revoked = true;
        issuerKeys[_key].revokedAt = block.timestamp;

        emit IssuerKeyRevoked(_key, issuerKeys[_key].purpose);
    }

    /**
     * @dev Get keys by purpose
     * @param _purpose The key purpose
     * @return keys Array of keys
     */
    function getKeysByPurpose(uint256 _purpose) external view returns (bytes32[] memory keys) {
        return keysByPurpose[_purpose];
    }

    // Trusted issuer management

    /**
     * @dev Add a trusted issuer for delegation
     * @param _issuer The issuer address
     * @param _topics Array of topics the issuer is trusted for
     */
    function addTrustedIssuer(address _issuer, uint256[] calldata _topics) external onlyManagementKey {
        require(_issuer != address(0), "ClaimIssuer: Invalid issuer");

        // Add to list if not already present
        bool exists = false;
        for (uint256 i = 0; i < trustedIssuersList.length; i++) {
            if (trustedIssuersList[i] == _issuer) {
                exists = true;
                break;
            }
        }

        if (!exists) {
            trustedIssuersList.push(_issuer);
        }

        trustedIssuers[_issuer] = _topics;

        emit TrustedIssuerAdded(_issuer, _topics);
    }

    /**
     * @dev Remove a trusted issuer
     * @param _issuer The issuer address
     */
    function removeTrustedIssuer(address _issuer) external onlyManagementKey {
        delete trustedIssuers[_issuer];

        // Remove from list
        for (uint256 i = 0; i < trustedIssuersList.length; i++) {
            if (trustedIssuersList[i] == _issuer) {
                trustedIssuersList[i] = trustedIssuersList[trustedIssuersList.length - 1];
                trustedIssuersList.pop();
                break;
            }
        }

        emit TrustedIssuerRemoved(_issuer);
    }

    // Admin functions

    /**
     * @dev Set issuer information
     * @param _name New issuer name
     * @param _description New issuer description
     * @param _website New issuer website
     */
    function setIssuerInfo(
        string calldata _name,
        string calldata _description,
        string calldata _website
    ) external onlyOwner {
        issuerName = _name;
        issuerDescription = _description;
        issuerWebsite = _website;
    }

    /**
     * @dev Set issuer active status
     * @param _active Whether the issuer is active
     */
    function setActive(bool _active) external onlyOwner {
        isActive = _active;
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

    // Internal functions

    /**
     * @dev Internal function to add an issuer key
     */
    function _addIssuerKey(bytes32 _key, uint256 _purpose, uint256 _keyType) internal {
        require(_key != bytes32(0), "ClaimIssuer: Invalid key");
        require(issuerKeys[_key].key == bytes32(0), "ClaimIssuer: Key already exists");

        issuerKeys[_key] = IssuerKey({key: _key, purpose: _purpose, keyType: _keyType, revoked: false, revokedAt: 0});

        keysByPurpose[_purpose].push(_key);
        allKeys.push(_key);

        emit IssuerKeyAdded(_key, _purpose);
    }

    /**
     * @dev Internal function to check if a key has a specific purpose
     */
    function _hasKeyPurpose(bytes32 _key, uint256 _purpose) internal view returns (bool) {
        IssuerKey memory key = issuerKeys[_key];
        return key.key != bytes32(0) && key.purpose == _purpose && !key.revoked;
    }

    /**
     * @dev Internal function to sign a claim
     */
    function _signClaim(bytes32 _dataHash) internal view returns (bytes memory signature) {
        // In a real implementation, this would use a secure signing mechanism
        // For this POC, we'll create a mock signature
        bytes32 ethSignedMessageHash = MessageHashUtils.toEthSignedMessageHash(_dataHash);

        // This is a simplified signature - in production, use proper key management
        return abi.encodePacked(ethSignedMessageHash, address(this));
    }
}
