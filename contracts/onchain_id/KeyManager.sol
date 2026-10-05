// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "./interfaces/IOnchainID.sol";
import "./interfaces/IERC734.sol";

/// @dev The OnchainID surface KeyManager reads beyond IOnchainID.
interface IManagedIdentity {
    function authorizedManagers(address manager) external view returns (bool);
    function owner() external view returns (address);
}

/**
 * @title KeyManager
 * @dev Key rotation, recovery, multi-sig and batch key operations for
 *      OnchainID identities. Holds no owner and no allowlist: every write
 *      is gated per identity, by the caller holding a MANAGEMENT key on it
 *      and by the identity having authorized this contract
 *      (`OnchainID.authorizeManager`), which its key writes check anyway.
 *      Withdrawing that authorization (`deauthorizeManager`) pauses
 *      pending rotations and recoveries; `cancelKeyRotation` and
 *      `cancelKeyRecovery` (both usable while withdrawn) stop them. An
 *      item not executed within EXECUTION_WINDOW of its executionTime is
 *      dead and must be re-initiated, so a paused item cannot revive later.
 */
contract KeyManager is ReentrancyGuard {
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

    /// @dev Per identity. Candidates live under (epoch, key); bumping the
    ///      epoch (setup, execute) drops every candidate at once.
    struct KeyRecovery {
        address[] recoveryAgents;
        uint256 threshold;
        uint256 epoch;
        bool completed;
        bytes32 lastKey; // last candidate opened, or the key recovered
    }

    /// @dev One proposed recovery key with its own tally (2F.2 review, F2):
    ///      a new candidate never touches another's approvals or timelock.
    struct RecoveryCandidate {
        uint256 initiatedAt;
        uint256 executionTime;
        uint256 approvalCount;
        address initiator;
        uint256 round; // bumps on each (re)open; older approvals die
        mapping(address => uint256) approvedRound;
    }

    event KeyRotationCancelled(address indexed identity, bytes32 indexed rotationId, address by);
    event KeyRecoveryCancelled(address indexed identity, bytes32 indexed recoveryKey, address by);

    // State variables
    mapping(address => mapping(bytes32 => KeyRotation)) public keyRotations;
    mapping(address => mapping(bytes32 => MultiSigKey)) public multiSigKeys;
    mapping(address => KeyRecovery) private _recoveries;
    mapping(address => mapping(uint256 => mapping(bytes32 => RecoveryCandidate))) private _candidates;

    // Configuration
    uint256 public constant DEFAULT_TIMELOCK = 24 hours;
    uint256 public constant RECOVERY_TIMELOCK = 48 hours;
    uint256 public constant MAX_RECOVERY_AGENTS = 10;
    /// @dev An item runs only within this window after its executionTime.
    uint256 public constant EXECUTION_WINDOW = 7 days;

    mapping(address => uint256) public customTimelocks;

    event CustomTimelockSet(address indexed identity, uint256 timelock);

    /// @dev Sender holds a MANAGEMENT key on `_identity`, and `_identity`
    ///      authorized this contract as its manager.
    modifier onlyIdentityManager(address _identity) {
        _checkManager(_identity);
        _checkAuthorized(_identity);
        _;
    }

    function _checkAuthorized(address _identity) private view {
        require(
            IManagedIdentity(_identity).authorizedManagers(address(this)),
            "KeyManager: Identity has not authorized KeyManager"
        );
    }

    /// @dev Refuses an item whose execution window has passed.
    function _checkWindow(uint256 executionTime) private view {
        require(block.timestamp >= executionTime, "KeyManager: Timelock not expired");
        require(
            block.timestamp <= executionTime + EXECUTION_WINDOW,
            "KeyManager: execution window passed, re-initiate"
        );
    }

    function _checkManager(address _identity) private view {
        bytes32 senderKey = keccak256(abi.encodePacked(msg.sender));
        require(IOnchainID(_identity).keyHasPurpose(senderKey, 1), "KeyManager: Not identity manager");
    }

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

    // Key recovery functions

    /**
     * @dev Set up key recovery. Clears every pending candidate and approval
     *      (new epoch) and re-opens recovery after a completed one.
     * @param _identity The OnchainID contract address
     * @param _recoveryAgents Distinct recovery agent addresses
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
        // A duplicate would let one agent count twice (2F.2 review, F3).
        for (uint256 i = 0; i < _recoveryAgents.length; i++) {
            for (uint256 j = i + 1; j < _recoveryAgents.length; j++) {
                require(_recoveryAgents[i] != _recoveryAgents[j], "KeyManager: Duplicate agent");
            }
        }

        KeyRecovery storage recovery = _recoveries[_identity];
        recovery.epoch++;
        recovery.recoveryAgents = _recoveryAgents;
        recovery.threshold = _threshold;
        recovery.completed = false;
        recovery.lastKey = bytes32(0);
    }

    /**
     * @dev Open a recovery candidate for `_newRecoveryKey`. Each candidate
     *      has its own approvals and timelock, so an agent proposing another
     *      key never erases or delays an honest candidate (2F.2 review, F2).
     *      Re-initiating a pending candidate is refused, so its timelock
     *      cannot be restarted.
     * @param _identity The OnchainID contract address
     * @param _newRecoveryKey The new recovery key to add
     */
    function initiateKeyRecovery(address _identity, bytes32 _newRecoveryKey) external {
        KeyRecovery storage recovery = _recoveries[_identity];
        require(recovery.recoveryAgents.length > 0, "KeyManager: Recovery not set up");
        require(!recovery.completed, "KeyManager: Recovery already completed");
        require(_isRecoveryAgent(recovery, msg.sender), "KeyManager: Not a recovery agent");
        _checkAuthorized(_identity);
        require(_newRecoveryKey != bytes32(0), "KeyManager: Invalid recovery key");
        RecoveryCandidate storage c = _candidates[_identity][recovery.epoch][_newRecoveryKey];
        // A candidate past its execution window is dead and may be re-opened.
        require(
            c.initiatedAt == 0 || block.timestamp > c.executionTime + EXECUTION_WINDOW,
            "KeyManager: Recovery already pending"
        );

        c.round++;
        c.approvalCount = 0;
        c.initiatedAt = block.timestamp;
        c.executionTime = block.timestamp + RECOVERY_TIMELOCK;
        c.initiator = msg.sender;
        recovery.lastKey = _newRecoveryKey;

        emit KeyRecoveryInitiated(_identity, _newRecoveryKey, msg.sender);
    }

    /**
     * @dev Approve the pending candidate for `_key`, once per agent.
     * @param _identity The OnchainID contract address
     * @param _key The recovery key being approved
     */
    function approveKeyRecovery(address _identity, bytes32 _key) external {
        KeyRecovery storage recovery = _recoveries[_identity];
        require(!recovery.completed, "KeyManager: Recovery already completed");
        RecoveryCandidate storage c = _candidates[_identity][recovery.epoch][_key];
        require(c.initiatedAt > 0, "KeyManager: Recovery not initiated");
        require(_isRecoveryAgent(recovery, msg.sender), "KeyManager: Not a recovery agent");
        _checkAuthorized(_identity);
        require(c.approvedRound[msg.sender] != c.round, "KeyManager: Already approved");

        c.approvedRound[msg.sender] = c.round;
        c.approvalCount++;
    }

    /**
     * @dev Cancel the pending candidate for `_key`: the identity owner, a
     *      MANAGEMENT key, or the agent that opened that candidate. Other
     *      candidates are untouched.
     */
    function cancelKeyRecovery(address _identity, bytes32 _key) external {
        KeyRecovery storage recovery = _recoveries[_identity];
        RecoveryCandidate storage c = _candidates[_identity][recovery.epoch][_key];
        require(c.initiatedAt > 0 && !recovery.completed, "KeyManager: Recovery not initiated");
        require(
            msg.sender == c.initiator ||
                IOnchainID(_identity).keyHasPurpose(keccak256(abi.encodePacked(msg.sender)), 1) ||
                msg.sender == IManagedIdentity(_identity).owner(),
            "KeyManager: Not allowed to cancel recovery"
        );
        c.initiatedAt = 0;
        c.executionTime = 0;
        c.approvalCount = 0;
        c.initiator = address(0);
        emit KeyRecoveryCancelled(_identity, _key, msg.sender);
    }

    /**
     * @dev Execute the candidate for `_key` after its timelock with enough
     *      approvals: adds `_key` as MANAGEMENT and ends the epoch, so every
     *      other candidate dies. Recovery stays closed until the next setup.
     * @param _identity The OnchainID contract address
     * @param _key The recovery key to add
     */
    function executeKeyRecovery(address _identity, bytes32 _key) external nonReentrant {
        KeyRecovery storage recovery = _recoveries[_identity];
        require(!recovery.completed, "KeyManager: Recovery already completed");
        RecoveryCandidate storage c = _candidates[_identity][recovery.epoch][_key];
        require(c.initiatedAt > 0, "KeyManager: Recovery not initiated");
        _checkWindow(c.executionTime);
        _checkAuthorized(_identity);
        // Exact: agents are distinct and fixed within an epoch.
        require(c.approvalCount >= recovery.threshold, "KeyManager: Insufficient approvals");

        recovery.completed = true;
        recovery.lastKey = _key;
        recovery.epoch++;

        require(IOnchainID(_identity).addKey(_key, 1, 1), "KeyManager: Failed to add recovery key");

        emit KeyRecoveryCompleted(_identity, _key);
    }

    function _isRecoveryAgent(KeyRecovery storage recovery, address who) private view returns (bool) {
        for (uint256 i = 0; i < recovery.recoveryAgents.length; i++) {
            if (recovery.recoveryAgents[i] == who) return true;
        }
        return false;
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

    /**
     * @dev Key recovery details. approvalCount describes `lastKey`: the last
     *      candidate opened in this epoch, or, once completed, the key
     *      recovered. Per-candidate data: getRecoveryCandidate.
     * @param _identity The OnchainID contract address
     * @return recoveryAgents Array of recovery agent addresses
     * @return threshold Required approval threshold
     * @return approvalCount Approvals of the last candidate
     * @return completed Whether a recovery executed since the last setup
     * @return epoch Current epoch (bumped by setup and execute)
     * @return lastKey Last candidate opened, or the key recovered
     */
    function getKeyRecovery(
        address _identity
    )
        external
        view
        returns (
            address[] memory recoveryAgents,
            uint256 threshold,
            uint256 approvalCount,
            bool completed,
            uint256 epoch,
            bytes32 lastKey
        )
    {
        KeyRecovery storage recovery = _recoveries[_identity];
        return (
            recovery.recoveryAgents,
            recovery.threshold,
            _lastCandidate(_identity).approvalCount,
            recovery.completed,
            recovery.epoch,
            recovery.lastKey
        );
    }

    /**
     * @dev Same outputs as the former public `keyRecoveries` getter, with
     *      `epoch` appended. Candidate fields describe `lastKey`.
     */
    function keyRecoveries(
        address _identity
    )
        external
        view
        returns (
            bytes32 recoveryKey,
            uint256 threshold,
            uint256 initiatedAt,
            uint256 executionTime,
            bool completed,
            uint256 approvalCount,
            address initiator,
            uint256 epoch
        )
    {
        KeyRecovery storage recovery = _recoveries[_identity];
        RecoveryCandidate storage c = _lastCandidate(_identity);
        return (
            recovery.lastKey,
            recovery.threshold,
            c.initiatedAt,
            c.executionTime,
            recovery.completed,
            c.approvalCount,
            c.initiator,
            recovery.epoch
        );
    }

    /// @dev The pending candidate for `_key` in the current epoch.
    function getRecoveryCandidate(
        address _identity,
        bytes32 _key
    ) external view returns (uint256 initiatedAt, uint256 executionTime, uint256 approvalCount, address initiator) {
        RecoveryCandidate storage c = _candidates[_identity][_recoveries[_identity].epoch][_key];
        return (c.initiatedAt, c.executionTime, c.approvalCount, c.initiator);
    }

    /// @dev True if `_agent` approved the pending candidate for `_key`.
    function hasApprovedRecovery(address _identity, bytes32 _key, address _agent) external view returns (bool) {
        RecoveryCandidate storage c = _candidates[_identity][_recoveries[_identity].epoch][_key];
        return c.initiatedAt > 0 && c.approvedRound[_agent] == c.round;
    }

    /// @dev `lastKey`'s candidate; after execution, in the epoch it ran in.
    function _lastCandidate(address _identity) private view returns (RecoveryCandidate storage) {
        KeyRecovery storage recovery = _recoveries[_identity];
        uint256 epoch = recovery.completed ? recovery.epoch - 1 : recovery.epoch;
        return _candidates[_identity][epoch][recovery.lastKey];
    }
}
