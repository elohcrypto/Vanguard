const { expect } = require("chai");
const { ethers } = require("hardhat");
const { RealProofGenerator } = require("../../scripts/generate-real-proofs");
const { MerkleTreeBuilder } = require("../../utils/merkle-tree-builder");
const { ProofFormatter } = require("../../utils/proof-formatter");

describe("RealProofGenerator - All 5 Proof Types", function() {
    let generator;
    let zkVerifier;
    let owner;

    // Increase timeout for proof generation
    this.timeout(60000);

    before(async function() {
        [owner] = await ethers.getSigners();
        
        // Deploy ZKVerifierIntegrated in testing mode
        const ZKVerifierIntegrated = await ethers.getContractFactory("ZKVerifierIntegrated");
        zkVerifier = await ZKVerifierIntegrated.deploy(true); // testingMode=true
        await zkVerifier.waitForDeployment();

        // Initialize proof generator
        generator = new RealProofGenerator();
        await generator.initialize();
    });

    describe("1. Whitelist Membership Proof", function() {
        it("should generate valid whitelist proof", async function() {
            console.log("\n  🧪 Testing Whitelist Proof Generation");

            const identity = BigInt(12345);
            const whitelistIdentities = [
                BigInt(11111),
                BigInt(12345), // Our identity
                BigInt(33333),
                BigInt(44444)
            ];

            const startTime = Date.now();
            const result = await generator.generateWhitelistProof({
                identity,
                whitelistIdentities
            });
            const duration = Date.now() - startTime;

            console.log(`  ⏱️  Generation time: ${duration}ms`);
            console.log(`  📊 Public signals: ${result.publicSignals.length}`);

            // Validate proof structure
            expect(result.proof).to.have.property('a');
            expect(result.proof).to.have.property('b');
            expect(result.proof).to.have.property('c');
            expect(result.publicSignals).to.have.lengthOf(1);

            // Verify on-chain
            const tx = await zkVerifier.verifyWhitelistMembership(
                result.proof.a,
                result.proof.b,
                result.proof.c,
                result.publicSignals
            );
            const receipt = await tx.wait();

            console.log(`  ⛽ Gas used: ${receipt.gasUsed.toString()}`);
            expect(tx).to.not.be.reverted;
        });

        it("should reject identity not in whitelist", async function() {
            const identity = BigInt(99999); // Not in whitelist
            const whitelistIdentities = [BigInt(11111), BigInt(22222)];

            await expect(
                generator.generateWhitelistProof({ identity, whitelistIdentities })
            ).to.be.rejectedWith("Identity not found in whitelist");
        });
    });

    describe("2. Blacklist Non-Membership Proof", function() {
        it("should generate valid blacklist proof", async function() {
            console.log("\n  🧪 Testing Blacklist Proof Generation");

            const identity = BigInt(12345);
            const blacklistIdentities = [
                BigInt(11111),
                BigInt(22222),
                BigInt(33333)
                // Identity NOT in blacklist
            ];
            const challengeHash = BigInt(999);

            const startTime = Date.now();
            const result = await generator.generateBlacklistProof({
                identity,
                blacklistIdentities,
                challengeHash
            });
            const duration = Date.now() - startTime;

            console.log(`  ⏱️  Generation time: ${duration}ms`);
            console.log(`  📊 Public signals: ${result.publicSignals.length}`);

            // Validate proof structure
            expect(result.proof).to.have.property('a');
            expect(result.publicSignals).to.have.lengthOf(1);
            // Circuit returns 0 for non-membership (not blacklisted)
            expect(result.publicSignals[0]).to.equal("0");

            // Verify on-chain
            const tx = await zkVerifier.verifyBlacklistNonMembership(
                result.proof.a,
                result.proof.b,
                result.proof.c,
                result.publicSignals
            );
            const receipt = await tx.wait();

            console.log(`  ⛽ Gas used: ${receipt.gasUsed.toString()}`);
            expect(tx).to.not.be.reverted;
        });
    });

    describe("3. Jurisdiction Proof", function() {
        it("should generate valid jurisdiction proof", async function() {
            console.log("\n  🧪 Testing Jurisdiction Proof Generation");

            const userJurisdiction = BigInt(1); // US
            const allowedJurisdictions = [BigInt(1), BigInt(2), BigInt(3)];

            const startTime = Date.now();
            const result = await generator.generateJurisdictionProof({
                userJurisdiction,
                allowedJurisdictions
            });
            const duration = Date.now() - startTime;

            console.log(`  ⏱️  Generation time: ${duration}ms`);
            console.log(`  📊 Public signals: ${result.publicSignals.length}`);

            // Validate proof structure
            expect(result.proof).to.have.property('a');
            expect(result.publicSignals).to.have.lengthOf(1);

            // Verify on-chain
            const tx = await zkVerifier.verifyJurisdictionProof(
                result.proof.a,
                result.proof.b,
                result.proof.c,
                result.publicSignals
            );
            const receipt = await tx.wait();

            console.log(`  ⛽ Gas used: ${receipt.gasUsed.toString()}`);
            expect(tx).to.not.be.reverted;
        });

        it("should reject disallowed jurisdiction", async function() {
            const userJurisdiction = BigInt(99); // Not allowed
            const allowedJurisdictions = [BigInt(1), BigInt(2)];

            await expect(
                generator.generateJurisdictionProof({ userJurisdiction, allowedJurisdictions })
            ).to.be.rejectedWith("User jurisdiction not in allowed list");
        });
    });

    describe("4. Accreditation Proof", function() {
        it("should generate valid accreditation proof", async function() {
            console.log("\n  🧪 Testing Accreditation Proof Generation");

            const userAccreditation = BigInt(5);
            const minimumAccreditation = BigInt(3);

            const startTime = Date.now();
            const result = await generator.generateAccreditationProof({
                userAccreditation,
                minimumAccreditation
            });
            const duration = Date.now() - startTime;

            console.log(`  ⏱️  Generation time: ${duration}ms`);
            console.log(`  📊 Public signals: ${result.publicSignals.length}`);

            // Validate proof structure
            expect(result.proof).to.have.property('a');
            expect(result.publicSignals).to.have.lengthOf(1);

            // Verify on-chain
            const tx = await zkVerifier.verifyAccreditationProof(
                result.proof.a,
                result.proof.b,
                result.proof.c,
                result.publicSignals
            );
            const receipt = await tx.wait();

            console.log(`  ⛽ Gas used: ${receipt.gasUsed.toString()}`);
            expect(tx).to.not.be.reverted;
        });

        it("should reject insufficient accreditation level", async function() {
            const userAccreditation = BigInt(2);
            const minimumAccreditation = BigInt(5);

            await expect(
                generator.generateAccreditationProof({ userAccreditation, minimumAccreditation })
            ).to.be.rejectedWith("Accreditation level below minimum");
        });
    });

    describe("5. Compliance Aggregation Proof", function() {
        it("should generate valid compliance proof", async function() {
            console.log("\n  🧪 Testing Compliance Proof Generation");

            const params = {
                kycScore: BigInt(90),
                amlScore: BigInt(85),
                jurisdictionScore: BigInt(95),
                accreditationScore: BigInt(80),
                weightKyc: BigInt(30),
                weightAml: BigInt(30),
                weightJurisdiction: BigInt(20),
                weightAccreditation: BigInt(20),
                // Weighted sum = 90*30 + 85*30 + 95*20 + 80*20 = 8750
                // minimumComplianceLevel is 0-100 (gets multiplied by 100 in circuit)
                // So 50 means minimum weighted sum of 5000
                minimumComplianceLevel: BigInt(50)
            };

            const startTime = Date.now();
            const result = await generator.generateComplianceProof(params);
            const duration = Date.now() - startTime;

            console.log(`  ⏱️  Generation time: ${duration}ms`);
            console.log(`  📊 Public signals: ${result.publicSignals.length}`);

            // Validate proof structure
            expect(result.proof).to.have.property('a');
            expect(result.publicSignals).to.have.lengthOf(2); // meetsCompliance and complianceLevel

            // Verify on-chain
            // Note: Contract expects 6 public inputs (not the 2 circuit outputs)
            // Construct the public inputs array manually
            const publicInputs = [
                params.minimumComplianceLevel,
                result.inputs.commitmentHash,
                params.weightKyc,
                params.weightAml,
                params.weightJurisdiction,
                params.weightAccreditation
            ];

            const tx = await zkVerifier.verifyComplianceAggregation(
                result.proof.a,
                result.proof.b,
                result.proof.c,
                publicInputs
            );
            const receipt = await tx.wait();

            console.log(`  ⛽ Gas used: ${receipt.gasUsed.toString()}`);
            expect(tx).to.not.be.reverted;
        });

        it("should reject insufficient compliance score", async function() {
            const params = {
                kycScore: BigInt(50),
                amlScore: BigInt(50),
                jurisdictionScore: BigInt(50),
                accreditationScore: BigInt(50),
                weightKyc: BigInt(25),
                weightAml: BigInt(25),
                weightJurisdiction: BigInt(25),
                weightAccreditation: BigInt(25),
                // Weighted sum = 50*25 + 50*25 + 50*25 + 50*25 = 5000
                // minimumComplianceLevel is 0-100 (gets multiplied by 100 in circuit)
                // So 90 means minimum weighted sum of 9000 (which is > 5000, so should fail)
                minimumComplianceLevel: BigInt(90)
            };

            // Circuit will fail with assertion error instead of throwing custom error
            await expect(
                generator.generateComplianceProof(params)
            ).to.be.rejected; // Accept any rejection (circuit assertion failure)
        });
    });

    describe("Utility Functions", function() {
        describe("MerkleTreeBuilder", function() {
            it("should build merkle tree correctly", async function() {
                const tree = await MerkleTreeBuilder.createSimpleTree(4, 20);
                
                expect(tree.getRoot()).to.not.be.null;
                expect(tree.getStats().levels).to.equal(20);
                expect(tree.getStats().maxLeaves).to.equal(Math.pow(2, 20));
            });

            it("should generate valid merkle proofs", async function() {
                const identities = [BigInt(1), BigInt(2), BigInt(3), BigInt(4)];
                const tree = await MerkleTreeBuilder.createFromIdentities(identities);
                
                const { pathElements, pathIndices } = tree.getProof(0);
                expect(pathElements).to.have.lengthOf(20);
                expect(pathIndices).to.have.lengthOf(20);
            });
        });

        describe("ProofFormatter", function() {
            it("should format proof for Solidity", async function() {
                const mockProof = {
                    pi_a: ["1", "2", "1"],
                    pi_b: [["3", "4"], ["5", "6"], ["1", "1"]],
                    pi_c: ["7", "8", "1"]
                };
                const publicSignals = ["12345"];

                const formatted = ProofFormatter.formatForSolidity(mockProof, publicSignals);

                expect(formatted.a).to.have.lengthOf(2);
                expect(formatted.b).to.have.lengthOf(2);
                expect(formatted.c).to.have.lengthOf(2);
                expect(formatted.publicSignals).to.deep.equal(["12345"]);
            });

            it("should validate proof structure", function() {
                const validProof = {
                    pi_a: ["1", "2", "1"],
                    pi_b: [["3", "4"], ["5", "6"], ["1", "1"]],
                    pi_c: ["7", "8", "1"]
                };

                expect(ProofFormatter.validateProof(validProof)).to.be.true;
                expect(ProofFormatter.validateProof({})).to.be.false;
            });
        });
    });
});

