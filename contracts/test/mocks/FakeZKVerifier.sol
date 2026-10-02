// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title FakeZKVerifier
 * @dev Test only (review 3.3 MEDIUM-2): a wrapper look-alike that passes
 *      every self-reported check. testingMode() is false, owner() and
 *      pendingOwner() report `governance` and every whitelist proof
 *      verifies. Only its code hash gives it away.
 */
contract FakeZKVerifier {
    address public governance;

    function setGovernance(address g) external {
        governance = g;
    }

    function testingMode() external pure returns (bool) {
        return false;
    }

    function owner() external view returns (address) {
        return governance;
    }

    function pendingOwner() external view returns (address) {
        return governance;
    }

    function verifyWhitelistMembership(uint256[24] calldata, uint256[3] calldata) external pure returns (bool) {
        return true;
    }
}
