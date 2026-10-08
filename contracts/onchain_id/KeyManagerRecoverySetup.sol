// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {KeyManagerRecovery, IManagedIdentity} from "./KeyManagerRecovery.sol";

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
        require(_threshold > 0 && _threshold <= _recoveryAgents.length, "KeyManager: Invalid threshold");
        // A duplicate would let one agent count twice (2F.2 review, F3).
        for (uint256 i = 0; i < _recoveryAgents.length; i++) {
            for (uint256 j = i + 1; j < _recoveryAgents.length; j++) {
                require(_recoveryAgents[i] != _recoveryAgents[j], "KeyManager: Duplicate agent");
            }
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
        emit KeyRecoverySetupPending(_identity, _recoveryAgents.length, _threshold, p.effectiveAt);
    }

    /// @dev Anyone applies a pending re-seat RECOVERY_TIMELOCK after it was
    ///      proposed, within EXECUTION_WINDOW, unless a recovery is approved.
    function applyKeyRecoverySetup(address _identity) external {
        PendingSetup storage p = _pendingSetups[_identity];
        if (p.effectiveAt == 0) revert NoPendingSetup();
        _checkWindow(p.effectiveAt);
        _checkPinned(_identity);
        if (recoveryLocked(_identity)) revert RecoveryLocked();
        address[] memory agents = p.agents;
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
