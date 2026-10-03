pragma circom 2.0.0;

include "circomlib/circuits/poseidon.circom";
include "circomlib/circuits/switcher.circom";

/**
 * @title MerkleInclusion
 * @dev Hard Merkle inclusion: the witness only exists when `leaf` sits in the
 *      tree under `root`. There is no output to ignore: a wrong path makes
 *      the constraint system unsatisfiable. Off-chain builders must hash
 *      pairs with the same Poseidon(2) (utils/merkle-tree-builder.js).
 *
 *      Each pathIndices[i] is constrained to {0,1}. circomlib's Switcher
 *      assumes a binary selector and is linear in it, so without this a
 *      prover picks a fractional selector and a crafted sibling that steer
 *      the hasher inputs to the real children of the published root, proving
 *      inclusion of a leaf that is not in the tree.
 *
 *      Used by the whitelist and the blacklist circuits. The soft
 *      MerkleTreeChecker (IsEqual output, unconstrained direction bits) was
 *      deleted in Task 3.7 (R-3R-1).
 */
template MerkleInclusion(levels) {
    signal input leaf;
    signal input root;
    signal input pathElements[levels];
    signal input pathIndices[levels];

    signal hashes[levels + 1];
    hashes[0] <== leaf;

    component hashers[levels];
    component switchers[levels];

    for (var i = 0; i < levels; i++) {
        // Direction bit must be 0 (current node left) or 1 (current node right).
        pathIndices[i] * (1 - pathIndices[i]) === 0;

        switchers[i] = Switcher();
        switchers[i].sel <== pathIndices[i];
        switchers[i].L <== hashes[i];
        switchers[i].R <== pathElements[i];

        hashers[i] = Poseidon(2);
        hashers[i].inputs[0] <== switchers[i].outL;
        hashers[i].inputs[1] <== switchers[i].outR;

        hashes[i + 1] <== hashers[i].out;
    }

    hashes[levels] === root;
}
