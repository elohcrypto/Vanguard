pragma circom 2.0.0;

include "circomlib/circuits/poseidon.circom";
include "circomlib/circuits/switcher.circom";
include "circomlib/circuits/comparators.circom";

/**
 * @title MerkleTreeChecker
 * @dev Verifies a Merkle tree inclusion proof using Poseidon hash
 * @notice This component verifies that a leaf is included in a Merkle tree with a given root
 * 
 * @param levels - The depth of the Merkle tree
 * 
 * Inputs:
 *   - leaf: The leaf value to verify
 *   - root: The expected Merkle root
 *   - pathElements[levels]: The sibling hashes along the path from leaf to root
 *   - pathIndices[levels]: The direction bits (0 = left, 1 = right) for each level
 * 
 * Output:
 *   - out: 1 if the proof is valid (computed root matches provided root), 0 otherwise
 * 
 * Algorithm:
 *   1. Start with the leaf value
 *   2. For each level from bottom to top:
 *      a. Get the sibling hash from pathElements[i]
 *      b. Use pathIndices[i] to determine if current node is left (0) or right (1) child
 *      c. Hash the current node with its sibling in the correct order
 *      d. The result becomes the current node for the next level
 *   3. Compare the final computed root with the provided root
 * 
 * Hashing Scheme:
 *   - Uses Poseidon(2) for hashing pairs of nodes
 *   - This is the standard ZK-friendly hash function for Merkle trees
 *   - Off-chain Merkle tree builders must use the same Poseidon(2) hashing
 */
template MerkleTreeChecker(levels) {
    // Inputs
    signal input leaf;
    signal input root;
    signal input pathElements[levels];
    signal input pathIndices[levels];

    // Output
    signal output out;

    // Internal signals to track the hash at each level
    signal hashes[levels + 1];
    
    // Start with the leaf
    hashes[0] <== leaf;

    // Components for each level
    component hashers[levels];
    component switchers[levels];

    // Verify the Merkle proof level by level
    for (var i = 0; i < levels; i++) {
        // Switcher determines the order of inputs to the hasher
        // If pathIndices[i] == 0: current node is left child, sibling is right
        // If pathIndices[i] == 1: current node is right child, sibling is left
        switchers[i] = Switcher();
        switchers[i].sel <== pathIndices[i];
        switchers[i].L <== hashes[i];
        switchers[i].R <== pathElements[i];

        // Hash the pair using Poseidon
        hashers[i] = Poseidon(2);
        hashers[i].inputs[0] <== switchers[i].outL;
        hashers[i].inputs[1] <== switchers[i].outR;

        // Store the result for the next level
        hashes[i + 1] <== hashers[i].out;
    }

    // Verify that the computed root matches the provided root
    component rootCheck = IsEqual();
    rootCheck.in[0] <== hashes[levels];
    rootCheck.in[1] <== root;

    // Output 1 if roots match, 0 otherwise
    out <== rootCheck.out;
}

