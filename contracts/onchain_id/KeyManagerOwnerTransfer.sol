// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IManagedIdentity, IOnchainID} from "./KeyManagerRecovery.sol";
import {KeyManagerRecoverySetup} from "./KeyManagerRecoverySetup.sol";

/// @dev The identity's ownership hook (OnchainIDOwnership, Task 4.11).
interface IRecoverableIdentity {
    function transferOwnershipByRecovery(address newOwner) external;
}

/**
 * @title KeyManagerOwnerTransfer
 * @dev The owner-transfer step of KeyManager recovery (D38 = c, Task 4.11;
 *      split by inheritance for size): OWNER_TRANSFER_TIMELOCK after an
 *      executed recovery's approval, the recovered wallet is proposed as the
 *      identity's owner through the identity's hook, which asks this
 *      contract back (isRecoveryOwner). KeyManager is the only contract
 *      deployed; see KeyManagerRecovery for the rules and the trust rule.
 */
abstract contract KeyManagerOwnerTransfer is KeyManagerRecoverySetup {
    event RecoveryOwnerTransferProposed(address indexed identity, address indexed newOwner, bytes32 indexed recoveryKey);

    /// @dev No executed recovery for this identity (or a new setup since).
    error NoExecutedRecovery();
    /// @dev `newOwner` is not the wallet whose key was recovered.
    error NotRecoveredWallet();
    error AlreadyOwner();
    /// @dev The recovery's lock has ended (owner moved or window passed).
    error RecoveryNotLocked();
    /// @dev Other MANAGEMENT keys remain: call continueKeyEviction first.
    error EvictionIncomplete();

    /**
     * @dev Propose `_newOwner` as the identity's owner: the wallet whose key
     *      the executed recovery added, OWNER_TRANSFER_TIMELOCK after the
     *      approval and within EXECUTION_WINDOW. The identity asks back
     *      (isRecoveryOwner) and sets it as pending owner; `_newOwner` then
     *      calls acceptOwnership itself. Repeatable in the window until it
     *      has accepted. Restores the recovered key first if it was removed
     *      and refuses while other MANAGEMENT keys remain.
     */
    function executeOwnerTransfer(address _identity, address _newOwner) external nonReentrant {
        KeyRecovery storage recovery = _recoveries[_identity];
        if (!recovery.completed || recovery.approvedKey == bytes32(0)) revert NoExecutedRecovery();
        if (keccak256(abi.encodePacked(_newOwner)) != recovery.approvedKey) revert NotRecoveredWallet();
        _checkWindow(recovery.approvedAt + OWNER_TRANSFER_TIMELOCK);
        if (IManagedIdentity(_identity).owner() == _newOwner) revert AlreadyOwner();
        _checkPinned(_identity);
        // Restores the recovered key if the old owner removed it and evicts
        // what is left; the transfer needs it to be the only MANAGEMENT key.
        _evictBatch(IManagedIdentity(_identity), _identity, recovery.approvedKey);
        if (IOnchainID(_identity).getKeysByPurpose(1).length != 1) revert EvictionIncomplete();
        IRecoverableIdentity(_identity).transferOwnershipByRecovery(_newOwner);
        emit RecoveryOwnerTransferProposed(_identity, _newOwner, recovery.approvedKey);
    }

    /**
     * @dev Evict the next MAX_EVICTIONS_PER_CALL MANAGEMENT keys left by
     *      an executed recovery (a list too long for one call). Anyone may
     *      call while the identity is still locked by that recovery;
     *      MANAGEMENT additions are frozen meanwhile.
     */
    function continueKeyEviction(address _identity) external nonReentrant {
        KeyRecovery storage recovery = _recoveries[_identity];
        if (!recovery.completed || recovery.approvedKey == bytes32(0)) revert NoExecutedRecovery();
        if (!recoveryLocked(_identity)) revert RecoveryNotLocked();
        _checkPinned(_identity);
        _evictBatch(IManagedIdentity(_identity), _identity, recovery.approvedKey);
    }

    /// @dev True while the identity's owner transfer to `_newOwner` is due:
    ///      the hook OnchainIDOwnership.transferOwnershipByRecovery asks it.
    function isRecoveryOwner(address _identity, address _newOwner) external view returns (bool) {
        KeyRecovery storage recovery = _recoveries[_identity];
        uint256 due = recovery.approvedAt + OWNER_TRANSFER_TIMELOCK;
        return
            recovery.completed &&
            recovery.approvedKey != bytes32(0) &&
            keccak256(abi.encodePacked(_newOwner)) == recovery.approvedKey &&
            block.timestamp >= due &&
            block.timestamp <= due + EXECUTION_WINDOW &&
            IManagedIdentity(_identity).owner() != _newOwner;
    }

    /**
     * @dev The approved candidate: key, approval time, when execution and
     *      the owner transfer open, and whether the identity is locked.
     */
    function getRecoveryApproval(
        address _identity
    )
        external
        view
        returns (bytes32 key, uint256 approvedAt, uint256 executionTime, uint256 ownerTransferTime, bool locked)
    {
        KeyRecovery storage recovery = _recoveries[_identity];
        if (recovery.approvedKey == bytes32(0)) return (bytes32(0), 0, 0, 0, false);
        return (
            recovery.approvedKey,
            recovery.approvedAt,
            recovery.approvedAt + RECOVERY_TIMELOCK,
            recovery.approvedAt + OWNER_TRANSFER_TIMELOCK,
            recoveryLocked(_identity)
        );
    }
}
