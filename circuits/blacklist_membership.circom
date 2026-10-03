pragma circom 2.0.0;

include "circomlib/circuits/poseidon.circom";
include "circomlib/circuits/smt/smtverifier.circom";
include "./merkletree.circom";

/**
 * @title BlacklistNonMembership
 * @dev The wallet's holder owns a commitment in the current whitelist root
 *      whose identity is not in the sanctions tree; nothing on chain gates on
 *      it (D2).
 *
 * Statement, every part a hard constraint (no validity output; a witness
 * exists only when all of it holds):
 *  1. commitment = Poseidon(identity, secret) is a leaf of the whitelist tree
 *     under the public `whitelistRoot` (MerkleInclusion, binary path bits).
 *     This ties `identity` to an onboarded commitment: a prover cannot pick an
 *     arbitrary unlisted value as its identity.
 *  2. `identity` is NOT a key of the sanctions sparse Merkle tree under the
 *     public `blacklistRoot` (circomlib SMTVerifier, fnc = 1 non-inclusion,
 *     enabled = 1, value = 0). The operator keys that tree by the same
 *     identity field element the whitelist commitment hides.
 *  3. nullifier = Poseidon(secret, blacklistRoot): one value per commitment
 *     per sanctions-tree version, unlinkable to the whitelist nullifier
 *     Poseidon(secret, whitelistRoot).
 *  4. walletBinding is kept in the constraint system (walletBindingSq) so the
 *     proof is bound to the wallet it names.
 *
 * Public signals, in snarkjs order (outputs first, then public inputs in
 * declaration order): [nullifier, whitelistRoot, blacklistRoot, walletBinding].
 *
 * The sanctions list itself stays explicit and immediate (D2): this proof is a
 * privacy demonstration and never the transfer gate.
 */
template BlacklistNonMembership(levels, smtLevels) {
    // Private inputs
    signal input identity;
    signal input secret;
    signal input pathElements[levels];
    signal input pathIndices[levels];
    signal input siblings[smtLevels];
    signal input oldKey;
    signal input oldValue;
    signal input isOld0;

    // Public inputs
    signal input whitelistRoot;
    signal input blacklistRoot;
    signal input walletBinding;

    // Public output
    signal output nullifier;

    // 1. The commitment is in the whitelist.
    component leafHasher = Poseidon(2);
    leafHasher.inputs[0] <== identity;
    leafHasher.inputs[1] <== secret;

    component inclusion = MerkleInclusion(levels);
    inclusion.leaf <== leafHasher.out;
    inclusion.root <== whitelistRoot;
    for (var i = 0; i < levels; i++) {
        inclusion.pathElements[i] <== pathElements[i];
        inclusion.pathIndices[i] <== pathIndices[i];
    }

    // 2. The identity is not a key of the sanctions tree. enabled and fnc
    //    are constants, so the check cannot be switched off or turned into an
    //    inclusion proof by the prover. isOld0 must be binary: the verifier's
    //    state machine assumes it.
    isOld0 * (1 - isOld0) === 0;

    component nonInclusion = SMTVerifier(smtLevels);
    nonInclusion.enabled <== 1;
    nonInclusion.fnc <== 1;
    nonInclusion.root <== blacklistRoot;
    for (var j = 0; j < smtLevels; j++) {
        nonInclusion.siblings[j] <== siblings[j];
    }
    nonInclusion.oldKey <== oldKey;
    nonInclusion.oldValue <== oldValue;
    nonInclusion.isOld0 <== isOld0;
    nonInclusion.key <== identity;
    nonInclusion.value <== 0;

    // 3. Nullifier bound to the commitment's secret and the sanctions root.
    component nullifierHasher = Poseidon(2);
    nullifierHasher.inputs[0] <== secret;
    nullifierHasher.inputs[1] <== blacklistRoot;
    nullifier <== nullifierHasher.out;

    // 4. walletBinding enters no other constraint; this quadratic one keeps it
    //    in the constraint system so the proof is bound to its value.
    signal walletBindingSq;
    walletBindingSq <== walletBinding * walletBinding;
}

// 20 whitelist levels (2^20 commitments); 20 sanctions-tree levels.
component main {public [whitelistRoot, blacklistRoot, walletBinding]} = BlacklistNonMembership(20, 20);
