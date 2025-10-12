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
     * @dev Verify a proof for a specific circuit
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
