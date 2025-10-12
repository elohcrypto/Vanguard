const snarkjs = require("snarkjs");
const { buildPoseidon } = require("circomlibjs");
const path = require("path");

async function main() {
    console.log("\n🧪 Testing FIXED Compliance Circuit\n");
    
    // Initialize Poseidon
    const poseidon = await buildPoseidon();
    const hash = (values) => poseidon.F.toObject(poseidon(values));
    
    // Test parameters
    const kycScore = BigInt(80);
    const amlScore = BigInt(75);
    const jurisdictionScore = BigInt(85);
    const accreditationScore = BigInt(70);
    const userSalt = BigInt(12345);
    
    const weightKyc = BigInt(25);
    const weightAml = BigInt(25);
    const weightJurisdiction = BigInt(25);
    const weightAccreditation = BigInt(25);
    
    const minimumComplianceLevel = BigInt(70);
    
    // Calculate commitment
    const commitmentHash = hash([
        kycScore, amlScore, jurisdictionScore, accreditationScore, userSalt
    ]);
    
    // Calculate expected compliance level
    const weightedSum = 
        (kycScore * weightKyc) +
        (amlScore * weightAml) +
        (jurisdictionScore * weightJurisdiction) +
        (accreditationScore * weightAccreditation);
    
    const complianceLevel = weightedSum / BigInt(100);
    
    console.log("📊 Test Parameters:");
    console.log(`   KYC Score: ${kycScore}`);
    console.log(`   AML Score: ${amlScore}`);
    console.log(`   Jurisdiction Score: ${jurisdictionScore}`);
    console.log(`   Accreditation Score: ${accreditationScore}`);
    console.log(`   Weighted Sum: ${weightedSum}`);
    console.log(`   Compliance Level: ${complianceLevel}`);
    console.log(`   Minimum Required: ${minimumComplianceLevel}`);
    console.log(`   Should Pass: ${complianceLevel >= minimumComplianceLevel ? "YES ✅" : "NO ❌"}\n`);
    
    // Prepare circuit inputs
    const input = {
        kycScore: kycScore.toString(),
        amlScore: amlScore.toString(),
        jurisdictionScore: jurisdictionScore.toString(),
        accreditationScore: accreditationScore.toString(),
        userSalt: userSalt.toString(),
        minimumComplianceLevel: minimumComplianceLevel.toString(),
        commitmentHash: commitmentHash.toString(),
        weightKyc: weightKyc.toString(),
        weightAml: weightAml.toString(),
        weightJurisdiction: weightJurisdiction.toString(),
        weightAccreditation: weightAccreditation.toString()
    };
    
    const circuitPath = path.join(__dirname, "../build/circuits/compliance_aggregation_fixed");
    
    try {
        console.log("🔐 Generating proof...");
        const startTime = Date.now();
        
        const { proof, publicSignals } = await snarkjs.groth16.fullProve(
            input,
            path.join(circuitPath, "compliance_aggregation_fixed_js/compliance_aggregation_fixed.wasm"),
            path.join(circuitPath, "compliance_aggregation_fixed.zkey")
        );
        
        const duration = Date.now() - startTime;
        
        console.log(`✅ Proof generated successfully in ${duration}ms\n`);
        console.log("📊 Public Signals:");
        console.log(`   meetsCompliance: ${publicSignals[0]}`);
        console.log(`   complianceLevel: ${publicSignals[1]}\n`);
        
        // Verify proof
        console.log("🔍 Verifying proof...");
        const vkey = require(path.join(circuitPath, "compliance_aggregation_fixed_vkey.json"));
        const verified = await snarkjs.groth16.verify(vkey, publicSignals, proof);
        
        console.log(`${verified ? "✅" : "❌"} Proof verification: ${verified ? "PASSED" : "FAILED"}\n`);
        
        if (verified) {
            console.log("🎉 SUCCESS! Fixed compliance circuit is working!\n");
            process.exit(0);
        } else {
            console.log("❌ FAILED! Proof verification failed\n");
            process.exit(1);
        }
        
    } catch (error) {
        console.log(`❌ FAILED: ${error.message}\n`);
        console.error(error);
        process.exit(1);
    }
}

main().catch(error => {
    console.error("Fatal error:", error);
    process.exit(1);
});

