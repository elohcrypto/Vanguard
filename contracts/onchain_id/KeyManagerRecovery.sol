// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "./interfaces/IOnchainID.sol";

/// @dev The OnchainID surface KeyManager reads beyond IOnchainID.
interface IManagedIdentity {
    function authorizedManagers(address manager) external view returns (bool);
    function owner() external view returns (address);
    function evictManagementKeys(bytes32 keep, uint256 max) external returns (bytes32[] memory evicted);
}

/**
 * @title KeyManagerRecovery
 * @dev The recovery half of KeyManager (split by inheritance, plan Task
 *      4.8): recovery agents and threshold per identity, candidates with
 *      their own approvals and timelock, execution, and the per-identity
 *      gates both halves use (MANAGEMENT key, authorization, execution
 *      window). KeyManager is the only contract deployed.
 *
 *      Recovery is the defence against a rogue MANAGEMENT key and a stolen
 *      owner key (D38 = c, Task 4.11):
 *      - the identity OWNER sets up the agents and threshold, never while
 *        a recovery is approved or its owner transfer is pending;
 *      - an agent opens a candidate; before the threshold of approvals is
 *        reached its initiator or the owner may cancel it; once reached
 *        (the APPROVAL) only the agents cancel it, by the same threshold;
 *      - RECOVERY_TIMELOCK after the approval, within EXECUTION_WINDOW,
 *        anyone executes: the recovered key is added and every other
 *        MANAGEMENT key on the identity is removed (ACTION, CLAIM and
 *        ENCRYPTION keys are untouched);
 *      - OWNER_TRANSFER_TIMELOCK after the approval, within
 *        EXECUTION_WINDOW, anyone proposes the recovered wallet (the
 *        address whose key was recovered) as the identity's owner; the
 *        wallet accepts it itself (Ownable2Step).
 *      From the approval until the owner moves (or the windows close) the
 *      identity refuses its owner's authorizeManager, deauthorizeManager
 *      and transferOwnership (recoveryLocked).
 *      Trust rule: agents at the threshold can take the identity (evict its
 *      keys, become its owner after OWNER_TRANSFER_TIMELOCK). Choose agents
 *      you would trust with the identity. The owner sees the approval on
 *      chain and has RECOVERY_TIMELOCK to move assets through the issuer's
 *      Token.recoveryAddress, which stays the asset-side bound.
 */
