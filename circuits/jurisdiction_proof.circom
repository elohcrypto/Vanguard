pragma circom 2.0.0;

include "circomlib/circuits/bitify.circom";
include "./attestation.circom";

/**
 * @title JurisdictionProof
 * @dev A trusted issuer attested the investor's jurisdiction, and that
 *      jurisdiction is in the policy's allowed set; the jurisdiction itself
 *      stays private (plan v2 Task 3.7b, D31 a).
 *
 * The attested attribute is the investor's jurisdiction BIT: the power of
 * two PrivacyManager.jurisdictionBit assigns to the ISO 3166-1 numeric code
 * (append-only; Task 3.8).
 *
 * Statement, every part a hard constraint (no validity output):
 *  1. userMask has exactly one bit set, within 64 bits.
 *  2. That bit is set in the public allowedMask (64 bits): PrivacyManager
 *     requires allowedMask == the OR of the bits of the registered codes
 *     ComplianceRules allows for its policy token.
 *  3. (R8x, R8y, S) is the issuer's EdDSA-Poseidon signature under the
 *     public (Ax, Ay) of M = Poseidon(1, chainId, verifierContext, validUntil,
 *     identity, userMask, salt); domain 1; chainId, verifierContext and
 *     validUntil are public (PrivacyManager refuses the proof from
 *     validUntil on and caps the record's expiresAt at it).
 *  4. nullifier = Poseidon(salt, allowedMask).
 *  5. walletBinding is kept in the constraint system (walletBindingSq).
 *
 * Public signals, in snarkjs order (outputs first, then public inputs in
 * declaration order): [nullifier, Ax, Ay, chainId, verifierContext,
 * validUntil, allowedMask, walletBinding].
 */
template JurisdictionProof() {
    // Private inputs
    signal input identity;
    signal input userMask;
    signal input salt;
    signal input R8x;
    signal input R8y;
    signal input S;

    // Public inputs
    signal input Ax;
    signal input Ay;
    signal input chainId;
    signal input verifierContext;
    signal input validUntil;
    signal input allowedMask;
    signal input walletBinding;

    // Public output
    signal output nullifier;

    // 1 and 2. One bit, and that bit is allowed.
    component userBits = Num2Bits(64);
    userBits.in <== userMask;
    component allowedBits = Num2Bits(64);
    allowedBits.in <== allowedMask;

    signal hit[64];
    var bitCount = 0;
    var hitCount = 0;
    for (var i = 0; i < 64; i++) {
        hit[i] <== userBits.out[i] * allowedBits.out[i];
        bitCount += userBits.out[i];
        hitCount += hit[i];
    }
    bitCount === 1;
    hitCount === 1;

    // 3. Issuer signature over the attestation.
    component attestation = AttestationSignature(1);
    attestation.domain <== 1;
    attestation.chainId <== chainId;
    attestation.verifierContext <== verifierContext;
    attestation.validUntil <== validUntil;
    attestation.identity <== identity;
    attestation.attributes[0] <== userMask;
    attestation.salt <== salt;
    attestation.Ax <== Ax;
    attestation.Ay <== Ay;
    attestation.R8x <== R8x;
    attestation.R8y <== R8y;
    attestation.S <== S;

    // 4. Nullifier bound to the attestation and the allowed set.
    component nullifierHasher = AttestationNullifier();
    nullifierHasher.salt <== salt;
    nullifierHasher.policyHash <== allowedMask;
    nullifier <== nullifierHasher.nullifier;

    // 5. walletBinding enters no other constraint; this quadratic one keeps it
    //    in the constraint system so the proof is bound to its value.
    signal walletBindingSq;
    walletBindingSq <== walletBinding * walletBinding;
}

component main {public [Ax, Ay, chainId, verifierContext, validUntil, allowedMask, walletBinding]} = JurisdictionProof();
