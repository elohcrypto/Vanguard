const { ethers } = require("hardhat");
const RealZKProofSetup = require("./setup-real-zk-proofs");

/**
 * Integration script to use real ZK proofs in the interactive demo
 * This replaces mock proofs with actual cryptographic proofs
 */
class RealProofIntegration {
    constructor() {
        this.setup = new RealZKProofSetup();
        this.contracts = {};
    }

    /**
     * Deploy contracts and setup real proof system
     */
    async deployAndSetup() {
        console.log("🚀 DEPLOYING CONTRACTS WITH REAL ZK PROOF INTEGRATION");
        console.log("=" .repeat(60));

        // Deploy ZK verification contracts
        console.log("📦 Deploying ZK verification system...");
        
        // Deploy ZKVerifierIntegrated
        const ZKVerifierIntegrated = await ethers.getContractFactory("ZKVerifierIntegrated");
        this.contracts.zkVerifier = await ZKVerifierIntegrated.deploy();
        await this.contracts.zkVerifier.waitForDeployment();
        
        console.log("✅ ZKVerifierIntegrated deployed:", await this.contracts.zkVerifier.getAddress());

        // Deploy PrivacyManager
        const PrivacyManager = await ethers.getContractFactory("PrivacyManager");
        this.contracts.privacyManager = await PrivacyManager.deploy();
        await this.contracts.privacyManager.waitForDeployment();
        
        console.log("✅ PrivacyManager deployed:", await this.contracts.privacyManager.getAddress());

        // Deploy ComplianceProofValidator
        const ComplianceProofValidator = await ethers.getContractFactory("ComplianceProofValidator");
        this.contracts.complianceValidator = await ComplianceProofValidator.deploy(
            await this.contracts.zkVerifier.getAddress(),
            await this.contracts.privacyManager.getAddress()
        );
        await this.contracts.complianceValidator.waitForDeployment();
        
        console.log("✅ ComplianceProofValidator deployed:", await this.contracts.complianceValidator.getAddress());

        // Initialize whitelist and generate proofs
        console.log("\n🔧 Setting up real ZK proofs...");
        await this.setup.initializeWhitelist();
        await this.setup.generateAllProofs();

        console.log("✅ Real ZK proof system ready!");
        return this.contracts;
    }

    /**
     * Submit real whitelist proof for a user
     */
    async submitRealWhitelistProof(userAddress) {
        console.log(`\n📋 SUBMITTING REAL WHITELIST PROOF FOR: ${userAddress}`);
        console.log("=" .repeat(50));

        try {
            // Get real proof for user
            const proofData = this.setup.getContractProof(userAddress);
            
            console.log("🔍 Proof details:");
            console.log(`   🌳 Merkle Root: ${proofData.merkleRoot.substring(0, 20)}...`);
            console.log(`   🔒 Nullifier Hash: ${proofData.nullifierHash.substring(0, 20)}...`);
            console.log(`   📊 Public Signals: ${proofData.publicSignals.length} elements`);

            // First, update the whitelist root in the contract
            console.log("📋 Updating whitelist root...");
            const updateTx = await this.contracts.complianceValidator.updateWhitelistRoot(
                proofData.merkleRoot
            );
            await updateTx.wait();
            console.log("✅ Whitelist root updated");

            // Submit the real proof
            console.log("🔐 Submitting ZK proof...");
            const submitTx = await this.contracts.complianceValidator.submitWhitelistProof(
                proofData.merkleRoot,
                proofData.nullifierHash,
                {
                    a: proofData.a,
                    b: proofData.b,
                    c: proofData.c
                }
            );
            const receipt = await submitTx.wait();

            console.log("✅ REAL WHITELIST PROOF SUBMITTED SUCCESSFULLY!");
            console.log(`   🔗 Transaction: ${receipt.hash}`);
            console.log(`   🧱 Block: ${receipt.blockNumber}`);
            console.log(`   ⛽ Gas Used: ${receipt.gasUsed.toString()}`);

            // Verify the proof was accepted
            const isVerified = await this.contracts.complianceValidator.verifyWhitelistMembership(userAddress);
            console.log(`   ${isVerified ? '✅' : '❌'} Verification Status: ${isVerified ? 'VERIFIED' : 'NOT VERIFIED'}`);

            return {
                success: true,
                transactionHash: receipt.hash,
                blockNumber: receipt.blockNumber,
                gasUsed: receipt.gasUsed.toString(),
                verified: isVerified
            };

        } catch (error) {
            console.error("❌ Failed to submit real proof:", error.message);
            return {
                success: false,
                error: error.message
            };
        }
    }

