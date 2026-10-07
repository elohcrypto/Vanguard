// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

/**
 * @title MockClaimIssuerNoExpiry
 * @dev Test double: answers hasValidClaim true for every (identity, topic)
 *      and has no claimValidTo view, so IdentityRegistry can verify through
 *      it but must never cache that verification (Task 4.9).
 */
contract MockClaimIssuerNoExpiry {
    function hasValidClaim(address, uint256) external pure returns (bool) {
        return true;
    }
}

/**
 * @title MockClaimIssuerExpiry
 * @dev MockClaimIssuerNoExpiry plus a claimValidTo the test sets.
 */
contract MockClaimIssuerExpiry is MockClaimIssuerNoExpiry {
    uint256 public validTo;

    function setValidTo(uint256 _validTo) external {
        validTo = _validTo;
    }

    function claimValidTo(address, uint256) external view returns (uint256) {
        return validTo;
    }
}
