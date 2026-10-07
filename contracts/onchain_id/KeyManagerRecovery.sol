// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "./interfaces/IOnchainID.sol";

/// @dev The OnchainID surface KeyManager reads beyond IOnchainID.
interface IManagedIdentity {
    function authorizedManagers(address manager) external view returns (bool);
    function owner() external view returns (address);
}

/**
 * @title KeyManagerRecovery
 * @dev The recovery half of KeyManager (split by inheritance, plan Task
 *      4.8): recovery agents and threshold per identity, candidates with
 *      their own approvals and timelock, execution, and the per-identity
 *      gates both halves use (MANAGEMENT key, authorization, execution
 *      window). KeyManager is the only contract deployed.
 */
abstract contract KeyManagerRecovery is ReentrancyGuard {
    event KeyRecoveryInitiated(address indexed identity, bytes32 indexed recoveryKey, address initiator);
    event KeyRecoveryCompleted(address indexed identity, bytes32 indexed recoveryKey);
    event KeyRecoveryCancelled(address indexed identity, bytes32 indexed recoveryKey, address by);

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

    mapping(address => KeyRecovery) private _recoveries;
    mapping(address => mapping(uint256 => mapping(bytes32 => RecoveryCandidate))) private _candidates;

    uint256 public constant RECOVERY_TIMELOCK = 48 hours;
    uint256 public constant MAX_RECOVERY_AGENTS = 10;
    /// @dev An item runs only within this window after its executionTime.
    uint256 public constant EXECUTION_WINDOW = 7 days;

    /// @dev Sender holds a MANAGEMENT key on `_identity`, and `_identity`
    ///      authorized this contract as its manager.
    modifier onlyIdentityManager(address _identity) {
        _checkManager(_identity);
        _checkAuthorized(_identity);
        _;
    }

    function _checkAuthorized(address _identity) internal view {
        require(
            IManagedIdentity(_identity).authorizedManagers(address(this)),
            "KeyManager: Identity has not authorized KeyManager"
        );
    }

    /// @dev Refuses an item whose execution window has passed.
    function _checkWindow(uint256 executionTime) internal view {
        require(block.timestamp >= executionTime, "KeyManager: Timelock not expired");
        require(
            block.timestamp <= executionTime + EXECUTION_WINDOW,
            "KeyManager: execution window passed, re-initiate"
        );
    }

    function _checkManager(address _identity) internal view {
        bytes32 senderKey = keccak256(abi.encodePacked(msg.sender));
        require(IOnchainID(_identity).keyHasPurpose(senderKey, 1), "KeyManager: Not identity manager");
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
