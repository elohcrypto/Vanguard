const { expect } = require("chai");
const { ethers } = require("hardhat");
const path = require("path");

// Import RealProofGenerator
const { RealProofGenerator } = require(
  path.join(__dirname, "../../scripts/generate-real-proofs.js"),
);

describe("Real ZK Proof Verification Tests", function () {
  let zkVerifierIntegrated;
  let realProofGenerator;
  let owner, user1, user2;

  // Increase timeout for proof generation (PLONK whitelist ~5 s, blacklist ~9 s)
  this.timeout(120000);

  before(async function () {
    console.log("\n🔧 Setting up Real ZK Proof Tests...");

    // Get signers
    [owner, user1, user2] = await ethers.getSigners();

    // testingMode=true: the proofs below are real; the wrapper's mock path
    // is what this file measures. The attestation proofs (3.7b) are generated
    // and verified on a real-mode wrapper in
    // test/proof-generation/RealProofGenerator.test.js and the three
    // *AttestationSoundness tests.
    console.log("📦 Deploying ZKVerifierIntegrated (testingMode=true)...");
    const ZKVerifierIntegratedFactory = await ethers.getContractFactory(
      "ZKVerifierIntegrated",
    );
    zkVerifierIntegrated = await ZKVerifierIntegratedFactory.deploy(true); // Testing mode
    await zkVerifierIntegrated.waitForDeployment();

    const zkAddr = await zkVerifierIntegrated.getAddress();
    console.log(`✅ ZKVerifierIntegrated deployed at: ${zkAddr}`);

    // Initialize RealProofGenerator
    console.log("🔐 Initializing RealProofGenerator...");
    realProofGenerator = new RealProofGenerator();
    await realProofGenerator.initialize();
    console.log("✅ RealProofGenerator initialized\n");
  });

  describe("1. Whitelist Membership Proofs", function () {
    it("should generate and verify valid whitelist proof", async function () {
      console.log(
        "  🔐 Generating whitelist proof (this may take ~50 seconds)...",
      );

      const members = [
        { identity: 11111n, secret: 101n },
        { identity: 12345n, secret: 202n },
        { identity: 33333n, secret: 303n },
      ];

      const startTime = Date.now();
      const result = await realProofGenerator.generateWhitelistProof({
        ...members[1],
        members,
        walletBinding: user1.address,
      });
      const duration = Date.now() - startTime;

      console.log(
        `  ✅ Proof generated in ${duration}ms (${(duration / 1000).toFixed(2)}s)`,
      );

      // Verify proof structure
      // PLONK: 24 proof words, [nullifier, merkleRoot, walletBinding]
      expect(result.proof).to.have.lengthOf(24);
      expect(result.publicSignals).to.be.an("array");
      expect(result.publicSignals.length).to.equal(3);

      // Verify on-chain
      console.log("  🔍 Verifying proof on-chain...");
      const tx = await zkVerifierIntegrated.verifyWhitelistMembership(
        result.proof,
        result.publicSignals,
      );
      const receipt = await tx.wait();

      console.log(
        `  ✅ Proof verified on-chain! Gas used: ${receipt.gasUsed.toString()}`,
      );
      expect(receipt.status).to.equal(1);
    });

    it("should verify second whitelist proof with different identity", async function () {
      console.log("  🔐 Generating second whitelist proof...");

      // Generate proof for different identity in same whitelist
      const members = [
        { identity: 11111n, secret: 101n },
        { identity: 22222n, secret: 202n },
        { identity: 33333n, secret: 303n },
      ];

      const startTime = Date.now();
      const result = await realProofGenerator.generateWhitelistProof({
        ...members[2],
        members,
        walletBinding: user1.address,
      });
      const duration = Date.now() - startTime;

      console.log(
        `  ✅ Second proof generated in ${duration}ms (${(duration / 1000).toFixed(2)}s)`,
      );

      // Verify on-chain
      console.log("  🔍 Verifying second proof on-chain...");
      const tx = await zkVerifierIntegrated.verifyWhitelistMembership(
        result.proof,
        result.publicSignals,
      );
      const receipt = await tx.wait();

      console.log(
        `  ✅ Second proof verified! Gas used: ${receipt.gasUsed.toString()}`,
      );
      expect(receipt.status).to.equal(1);
    });
  });

  describe("2. Blacklist Non-Membership Proofs", function () {
    it("should generate and verify valid blacklist proof", async function () {
      console.log("  🔐 Generating blacklist proof (PLONK, ~9 seconds)...");

      // The prover is a whitelisted commitment; the sanctions list is a
      // sparse Merkle tree of identities (Task 3.7).
      const members = [
        { identity: 11111n, secret: 101n },
        { identity: 12345n, secret: 202n },
      ];
      const blacklistIdentities = [BigInt(99999), BigInt(88888)]; // User NOT in blacklist

      const startTime = Date.now();
      const result = await realProofGenerator.generateBlacklistProof({
        ...members[1],
        members,
        blacklistIdentities,
        walletBinding: user1.address,
      });
      const duration = Date.now() - startTime;

      console.log(
        `  ✅ Proof generated in ${duration}ms (${(duration / 1000).toFixed(2)}s)`,
      );

      // PLONK: 24 proof words,
      // [nullifier, whitelistRoot, blacklistRoot, walletBinding]
      expect(result.proof).to.have.lengthOf(24);
      expect(result.publicSignals).to.be.an("array");
      expect(result.publicSignals.length).to.equal(4);

      // Verify on-chain
      console.log("  🔍 Verifying proof on-chain...");
      const tx = await zkVerifierIntegrated.verifyBlacklistNonMembership(
        result.proof,
        result.publicSignals,
      );
      const receipt = await tx.wait();

      console.log(
        `  ✅ Proof verified on-chain! Gas used: ${receipt.gasUsed.toString()}`,
      );
      expect(receipt.status).to.equal(1);
    });
  });

  after(function () {
    console.log("\n✅ All Real ZK Proof Tests Complete!\n");
  });
});
