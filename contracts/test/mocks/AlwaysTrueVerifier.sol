// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title AlwaysTrueVerifier
 * @dev TEST ONLY — accepts every proof.
 *
 * Used by test/privacy/VerifierSwapRisk.test.ts to demonstrate that
 * ZKVerifierIntegrated.updateVerifier() lets the owner bypass ZK verification
 * entirely, even when the immutable `testingMode` flag is false.
 *
 * Never deploy this outside a test.
 */
contract AlwaysTrueVerifier {
    /// @dev PLONK whitelist shape (since Task 3.1).
    function verifyProof(
        uint256[24] calldata,
        uint256[3] calldata
    ) public pure returns (bool) {
        return true;
    }

    /// @dev PLONK blacklist shape (since Task 3.7).
    function verifyProof(
        uint256[24] calldata,
        uint256[4] calldata
    ) public pure returns (bool) {
        return true;
    }

    /// @dev PLONK jurisdiction and accreditation shape (since Task 3.10).
    function verifyProof(
        uint256[24] calldata,
        uint256[8] calldata
    ) public pure returns (bool) {
        return true;
    }

    /// @dev PLONK compliance-aggregation shape (since Task 3.10).
    function verifyProof(
        uint256[24] calldata,
        uint256[12] calldata
    ) public pure returns (bool) {
        return true;
    }
}
