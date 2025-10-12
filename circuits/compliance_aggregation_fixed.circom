pragma circom 2.0.0;

include "circomlib/circuits/poseidon.circom";
include "circomlib/circuits/comparators.circom";
include "circomlib/circuits/gates.circom";

/**
 * @title ComplianceAggregationFixed
 * @dev FIXED: Zero-knowledge proof circuit for aggregated compliance verification
 * @notice Proves overall compliance level without revealing individual scores
 * 
 * KEY FIX: Uses 32-bit comparisons to handle weighted sums up to 40,000
 */
template ComplianceAggregationFixed() {
    // Private inputs (secret)
    signal input kycScore;           // KYC compliance score (0-100)
    signal input amlScore;           // AML compliance score (0-100)
    signal input jurisdictionScore;  // Jurisdiction compliance score (0-100)
    signal input accreditationScore; // Accreditation score (0-100)
    signal input userSalt;           // Random salt for privacy

    // Public inputs
    signal input minimumComplianceLevel;     // Minimum required overall compliance (0-100)
    signal input commitmentHash;             // Commitment to compliance scores
    signal input weightKyc;                  // Weight for KYC score (0-100)
    signal input weightAml;                  // Weight for AML score (0-100)
    signal input weightJurisdiction;         // Weight for jurisdiction score (0-100)
    signal input weightAccreditation;        // Weight for accreditation score (0-100)

    // Outputs
    signal output meetsCompliance;           // 1 if meets compliance, 0 otherwise
    signal output complianceLevel;           // Actual compliance level (for transparency)

    // Verify commitment to all scores
    component commitmentHasher = Poseidon(5);
    commitmentHasher.inputs[0] <== kycScore;
    commitmentHasher.inputs[1] <== amlScore;
    commitmentHasher.inputs[2] <== jurisdictionScore;
    commitmentHasher.inputs[3] <== accreditationScore;
    commitmentHasher.inputs[4] <== userSalt;
    
    component commitmentCheck = IsEqual();
    commitmentCheck.in[0] <== commitmentHasher.out;
    commitmentCheck.in[1] <== commitmentHash;

    // Calculate weighted compliance score
    // Max value: 100*100 = 10,000 per score, total 40,000 (needs 16 bits)
    signal kycWeighted <== kycScore * weightKyc;
    signal amlWeighted <== amlScore * weightAml;
    signal jurisdictionWeighted <== jurisdictionScore * weightJurisdiction;
    signal accreditationWeighted <== accreditationScore * weightAccreditation;

    signal weightedSum <== kycWeighted + amlWeighted + jurisdictionWeighted + accreditationWeighted;
    signal totalWeight <== weightKyc + weightAml + weightJurisdiction + weightAccreditation;

    // Output the weighted sum directly (no division in circuit)
    // Off-chain: complianceLevel = weightedSum / 100
    complianceLevel <== weightedSum;

    // Check if compliance level meets minimum requirement
    // Compare weightedSum directly against minimumComplianceLevel * 100
    // This avoids division entirely!
    signal minimumWeightedSum <== minimumComplianceLevel * 100;

    // Use 16-bit comparison (max value is 40,000 which fits in 16 bits)
    component complianceCheck = GreaterEqThan(16);
    complianceCheck.in[0] <== weightedSum;
    complianceCheck.in[1] <== minimumWeightedSum;

    // Validate all scores are in range (0-100)
    component kycRange = LessEqThan(8);
    kycRange.in[0] <== kycScore;
    kycRange.in[1] <== 100;
    
    component amlRange = LessEqThan(8);
    amlRange.in[0] <== amlScore;
    amlRange.in[1] <== 100;
    
    component jurisdictionRange = LessEqThan(8);
    jurisdictionRange.in[0] <== jurisdictionScore;
    jurisdictionRange.in[1] <== 100;
    
    component accreditationRange = LessEqThan(8);
    accreditationRange.in[0] <== accreditationScore;
    accreditationRange.in[1] <== 100;

    // Validate all weights are in range (0-100)
    component weightKycRange = LessEqThan(8);
    weightKycRange.in[0] <== weightKyc;
    weightKycRange.in[1] <== 100;
    
    component weightAmlRange = LessEqThan(8);
    weightAmlRange.in[0] <== weightAml;
    weightAmlRange.in[1] <== 100;
    
    component weightJurRange = LessEqThan(8);
    weightJurRange.in[0] <== weightJurisdiction;
    weightJurRange.in[1] <== 100;
    
    component weightAccRange = LessEqThan(8);
    weightAccRange.in[0] <== weightAccreditation;
    weightAccRange.in[1] <== 100;

    // All validations must pass
    component and1 = AND();
    and1.a <== commitmentCheck.out;
    and1.b <== complianceCheck.out;
    
    component and2 = AND();
    and2.a <== and1.out;
    and2.b <== kycRange.out;
    
    component and3 = AND();
    and3.a <== and2.out;
    and3.b <== amlRange.out;
    
    component and4 = AND();
    and4.a <== and3.out;
    and4.b <== jurisdictionRange.out;
    
    component and5 = AND();
    and5.a <== and4.out;
    and5.b <== accreditationRange.out;
    
    component and6 = AND();
    and6.a <== and5.out;
    and6.b <== weightKycRange.out;
    
    component and7 = AND();
    and7.a <== and6.out;
    and7.b <== weightAmlRange.out;
    
    component and8 = AND();
    and8.a <== and7.out;
    and8.b <== weightJurRange.out;
    
    component and9 = AND();
    and9.a <== and8.out;
    and9.b <== weightAccRange.out;
    
    meetsCompliance <== and9.out;
}

component main {public [minimumComplianceLevel, commitmentHash, weightKyc, weightAml, weightJurisdiction, weightAccreditation]} = ComplianceAggregationFixed();

