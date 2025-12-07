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

    // Check if user's jurisdiction is in allowed bitmask
    // Improved bitmask implementation using direct bit extraction
    //
    // We support up to 16 jurisdictions (bits 0-15) for efficiency
    // This is a practical limit that covers most use cases
    // For more jurisdictions, deploy multiple instances or use a Merkle tree

    // Convert allowedJurisdictionsMask to bits (16 bits for efficiency)
    component maskToBits = Num2Bits(16);
    maskToBits.in <== allowedJurisdictionsMask;

    // Convert userJurisdiction to bits to use as selector
    component jurisdictionToBits = Num2Bits(16);
    jurisdictionToBits.in <== userJurisdiction;

    // Create components array OUTSIDE the loop (Circom requirement)
    component posMatch[16];
    component andGate[16];

    // Check each bit position
    signal bitChecks[16];
    signal positionMatches[16];

    for (var i = 0; i < 16; i++) {
        // Check if this position matches our jurisdiction
        posMatch[i] = IsEqual();
        posMatch[i].in[0] <== i;
        posMatch[i].in[1] <== userJurisdiction;
        positionMatches[i] <== posMatch[i].out;

        // If position matches AND bit is set, this check passes
        andGate[i] = AND();
        andGate[i].a <== positionMatches[i];
        andGate[i].b <== maskToBits.out[i];
        bitChecks[i] <== andGate[i].out;
    }

    // Sum all bit checks - should be 1 if jurisdiction is allowed, 0 otherwise
    signal bitCheckSum;
    var sum = 0;
    for (var i = 0; i < 16; i++) {
        sum += bitChecks[i];
    }
    bitCheckSum <== sum;

    // Verify that exactly one bit matched (jurisdiction is in the allowed set)
    component jurisdictionAllowed = IsEqual();
    jurisdictionAllowed.in[0] <== bitCheckSum;
    jurisdictionAllowed.in[1] <== 1;

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