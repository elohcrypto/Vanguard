// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @dev The identity surface the attack drives (Task 4.11 review, H-1).
interface IAttackedIdentity {
    function evictManagementKeys(bytes32 keep, uint256 max) external returns (bytes32[] memory);
    function transferOwnershipByRecovery(address newOwner) external;
}

/**
 * @title EvilRecoveryManager
 * @dev Test-only. A manager a thief authorizes with a stolen owner key: it
 *      answers every recovery question in the thief's favour and tries the
 *      identity's recovery hooks. Tests prove the identity ignores it.
 */
contract EvilRecoveryManager {
    function recoveryLocked(address) external pure returns (bool) {
        return true;
    }

    function isRecoveryOwner(address, address) external pure returns (bool) {
        return true;
    }

    function evict(address identity, bytes32 keep) external {
        IAttackedIdentity(identity).evictManagementKeys(keep, 100);
    }

    function propose(address identity, address newOwner) external {
        IAttackedIdentity(identity).transferOwnershipByRecovery(newOwner);
    }
}
