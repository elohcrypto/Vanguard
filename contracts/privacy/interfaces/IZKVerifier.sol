// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title IZKVerifier
 * @dev Interface for zero-knowledge proof verification
 */
interface IZKVerifier {
    struct Proof {
        uint256[2] a;
        uint256[2][2] b;
        uint256[2] c;
    }

    struct VerifyingKey {
        uint256[2] alpha;
        uint256[2][2] beta;
        uint256[2][2] gamma;
        uint256[2][2] delta;
        uint256[][] ic;
    }

    /**
     * @dev Verify a zero-knowledge proof
     * @param proof The proof to verify
     * @param publicInputs Public inputs for the proof
     * @return True if the proof is valid
     */
    function verifyProof(Proof memory proof, uint256[] memory publicInputs) external view returns (bool);

    /**
     * @dev Set the verifying key for a specific circuit
     * @param circuitId Identifier for the circuit
     * @param vk The verifying key
     */
    function setVerifyingKey(bytes32 circuitId, VerifyingKey memory vk) external;

    /**
     * @dev Get the verifying key for a specific circuit
     * @param circuitId Identifier for the circuit
     * @return The verifying key
     */
    function getVerifyingKey(bytes32 circuitId) external view returns (VerifyingKey memory);

    /**
     * @dev Verify a proof for a specific circuit. For the whitelist circuit
     *      `proof` is ignored and publicInputs carries [24 PLONK proof words,
     *      nullifier, merkleRoot, walletBinding]; Task 3.3 removes that route
     *      in favour of verifyWhitelistMembership.
     * @param circuitId Identifier for the circuit
     * @param proof The proof to verify
     * @param publicInputs Public inputs for the proof
     * @return True if the proof is valid
     */
    function verifyCircuitProof(
        bytes32 circuitId,
        Proof memory proof,
        uint256[] memory publicInputs
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

    // Events
    event ProofVerified(bytes32 indexed circuitId, address indexed verifier, bool result);
    event VerifyingKeyUpdated(bytes32 indexed circuitId, address indexed updater);
}
