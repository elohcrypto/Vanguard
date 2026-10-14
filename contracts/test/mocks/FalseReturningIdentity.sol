// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title FalseReturningIdentity
 * @dev Test-only identity (Task 5.3 fix round, M-1): any caller may point
 *      KeyManager at an identity contract of its own. This one answers
 *      every view KeyManager checks first (keyHasPurpose,
 *      authorizedManagers) with true, and returns false from addKey and
 *      from removeKey (unless `removeOk`), so KeyManager's "Failed to ..."
 *      requires are reachable.
 */
contract FalseReturningIdentity {
    bool public removeOk;

    function setRemoveOk(bool ok) external {
        removeOk = ok;
    }

    function keyHasPurpose(bytes32, uint256) external pure returns (bool) {
        return true;
    }

    function authorizedManagers(address) external pure returns (bool) {
        return true;
    }

    function addKey(bytes32, uint256, uint256) external pure returns (bool) {
        return false;
    }

    function removeKey(bytes32, uint256) external view returns (bool) {
        return removeOk;
    }
}
