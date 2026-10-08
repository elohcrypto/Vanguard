// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "./KeyManagerOwnerTransfer.sol";
import "./interfaces/IERC734.sol";

/**
 * @title KeyManager
 * @dev Key rotation, recovery, multi-sig and batch key operations for
 *      OnchainID identities. Holds no owner and no allowlist: every write
 *      is gated per identity, by the caller holding a MANAGEMENT key on it
 *      (recovery: its owner and its agents) and by the identity having
 *      authorized this contract (`OnchainID.authorizeManager`), which its
 *      key writes check anyway. Withdrawing that authorization
 *      (`deauthorizeManager`) pauses pending rotations and unapproved
 *      recovery candidates; it is refused while a recovery is approved
 *      (recoveryLocked, Task 4.11). `cancelKeyRotation` and
 *      `cancelKeyRecovery` (both usable while withdrawn) stop them. An
 *      item not executed within EXECUTION_WINDOW of its executionTime is
 *      dead and must be re-initiated, so a paused item cannot revive later.
 */
contract KeyManager is KeyManagerOwnerTransfer {
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

    event KeyRotationCancelled(address indexed identity, bytes32 indexed rotationId, address by);

    // State variables
    mapping(address => mapping(bytes32 => KeyRotation)) public keyRotations;
    mapping(address => mapping(bytes32 => MultiSigKey)) public multiSigKeys;

    // Configuration
    uint256 public constant DEFAULT_TIMELOCK = 24 hours;

    mapping(address => uint256) public customTimelocks;

    event CustomTimelockSet(address indexed identity, uint256 timelock);

    // Key rotation functions

    /// @dev Queue `_oldKey` -> `_newKey` for `_purpose` behind the timelock.
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

    /// @dev Run a queued rotation inside its execution window. Anyone may call.
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
        _checkWindow(rotation.executionTime);
        _checkAuthorized(_identity);
        // A rotation queued by a key that was revoked since must not run (M3).
        require(
            IOnchainID(_identity).keyHasPurpose(keccak256(abi.encodePacked(rotation.initiator)), 1),
            "KeyManager: Initiator no longer a manager"
        );

        // Add new key first
        require(IOnchainID(_identity).addKey(_newKey, _purpose, 1), "KeyManager: Failed to add new key");

        // Remove old key
        require(IOnchainID(_identity).removeKey(_oldKey, _purpose), "KeyManager: Failed to remove old key");

        rotation.completed = true;

        emit KeyRotationCompleted(_identity, _oldKey, _newKey, _purpose);
    }

    /**
     * @dev Cancel a pending rotation. Any current MANAGEMENT key of the
     *      identity, even after it withdrew this contract's authorization.
     */
    function cancelKeyRotation(address _identity, bytes32 _oldKey, bytes32 _newKey, uint256 _purpose) external {
        _checkManager(_identity);
        bytes32 rotationId = keccak256(abi.encodePacked(_identity, _oldKey, _newKey, _purpose));
        KeyRotation storage rotation = keyRotations[_identity][rotationId];
        require(rotation.initiatedAt > 0 && !rotation.completed, "KeyManager: No pending rotation");
        delete keyRotations[_identity][rotationId];
        emit KeyRotationCancelled(_identity, rotationId, msg.sender);
    }

    // Multi-signature key management

    /// @dev Record an N-of-M signer set (bookkeeping: nothing executes on it).
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

    /// @dev A listed signer signs, once.
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

    /// @dev True once the signer set reached its threshold.
    function checkMultiSigThreshold(
        address _identity,
        bytes32 _keyId
    ) external view returns (bool hasEnoughSignatures) {
        MultiSigKey storage multiSig = multiSigKeys[_identity][_keyId];
        return multiSig.active && multiSig.signatureCount >= multiSig.threshold;
    }

    // Utility functions

    /// @dev Add several keys at once (no timelock).
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

    /// @dev Remove several keys at once (no timelock).
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

    /**
     * @dev Set the rotation timelock of `_identity` (1h..7d). Its own
     *      MANAGEMENT key only; applies to rotations initiated afterwards.
     */
    function setCustomTimelock(address _identity, uint256 _timelock) external onlyIdentityManager(_identity) {
        require(_timelock >= 1 hours, "KeyManager: Timelock too short");
        require(_timelock <= 7 days, "KeyManager: Timelock too long");
        customTimelocks[_identity] = _timelock;
        emit CustomTimelockSet(_identity, _timelock);
    }

    // View functions

    /// @dev A rotation by id: keccak256(identity, oldKey, newKey, purpose).
    function getKeyRotation(
        address _identity,
        bytes32 _rotationId
    ) external view returns (KeyRotation memory rotation) {
        return keyRotations[_identity][_rotationId];
    }

    /// @dev A multi-sig record.
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
}
