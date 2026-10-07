// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable2Step.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";

/**
 * @title ClaimIssuerKeys
 * @dev The issuer half of ClaimIssuer (split by inheritance, plan Task
 *      4.8): the issuer's own keys and their purposes, the trusted-issuer
 *      delegation list, the issuer's name, description, website and active
 *      flag, and the key checks every claim write uses. ClaimIssuer is the
 *      only contract deployed.
 */
abstract contract ClaimIssuerKeys is Ownable2Step {
    // Events
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

    // State variables
    mapping(bytes32 => IssuerKey) public issuerKeys;
    mapping(uint256 => bytes32[]) public keysByPurpose;
    bytes32[] public allKeys;

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
     * @dev Require `_sig` to be an EIP-191 signature over keccak256(identity, topic, data)
     *      by a key allowed to sign claims: same rule as `onlyClaimSigner`, applied to the signer.
     */
    function _requireTrustedSignature(bytes32 _dataHash, bytes calldata _sig) internal view {
        address signer = ECDSA.recover(MessageHashUtils.toEthSignedMessageHash(_dataHash), _sig);
        bytes32 signerKey = keccak256(abi.encodePacked(signer));
        require(
            _hasKeyPurpose(signerKey, CLAIM_SIGNER_KEY) ||
                _hasKeyPurpose(signerKey, MANAGEMENT_KEY) ||
                signer == owner(),
            "ClaimIssuer: Signer does not have claim signer key"
        );
    }
}
