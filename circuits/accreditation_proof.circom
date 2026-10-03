pragma circom 2.0.0;

include "circomlib/circuits/bitify.circom";
include "circomlib/circuits/comparators.circom";
include "./attestation.circom";

/**
 * @title AccreditationProof
 * @dev A trusted issuer attested the investor's accreditation amount, and it
 *      meets the policy's minimum; the amount stays private (plan v2 Task
 *      3.7b, D31 a). The old self-attested "issuer signature" (a Poseidon hash
 *      over the issuer's PUBLIC key, computable by anyone) is gone.
 *
 * Statement, every part a hard constraint (no validity output):
 *  1. amount and minimumAccreditation are below 2^64.
 *  2. amount >= minimumAccreditation (PrivacyManager requires the public
 *     minimum to equal its owner-set policy).
 *  3. (R8x, R8y, S) is the issuer's EdDSA-Poseidon signature under the
 *     public (Ax, Ay) of M = Poseidon(2, chainId, verifierContext, identity,
 *     amount, salt); domain 2; chainId and verifierContext are public.
 *  4. nullifier = Poseidon(salt, minimumAccreditation).
 *  5. walletBinding is kept in the constraint system (walletBindingSq).
 *
 * Public signals, in snarkjs order: [nullifier, Ax, Ay, chainId,
 * verifierContext, minimumAccreditation, walletBinding].
 */
template AccreditationProof() {
    // Private inputs
    signal input identity;
    signal input amount;
    signal input salt;
    signal input R8x;
    signal input R8y;
    signal input S;

    // Public inputs
    signal input Ax;
    signal input Ay;
    signal input chainId;
    signal input verifierContext;
    signal input minimumAccreditation;
    signal input walletBinding;

    // Public output
    signal output nullifier;

    // 1. Range: GreaterEqThan(64) is only sound on values below 2^64.
    component amountBits = Num2Bits(64);
    amountBits.in <== amount;
    component minimumBits = Num2Bits(64);
    minimumBits.in <== minimumAccreditation;

    // 2. The amount meets the minimum.
    component meets = GreaterEqThan(64);
    meets.in[0] <== amount;
    meets.in[1] <== minimumAccreditation;
    meets.out === 1;

    // 3. Issuer signature over the attestation.
    component attestation = AttestationSignature(1);
    attestation.domain <== 2;
    attestation.chainId <== chainId;
    attestation.verifierContext <== verifierContext;
    attestation.identity <== identity;
    attestation.attributes[0] <== amount;
    attestation.salt <== salt;
    attestation.Ax <== Ax;
    attestation.Ay <== Ay;
    attestation.R8x <== R8x;
    attestation.R8y <== R8y;
    attestation.S <== S;

    // 4. Nullifier bound to the attestation and the minimum.
    component nullifierHasher = AttestationNullifier();
    nullifierHasher.salt <== salt;
    nullifierHasher.policyHash <== minimumAccreditation;
    nullifier <== nullifierHasher.nullifier;

    // 5. walletBinding enters no other constraint; this quadratic one keeps it
    //    in the constraint system so the proof is bound to its value.
    signal walletBindingSq;
    walletBindingSq <== walletBinding * walletBinding;
}

component main {public [Ax, Ay, chainId, verifierContext, minimumAccreditation, walletBinding]} = AccreditationProof();
