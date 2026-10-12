// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {KeyManagerRecovery, IManagedIdentity, IOnchainID} from "./KeyManagerRecovery.sol";

/**
 * @title KeyManagerRecoverySetup
 * @dev Seating the recovery agents (Task 4.11, split by inheritance for
 *      size; KeyManager is the only contract deployed). The identity OWNER
 *      seats them, on an identity that pinned this KeyManager as its
 *      recovery manager. The first seating is immediate. Once agents are
 *      seated, a re-seat is PENDING for RECOVERY_TIMELOCK (R-411-16): the
 *      seated agents can veto it at their threshold, an approved recovery
 *      blocks it, and an executed recovery drops it. A thief holding the
 *      owner key therefore cannot replace the agents who would evict it.
 *      A re-seat applies only while its proposer still owns the identity
 *      (Task 4.14, M-B): an ordinary ownership transfer leaves it stale,
 *      refused at apply and droppable by anyone. Neither the owner nor a
 *      current MANAGEMENT key may be seated as an agent, at seating or at
 *      re-seat apply, and the owner may not open or approve a candidate
 *      (D53, R-414-10): a stolen owner key must not vote on its own
 *      eviction. A MANAGEMENT key is not refused at the vote: a rogue key
 *      could force one onto every agent (addKey needs no consent) and
 *      stall recovery, while holding one makes nobody an agent.
 */