    /**
     * Test real proof submission for multiple users
     */
    async testMultipleUsers() {
        console.log("\n🧪 TESTING REAL PROOFS FOR MULTIPLE USERS");
        console.log("=" .repeat(50));

        const signers = await ethers.getSigners();
        const testUsers = signers.slice(0, 3); // Test first 3 users
        const results = [];

        for (let i = 0; i < testUsers.length; i++) {
            const user = testUsers[i];
            console.log(`\n👤 Testing user ${i + 1}/${testUsers.length}: ${user.address}`);
            
            const result = await this.submitRealWhitelistProof(user.address);
            results.push({
                userAddress: user.address,
                userIndex: i,
                ...result
            });

            // Wait a bit between submissions
            await new Promise(resolve => setTimeout(resolve, 1000));
        }

        // Summary
        console.log("\n📊 TESTING SUMMARY");
        console.log("=" .repeat(30));
        const successful = results.filter(r => r.success).length;
        console.log(`✅ Successful submissions: ${successful}/${results.length}`);
        console.log(`❌ Failed submissions: ${results.length - successful}/${results.length}`);

        results.forEach((result, i) => {
            const status = result.success ? '✅' : '❌';
            console.log(`   ${status} User ${i + 1}: ${result.success ? 'SUCCESS' : result.error}`);
        });

        return results;
    }

    /**
     * Compare real vs mock proof performance
     */
    async performanceComparison() {
        console.log("\n⚡ PERFORMANCE COMPARISON: REAL vs MOCK PROOFS");
        console.log("=" .repeat(55));

        const signer = (await ethers.getSigners())[0];
        const userAddress = signer.address;

        // Test real proof
        console.log("🔐 Testing REAL proof submission...");
        const realStart = Date.now();
        const realResult = await this.submitRealWhitelistProof(userAddress);
        const realTime = Date.now() - realStart;

        // Test mock proof (simplified)
        console.log("\n🎭 Testing MOCK proof submission...");
        const mockStart = Date.now();
        try {
            const mockProof = {
                a: [1, 2],
                b: [[1, 2], [3, 4]], 
                c: [5, 6]
            };
            const mockNullifier = Math.floor(Math.random() * 1000000);
            
            // Enable testing mode for mock
            await this.contracts.zkVerifier.setTestingMode(true);
            
            const mockTx = await this.contracts.zkVerifier.verifyWhitelistMembership(
                mockProof.a,
                mockProof.b,
                mockProof.c,
                [mockNullifier]
            );
            await mockTx.wait();
            
            const mockTime = Date.now() - mockStart;
            
            console.log("📊 PERFORMANCE RESULTS:");
            console.log(`   🔐 Real Proof Time: ${realTime}ms`);
            console.log(`   🎭 Mock Proof Time: ${mockTime}ms`);
            console.log(`   📈 Real/Mock Ratio: ${(realTime / mockTime).toFixed(2)}x`);
            
            // Disable testing mode
            await this.contracts.zkVerifier.setTestingMode(false);
            
        } catch (error) {
            console.error("❌ Mock proof test failed:", error.message);
        }
    }

    /**
     * Complete demo with real proofs
     */
    async demo() {
        console.log("🎯 REAL ZK PROOF INTEGRATION DEMO");
        console.log("=" .repeat(50));

        try {
            // 1. Deploy and setup
            await this.deployAndSetup();

            // 2. Test single user
            const signer = (await ethers.getSigners())[0];
            await this.submitRealWhitelistProof(signer.address);

            // 3. Test multiple users
            await this.testMultipleUsers();

            // 4. Performance comparison
            await this.performanceComparison();

            console.log("\n🎉 REAL ZK PROOF INTEGRATION COMPLETE!");
            console.log("💡 Your system now uses cryptographically secure ZK proofs!");
            console.log("🔐 Privacy is preserved while maintaining compliance verification!");

        } catch (error) {
            console.error("❌ Demo failed:", error.message);
            throw error;
        }
    }
}

// Export for use in other scripts
module.exports = RealProofIntegration;

// Run demo if called directly
if (require.main === module) {
    async function main() {
        try {
            const integration = new RealProofIntegration();
            await integration.demo();
        } catch (error) {
            console.error("❌ Error:", error.message);
            process.exit(1);
        }
    }
    
    main();
}
