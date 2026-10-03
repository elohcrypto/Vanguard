// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title IZKVerifier
 * @dev The ZKVerifierIntegrated entries PrivacyManager consumes. Every
 *      circuit is PLONK (24-word proof); the Groth16 Proof/VerifyingKey ABI
 *      that nothing implemented was removed in Task 3.7b.
 */
interface IZKVerifier {
    /**
     * @dev Verify an attestation proof routed by circuit id (Task 3.7b):
     *      jurisdiction and accreditation [nullifier, Ax, Ay, policy,
     *      walletBinding], compliance aggregation [nullifier, Ax, Ay, minimum,
     *      wK, wA, wJ, wAcc, walletBinding]. Returns false on a bad proof or
     *      any signal >= the BN254 scalar field order; reverts on a wrong
     *      signal count, an unknown id, and the whitelist/blacklist ids
     *      ("use verifyWhitelistMembership" / "use verifyBlacklistNonMembership").
     * @param circuitId Identifier for the circuit
     * @param proof 24-word PLONK proof
     * @param signals Public signals, in snarkjs order
     * @return True if the proof is valid
     */
    function verifyCircuitProof(
        bytes32 circuitId,
        uint256[24] calldata proof,
        uint256[] calldata signals
    ) external returns (bool);

    /**
     * @dev Verify a PLONK whitelist membership proof (the typed entry for
     *      the whitelist circuit). Returns false on a bad proof or on any
     *      signal >= the BN254 scalar field order; reverts only if the
     *      configured verifier itself reverts (the shipped one does not).
     * @param proof 24-word PLONK proof (snarkjs `plonk exportSolidityCallData`)
     * @param pubSignals [nullifier, merkleRoot, walletBinding]
     * @return True if the proof verifies against these public signals
     */
    function verifyWhitelistMembership(
        uint256[24] calldata proof,
        uint256[3] calldata pubSignals
    ) external returns (bool);

    /**
     * @dev Proof-cache key of a whitelist proof, bound to the current
     *      whitelist verifier instance (for clearExpiredProofs).
     */
    function whitelistProofCacheKey(
        uint256[24] calldata proof,
        uint256[3] calldata pubSignals
    ) external view returns (bytes32);

    /**
     * @dev Verify a PLONK blacklist non-membership proof: the wallet's holder
     *      owns a commitment in the whitelist root whose identity is not in
     *      the sanctions tree. A non-gating demonstration (D2): nothing on
     *      chain consumes the result. Returns false on a bad proof or on any
     *      signal >= the BN254 scalar field order.
     * @param proof 24-word PLONK proof (snarkjs `plonk exportSolidityCallData`)
     * @param pubSignals [nullifier, whitelistRoot, blacklistRoot, walletBinding]
     */
    function verifyBlacklistNonMembership(
        uint256[24] calldata proof,
        uint256[4] calldata pubSignals
    ) external returns (bool);

    /// @dev Proof-cache key of a blacklist proof, bound to the current
    ///      blacklist verifier instance (for clearExpiredProofs).
    function blacklistProofCacheKey(
        uint256[24] calldata proof,
        uint256[4] calldata pubSignals
    ) external view returns (bytes32);

    /// @dev True on a demo deployment whose verify functions do not check proofs.
    function testingMode() external view returns (bool);

    // Circuit constants
    function WHITELIST_MEMBERSHIP_CIRCUIT() external view returns (bytes32);

    function BLACKLIST_MEMBERSHIP_CIRCUIT() external view returns (bytes32);

    function JURISDICTION_PROOF_CIRCUIT() external view returns (bytes32);

    function ACCREDITATION_PROOF_CIRCUIT() external view returns (bytes32);

    function COMPLIANCE_AGGREGATION_CIRCUIT() external view returns (bytes32);

    /**
     * @dev Check if a circuit is registered
     * @param circuitId Circuit identifier
     * @return True if circuit is registered
     */
    function isCircuitRegistered(bytes32 circuitId) external view returns (bool);

}
