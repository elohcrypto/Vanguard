pragma circom 2.0.0;

include "circomlib/circuits/poseidon.circom";
include "./merkletree.circom";

/**
 * @title WhitelistMembership
 * @dev Proves that Poseidon(identity) is a leaf of the whitelist tree under
 *      the public `merkleRoot`, without revealing the identity.
 *
 * Public signals, in snarkjs order (outputs first, then public inputs in
 * declaration order): [nullifier, merkleRoot, walletBinding].
 *
 *  - nullifier = Poseidon(identity, merkleRoot): the same for every wallet of
 *    one identity under one root, so the consumer (PrivacyManager, Task 3.3)
 *    can allow one wallet per identity per root (D29 a).
 *  - walletBinding: the wallet the proof is for; the consumer requires it to
 *    equal msg.sender, which stops a copied proof being replayed by another
 *    wallet.
 *
 * There is no validity output: a non-member cannot produce a witness.
 */
template WhitelistMembership(levels) {
    // Private inputs
    signal input identity;
    signal input pathElements[levels];
    signal input pathIndices[levels];

    // Public inputs
    signal input merkleRoot;
    signal input walletBinding;

    // Public output
    signal output nullifier;

    component leafHasher = Poseidon(1);
    leafHasher.inputs[0] <== identity;

    component inclusion = MerkleInclusion(levels);
    inclusion.leaf <== leafHasher.out;
    inclusion.root <== merkleRoot;
    for (var i = 0; i < levels; i++) {
        inclusion.pathElements[i] <== pathElements[i];
        inclusion.pathIndices[i] <== pathIndices[i];
    }

    component nullifierHasher = Poseidon(2);
    nullifierHasher.inputs[0] <== identity;
    nullifierHasher.inputs[1] <== merkleRoot;
    nullifier <== nullifierHasher.out;

    // walletBinding enters no other constraint; this quadratic one keeps it in
    // the constraint system so the proof is bound to its value.
    signal walletBindingSq;
    walletBindingSq <== walletBinding * walletBinding;
}

// 20 levels: up to 2^20 identities.
component main {public [merkleRoot, walletBinding]} = WhitelistMembership(20);
