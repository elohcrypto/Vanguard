pragma circom 2.0.0;

include "circomlib/circuits/bitify.circom";
include "circomlib/circuits/comparators.circom";
include "circomlib/circuits/poseidon.circom";
include "./attestation.circom";

/**
 * @title ComplianceAggregation
 * @dev A trusted issuer attested four compliance scores in one attestation,
 *      and their weighted sum meets the policy's minimum; the scores and the
 *      aggregate stay private (plan v2 Task 3.7b, D31 a). The old public
 *      complianceLevel output is gone: it disclosed what the proof hides.
 *
 * Statement, every part a hard constraint (no validity output):
 *  1. Each score is at most 100; each weight is below 2^7 and the four sum to
 *     exactly 100; minimum is below 2^7 (PrivacyManager's setter keeps it at
 *     most 100 and the weights summing to 100).
 *  2. kyc*wK + aml*wA + jur*wJ + acc*wAcc >= minimum * 100.
 *  3. (R8x, R8y, S) is the issuer's EdDSA-Poseidon signature under the
 *     public (Ax, Ay) of M = Poseidon(3, identity, kyc, aml, jur, acc, salt);
 *     domain 3.
 *  4. nullifier = Poseidon(salt, Poseidon(minimum, wK, wA, wJ, wAcc)).
 *  5. walletBinding is kept in the constraint system (walletBindingSq).
 *
 * Public signals, in snarkjs order: [nullifier, Ax, Ay, minimum, wK, wA, wJ,
 * wAcc, walletBinding].
 */
template ComplianceAggregation() {
    // Private inputs
    signal input identity;
    signal input scores[4]; // kyc, aml, jurisdiction, accreditation
    signal input salt;
    signal input R8x;
    signal input R8y;
    signal input S;

    // Public inputs
    signal input Ax;
    signal input Ay;
    signal input minimum;
    signal input weights[4]; // wK, wA, wJ, wAcc
    signal input walletBinding;

    // Public output
    signal output nullifier;

    // 1. Ranges. Num2Bits(7) bounds each value below 128 as an integer, so the
    //    comparisons below and the weight sum cannot wrap the field.
    component scoreBits[4];
    component scoreMax[4];
    component weightBits[4];
    signal weighted[4];
    var weightSum = 0;
    var weightedSum = 0;
    for (var i = 0; i < 4; i++) {
        scoreBits[i] = Num2Bits(7);
        scoreBits[i].in <== scores[i];
        scoreMax[i] = LessEqThan(7);
        scoreMax[i].in[0] <== scores[i];
        scoreMax[i].in[1] <== 100;
        scoreMax[i].out === 1;

        weightBits[i] = Num2Bits(7);
        weightBits[i].in <== weights[i];
        weightSum += weights[i];

        weighted[i] <== scores[i] * weights[i];
        weightedSum += weighted[i];
    }
    weightSum === 100;

    component minimumBits = Num2Bits(7);
    minimumBits.in <== minimum;

    // 2. The weighted sum (at most 10000) meets minimum * 100.
    component meets = GreaterEqThan(32);
    meets.in[0] <== weightedSum;
    meets.in[1] <== minimum * 100;
    meets.out === 1;

    // 3. Issuer signature over the attestation.
    component attestation = AttestationSignature(4);
    attestation.domain <== 3;
    attestation.identity <== identity;
    for (var j = 0; j < 4; j++) {
        attestation.attributes[j] <== scores[j];
    }
    attestation.salt <== salt;
    attestation.Ax <== Ax;
    attestation.Ay <== Ay;
    attestation.R8x <== R8x;
    attestation.R8y <== R8y;
    attestation.S <== S;

    // 4. Nullifier bound to the attestation and the whole policy.
    component policy = Poseidon(5);
    policy.inputs[0] <== minimum;
    for (var k = 0; k < 4; k++) {
        policy.inputs[1 + k] <== weights[k];
    }
    component nullifierHasher = AttestationNullifier();
    nullifierHasher.salt <== salt;
    nullifierHasher.policyHash <== policy.out;
    nullifier <== nullifierHasher.nullifier;

    // 5. walletBinding enters no other constraint; this quadratic one keeps it
    //    in the constraint system so the proof is bound to its value.
    signal walletBindingSq;
    walletBindingSq <== walletBinding * walletBinding;
}

component main {public [Ax, Ay, minimum, weights, walletBinding]} = ComplianceAggregation();