abstract contract KeyManagerRecoverySetup is KeyManagerRecovery {
    event KeyRecoverySetupPending(
        address indexed identity,
        uint256 agents,
        uint256 threshold,
        uint256 effectiveAt
    );
    event KeyRecoverySetupVetoVote(address indexed identity, address agent, uint256 votes);
    event KeyRecoverySetupVetoed(address indexed identity);

    error NoPendingSetup();
    error AlreadyVetoed();
    /// @dev The pending re-seat's proposer no longer owns the identity.
    error StaleReseat();
    /// @dev The pending re-seat's proposer still owns the identity.
    error ReseatNotStale();
    /// @dev An agent that is the owner or holds a MANAGEMENT key (D53).
    error AgentControlsIdentity(address agent);

    /// @dev A stale re-seat was dropped (its proposer no longer owns).
    event KeyRecoverySetupDropped(address indexed identity);

    /**
     * @dev Seat (first time) or propose to re-seat the agents. Owner only;
     *      refused while recoveryLocked. A re-seat replaces any earlier
     *      pending one and restarts its timelock.
     * @param _identity The OnchainID contract address
     * @param _recoveryAgents Distinct recovery agent addresses
     * @param _threshold Number of agents required for recovery
     */
    function setupKeyRecovery(address _identity, address[] calldata _recoveryAgents, uint256 _threshold) external {
        if (msg.sender != IManagedIdentity(_identity).owner()) revert NotIdentityOwner();
        _checkPinned(_identity);
        if (recoveryLocked(_identity)) revert RecoveryLocked();
        require(_recoveryAgents.length > 0, "KeyManager: No recovery agents");
        require(_recoveryAgents.length <= MAX_RECOVERY_AGENTS, "KeyManager: Too many recovery agents");
        // D59 (a), Task 4.17: since D39 an agent's open is its approval, so
        // one agent key alone would move the identity; seats and re-seats
        // (both proposed here) need two.
        require(_threshold >= 2, "KeyManager: Threshold below 2");
        require(_threshold <= _recoveryAgents.length, "KeyManager: Invalid threshold");
        // A duplicate would let one agent count twice (2F.2 review, F3).
        for (uint256 i = 0; i < _recoveryAgents.length; i++) {
            for (uint256 j = i + 1; j < _recoveryAgents.length; j++) {
                require(_recoveryAgents[i] != _recoveryAgents[j], "KeyManager: Duplicate agent");
            }
            _checkNotController(_identity, _recoveryAgents[i]);
        }
        if (_recoveries[_identity].recoveryAgents.length == 0) {
            _seat(_identity, _recoveryAgents, _threshold);
            return;
        }
        PendingSetup storage p = _pendingSetups[_identity];
        _clearPendingSetup(p);
        p.agents = _recoveryAgents;
        p.threshold = _threshold;
        p.effectiveAt = block.timestamp + RECOVERY_TIMELOCK;
        p.proposer = msg.sender;
        emit KeyRecoverySetupPending(_identity, _recoveryAgents.length, _threshold, p.effectiveAt);
    }

    /// @dev D53: the owner and MANAGEMENT keys are what recovery evicts.
    function _checkNotController(address _identity, address _agent) private view {
        if (
            _agent == IManagedIdentity(_identity).owner() ||
            IOnchainID(_identity).keyHasPurpose(keccak256(abi.encodePacked(_agent)), 1)
        ) revert AgentControlsIdentity(_agent);
    }

    /// @dev R-414-10 (review M-R2-1): at a vote only the owner is refused.
    function _checkNotOwner(address _identity) internal view override {
        if (msg.sender == IManagedIdentity(_identity).owner()) revert AgentControlsIdentity(msg.sender);
    }

    /// @dev Anyone applies a pending re-seat RECOVERY_TIMELOCK after it was
    ///      proposed, within EXECUTION_WINDOW, unless a recovery is approved
    ///      or the identity changed hands since (StaleReseat, M-B).
    function applyKeyRecoverySetup(address _identity) external {
        PendingSetup storage p = _pendingSetups[_identity];
        if (p.effectiveAt == 0) revert NoPendingSetup();
        _checkWindow(p.effectiveAt);
        _checkPinned(_identity);
        if (recoveryLocked(_identity)) revert RecoveryLocked();
        if (p.proposer != IManagedIdentity(_identity).owner()) revert StaleReseat();
        address[] memory agents = p.agents;
        // An agent that gained control during the 48 hours is refused too.
        for (uint256 i = 0; i < agents.length; i++) _checkNotController(_identity, agents[i]);
        uint256 threshold = p.threshold;
        _clearPendingSetup(p);
        _seat(_identity, agents, threshold);
    }

    /// @dev A seated agent votes against the pending re-seat; at the seated
    ///      threshold it is dropped.
    function vetoKeyRecoverySetup(address _identity) external {
        PendingSetup storage p = _pendingSetups[_identity];
        if (p.effectiveAt == 0) revert NoPendingSetup();
        KeyRecovery storage recovery = _recoveries[_identity];
        require(_isRecoveryAgent(recovery, msg.sender), "KeyManager: Not a recovery agent");
        if (p.vetoedRound[msg.sender] == p.round) revert AlreadyVetoed();
        p.vetoedRound[msg.sender] = p.round;
        p.vetoes++;
        emit KeyRecoverySetupVetoVote(_identity, msg.sender, p.vetoes);
        if (p.vetoes < recovery.threshold) return;
        _clearPendingSetup(p);
        emit KeyRecoverySetupVetoed(_identity);
    }

    /// @dev Anyone drops a pending re-seat whose proposer no longer owns
    ///      the identity (an ordinary transfer happened since, M-B).
    function dropStaleRecoverySetup(address _identity) external {
        PendingSetup storage p = _pendingSetups[_identity];
        if (p.effectiveAt == 0) revert NoPendingSetup();
        if (p.proposer == IManagedIdentity(_identity).owner()) revert ReseatNotStale();
        _clearPendingSetup(p);
        emit KeyRecoverySetupDropped(_identity);
    }

    /// @dev The pending re-seat: agents, threshold, when it applies, vetoes.
    function getPendingRecoverySetup(
        address _identity
    ) external view returns (address[] memory agents, uint256 threshold, uint256 effectiveAt, uint256 vetoes) {
        PendingSetup storage p = _pendingSetups[_identity];
        return (p.agents, p.threshold, p.effectiveAt, p.vetoes);
    }

    /// @dev New epoch: clears every candidate and approval and re-opens
    ///      recovery after a completed one.
    function _seat(address _identity, address[] memory _agents, uint256 _threshold) private {
        KeyRecovery storage recovery = _recoveries[_identity];
        recovery.epoch++;
        recovery.recoveryAgents = _agents;
        recovery.threshold = _threshold;
        recovery.completed = false;
        recovery.lastKey = bytes32(0);
        recovery.approvedKey = bytes32(0);
        recovery.approvedAt = 0;
        emit KeyRecoverySetUp(_identity, _agents.length, _threshold, recovery.epoch);
    }
}
