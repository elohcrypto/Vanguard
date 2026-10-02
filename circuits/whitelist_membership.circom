pragma circom 2.0.0;

include "circomlib/circuits/poseidon.circom";
include "./merkletree.circom";

/**
 * @title WhitelistMembership
 * @dev Proves that the commitment Poseidon(identity, secret) is a leaf of the
 *      whitelist tree under the public `merkleRoot` (D30 a).
 *
 * The investor picks `secret` at onboarding and hands the operator only the
 * commitment; the operator publishes the tree of commitments. Without the
 * secrets the leaves cannot be recomputed from public identity data, so the
 * list stays confidential and cannot be enumerated, and nobody can say which
 * listed identity produced a given proof or whether a listed identity ever
 * proved. This is not prover anonymity: the prover's wallet is public by
 * ERC-3643 design (walletBinding below).
 *
 * Public signals, in snarkjs order (outputs first, then public inputs in
 * declaration order): [nullifier, merkleRoot, walletBinding].
 *
 *  - nullifier = Poseidon(secret, merkleRoot): the same for every wallet of
 *    one commitment under one root, so the consumer (PrivacyManager, Task 3.3)
 *    can allow one wallet per commitment per root (D29 a); the operator's
 *    one-commitment-per-identity rule (Task 3.5) makes that per identity.
 *  - walletBinding: the wallet the proof is for; the consumer requires it to
 *    equal msg.sender, which stops a copied proof being replayed by another
 *    wallet.
 *
 * There is no validity output: a non-member cannot produce a witness.
 */
template WhitelistMembership(levels) {
    // Private inputs
    signal input identity;
    signal input secret;
    signal input pathElements[levels];
    signal input pathIndices[levels];

    // Public inputs
    signal input merkleRoot;
    signal input walletBinding;

    // Public output
    signal output nullifier;

    component leafHasher = Poseidon(2);
    leafHasher.inputs[0] <== identity;
    leafHasher.inputs[1] <== secret;

    component inclusion = MerkleInclusion(levels);
    inclusion.leaf <== leafHasher.out;
    inclusion.root <== merkleRoot;
    for (var i = 0; i < levels; i++) {
        inclusion.pathElements[i] <== pathElements[i];
        inclusion.pathIndices[i] <== pathIndices[i];
    }

    component nullifierHasher = Poseidon(2);
    nullifierHasher.inputs[0] <== secret;
    nullifierHasher.inputs[1] <== merkleRoot;
    nullifier <== nullifierHasher.out;

    // walletBinding enters no other constraint; this quadratic one keeps it in
    // the constraint system so the proof is bound to its value.
    signal walletBindingSq;
    walletBindingSq <== walletBinding * walletBinding;
}

// 20 levels: up to 2^20 commitments.
component main {public [merkleRoot, walletBinding]} = WhitelistMembership(20);
