// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "./interfaces/IOnchainID.sol";
import "./interfaces/IERC734.sol";

/**
 * @title KeyManager
 * @dev Utility contract for advanced key management operations on OnchainID contracts
 * @author CMTA UTXO Compliance Team
 */
contract KeyManager is Ownable, ReentrancyGuard {
    using ECDSA for bytes32;

    // Events
    event KeyRotationInitiated(
        address indexed identity,
        bytes32 indexed oldKey,
        bytes32 indexed newKey,
        uint256 purpose
    );

    event KeyRotationCompleted(
        address indexed identity,
        bytes32 indexed oldKey,
        bytes32 indexed newKey,
        uint256 purpose
    );

    event MultiSigKeyAdded(
        address indexed identity,
        bytes32 indexed keyId,
        uint256 purpose,
        uint256 threshold,
        bytes32[] signers
    );

    event KeyRecoveryInitiated(address indexed identity, bytes32 indexed recoveryKey, address initiator);

    event KeyRecoveryCompleted(address indexed identity, bytes32 indexed recoveryKey);

    // Structs
    struct KeyRotation {
        bytes32 oldKey;
        bytes32 newKey;
        uint256 purpose;
        uint256 initiatedAt;
        uint256 executionTime;
        bool completed;
        address initiator;
    }

    struct MultiSigKey {
        bytes32[] signers;
        uint256 threshold;
        uint256 purpose;
        bool active;
        mapping(bytes32 => bool) hasSigned;
        uint256 signatureCount;
    }

    struct KeyRecovery {
        bytes32 recoveryKey;
        address[] recoveryAgents;
        uint256 threshold;
        uint256 initiatedAt;
        uint256 executionTime;
        bool completed;
        mapping(address => bool) hasApproved;
        uint256 approvalCount;
    }

    // State variables
    mapping(address => mapping(bytes32 => KeyRotation)) public keyRotations;
    mapping(address => mapping(bytes32 => MultiSigKey)) public multiSigKeys;
    mapping(address => KeyRecovery) public keyRecoveries;

    // Configuration
    uint256 public constant DEFAULT_TIMELOCK = 24 hours;
    uint256 public constant RECOVERY_TIMELOCK = 48 hours;
    uint256 public constant MAX_RECOVERY_AGENTS = 10;

    mapping(address => uint256) public customTimelocks;
    mapping(address => bool) public authorizedManagers;

    /**
     * @dev Constructor
     * @param _owner Initial owner of the KeyManager
     */
    constructor(address _owner) Ownable(_owner) {}

    /**
     * @dev Modifier to check if sender is authorized manager
     */
    modifier onlyAuthorizedManager() {
        require(authorizedManagers[msg.sender] || msg.sender == owner(), "KeyManager: Not authorized manager");
        _;
    }

    /**
     * @dev Modifier to check if sender has management key for identity
     */
    modifier onlyIdentityManager(address _identity) {
        bytes32 senderKey = keccak256(abi.encodePacked(msg.sender));
        require(IOnchainID(_identity).keyHasPurpose(senderKey, 1), "KeyManager: Not identity manager");
        _;
    }

    // Key rotation functions

    /**
     * @dev Initiate key rotation with timelock
     * @param _identity The OnchainID contract address
     * @param _oldKey The key to be replaced
     * @param _newKey The new key to add
     * @param _purpose The purpose of the key
     */
    function initiateKeyRotation(
        address _identity,
        bytes32 _oldKey,
        bytes32 _newKey,
        uint256 _purpose
    ) external onlyIdentityManager(_identity) {
        require(_identity != address(0), "KeyManager: Invalid identity");
        require(_oldKey != bytes32(0), "KeyManager: Invalid old key");
        require(_newKey != bytes32(0), "KeyManager: Invalid new key");
        require(_oldKey != _newKey, "KeyManager: Keys must be different");

        // Check that old key exists and has the specified purpose
        require(
            IOnchainID(_identity).keyHasPurpose(_oldKey, _purpose),
            "KeyManager: Old key does not have specified purpose"
        );

        bytes32 rotationId = keccak256(abi.encodePacked(_identity, _oldKey, _newKey, _purpose));
        require(!keyRotations[_identity][rotationId].completed, "KeyManager: Rotation already completed");

        uint256 timelock = customTimelocks[_identity] > 0 ? customTimelocks[_identity] : DEFAULT_TIMELOCK;

        keyRotations[_identity][rotationId] = KeyRotation({
            oldKey: _oldKey,
            newKey: _newKey,
            purpose: _purpose,
            initiatedAt: block.timestamp,
            executionTime: block.timestamp + timelock,
            completed: false,
            initiator: msg.sender
        });

        emit KeyRotationInitiated(_identity, _oldKey, _newKey, _purpose);
    }

    /**
     * @dev Execute key rotation after timelock
     * @param _identity The OnchainID contract address
     * @param _oldKey The key to be replaced
     * @param _newKey The new key to add
     * @param _purpose The purpose of the key
     */
    function executeKeyRotation(
        address _identity,
        bytes32 _oldKey,
        bytes32 _newKey,
        uint256 _purpose
    ) external nonReentrant {
        bytes32 rotationId = keccak256(abi.encodePacked(_identity, _oldKey, _newKey, _purpose));
        KeyRotation storage rotation = keyRotations[_identity][rotationId];

        require(rotation.initiatedAt > 0, "KeyManager: Rotation not initiated");
        require(!rotation.completed, "KeyManager: Rotation already completed");
        require(block.timestamp >= rotation.executionTime, "KeyManager: Timelock not expired");

        // Add new key first
        require(IOnchainID(_identity).addKey(_newKey, _purpose, 1), "KeyManager: Failed to add new key");

        // Remove old key
        require(IOnchainID(_identity).removeKey(_oldKey, _purpose), "KeyManager: Failed to remove old key");

        rotation.completed = true;

        emit KeyRotationCompleted(_identity, _oldKey, _newKey, _purpose);
    }

    // Multi-signature key management

    /**
     * @dev Add a multi-signature key requirement
     * @param _identity The OnchainID contract address
     * @param _keyId Unique identifier for the multi-sig key
     * @param _signers Array of signer keys
     * @param _threshold Number of signatures required
     * @param _purpose The purpose of the key
     */
    function addMultiSigKey(
        address _identity,
        bytes32 _keyId,
        bytes32[] calldata _signers,
        uint256 _threshold,
        uint256 _purpose
    ) external onlyIdentityManager(_identity) {
        require(_signers.length > 0, "KeyManager: No signers provided");
        require(_threshold > 0 && _threshold <= _signers.length, "KeyManager: Invalid threshold");
        require(!multiSigKeys[_identity][_keyId].active, "KeyManager: Multi-sig key already exists");

        MultiSigKey storage multiSig = multiSigKeys[_identity][_keyId];
        multiSig.signers = _signers;
        multiSig.threshold = _threshold;
        multiSig.purpose = _purpose;
        multiSig.active = true;
        multiSig.signatureCount = 0;

        emit MultiSigKeyAdded(_identity, _keyId, _purpose, _threshold, _signers);
    }

    /**
     * @dev Sign a multi-signature operation
     * @param _identity The OnchainID contract address
     * @param _keyId The multi-sig key identifier
     */
    function signMultiSigOperation(address _identity, bytes32 _keyId, bytes32 /* _operation */) external {
        MultiSigKey storage multiSig = multiSigKeys[_identity][_keyId];
        require(multiSig.active, "KeyManager: Multi-sig key not active");

        bytes32 signerKey = keccak256(abi.encodePacked(msg.sender));
        bool isValidSigner = false;

        // Check if sender is a valid signer
        for (uint256 i = 0; i < multiSig.signers.length; i++) {
            if (multiSig.signers[i] == signerKey) {
                isValidSigner = true;
                break;
            }
        }

        require(isValidSigner, "KeyManager: Not a valid signer");
        require(!multiSig.hasSigned[signerKey], "KeyManager: Already signed");

        multiSig.hasSigned[signerKey] = true;
        multiSig.signatureCount++;
    }

    /**
     * @dev Check if multi-sig operation has enough signatures
     * @param _identity The OnchainID contract address
     * @param _keyId The multi-sig key identifier
     * @return hasEnoughSignatures True if threshold is met
     */
    function checkMultiSigThreshold(
        address _identity,
        bytes32 _keyId
    ) external view returns (bool hasEnoughSignatures) {
        MultiSigKey storage multiSig = multiSigKeys[_identity][_keyId];
        return multiSig.active && multiSig.signatureCount >= multiSig.threshold;
    }

    // Key recovery functions

    /**
     * @dev Set up key recovery mechanism
     * @param _identity The OnchainID contract address
     * @param _recoveryAgents Array of recovery agent addresses
     * @param _threshold Number of agents required for recovery
     */
    function setupKeyRecovery(
        address _identity,
        address[] calldata _recoveryAgents,
        uint256 _threshold
    ) external onlyIdentityManager(_identity) {
        require(_recoveryAgents.length > 0, "KeyManager: No recovery agents");
        require(_recoveryAgents.length <= MAX_RECOVERY_AGENTS, "KeyManager: Too many recovery agents");
        require(_threshold > 0 && _threshold <= _recoveryAgents.length, "KeyManager: Invalid threshold");

        KeyRecovery storage recovery = keyRecoveries[_identity];
        recovery.recoveryAgents = _recoveryAgents;
        recovery.threshold = _threshold;
        recovery.completed = false;
        recovery.approvalCount = 0;

        // Reset previous approvals
        for (uint256 i = 0; i < _recoveryAgents.length; i++) {
            recovery.hasApproved[_recoveryAgents[i]] = false;
        }
    }

    /**
     * @dev Initiate key recovery process
     * @param _identity The OnchainID contract address
     * @param _newRecoveryKey The new recovery key to add
     */
    function initiateKeyRecovery(address _identity, bytes32 _newRecoveryKey) external {
        KeyRecovery storage recovery = keyRecoveries[_identity];
        require(recovery.recoveryAgents.length > 0, "KeyManager: Recovery not set up");
        require(!recovery.completed, "KeyManager: Recovery already completed");

        // Check if sender is a recovery agent
        bool isRecoveryAgent = false;
        for (uint256 i = 0; i < recovery.recoveryAgents.length; i++) {
            if (recovery.recoveryAgents[i] == msg.sender) {
                isRecoveryAgent = true;
                break;
            }
        }
        require(isRecoveryAgent, "KeyManager: Not a recovery agent");

        recovery.recoveryKey = _newRecoveryKey;
        recovery.initiatedAt = block.timestamp;
        recovery.executionTime = block.timestamp + RECOVERY_TIMELOCK;

        emit KeyRecoveryInitiated(_identity, _newRecoveryKey, msg.sender);
    }

    /**
     * @dev Approve key recovery
     * @param _identity The OnchainID contract address
     */
    function approveKeyRecovery(address _identity) external {
        KeyRecovery storage recovery = keyRecoveries[_identity];
        require(recovery.initiatedAt > 0, "KeyManager: Recovery not initiated");
        require(!recovery.completed, "KeyManager: Recovery already completed");

        // Check if sender is a recovery agent
        bool isRecoveryAgent = false;
        for (uint256 i = 0; i < recovery.recoveryAgents.length; i++) {
            if (recovery.recoveryAgents[i] == msg.sender) {
                isRecoveryAgent = true;
                break;
            }
        }
        require(isRecoveryAgent, "KeyManager: Not a recovery agent");
        require(!recovery.hasApproved[msg.sender], "KeyManager: Already approved");

        recovery.hasApproved[msg.sender] = true;
        recovery.approvalCount++;
    }

    /**
     * @dev Execute key recovery after timelock and sufficient approvals
     * @param _identity The OnchainID contract address
     */
    function executeKeyRecovery(address _identity) external nonReentrant {
        KeyRecovery storage recovery = keyRecoveries[_identity];
        require(recovery.initiatedAt > 0, "KeyManager: Recovery not initiated");
        require(!recovery.completed, "KeyManager: Recovery already completed");
        require(block.timestamp >= recovery.executionTime, "KeyManager: Timelock not expired");
        require(recovery.approvalCount >= recovery.threshold, "KeyManager: Insufficient approvals");

        // Add recovery key as management key
        require(IOnchainID(_identity).addKey(recovery.recoveryKey, 1, 1), "KeyManager: Failed to add recovery key");

        recovery.completed = true;

        emit KeyRecoveryCompleted(_identity, recovery.recoveryKey);
    }

    // Utility functions

    /**
     * @dev Batch add keys to an identity
     * @param _identity The OnchainID contract address
     * @param _keys Array of keys to add
     * @param _purposes Array of key purposes
     * @param _keyTypes Array of key types
     */
    function batchAddKeys(
        address _identity,
        bytes32[] calldata _keys,
        uint256[] calldata _purposes,
        uint256[] calldata _keyTypes
    ) external onlyIdentityManager(_identity) {
        require(
            _keys.length == _purposes.length && _purposes.length == _keyTypes.length,
            "KeyManager: Array length mismatch"
        );

        for (uint256 i = 0; i < _keys.length; i++) {
            require(
                IOnchainID(_identity).addKey(_keys[i], _purposes[i], _keyTypes[i]),
                "KeyManager: Failed to add key"
            );
        }
    }

    /**
     * @dev Batch remove keys from an identity
     * @param _identity The OnchainID contract address
     * @param _keys Array of keys to remove
     * @param _purposes Array of key purposes
     */
    function batchRemoveKeys(
        address _identity,
        bytes32[] calldata _keys,
        uint256[] calldata _purposes
    ) external onlyIdentityManager(_identity) {
        require(_keys.length == _purposes.length, "KeyManager: Array length mismatch");

        for (uint256 i = 0; i < _keys.length; i++) {
            require(IOnchainID(_identity).removeKey(_keys[i], _purposes[i]), "KeyManager: Failed to remove key");
        }
    }

    // Admin functions

    /**
     * @dev Add authorized manager
     * @param _manager The manager address to authorize
     */
    function addAuthorizedManager(address _manager) external onlyOwner {
        require(_manager != address(0), "KeyManager: Invalid manager");
        authorizedManagers[_manager] = true;
    }

    /**
     * @dev Remove authorized manager
     * @param _manager The manager address to remove
     */
    function removeAuthorizedManager(address _manager) external onlyOwner {
        authorizedManagers[_manager] = false;
    }

    /**
     * @dev Set custom timelock for an identity
     * @param _identity The OnchainID contract address
     * @param _timelock The custom timelock duration
     */
    function setCustomTimelock(address _identity, uint256 _timelock) external onlyOwner {
        require(_timelock >= 1 hours, "KeyManager: Timelock too short");
        require(_timelock <= 7 days, "KeyManager: Timelock too long");
        customTimelocks[_identity] = _timelock;
    }

    // View functions

    /**
     * @dev Get key rotation details
     * @param _identity The OnchainID contract address
     * @param _rotationId The rotation identifier
     * @return rotation The key rotation details
     */
    function getKeyRotation(
        address _identity,
        bytes32 _rotationId
    ) external view returns (KeyRotation memory rotation) {
        return keyRotations[_identity][_rotationId];
    }

    /**
     * @dev Get multi-sig key details
     * @param _identity The OnchainID contract address
     * @param _keyId The multi-sig key identifier
     * @return signers Array of signer keys
     * @return threshold Required signature threshold
     * @return purpose Key purpose
     * @return active Whether the multi-sig key is active
     * @return signatureCount Current signature count
     */
    function getMultiSigKey(
        address _identity,
        bytes32 _keyId
    )
        external
        view
        returns (bytes32[] memory signers, uint256 threshold, uint256 purpose, bool active, uint256 signatureCount)
    {
        MultiSigKey storage multiSig = multiSigKeys[_identity][_keyId];
        return (multiSig.signers, multiSig.threshold, multiSig.purpose, multiSig.active, multiSig.signatureCount);
    }

    /**
     * @dev Get key recovery details
     * @param _identity The OnchainID contract address
     * @return recoveryAgents Array of recovery agent addresses
     * @return threshold Required approval threshold
     * @return approvalCount Current approval count
     * @return completed Whether recovery is completed
     */
    function getKeyRecovery(
        address _identity
    )
        external
        view
        returns (address[] memory recoveryAgents, uint256 threshold, uint256 approvalCount, bool completed)
    {
        KeyRecovery storage recovery = keyRecoveries[_identity];
        return (recovery.recoveryAgents, recovery.threshold, recovery.approvalCount, recovery.completed);
    }
}
