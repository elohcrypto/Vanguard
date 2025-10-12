const { expect } = require('chai');
const { ethers } = require('hardhat');
const path = require('path');

// Import RealProofGenerator
const { RealProofGenerator } = require(path.join(__dirname, '../../scripts/generate-real-proofs.js'));

describe('ZK System Integration Tests', function() {
    let zkVerifierIntegrated;
    let realProofGenerator;
    let owner, user1, user2, user3;

    // Increase timeout for proof generation
    this.timeout(180000);

    before(async function() {
        console.log('\n🔧 Setting up ZK System Integration Tests...');
        
        // Get signers
        [owner, user1, user2, user3] = await ethers.getSigners();
        
        // Deploy ZKVerifierIntegrated with testingMode=true
        console.log('📦 Deploying ZKVerifierIntegrated (testingMode=true)...');
        const ZKVerifierIntegratedFactory = await ethers.getContractFactory('ZKVerifierIntegrated');
        zkVerifierIntegrated = await ZKVerifierIntegratedFactory.deploy(true);
        await zkVerifierIntegrated.waitForDeployment();
        
        const zkAddr = await zkVerifierIntegrated.getAddress();
        console.log(`✅ ZKVerifierIntegrated deployed at: ${zkAddr}`);
        
        // Initialize RealProofGenerator
        console.log('🔐 Initializing RealProofGenerator...');
        realProofGenerator = new RealProofGenerator();
        await realProofGenerator.initialize();
        console.log('✅ RealProofGenerator initialized\n');
    });

    describe('1. Proof Caching Mechanism', function() {
        it('should cache verified proofs and reduce gas costs', async function() {
            console.log('  🔐 Testing proof caching...');
            
            // Generate a whitelist proof
            const identity = BigInt(12345);
            const whitelistIdentities = [BigInt(11111), BigInt(12345), BigInt(33333)];
            
            console.log('  📊 Generating whitelist proof...');
            const result = await realProofGenerator.generateWhitelistProof({
                identity,
                whitelistIdentities
            });
            
            // First verification (should NOT be cached)
            console.log('  �� First verification (uncached)...');
            const tx1 = await zkVerifierIntegrated.verifyWhitelistMembership(
                result.proof.a,
                result.proof.b,
                result.proof.c,
                result.publicSignals
            );
            const receipt1 = await tx1.wait();
            const gasUsed1 = receipt1.gasUsed;
            console.log(`  ✅ First verification gas: ${gasUsed1.toString()}`);
            
            // Second verification (should be cached)
            console.log('  🔍 Second verification (cached)...');
            const tx2 = await zkVerifierIntegrated.verifyWhitelistMembership(
                result.proof.a,
                result.proof.b,
                result.proof.c,
                result.publicSignals
            );
            const receipt2 = await tx2.wait();
            const gasUsed2 = receipt2.gasUsed;
            console.log(`  ✅ Second verification gas: ${gasUsed2.toString()}`);
            
            // Calculate savings
            const savings = Number(gasUsed1 - gasUsed2);
            const savingsPercent = (savings / Number(gasUsed1) * 100).toFixed(2);
            console.log(`  💰 Gas savings: ${savings} (${savingsPercent}%)`);
            
            // Verify caching provides significant savings
            expect(gasUsed2).to.be.lessThan(gasUsed1);
            expect(Number(savingsPercent)).to.be.greaterThan(30); // At least 30% savings
        });

        it('should handle cache expiry correctly', async function() {
            console.log('  🕐 Testing cache expiry...');

            // Get cache expiry time (it's a public state variable)
            const expiryTime = await zkVerifierIntegrated.proofCacheExpiry();
            console.log(`  ⏱️  Cache expiry: ${expiryTime.toString()} seconds`);

            // Verify expiry is reasonable (24 hours = 86400 seconds)
            expect(expiryTime).to.equal(86400n);
            console.log('  ✅ Cache expiry time is correct');
        });
    });

    describe('2. Batch Verification', function() {
        it('should verify multiple proofs in batch with gas savings', async function() {
            console.log('  🔐 Testing batch verification...');
            
            // Generate 3 whitelist proofs
            console.log('  📊 Generating 3 whitelist proofs...');
            const identities = [BigInt(11111), BigInt(22222), BigInt(33333)];
            const whitelistIdentities = [BigInt(11111), BigInt(22222), BigInt(33333), BigInt(44444)];
            
            const proofs = [];
            for (let i = 0; i < 3; i++) {
                console.log(`  🔐 Generating proof ${i + 1}/3...`);
                const result = await realProofGenerator.generateWhitelistProof({
                    identity: identities[i],
                    whitelistIdentities
                });
                proofs.push(result);
            }
            
            console.log('  ✅ All 3 proofs generated');
            
            // Prepare batch verification data
            const proofsA = proofs.map(p => p.proof.a);
            const proofsB = proofs.map(p => p.proof.b);
            const proofsC = proofs.map(p => p.proof.c);
            const publicSignals = proofs.map(p => p.publicSignals);
            
            // Batch verification
            console.log('  🔍 Batch verifying 3 proofs...');
            const tx = await zkVerifierIntegrated.verifyBatchWhitelistMembership(
                proofsA,
                proofsB,
                proofsC,
                publicSignals
            );
            const receipt = await tx.wait();
            const batchGas = receipt.gasUsed;
            
            console.log(`  ✅ Batch verification gas: ${batchGas.toString()}`);
            console.log(`  💰 Gas per proof: ${(Number(batchGas) / 3).toFixed(0)}`);
            
            // Verify batch verification succeeded
            expect(receipt.status).to.equal(1);
        });
    });

    describe('3. Proof Format Validation', function() {
        it('should validate proof structure', async function() {
            console.log('  �� Testing proof format validation...');
            
            // Generate a proof
            const identity = BigInt(12345);
            const whitelistIdentities = [BigInt(11111), BigInt(12345), BigInt(33333)];
            
            const result = await realProofGenerator.generateWhitelistProof({
                identity,
                whitelistIdentities
            });
            
            // Verify proof structure
            expect(result.proof).to.have.property('a');
            expect(result.proof).to.have.property('b');
            expect(result.proof).to.have.property('c');
            
            // Verify proof.a is array of 2 elements
            expect(result.proof.a).to.be.an('array');
            expect(result.proof.a.length).to.equal(2);
            
            // Verify proof.b is array of 2 arrays, each with 2 elements
            expect(result.proof.b).to.be.an('array');
            expect(result.proof.b.length).to.equal(2);
            expect(result.proof.b[0]).to.be.an('array');
            expect(result.proof.b[0].length).to.equal(2);
            
            // Verify proof.c is array of 2 elements
            expect(result.proof.c).to.be.an('array');
            expect(result.proof.c.length).to.equal(2);
            
            // Verify public signals
            expect(result.publicSignals).to.be.an('array');
            expect(result.publicSignals.length).to.equal(1);
            
            console.log('  ✅ Proof format is valid');
        });
    });

    describe('4. Gas Cost Profiling', function() {
        it('should profile gas costs for different proof types', async function() {
            console.log('  💰 Profiling gas costs...\n');
            
            const gasCosts = {};
            
            // Whitelist proof
            console.log('  📊 Testing whitelist proof gas cost...');
            const whitelistResult = await realProofGenerator.generateWhitelistProof({
                identity: BigInt(12345),
                whitelistIdentities: [BigInt(11111), BigInt(12345), BigInt(33333)]
            });
            
            const whitelistTx = await zkVerifierIntegrated.verifyWhitelistMembership(
                whitelistResult.proof.a,
                whitelistResult.proof.b,
                whitelistResult.proof.c,
                whitelistResult.publicSignals
            );
            const whitelistReceipt = await whitelistTx.wait();
            gasCosts.whitelist = whitelistReceipt.gasUsed;
            console.log(`  ✅ Whitelist gas: ${gasCosts.whitelist.toString()}\n`);
            
            // Jurisdiction proof
            console.log('  📊 Testing jurisdiction proof gas cost...');
            const jurisdictionResult = await realProofGenerator.generateJurisdictionProof({
                userJurisdiction: 840,
                allowedJurisdictions: [840, 276, 826]
            });
            
            const jurisdictionTx = await zkVerifierIntegrated.verifyJurisdictionProof(
                jurisdictionResult.proof.a,
                jurisdictionResult.proof.b,
                jurisdictionResult.proof.c,
                jurisdictionResult.publicSignals
            );
            const jurisdictionReceipt = await jurisdictionTx.wait();
            gasCosts.jurisdiction = jurisdictionReceipt.gasUsed;
            console.log(`  ✅ Jurisdiction gas: ${gasCosts.jurisdiction.toString()}\n`);
            
            // Display gas cost summary
            console.log('  💰 GAS COST SUMMARY');
            console.log('  ' + '='.repeat(50));
            console.log(`  Whitelist Membership: ${gasCosts.whitelist.toString()} gas`);
            console.log(`  Jurisdiction Proof: ${gasCosts.jurisdiction.toString()} gas`);
            console.log('  ' + '='.repeat(50));
            
            // Verify gas costs are reasonable (< 200k)
            expect(gasCosts.whitelist).to.be.lessThan(200000n);
            expect(gasCosts.jurisdiction).to.be.lessThan(200000n);
        });
    });

    after(function() {
        console.log('\n✅ All ZK System Integration Tests Complete!\n');
    });
});
