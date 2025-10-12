pragma circom 2.0.0;

include "circomlib/circuits/poseidon.circom";
include "circomlib/circuits/merkletree.circom";
include "circomlib/circuits/comparators.circom";
include "circomlib/circuits/gates.circom";

/**
 * @title WhitelistMembership
 * @dev Zero-knowledge proof circuit for whitelist membership verification
 * @notice Proves that a user is in a whitelist without revealing their identity
 */
template WhitelistMembership(levels) {
    // Private inputs (secret)
    signal input identity;           // User's secret identity
    signal input pathElements[levels]; // Merkle path elements
    signal input pathIndices[levels];  // Merkle path indices

    // Public inputs
    signal input merkleRoot;                 // Public merkle root of whitelist
    signal input nullifierHash;             // Prevents double-spending/reuse

    // Outputs
    signal output isValid;                   // 1 if proof is valid, 0 otherwise

    // Components
    component hasher = Poseidon(1);
    component merkleProof = MerkleTreeChecker(levels);

    // Hash the identity to create leaf
    hasher.inputs[0] <== identity;

    // Verify merkle proof
    merkleProof.leaf <== hasher.out;
    merkleProof.root <== merkleRoot;

    for (var i = 0; i < levels; i++) {
        merkleProof.pathElements[i] <== pathElements[i];
        merkleProof.pathIndices[i] <== pathIndices[i];
    }

    // Generate nullifier to prevent reuse
    component nullifierHasher = Poseidon(2);
    nullifierHasher.inputs[0] <== identity;
    nullifierHasher.inputs[1] <== merkleRoot;

    // Verify nullifier matches
    component nullifierCheck = IsEqual();
    nullifierCheck.in[0] <== nullifierHasher.out;
    nullifierCheck.in[1] <== nullifierHash;

    // Output is valid if merkle proof is valid and nullifier matches
    component and = AND();
    and.a <== merkleProof.out;
    and.b <== nullifierCheck.out;

    isValid <== and.out;
}

// Instantiate with 20 levels (supports up to 2^20 = ~1M users)
component main = WhitelistMembership(20);