abstract contract KeyManagerRecovery is ReentrancyGuard {
    event KeyRecoveryInitiated(address indexed identity, bytes32 indexed recoveryKey, address initiator);
    event KeyRecoveryCompleted(address indexed identity, bytes32 indexed recoveryKey);
    event KeyRecoveryCancelled(address indexed identity, bytes32 indexed recoveryKey, address by);
    event KeyRecoverySetUp(address indexed identity, uint256 agents, uint256 threshold, uint256 epoch);
    /// @dev The threshold was reached: both timelocks run from here.
    event KeyRecoveryApproved(
        address indexed identity,
        bytes32 indexed recoveryKey,
        uint256 executionTime,
        uint256 ownerTransferTime
    );
    /// @dev An agent's vote to cancel the approved candidate.
    event KeyRecoveryCancelVote(address indexed identity, bytes32 indexed recoveryKey, address agent, uint256 votes);
    /// @dev A MANAGEMENT key removed by executeKeyRecovery.
    event KeyRecoveryKeyEvicted(address indexed identity, bytes32 indexed evictedKey, bytes32 indexed recoveryKey);

    /// @dev Setup is the identity owner's (Task 4.11).
    error NotIdentityOwner();
    /// @dev Setup while a recovery is approved or its owner transfer pends.
    error RecoveryLocked();
    /// @dev The candidate's window has passed: re-initiate it.
    error CandidateExpired();
    /// @dev Another candidate is approved; one at a time.
    error AnotherRecoveryApproved();
    /// @dev An approved candidate is cancelled by its agents only.
    error ApprovedRecoveryAgentsOnly();
    error AlreadyVotedToCancel();
    error EvictionFailed(bytes32 key);
    error IdentityNotAContract();

    /// @dev Per identity. Candidates live under (epoch, key); bumping the
    ///      epoch (setup, execute) drops every candidate at once.
    struct KeyRecovery {
        address[] recoveryAgents;
        uint256 threshold;
        uint256 epoch;
        bool completed;
        bytes32 lastKey; // last candidate opened, or the key recovered
        bytes32 approvedKey; // candidate that reached the threshold
        uint256 approvedAt; // when it did; both timelocks run from here
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
        uint256 cancelCount; // agents' votes to cancel once approved
        mapping(address => uint256) cancelledRound;
    }

    mapping(address => KeyRecovery) internal _recoveries;
    mapping(address => mapping(uint256 => mapping(bytes32 => RecoveryCandidate))) private _candidates;

    uint256 public constant RECOVERY_TIMELOCK = 48 hours;
    uint256 public constant MAX_RECOVERY_AGENTS = 10;
    /// @dev An item runs only within this window after its executionTime.
    uint256 public constant EXECUTION_WINDOW = 7 days;
    /// @dev From the approval to the owner transfer (D38 c).
    uint256 public constant OWNER_TRANSFER_TIMELOCK = 7 days;
    /// @dev MANAGEMENT keys evicted per call (~50k gas each): a bloated key
    ///      list is evicted over several calls (continueKeyEviction).
    uint256 public constant MAX_EVICTIONS_PER_CALL = 100;

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
     * @dev Set up key recovery: the identity OWNER only (a MANAGEMENT key
     *      could otherwise seat its own agents and, through them, take the
     *      identity). Refused while recoveryLocked: re-seating the agents
     *      must not kill an approved recovery. Clears every pending
     *      candidate and approval (new epoch) and re-opens recovery after a
     *      completed one.
     * @param _identity The OnchainID contract address
     * @param _recoveryAgents Distinct recovery agent addresses
     * @param _threshold Number of agents required for recovery
     */
    function setupKeyRecovery(address _identity, address[] calldata _recoveryAgents, uint256 _threshold) external {
        if (msg.sender != IManagedIdentity(_identity).owner()) revert NotIdentityOwner();
        _checkAuthorized(_identity);
        if (recoveryLocked(_identity)) revert RecoveryLocked();
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
        recovery.approvedKey = bytes32(0);
        recovery.approvedAt = 0;
        emit KeyRecoverySetUp(_identity, _recoveryAgents.length, _threshold, recovery.epoch);
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
        c.cancelCount = 0;
        c.initiatedAt = block.timestamp;
        c.executionTime = block.timestamp + RECOVERY_TIMELOCK;
        c.initiator = msg.sender;
        recovery.lastKey = _newRecoveryKey;

        emit KeyRecoveryInitiated(_identity, _newRecoveryKey, msg.sender);
    }

    /**
     * @dev Approve the pending candidate for `_key`, once per agent. The
     *      approval that reaches the threshold approves the candidate: its
     *      timelock restarts from now (RECOVERY_TIMELOCK to execution,
     *      OWNER_TRANSFER_TIMELOCK to the owner transfer). One candidate is
     *      approved at a time.
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
        if (block.timestamp > c.executionTime + EXECUTION_WINDOW) revert CandidateExpired();
        bool approved = _liveApproval(recovery);
        if (approved && recovery.approvedKey != _key) revert AnotherRecoveryApproved();

        c.approvedRound[msg.sender] = c.round;
        c.approvalCount++;
        if (!approved && c.approvalCount >= recovery.threshold) {
            recovery.approvedKey = _key;
            recovery.approvedAt = block.timestamp;
            c.executionTime = block.timestamp + RECOVERY_TIMELOCK;
            emit KeyRecoveryApproved(
                _identity,
                _key,
                c.executionTime,
                block.timestamp + OWNER_TRANSFER_TIMELOCK
            );
        }
    }

    /**
     * @dev Cancel the candidate for `_key`. Before its approval: the agent
     *      that opened it or the identity owner (a MANAGEMENT key no longer
     *      may: it is what recovery defends against). Once approved: only
     *      the agents, each voting once, cancelling at the threshold; the
     *      owner and MANAGEMENT keys are refused, so a stolen owner key or a
     *      rogue MANAGEMENT key cannot veto its own eviction. Other
     *      candidates are untouched.
     */
    function cancelKeyRecovery(address _identity, bytes32 _key) external {
        KeyRecovery storage recovery = _recoveries[_identity];
        RecoveryCandidate storage c = _candidates[_identity][recovery.epoch][_key];
        require(c.initiatedAt > 0 && !recovery.completed, "KeyManager: Recovery not initiated");
        if (_liveApproval(recovery) && recovery.approvedKey == _key) {
            if (!_isRecoveryAgent(recovery, msg.sender)) revert ApprovedRecoveryAgentsOnly();
            if (c.cancelledRound[msg.sender] == c.round) revert AlreadyVotedToCancel();
            c.cancelledRound[msg.sender] = c.round;
            c.cancelCount++;
            emit KeyRecoveryCancelVote(_identity, _key, msg.sender, c.cancelCount);
            if (c.cancelCount < recovery.threshold) return;
            recovery.approvedKey = bytes32(0);
            recovery.approvedAt = 0;
        } else {
            require(
                msg.sender == c.initiator || msg.sender == IManagedIdentity(_identity).owner(),
                "KeyManager: Not allowed to cancel recovery"
            );
        }
        c.initiatedAt = 0;
        c.executionTime = 0;
        c.approvalCount = 0;
        c.cancelCount = 0;
        c.initiator = address(0);
        emit KeyRecoveryCancelled(_identity, _key, msg.sender);
    }

    /**
     * @dev Execute the approved candidate for `_key`, RECOVERY_TIMELOCK
     *      after its approval and within EXECUTION_WINDOW: adds `_key` as
     *      MANAGEMENT (moving it from another purpose if it holds one),
     *      removes the other MANAGEMENT keys (the owner's included; owner()
     *      keeps its owner powers until the owner transfer), up to
     *      MAX_EVICTIONS_PER_CALL here and the rest through
     *      continueKeyEviction, and ends the epoch, so every other
     *      candidate dies. Recovery stays closed until the next setup.
     * @param _identity The OnchainID contract address
     * @param _key The recovery key to add
     */
    function executeKeyRecovery(address _identity, bytes32 _key) external nonReentrant {
        if (_identity.code.length == 0) revert IdentityNotAContract();
        KeyRecovery storage recovery = _recoveries[_identity];
        require(!recovery.completed, "KeyManager: Recovery already completed");
        RecoveryCandidate storage c = _candidates[_identity][recovery.epoch][_key];
        require(c.initiatedAt > 0, "KeyManager: Recovery not initiated");
        _checkWindow(c.executionTime);
        _checkAuthorized(_identity);
        // Exact: agents are distinct and fixed within an epoch.
        require(
            recovery.approvedKey == _key && c.approvalCount >= recovery.threshold,
            "KeyManager: Insufficient approvals"
        );

        recovery.completed = true;
        recovery.lastKey = _key;
        recovery.epoch++;

        _evictBatch(IManagedIdentity(_identity), _identity, _key);
        emit KeyRecoveryCompleted(_identity, _key);
    }

    /// @dev Makes `_keep` MANAGEMENT and evicts the next batch of others.
    function _evictBatch(IManagedIdentity id, address identityAddr, bytes32 _keep) internal {
        bytes32[] memory gone = id.evictManagementKeys(_keep, MAX_EVICTIONS_PER_CALL);
        for (uint256 i = 0; i < gone.length; i++) {
            emit KeyRecoveryKeyEvicted(identityAddr, gone[i], _keep);
        }
    }

    /**
     * @dev True from an approval until the recovered wallet owns the
     *      identity, or until the window that applies has passed (execution
     *      not run: RECOVERY_TIMELOCK + EXECUTION_WINDOW; owner not moved:
     *      OWNER_TRANSFER_TIMELOCK + EXECUTION_WINDOW). While true, setup is
     *      refused here and the identity refuses its owner's
     *      authorizeManager, deauthorizeManager and transferOwnership.
     */
    function recoveryLocked(address _identity) public view returns (bool) {
        KeyRecovery storage recovery = _recoveries[_identity];
        if (_liveApproval(recovery)) return true;
        return
            recovery.completed &&
            recovery.approvedKey != bytes32(0) &&
            block.timestamp <= recovery.approvedAt + OWNER_TRANSFER_TIMELOCK + EXECUTION_WINDOW &&
            keccak256(abi.encodePacked(IManagedIdentity(_identity).owner())) != recovery.approvedKey;
    }

    /// @dev An approved, not yet executed candidate whose window is open.
    function _liveApproval(KeyRecovery storage recovery) internal view returns (bool) {
        return
            recovery.approvedKey != bytes32(0) &&
            !recovery.completed &&
            block.timestamp <= recovery.approvedAt + RECOVERY_TIMELOCK + EXECUTION_WINDOW;
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
