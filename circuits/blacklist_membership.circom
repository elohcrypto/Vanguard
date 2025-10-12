pragma circom 2.0.0;

include "circomlib/circuits/poseidon.circom";
include "circomlib/circuits/merkletree.circom";
include "circomlib/circuits/comparators.circom";
include "circomlib/circuits/gates.circom";

/**
 * @title BlacklistMembership
 * @dev Zero-knowledge proof circuit for blacklist membership verification
 * @notice Proves that a user is NOT in a blacklist without revealing their identity
 * @dev This is the inverse of whitelist - proves NON-membership for privacy
 */
template BlacklistMembership(levels) {
    // Private inputs (secret)
    signal input identity;                   // User's secret identity
    signal input pathElements[levels];       // Merkle path elements (for non-membership proof)
    signal input pathIndices[levels];        // Merkle path indices
    signal input siblingHash;                // Hash of sibling node to prove non-inclusion

    // Public inputs
    signal input blacklistRoot;              // Public merkle root of blacklist
    signal input nullifierHash;             // Prevents double-spending/reuse
    signal input challengeHash;              // Challenge to prove non-membership

    // Outputs
    signal output isNotBlacklisted;          // 1 if user is NOT in blacklist, 0 if they are

    // Verify user identity hash
    component identityHasher = Poseidon(1);
    identityHasher.inputs[0] <== identity;

    // Create merkle proof for the position where user WOULD be
    component merkleProof = MerkleTreeChecker(levels);
    merkleProof.leaf <== siblingHash;  // Use sibling hash instead of user hash
    merkleProof.root <== blacklistRoot;

    for (var i = 0; i < levels; i++) {
        merkleProof.pathElements[i] <== pathElements[i];
        merkleProof.pathIndices[i] <== pathIndices[i];
    }

    // Verify that the sibling hash is NOT the user's hash
    component notEqual = IsEqual();
    notEqual.in[0] <== identityHasher.out;
    notEqual.in[1] <== siblingHash;
    
    // User is not blacklisted if sibling hash != user hash AND merkle proof is valid
    component not = NOT();
    not.in <== notEqual.out;
    
    component and = AND();
    and.a <== merkleProof.out;
    and.b <== not.out;

    // Generate nullifier to prevent reuse
    component nullifierHasher = Poseidon(3);
    nullifierHasher.inputs[0] <== identity;
    nullifierHasher.inputs[1] <== blacklistRoot;
    nullifierHasher.inputs[2] <== challengeHash;

    // Verify nullifier matches
    component nullifierCheck = IsEqual();
    nullifierCheck.in[0] <== nullifierHasher.out;
    nullifierCheck.in[1] <== nullifierHash;

    // Output is valid if user is not blacklisted and nullifier matches
    component finalAnd = AND();
    finalAnd.a <== and.out;
    finalAnd.b <== nullifierCheck.out;

    isNotBlacklisted <== finalAnd.out;
}

// Instantiate with 20 levels (supports up to 2^20 = ~1M users)
component main = BlacklistMembership(20);
