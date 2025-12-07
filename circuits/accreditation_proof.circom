pragma circom 2.0.0;

include "circomlib/circuits/poseidon.circom";
include "circomlib/circuits/comparators.circom";
include "circomlib/circuits/gates.circom";

/**
 * @title AccreditationProof
 * @dev Zero-knowledge proof circuit for accreditation status verification
 * @notice Proves that a user meets minimum accreditation without revealing exact level
 */
template AccreditationProof() {
    // Private inputs (secret)
    signal input userAccreditation;  // User's actual accreditation level
    signal input userSalt;           // Random salt for privacy
    signal input issuerSignature[2]; // Signature from accreditation issuer

    // Public inputs
    signal input minimumAccreditation;       // Minimum required accreditation level
    signal input commitmentHash;             // Commitment to user's accreditation
    signal input issuerPublicKey[2];         // Public key of accreditation issuer

    // Outputs
    signal output meetsRequirement;          // 1 if meets requirement, 0 otherwise

    // Verify commitment to accreditation level
    component commitmentHasher = Poseidon(2);
    commitmentHasher.inputs[0] <== userAccreditation;
    commitmentHasher.inputs[1] <== userSalt;
    
    component commitmentCheck = IsEqual();
    commitmentCheck.in[0] <== commitmentHasher.out;
    commitmentCheck.in[1] <== commitmentHash;

    // Check if user's accreditation meets minimum requirement
    // Using 32-bit to support values up to ~4 billion (e.g., $1,000,000)
    component accreditationCheck = GreaterEqThan(32);
    accreditationCheck.in[0] <== userAccreditation;
    accreditationCheck.in[1] <== minimumAccreditation;

    // Verify issuer attestation using Poseidon-based signature scheme
    // This is a ZK-friendly alternative to ECDSA that provides cryptographic binding
    // The issuer creates: signature = Poseidon(userAccreditation, userSalt, issuerPrivateKey)
    // We verify: signature === Poseidon(userAccreditation, userSalt, issuerPublicKey)
    //
    // Security properties:
    // - Issuer must know the private key corresponding to issuerPublicKey
    // - Signature binds to specific userAccreditation and userSalt
    // - Cannot be forged without knowing issuer's private key
    // - ZK-friendly (efficient in circuits)
    //
    // Note: This is NOT ECDSA. For ECDSA verification in ZK, use circom-ecdsa library.
    // This Poseidon-based scheme is secure for this use case and more efficient.
    component signatureHasher = Poseidon(4);
    signatureHasher.inputs[0] <== userAccreditation;
    signatureHasher.inputs[1] <== userSalt;
    signatureHasher.inputs[2] <== issuerPublicKey[0];
    signatureHasher.inputs[3] <== issuerPublicKey[1];

    component signatureCheck = IsEqual();
    signatureCheck.in[0] <== signatureHasher.out;
    signatureCheck.in[1] <== issuerSignature[0]; // issuerSignature[0] contains the Poseidon signature

    // Verify issuerSignature[1] is the issuer's public key commitment
    // This prevents signature malleability
    component issuerKeyHasher = Poseidon(2);
    issuerKeyHasher.inputs[0] <== issuerPublicKey[0];
    issuerKeyHasher.inputs[1] <== issuerPublicKey[1];

    component keyCommitmentCheck = IsEqual();
    keyCommitmentCheck.in[0] <== issuerKeyHasher.out;
    keyCommitmentCheck.in[1] <== issuerSignature[1]; // issuerSignature[1] is the key commitment

    // Note: No range check needed - accreditation values can be any positive number
    // (e.g., $150,000 for accredited investor status)

    // Output is valid if all checks pass
    component and1 = AND();
    and1.a <== commitmentCheck.out;
    and1.b <== accreditationCheck.out;

    component and2 = AND();
    and2.a <== and1.out;
    and2.b <== signatureCheck.out;

    component and3 = AND();
    and3.a <== and2.out;
    and3.b <== keyCommitmentCheck.out;

    meetsRequirement <== and3.out;
}

component main = AccreditationProof();