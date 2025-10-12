const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("ZKVerifierIntegrated - Phase 2 Features", function() {
    let zkVerifier;
    let owner, user1, user2;

    // Sample proof data for testing
    const sampleProof = {
        a: [1, 2],
        b: [[3, 4], [5, 6]],
        c: [7, 8]
    };

    const samplePublicSignals = [12345];

    beforeEach(async function() {
        [owner, user1, user2] = await ethers.getSigners();
    });

    describe("Immutable Testing Mode", function() {
        it("should deploy with testingMode=true", async function() {
            const ZKVerifierIntegrated = await ethers.getContractFactory("ZKVerifierIntegrated");
            zkVerifier = await ZKVerifierIntegrated.deploy(true);
            await zkVerifier.waitForDeployment();

            expect(await zkVerifier.testingMode()).to.equal(true);
        });

        it("should deploy with testingMode=false", async function() {
            const ZKVerifierIntegrated = await ethers.getContractFactory("ZKVerifierIntegrated");
            zkVerifier = await ZKVerifierIntegrated.deploy(false);
            await zkVerifier.waitForDeployment();

            expect(await zkVerifier.testingMode()).to.equal(false);
        });

        it("should not have setTestingMode function", async function() {
            const ZKVerifierIntegrated = await ethers.getContractFactory("ZKVerifierIntegrated");
            zkVerifier = await ZKVerifierIntegrated.deploy(true);
            await zkVerifier.waitForDeployment();

            // Verify the function doesn't exist
            expect(zkVerifier.setTestingMode).to.be.undefined;
        });
    });

    describe("Proof Caching", function() {
        beforeEach(async function() {
            const ZKVerifierIntegrated = await ethers.getContractFactory("ZKVerifierIntegrated");
            zkVerifier = await ZKVerifierIntegrated.deploy(true); // Testing mode
            await zkVerifier.waitForDeployment();
        });

        it("should cache successful whitelist proof", async function() {
            // First verification
            const tx1 = await zkVerifier.verifyWhitelistMembership(
                sampleProof.a,
                sampleProof.b,
                sampleProof.c,
                samplePublicSignals
            );
            const receipt1 = await tx1.wait();

            // Check for ProofCached event
            const cachedEvent = receipt1.logs.find(
                log => log.fragment && log.fragment.name === "ProofCached"
            );
            expect(cachedEvent).to.not.be.undefined;

            // Second verification (should hit cache)
            const tx2 = await zkVerifier.verifyWhitelistMembership(
                sampleProof.a,
                sampleProof.b,
                sampleProof.c,
                samplePublicSignals
            );
            const receipt2 = await tx2.wait();

            // Check for ProofCacheHit event
            const cacheHitEvent = receipt2.logs.find(
                log => log.fragment && log.fragment.name === "ProofCacheHit"
            );
            expect(cacheHitEvent).to.not.be.undefined;

            // Gas comparison (cached should be much cheaper)
            console.log(`      First verification gas: ${receipt1.gasUsed.toString()}`);
            console.log(`      Cached verification gas: ${receipt2.gasUsed.toString()}`);
            console.log(`      Gas savings: ${((1 - Number(receipt2.gasUsed) / Number(receipt1.gasUsed)) * 100).toFixed(2)}%`);

            expect(Number(receipt2.gasUsed)).to.be.lessThan(Number(receipt1.gasUsed));
        });

        it("should cache successful blacklist proof", async function() {
            const blacklistSignals = [1]; // isNotBlacklisted = 1

            // First verification
            const tx1 = await zkVerifier.verifyBlacklistNonMembership(
                sampleProof.a,
                sampleProof.b,
                sampleProof.c,
                blacklistSignals
            );
            await tx1.wait();

            // Second verification (should hit cache)
            const tx2 = await zkVerifier.verifyBlacklistNonMembership(
                sampleProof.a,
                sampleProof.b,
                sampleProof.c,
                blacklistSignals
            );
            const receipt2 = await tx2.wait();

            // Check for ProofCacheHit event
            const cacheHitEvent = receipt2.logs.find(
                log => log.fragment && log.fragment.name === "ProofCacheHit"
            );
            expect(cacheHitEvent).to.not.be.undefined;
        });

        it("should allow owner to set cache expiry", async function() {
            const newExpiry = 12 * 3600; // 12 hours

            await zkVerifier.setProofCacheExpiry(newExpiry);
            expect(await zkVerifier.proofCacheExpiry()).to.equal(newExpiry);
        });

        it("should reject invalid cache expiry times", async function() {
            // Too short (< 1 hour)
            await expect(
                zkVerifier.setProofCacheExpiry(30 * 60) // 30 minutes
            ).to.be.revertedWith("Invalid expiry time");

            // Too long (> 7 days)
            await expect(
                zkVerifier.setProofCacheExpiry(8 * 24 * 3600) // 8 days
            ).to.be.revertedWith("Invalid expiry time");
        });

        it("should clear expired proofs", async function() {
            // Verify a proof
            await zkVerifier.verifyWhitelistMembership(
                sampleProof.a,
                sampleProof.b,
                sampleProof.c,
                samplePublicSignals
            );

            // Calculate proof hash (same as contract)
            const proofHash = ethers.keccak256(
                ethers.AbiCoder.defaultAbiCoder().encode(
                    ["uint256[2]", "uint256[2][2]", "uint256[2]", "uint256[1]"],
                    [sampleProof.a, sampleProof.b, sampleProof.c, samplePublicSignals]
                )
            );

            // Set very short expiry
            await zkVerifier.setProofCacheExpiry(3600); // 1 hour

            // Fast forward time (simulate expiry)
            await ethers.provider.send("evm_increaseTime", [3601]);
            await ethers.provider.send("evm_mine");

            // Clear expired proofs
            await zkVerifier.clearExpiredProofs([proofHash]);

            // Next verification should not hit cache
            const tx = await zkVerifier.verifyWhitelistMembership(
                sampleProof.a,
                sampleProof.b,
                sampleProof.c,
                samplePublicSignals
            );
            const receipt = await tx.wait();

            // Should have ProofCached event (not ProofCacheHit)
            const cachedEvent = receipt.logs.find(
                log => log.fragment && log.fragment.name === "ProofCached"
            );
            expect(cachedEvent).to.not.be.undefined;
        });
    });

    describe("Batch Verification", function() {
        beforeEach(async function() {
            const ZKVerifierIntegrated = await ethers.getContractFactory("ZKVerifierIntegrated");
            zkVerifier = await ZKVerifierIntegrated.deploy(true); // Testing mode
            await zkVerifier.waitForDeployment();
        });

        it("should verify multiple proofs in batch", async function() {
            const circuitIds = [
                await zkVerifier.WHITELIST_MEMBERSHIP_CIRCUIT(),
                await zkVerifier.BLACKLIST_MEMBERSHIP_CIRCUIT(),
                await zkVerifier.JURISDICTION_PROOF_CIRCUIT()
            ];

            const proofs = [
                sampleProof,
                sampleProof,
                sampleProof
            ];

            const publicInputsArray = [
                [12345],
                [1], // isNotBlacklisted
                [67890]
            ];

            const tx = await zkVerifier.verifyBatchProofs(circuitIds, proofs, publicInputsArray);
            const receipt = await tx.wait();

            // Check for BatchProofsVerified event
            const batchEvent = receipt.logs.find(
                log => log.fragment && log.fragment.name === "BatchProofsVerified"
            );
            expect(batchEvent).to.not.be.undefined;

            console.log(`      Batch verification gas: ${receipt.gasUsed.toString()}`);
            console.log(`      Average gas per proof: ${(Number(receipt.gasUsed) / 3).toFixed(0)}`);
        });

        it("should reject batch with mismatched array lengths", async function() {
            const circuitIds = [await zkVerifier.WHITELIST_MEMBERSHIP_CIRCUIT()];
            const proofs = [sampleProof, sampleProof]; // Mismatch
            const publicInputsArray = [[12345]];

            await expect(
                zkVerifier.verifyBatchProofs(circuitIds, proofs, publicInputsArray)
            ).to.be.revertedWith("Array length mismatch");
        });

        it("should reject batch with invalid size", async function() {
            const circuitIds = [];
            const proofs = [];
            const publicInputsArray = [];

            await expect(
                zkVerifier.verifyBatchProofs(circuitIds, proofs, publicInputsArray)
            ).to.be.revertedWith("Invalid batch size");
        });

        it("should handle partial failures in batch", async function() {
            const circuitIds = [
                await zkVerifier.WHITELIST_MEMBERSHIP_CIRCUIT(),
                await zkVerifier.COMPLIANCE_AGGREGATION_CIRCUIT() // Will fail with wrong inputs
            ];

            const proofs = [sampleProof, sampleProof];

            const publicInputsArray = [
                [12345],
                [1] // Wrong number of inputs for compliance (needs 6)
            ];

            // Should not revert, but return partial results
            const tx = await zkVerifier.verifyBatchProofs(circuitIds, proofs, publicInputsArray);
            await tx.wait();

            // Transaction should succeed even with partial failures
            expect(tx).to.not.be.undefined;
        });
    });

    describe("Gas Optimization Statistics", function() {
        beforeEach(async function() {
            const ZKVerifierIntegrated = await ethers.getContractFactory("ZKVerifierIntegrated");
            zkVerifier = await ZKVerifierIntegrated.deploy(true);
            await zkVerifier.waitForDeployment();
        });

        it("should show gas savings with proof caching", async function() {
            const iterations = 5;
            const gasUsed = [];

            for (let i = 0; i < iterations; i++) {
                const tx = await zkVerifier.verifyWhitelistMembership(
                    sampleProof.a,
                    sampleProof.b,
                    sampleProof.c,
                    samplePublicSignals
                );
                const receipt = await tx.wait();
                gasUsed.push(Number(receipt.gasUsed));
            }

            console.log("\n      Gas Usage Pattern:");
            console.log(`      First verification: ${gasUsed[0]} gas`);
            for (let i = 1; i < iterations; i++) {
                const savings = ((1 - gasUsed[i] / gasUsed[0]) * 100).toFixed(2);
                console.log(`      Verification ${i + 1}: ${gasUsed[i]} gas (${savings}% savings)`);
            }

            // All subsequent verifications should use less gas
            for (let i = 1; i < iterations; i++) {
                expect(gasUsed[i]).to.be.lessThan(gasUsed[0]);
            }
        });
    });
});

