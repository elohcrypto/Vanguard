// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./KeyManagerRecovery.sol";

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
abstract contract KeyManagerOwnerTransfer is KeyManagerRecovery {
    event RecoveryOwnerTransferProposed(address indexed identity, address indexed newOwner, bytes32 indexed recoveryKey);

    /**
     * @dev Propose `_newOwner` as the identity's owner: the wallet whose key
     *      the executed recovery added, OWNER_TRANSFER_TIMELOCK after the
     *      approval and within EXECUTION_WINDOW. The identity asks back
     *      (isRecoveryOwner) and sets it as pending owner; `_newOwner` then
     *      calls acceptOwnership itself. Repeatable in the window until it
     *      has accepted.
     */
    function executeOwnerTransfer(address _identity, address _newOwner) external nonReentrant {
        KeyRecovery storage recovery = _recoveries[_identity];
        require(recovery.completed && recovery.approvedKey != bytes32(0), "KeyManager: no executed recovery");
        require(
            keccak256(abi.encodePacked(_newOwner)) == recovery.approvedKey,
            "KeyManager: not the recovered wallet"
        );
        _checkWindow(recovery.approvedAt + OWNER_TRANSFER_TIMELOCK);
        require(IManagedIdentity(_identity).owner() != _newOwner, "KeyManager: already the owner");
        _checkAuthorized(_identity);
        IRecoverableIdentity(_identity).transferOwnershipByRecovery(_newOwner);
        emit RecoveryOwnerTransferProposed(_identity, _newOwner, recovery.approvedKey);
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
