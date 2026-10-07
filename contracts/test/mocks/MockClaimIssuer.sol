// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

/**
 * @title MockClaimIssuer
 * @dev Test double for the verification cache (Task 4.9): answers
 *      hasValidClaim true for every (identity, topic) and claimValidTo
 *      with a value the test sets. With `noExpiryView` set, claimValidTo
 *      reverts, which IdentityRegistry sees exactly as a missing function
 *      (the staticcall fails): the walk verifies but is never cached.
 */
contract MockClaimIssuer {
    uint256 public validTo;
    bool public noExpiryView;

    error NoClaimValidTo();

    function setValidTo(uint256 _validTo) external {
        validTo = _validTo;
    }

    function setNoExpiryView(bool _noExpiryView) external {
        noExpiryView = _noExpiryView;
    }

    function hasValidClaim(address, uint256) external pure returns (bool) {
        return true;
    }

    function claimValidTo(address, uint256) external view returns (uint256) {
        if (noExpiryView) revert NoClaimValidTo();
        return validTo;
    }
}
