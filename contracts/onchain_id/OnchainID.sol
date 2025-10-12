// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import "./interfaces/IOnchainID.sol";

/**
 * @title OnchainID
 * @dev Implementation of OnchainID with ERC-734 and ERC-735 standards
 * @author CMTA UTXO Compliance Team
 */
contract OnchainID is IOnchainID, Ownable, ReentrancyGuard {
    using ECDSA for bytes32;

    // Key purposes
    uint256 public constant MANAGEMENT_KEY = 1;
    uint256 public constant ACTION_KEY = 2;
    uint256 public constant CLAIM_SIGNER_KEY = 3;
    uint256 public constant ENCRYPTION_KEY = 4;

    // Key types
    uint256 public constant ECDSA_TYPE = 1;
    uint256 public constant RSA_TYPE = 2;

    // Claim topics
    uint256 public constant IDENTITY_TOPIC = 1;
    uint256 public constant BIOMETRIC_TOPIC = 2;
    uint256 public constant RESIDENCE_TOPIC = 3;
    uint256 public constant REGISTRY_TOPIC = 4;
    uint256 public constant ACCREDITATION_TOPIC = 5;
    uint256 public constant KYC_TOPIC = 6;
    uint256 public constant AML_TOPIC = 7;
    uint256 public constant INVESTOR_TYPE_TOPIC = 8;

    // Signature schemes
    uint256 public constant ECDSA_SCHEME = 1;
    uint256 public constant RSA_SCHEME = 2;
    uint256 public constant CONTRACT_SCHEME = 3;

    // Structs
    struct Key {
        uint256 purpose;
        uint256 keyType;
        bytes32 key;
        uint256 revokedAt;
    }

    struct Claim {
        uint256 topic;
        uint256 scheme;
        address issuer;
        bytes signature;
        bytes data;
        string uri;
        uint256 validTo;
        uint256 validFrom;
    }

    // Additional Events (beyond ERC-734/735)
    event IdentityCreated(address indexed identity, address indexed owner, bytes32 managementKey);
    event Approved(uint256 indexed executionId, bool approved);
    event TrustedIssuerAdded(address indexed issuer, uint256[] topics);
    event TrustedIssuerRemoved(address indexed issuer);
    event ClaimTopicAdded(uint256 indexed topic, bool required);
    event ClaimTopicRemoved(uint256 indexed topic);

    // State variables
    mapping(bytes32 => Key) private keys;
    mapping(uint256 => bytes32[]) private keysByPurpose;
    mapping(bytes32 => Claim) private claims;
    mapping(uint256 => bytes32[]) private claimsByTopic;
    mapping(address => uint256[]) private trustedIssuers;
    mapping(uint256 => bool) private requiredTopics;

    bytes32[] private allKeys;
    bytes32[] private allClaims;
    address[] private trustedIssuersList;
    uint256[] private requiredTopicsList;

    uint256 private executionNonce;
    uint256 private claimRequestNonce;
    uint256 private creationTime;

    // ✅ DoS Protection: Maximum array sizes to prevent gas limit attacks
    uint256 public constant MAX_BATCH_SIZE = 50;
    uint256 public constant MAX_ARRAY_LENGTH = 100;

    mapping(uint256 => ExecutionRequest) private executionRequests;
    mapping(uint256 => bool) private executionApprovals;
    mapping(address => bool) public authorizedManagers;

    struct ExecutionRequest {
        address to;
        uint256 value;
        bytes data;
        bool executed;
        uint256 approvals;
    }

    /**
     * @dev Modifier to check if sender has management key
     */
    modifier onlyManagementKey() {
        require(
            keyHasPurpose(keccak256(abi.encodePacked(msg.sender)), MANAGEMENT_KEY) ||
                msg.sender == owner() ||
                authorizedManagers[msg.sender],
            "OnchainID: Sender does not have management key"
        );
        _;
    }

    /**
     * @dev Modifier to check if sender has action key
     */
    modifier onlyActionKey() {
        require(
            keyHasPurpose(keccak256(abi.encodePacked(msg.sender)), ACTION_KEY) ||
                keyHasPurpose(keccak256(abi.encodePacked(msg.sender)), MANAGEMENT_KEY) ||
                msg.sender == owner(),
            "OnchainID: Sender does not have action key"
        );
        _;
    }

    /**
     * @dev Constructor
     * @param _owner Initial owner of the identity
     */
    constructor(address _owner) Ownable(_owner == address(0) ? address(this) : _owner) {
        creationTime = block.timestamp;

        // Add owner's address as management key (only if not zero address)
        if (_owner != address(0)) {
            bytes32 ownerKey = keccak256(abi.encodePacked(_owner));
            _addKey(ownerKey, MANAGEMENT_KEY, ECDSA_TYPE);
            emit IdentityCreated(address(this), _owner, bytes32(0));
        }
    }

    /**
     * @dev Override owner function to satisfy both interfaces
     */
    function owner() public view override(Ownable) returns (address) {
        return Ownable.owner();
    }

    /**
     * @dev Allow authorized contracts to manage keys
     * @param _contract The contract address to authorize
     */
    function authorizeContract(address _contract) external onlyOwner {
        bytes32 contractKey = keccak256(abi.encodePacked(_contract));
        _addKey(contractKey, MANAGEMENT_KEY, ECDSA_TYPE);
    }

    /**
     * @dev Initialize function (for factory pattern)
     */
    function initialize(address _owner, bytes32 _managementKey) external {
        require(owner() == address(0), "OnchainID: Already initialized");
        _transferOwnership(_owner);
        creationTime = block.timestamp;

        _addKey(_managementKey, MANAGEMENT_KEY, ECDSA_TYPE);

        emit IdentityCreated(address(this), _owner, _managementKey);
    }

    // ERC-734 Implementation

    /**
     * @dev Get key information
     */
    function getKey(
        bytes32 _key
    ) external view override returns (uint256 purpose, uint256 keyType, bytes32 key, uint256 revokedAt) {
        Key memory k = keys[_key];
        return (k.purpose, k.keyType, k.key, k.revokedAt);
    }

    /**
     * @dev Check if key has purpose
     */
    function keyHasPurpose(bytes32 _key, uint256 _purpose) public view override returns (bool exists) {
        Key memory key = keys[_key];
        return key.key != bytes32(0) && key.purpose == _purpose && key.revokedAt == 0;
    }

    /**
     * @dev Get keys by purpose
     */
    function getKeysByPurpose(uint256 _purpose) external view override returns (bytes32[] memory) {
        return keysByPurpose[_purpose];
    }

    /**
     * @dev Add key
     */
    function addKey(
        bytes32 _key,
        uint256 _purpose,
        uint256 _keyType
    ) external override onlyManagementKey returns (bool success) {
        return _addKey(_key, _purpose, _keyType);
    }

    /**
     * @dev Remove key (legacy - no ownership proof required)
     * @notice DEPRECATED: Use removeKeyWithProof for better security
     */
    function removeKey(bytes32 _key, uint256 _purpose) external override onlyManagementKey returns (bool success) {
        require(keys[_key].key != bytes32(0), "OnchainID: Key does not exist");
        require(keys[_key].purpose == _purpose, "OnchainID: Purpose mismatch");

        keys[_key].revokedAt = block.timestamp;

        // Remove from keysByPurpose array
        bytes32[] storage purposeKeys = keysByPurpose[_purpose];
        for (uint256 i = 0; i < purposeKeys.length; i++) {
            if (purposeKeys[i] == _key) {
                purposeKeys[i] = purposeKeys[purposeKeys.length - 1];
                purposeKeys.pop();
                break;
            }
        }

        emit KeyRemoved(_key, _purpose, keys[_key].keyType);
        return true;
    }

    /**
     * @dev Remove key with ownership proof (RECOMMENDED)
     * @param _key The key hash to remove
     * @param _purpose The purpose of the key
     * @param _signature Signature proving ownership of the key being removed
     * @return success True if the key was removed successfully
     *
     * @notice This function requires cryptographic proof that the caller owns the key being removed.
     * For address-based keys: Sign the message with the private key of the address
     * For string-based keys: This function cannot be used (use removeKey with caution)
     *
     * Security: Prevents unauthorized key removal by requiring signature verification
     */
    function removeKeyWithProof(
        bytes32 _key,
        uint256 _purpose,
        bytes calldata _signature
    ) external onlyManagementKey returns (bool success) {
        require(keys[_key].key != bytes32(0), "OnchainID: Key does not exist");
        require(keys[_key].purpose == _purpose, "OnchainID: Purpose mismatch");
        require(keys[_key].keyType == ECDSA_TYPE, "OnchainID: Only ECDSA keys support proof");

        // Construct the message that should have been signed
        bytes32 message = keccak256(abi.encodePacked(
            "Remove key from OnchainID",
            address(this),
            _key,
            _purpose,
            block.chainid
        ));

        // Recover the signer from the signature
        bytes32 ethSignedMessageHash = MessageHashUtils.toEthSignedMessageHash(message);
        address signer = ECDSA.recover(ethSignedMessageHash, _signature);

        // Verify the signer owns the key being removed
        // For address-based keys: keccak256(abi.encode(address))
        bytes32 signerKeyHash = keccak256(abi.encode(signer));
        require(signerKeyHash == _key, "OnchainID: Signature does not prove ownership of key");

        // Proceed with removal
        keys[_key].revokedAt = block.timestamp;

        // Remove from keysByPurpose array
        bytes32[] storage purposeKeys = keysByPurpose[_purpose];
        for (uint256 i = 0; i < purposeKeys.length; i++) {
            if (purposeKeys[i] == _key) {
                purposeKeys[i] = purposeKeys[purposeKeys.length - 1];
                purposeKeys.pop();
                break;
            }
        }

        emit KeyRemoved(_key, _purpose, keys[_key].keyType);
        return true;
    }

    /**
     * @dev Get the message hash that needs to be signed for removeKeyWithProof
     * @param _key The key hash to remove
     * @param _purpose The purpose of the key
     * @return messageHash The hash that should be signed
     *
     * @notice Helper function to generate the correct message for signing.
     * Users should sign this message with the private key of the address being removed.
     *
     * Example usage:
     * 1. Call getRemoveKeyMessage(keyHash, purpose)
     * 2. Sign the returned hash with your wallet
     * 3. Call removeKeyWithProof(keyHash, purpose, signature)
     */
    function getRemoveKeyMessage(
        bytes32 _key,
        uint256 _purpose
    ) external view returns (bytes32 messageHash) {
        bytes32 message = keccak256(abi.encodePacked(
            "Remove key from OnchainID",
            address(this),
            _key,
            _purpose,
            block.chainid
        ));
        return MessageHashUtils.toEthSignedMessageHash(message);
    }

    /**
     * @dev Execute transaction
     */
    function execute(
        address _to,
        uint256 _value,
        bytes calldata _data
    ) external override onlyActionKey returns (uint256 executionId) {
        executionId = executionNonce++;

        executionRequests[executionId] = ExecutionRequest({
            to: _to,
            value: _value,
            data: _data,
            executed: false,
            approvals: 1
        });

        emit ExecutionRequested(executionId, _to, _value, _data);

        // Auto-execute if sender is owner or has management key
        if (msg.sender == owner() || keyHasPurpose(keccak256(abi.encodePacked(msg.sender)), MANAGEMENT_KEY)) {
            _executeRequest(executionId);
        }

        return executionId;
    }

    /**
     * @dev Approve execution
     */
    function approve(uint256 _id, bool _approve) external override onlyActionKey returns (bool success) {
        require(executionRequests[_id].to != address(0), "OnchainID: Execution request does not exist");
        require(!executionRequests[_id].executed, "OnchainID: Already executed");

        if (_approve) {
            executionRequests[_id].approvals++;
            emit Approved(_id, true);

            // Execute if enough approvals (simplified: 1 approval needed)
            _executeRequest(_id);
        } else {
            emit Approved(_id, false);
        }

        return true;
    }

    // ERC-735 Implementation

    /**
     * @dev Get claim
     */
    function getClaim(
        bytes32 _claimId
    )
        external
        view
        override
        returns (
            uint256 topic,
            uint256 scheme,
            address issuer,
            bytes memory signature,
            bytes memory data,
            string memory uri
        )
    {
        Claim memory claim = claims[_claimId];
        return (claim.topic, claim.scheme, claim.issuer, claim.signature, claim.data, claim.uri);
    }

    /**
     * @dev Get claim IDs by topic
     */
    function getClaimIdsByTopic(uint256 _topic) external view override returns (bytes32[] memory) {
        return claimsByTopic[_topic];
    }

    /**
     * @dev Add claim
     */
    function addClaim(
        uint256 _topic,
        uint256 _scheme,
        address _issuer,
        bytes calldata _signature,
        bytes calldata _data,
        string calldata _uri
    ) external override returns (bytes32 claimRequestId) {
        require(_issuer != address(0), "OnchainID: Invalid issuer");

        // Check if sender is authorized to add claims
        require(
            msg.sender == owner() ||
                keyHasPurpose(keccak256(abi.encodePacked(msg.sender)), MANAGEMENT_KEY) ||
                keyHasPurpose(keccak256(abi.encodePacked(msg.sender)), CLAIM_SIGNER_KEY) ||
                msg.sender == _issuer,
            "OnchainID: Not authorized to add claim"
        );

        bytes32 claimId = keccak256(abi.encodePacked(_issuer, _topic, _data));
        claimRequestId = claimId;

        claims[claimId] = Claim({
            topic: _topic,
            scheme: _scheme,
            issuer: _issuer,
            signature: _signature,
            data: _data,
            uri: _uri,
            validTo: 0, // 0 means no expiry
            validFrom: block.timestamp
        });

        claimsByTopic[_topic].push(claimId);
        allClaims.push(claimId);

        emit ClaimAdded(claimId, _topic, _scheme, _issuer, _signature, _data, _uri);

        return claimRequestId;
    }

    /**
     * @dev Remove claim
     */
    function removeClaim(bytes32 _claimId) external override onlyManagementKey returns (bool success) {
        require(claims[_claimId].issuer != address(0), "OnchainID: Claim does not exist");

        Claim memory claim = claims[_claimId];

        // Remove from claimsByTopic
        bytes32[] storage topicClaims = claimsByTopic[claim.topic];
        for (uint256 i = 0; i < topicClaims.length; i++) {
            if (topicClaims[i] == _claimId) {
                topicClaims[i] = topicClaims[topicClaims.length - 1];
                topicClaims.pop();
                break;
            }
        }

        // Remove from allClaims
        for (uint256 i = 0; i < allClaims.length; i++) {
            if (allClaims[i] == _claimId) {
                allClaims[i] = allClaims[allClaims.length - 1];
                allClaims.pop();
                break;
            }
        }

        emit ClaimRemoved(_claimId, claim.topic, claim.scheme, claim.issuer, claim.signature, claim.data, claim.uri);

        delete claims[_claimId];
        return true;
    }

    /**
     * @dev Check if has valid claim
     */
    function hasValidClaim(uint256 _topic, address _issuer) external view returns (bool exists) {
        bytes32[] memory topicClaims = claimsByTopic[_topic];

        for (uint256 i = 0; i < topicClaims.length; i++) {
            Claim memory claim = claims[topicClaims[i]];
            if (claim.issuer == _issuer && (claim.validTo == 0 || claim.validTo > block.timestamp)) {
                return true;
            }
        }

        return false;
    }

    /**
     * @dev Get all claims
     */
    function getAllClaims() external view returns (bytes32[] memory) {
        return allClaims;
    }

    /**
     * @dev Check if has topic
     */
    function hasTopic(uint256 _topic) external view returns (bool exists) {
        return claimsByTopic[_topic].length > 0;
    }

    // OnchainID specific functions

    /**
     * @dev Check if trusted issuer
     */
    function isTrustedIssuer(address _issuer, uint256 _topic) external view returns (bool trusted) {
        uint256[] memory topics = trustedIssuers[_issuer];
        for (uint256 i = 0; i < topics.length; i++) {
            if (topics[i] == _topic) {
                return true;
            }
        }
        return false;
    }

    /**
     * @dev Add trusted issuer
     */
    function addTrustedIssuer(address _issuer, uint256[] calldata _topics) external onlyManagementKey {
        require(_issuer != address(0), "OnchainID: Invalid issuer");
        // ✅ DoS Protection: Validate topics array length
        require(_topics.length > 0, "OnchainID: Empty topics array");
        require(_topics.length <= MAX_ARRAY_LENGTH, "OnchainID: Too many topics");

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
     * @dev Remove trusted issuer
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

    /**
     * @dev Get trusted issuers
     */
    function getTrustedIssuers() external view returns (address[] memory) {
        return trustedIssuersList;
    }

    /**
     * @dev Add claim topic
     */
    function addClaimTopic(uint256 _topic, bool _required) external onlyManagementKey {
        if (_required && !requiredTopics[_topic]) {
            requiredTopics[_topic] = true;
            requiredTopicsList.push(_topic);
        }

        emit ClaimTopicAdded(_topic, _required);
    }

    /**
     * @dev Remove claim topic
     */
    function removeClaimTopic(uint256 _topic) external onlyManagementKey {
        requiredTopics[_topic] = false;

        // Remove from list
        for (uint256 i = 0; i < requiredTopicsList.length; i++) {
            if (requiredTopicsList[i] == _topic) {
                requiredTopicsList[i] = requiredTopicsList[requiredTopicsList.length - 1];
                requiredTopicsList.pop();
                break;
            }
        }

        emit ClaimTopicRemoved(_topic);
    }

    /**
     * @dev Check if required topic
     */
    function isRequiredTopic(uint256 _topic) external view returns (bool required) {
        return requiredTopics[_topic];
    }

    /**
     * @dev Get required topics
     */
    function getRequiredTopics() external view returns (uint256[] memory) {
        return requiredTopicsList;
    }

    /**
     * @dev Check compliance
     */
    function isCompliant() external view returns (bool valid) {
        for (uint256 i = 0; i < requiredTopicsList.length; i++) {
            uint256 topic = requiredTopicsList[i];
            bool hasValidClaimForTopic = false;

            bytes32[] memory topicClaims = claimsByTopic[topic];
            for (uint256 j = 0; j < topicClaims.length; j++) {
                Claim memory claim = claims[topicClaims[j]];
                if (claim.validTo == 0 || claim.validTo > block.timestamp) {
                    // Check if issuer is trusted for this topic
                    uint256[] memory issuerTopics = trustedIssuers[claim.issuer];
                    for (uint256 k = 0; k < issuerTopics.length; k++) {
                        if (issuerTopics[k] == topic) {
                            hasValidClaimForTopic = true;
                            break;
                        }
                    }
                    if (hasValidClaimForTopic) break;
                }
            }

            if (!hasValidClaimForTopic) {
                return false;
            }
        }

        return true;
    }

    /**
     * @dev Get compliance status
     */
    function getComplianceStatus()
        external
        view
        returns (bool valid, uint256[] memory missingTopics, bytes32[] memory expiredClaims)
    {
        uint256[] memory missing = new uint256[](requiredTopicsList.length);
        bytes32[] memory expired = new bytes32[](allClaims.length);
        uint256 missingCount = 0;
        uint256 expiredCount = 0;

        // Check for missing required topics
        for (uint256 i = 0; i < requiredTopicsList.length; i++) {
            uint256 topic = requiredTopicsList[i];
            bool hasValidClaimForTopic = false;

            bytes32[] memory topicClaims = claimsByTopic[topic];
            for (uint256 j = 0; j < topicClaims.length; j++) {
                Claim memory claim = claims[topicClaims[j]];
                if (claim.validTo == 0 || claim.validTo > block.timestamp) {
                    hasValidClaimForTopic = true;
                    break;
                }
            }

            if (!hasValidClaimForTopic) {
                missing[missingCount++] = topic;
            }
        }

        // Check for expired claims
        for (uint256 i = 0; i < allClaims.length; i++) {
            Claim memory claim = claims[allClaims[i]];
            if (claim.validTo != 0 && claim.validTo <= block.timestamp) {
                expired[expiredCount++] = allClaims[i];
            }
        }

        // Resize arrays
        uint256[] memory finalMissing = new uint256[](missingCount);
        for (uint256 i = 0; i < missingCount; i++) {
            finalMissing[i] = missing[i];
        }

        bytes32[] memory finalExpired = new bytes32[](expiredCount);
        for (uint256 i = 0; i < expiredCount; i++) {
            finalExpired[i] = expired[i];
        }

        return (missingCount == 0, finalMissing, finalExpired);
    }

    /**
     * @dev Batch add claims
     */
    function batchAddClaims(
        uint256[] calldata _topics,
        uint256[] calldata _schemes,
        address[] calldata _issuers,
        bytes[] calldata _signatures,
        bytes[] calldata _data,
        string[] calldata _uris
    ) external returns (uint256[] memory claimRequestIds) {
        // ✅ DoS Protection: Validate array length
        require(_topics.length > 0, "OnchainID: Empty array");
        require(_topics.length <= MAX_BATCH_SIZE, "OnchainID: Batch size exceeds maximum");

        require(
            _topics.length == _schemes.length &&
                _schemes.length == _issuers.length &&
                _issuers.length == _signatures.length &&
                _signatures.length == _data.length &&
                _data.length == _uris.length,
            "OnchainID: Array length mismatch"
        );

        claimRequestIds = new uint256[](_topics.length);

        for (uint256 i = 0; i < _topics.length; i++) {
            // Check authorization for each claim
            require(
                msg.sender == owner() ||
                    keyHasPurpose(keccak256(abi.encodePacked(msg.sender)), MANAGEMENT_KEY) ||
                    keyHasPurpose(keccak256(abi.encodePacked(msg.sender)), CLAIM_SIGNER_KEY) ||
                    msg.sender == _issuers[i] ||
                    authorizedManagers[msg.sender],
                "OnchainID: Not authorized to add claim"
            );

            claimRequestIds[i] = claimRequestNonce++;
            bytes32 claimId = keccak256(abi.encodePacked(_issuers[i], _topics[i], _data[i]));

            claims[claimId] = Claim({
                topic: _topics[i],
                scheme: _schemes[i],
                issuer: _issuers[i],
                signature: _signatures[i],
                data: _data[i],
                uri: _uris[i],
                validFrom: block.timestamp,
                validTo: 0
            });

            claimsByTopic[_topics[i]].push(claimId);
            allClaims.push(claimId);

            emit ClaimAdded(claimId, _topics[i], _schemes[i], _issuers[i], _signatures[i], _data[i], _uris[i]);
        }

        return claimRequestIds;
    }

    /**
     * @dev Get creation time
     */
    function getCreationTime() external view returns (uint256) {
        return creationTime;
    }

    /**
     * @dev Get identity statistics
     */
    function getIdentityStats()
        external
        view
        returns (uint256 keyCount, uint256 claimCount, uint256 trustedIssuerCount, uint256 requiredTopicCount)
    {
        return (allKeys.length, allClaims.length, trustedIssuersList.length, requiredTopicsList.length);
    }

    // Internal functions

    /**
     * @dev Internal add key function
     */
    function _addKey(bytes32 _key, uint256 _purpose, uint256 _keyType) internal returns (bool) {
        require(_key != bytes32(0), "OnchainID: Invalid key");
        require(keys[_key].key == bytes32(0), "OnchainID: Key already exists");

        keys[_key] = Key({purpose: _purpose, keyType: _keyType, key: _key, revokedAt: 0});

        keysByPurpose[_purpose].push(_key);
        allKeys.push(_key);

        emit KeyAdded(_key, _purpose, _keyType);
        return true;
    }

    /**
     * @dev Internal execute request function
     */
    function _executeRequest(uint256 _executionId) internal {
        ExecutionRequest storage request = executionRequests[_executionId];
        require(!request.executed, "OnchainID: Already executed");

        request.executed = true;

        (bool success, ) = request.to.call{value: request.value}(request.data);

        if (success) {
            emit Executed(_executionId, request.to, request.value, request.data);
        } else {
            emit ExecutionFailed(_executionId, request.to, request.value, request.data);
        }
    }

    /**
     * @dev Authorize a manager to perform management operations
     * @param _manager The manager address to authorize
     */
    function authorizeManager(address _manager) external {
        require(msg.sender == owner(), "OnchainID: Only owner can authorize managers");
        require(_manager != address(0), "OnchainID: Invalid manager address");
        authorizedManagers[_manager] = true;
    }

    /**
     * @dev Remove authorization from a manager
     * @param _manager The manager address to deauthorize
     */
    function deauthorizeManager(address _manager) external {
        require(msg.sender == owner(), "OnchainID: Only owner can deauthorize managers");
        authorizedManagers[_manager] = false;
    }
}
