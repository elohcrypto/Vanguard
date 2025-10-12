pragma circom 2.0.0;

include "circomlib/circuits/poseidon.circom";
include "circomlib/circuits/comparators.circom";
include "circomlib/circuits/bitify.circom";
include "circomlib/circuits/gates.circom";

/**
 * @title JurisdictionProof
 * @dev Zero-knowledge proof circuit for jurisdiction eligibility verification
 * @notice Proves that a user is from an allowed jurisdiction without revealing location
 */
template JurisdictionProof() {
    // Private inputs (secret)
    signal input userJurisdiction;   // User's actual jurisdiction code
    signal input userSalt;           // Random salt for privacy

    // Public inputs
    signal input allowedJurisdictionsMask;   // Bitmask of allowed jurisdictions
    signal input commitmentHash;             // Commitment to user's jurisdiction

    // Outputs
    signal output isEligible;                // 1 if eligible, 0 otherwise

    // Verify commitment
    component commitmentHasher = Poseidon(2);
    commitmentHasher.inputs[0] <== userJurisdiction;
    commitmentHasher.inputs[1] <== userSalt;
    
    component commitmentCheck = IsEqual();
    commitmentCheck.in[0] <== commitmentHasher.out;
    commitmentCheck.in[1] <== commitmentHash;

    // Check if user's jurisdiction is in allowed mask
    // Simplified approach: check if jurisdiction equals one of allowed values
    // In production, this would use more sophisticated bit manipulation
    component jurisdictionAllowed = IsEqual();
    jurisdictionAllowed.in[0] <== userJurisdiction;
    jurisdictionAllowed.in[1] <== allowedJurisdictionsMask; // Simplified: direct comparison

    // Ensure jurisdiction code is valid (0-999 for ISO 3166-1 numeric codes)
    // Using 16-bit to support codes up to 65535
    component jurisdictionRange = LessEqThan(16);
    jurisdictionRange.in[0] <== userJurisdiction;
    jurisdictionRange.in[1] <== 999; // Max ISO 3166-1 numeric code

    // Output is valid if commitment is correct, jurisdiction is allowed, and in valid range
    component and1 = AND();
    and1.a <== commitmentCheck.out;
    and1.b <== jurisdictionAllowed.out;
    
    component and2 = AND();
    and2.a <== and1.out;
    and2.b <== jurisdictionRange.out;
    
    isEligible <== and2.out;
}

component main = JurisdictionProof();