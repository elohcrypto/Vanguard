// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title MockWhitelistBinder
 * @dev Test double for the one PrivacyManager view ComplianceRules reads
 *      (hasValidWhitelistProof), so a test can give a wallet a live proof
 *      binding without generating a PLONK proof (Task 4.10 tier tests).
 */
contract MockWhitelistBinder {
    mapping(address => bool) public bound;

    function setBound(address user, bool value) external {
        bound[user] = value;
    }

    function hasValidWhitelistProof(address user) external view returns (bool) {
        return bound[user];
    }
}
