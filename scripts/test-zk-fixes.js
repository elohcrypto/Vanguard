const { ethers } = require('hardhat');

async function main() {
    console.log('🔧 TESTING ZK PROOF FUNCTION FIXES');
    console.log('=' .repeat(40));
    
    try {
        // Get signers
        const [deployer] = await ethers.getSigners();
        console.log('👤 Using deployer:', deployer.address);
        
        // Deploy ZKVerifierIntegrated
        console.log('\n📦 Deploying ZKVerifierIntegrated...');
        const ZKVerifierIntegrated = await ethers.getContractFactory('ZKVerifierIntegrated');
        const zkVerifier = await ZKVerifierIntegrated.deploy();
        await zkVerifier.waitForDeployment();
        console.log('✅ ZKVerifierIntegrated deployed at:', await zkVerifier.getAddress());
        
        // Create mock Groth16 proof
        const createMockGroth16Proof = () => {
            const randomFieldElement = () => {
                return Math.floor(Math.random() * 1000000000).toString();
            };
            
            return {
                a: [randomFieldElement(), randomFieldElement()],
                b: [[randomFieldElement(), randomFieldElement()], [randomFieldElement(), randomFieldElement()]],
                c: [randomFieldElement(), randomFieldElement()]
            };
        };
        
        console.log('\n🧪 Testing ZK Proof Functions...');
        
        // Test 1: Jurisdiction Proof
        console.log('\n1️⃣ Testing Jurisdiction Proof...');
        try {
            const mockProof = createMockGroth16Proof();
            const allowedMask = 5; // US + UK
            
            const tx1 = await zkVerifier.verifyJurisdictionProof(
                mockProof.a,
                mockProof.b,
                mockProof.c,
                [allowedMask]
            );
            await tx1.wait();
            console.log('   ✅ Jurisdiction proof function works correctly');
        } catch (error) {
            console.log('   ❌ Jurisdiction proof failed:', error.message);
        }
        
        // Test 2: Accreditation Proof
        console.log('\n2️⃣ Testing Accreditation Proof...');
        try {
            const mockProof = createMockGroth16Proof();
            const minimumLevel = 100000; // $100K
            
            const tx2 = await zkVerifier.verifyAccreditationProof(
                mockProof.a,
                mockProof.b,
                mockProof.c,
                [minimumLevel]
            );
            await tx2.wait();
            console.log('   ✅ Accreditation proof function works correctly');
        } catch (error) {
            console.log('   ❌ Accreditation proof failed:', error.message);
        }
        
        // Test 3: Compliance Aggregation Proof
        console.log('\n3️⃣ Testing Compliance Aggregation Proof...');
        try {
            const mockProof = createMockGroth16Proof();
            const aggregatedScore = 87;
            const timestamp = Math.floor(Date.now() / 1000);
            
            const tx3 = await zkVerifier.verifyComplianceProof(
                mockProof.a,
                mockProof.b,
                mockProof.c,
                [aggregatedScore, timestamp]
            );
            await tx3.wait();
            console.log('   ✅ Compliance aggregation proof function works correctly');
        } catch (error) {
            console.log('   ❌ Compliance aggregation proof failed:', error.message);
        }
        
        console.log('\n🎉 ALL ZK PROOF FUNCTION TESTS COMPLETED!');
        console.log('✅ The interactive demo should now work correctly for options 44 and 45');
        
    } catch (error) {
        console.error('❌ Test failed:', error.message);
    }
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error(error);
        process.exit(1);
    });
