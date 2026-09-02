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
    function verifyProof(
        uint[2] calldata,
        uint[2][2] calldata,
        uint[2] calldata,
        uint[1] calldata
    ) public pure returns (bool) {
        return true;
    }
}
