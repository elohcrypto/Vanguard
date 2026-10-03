pragma circom 2.0.0;

include "circomlib/circuits/poseidon.circom";
include "circomlib/circuits/babyjub.circom";
include "circomlib/circuits/eddsaposeidon.circom";

/**
 * @title Attestation (shared by jurisdiction_proof, accreditation_proof and
 *        compliance_aggregation; plan v2 Task 3.7b, D31 a)
 * @dev A trusted issuer signs the investor's attribute message off chain with
 *      an EdDSA (Baby Jubjub, Poseidon) key; PrivacyManager holds the trusted
 *      issuer keys and the policy.
 *
 * AttestationSignature(n): the message is
 *     M = Poseidon(domain, chainId, verifierContext, identity,
 *                  attributes[0..n-1], salt)
 * and (R8x, R8y, S) must be a valid signature of M under the PUBLIC key
 * (Ax, Ay). chainId and verifierContext (the PrivacyManager address as a
 * field element) are public inputs PrivacyManager compares to block.chainid
 * and itself (Task 3.8 review M1): an attestation is valid for one chain and
 * one PrivacyManager only, so a second deployment trusting the same key,
 * whose jurisdiction bits may be assigned in another order, cannot accept
 * it. `domain` is a per-circuit constant, so an attestation signed for
 * one circuit never verifies in another (an accreditation amount of 4 must
 * not pass as the jurisdiction mask 4 when one issuer key is trusted for
 * both). enabled is the constant 1: the check cannot be switched off. R8 is
 * checked on the curve (circomlib's verifier does not); the subgroup bound on
 * S and A != 0 come from EdDSAPoseidonVerifier.
 *
 * AttestationNullifier: Poseidon(salt, policyHash). The salt is fresh per
 * attestation, so one attestation binds one wallet per policy; a policy
 * change gives a new nullifier (re-admission), like a whitelist root rotation.
 */
template AttestationSignature(n) {
    signal input domain;
    signal input chainId;
    signal input verifierContext;
    signal input identity;
    signal input attributes[n];
    signal input salt;
    signal input Ax;
    signal input Ay;
    signal input R8x;
    signal input R8y;
    signal input S;

    component message = Poseidon(n + 5);
    message.inputs[0] <== domain;
    message.inputs[1] <== chainId;
    message.inputs[2] <== verifierContext;
    message.inputs[3] <== identity;
    for (var i = 0; i < n; i++) {
        message.inputs[4 + i] <== attributes[i];
    }
    message.inputs[n + 4] <== salt;

    component r8OnCurve = BabyCheck();
    r8OnCurve.x <== R8x;
    r8OnCurve.y <== R8y;

    component sig = EdDSAPoseidonVerifier();
    sig.enabled <== 1;
    sig.Ax <== Ax;
    sig.Ay <== Ay;
    sig.S <== S;
    sig.R8x <== R8x;
    sig.R8y <== R8y;
    sig.M <== message.out;
}

template AttestationNullifier() {
    signal input salt;
    signal input policyHash;
    signal output nullifier;

    component h = Poseidon(2);
    h.inputs[0] <== salt;
    h.inputs[1] <== policyHash;
    nullifier <== h.out;
}
