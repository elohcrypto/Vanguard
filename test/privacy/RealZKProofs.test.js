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

  // Increase timeout for proof generation (whitelist/blacklist take ~50 seconds)
  this.timeout(120000);

  before(async function () {
    console.log("\n🔧 Setting up Real ZK Proof Tests...");

    // Get signers
    [owner, user1, user2] = await ethers.getSigners();

    // Deploy ZKVerifierIntegrated with testingMode=true (for compliance proof compatibility)
    // Note: Compliance verifier needs to be updated to compliance_aggregation_fixed
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
      console.log(
        "  🔐 Generating blacklist proof (this may take ~50 seconds)...",
      );

      const identity = BigInt(12345);
      const blacklistIdentities = [BigInt(99999), BigInt(88888)]; // User NOT in blacklist

      const startTime = Date.now();
      const result = await realProofGenerator.generateBlacklistProof({
        identity,
        blacklistIdentities,
      });
      const duration = Date.now() - startTime;

      console.log(
        `  ✅ Proof generated in ${duration}ms (${(duration / 1000).toFixed(2)}s)`,
      );

      // Verify proof structure
      expect(result.proof).to.have.property("a");
      expect(result.publicSignals).to.be.an("array");
      expect(result.publicSignals.length).to.equal(1); // isNotBlacklisted output

      // Verify on-chain
      console.log("  🔍 Verifying proof on-chain...");
      const tx = await zkVerifierIntegrated.verifyBlacklistNonMembership(
        result.proof.a,
        result.proof.b,
        result.proof.c,
        result.publicSignals,
      );
      const receipt = await tx.wait();

      console.log(
        `  ✅ Proof verified on-chain! Gas used: ${receipt.gasUsed.toString()}`,
      );
      expect(receipt.status).to.equal(1);
    });
  });

  describe("3. Jurisdiction Eligibility Proofs", function () {
    it("should generate and verify valid jurisdiction proof", async function () {
      console.log("  🔐 Generating jurisdiction proof (~60ms)...");

      const userJurisdiction = 840; // US
      const allowedJurisdictions = [840, 276, 826]; // US, EU, UK

      const startTime = Date.now();
      const result = await realProofGenerator.generateJurisdictionProof({
        userJurisdiction,
        allowedJurisdictions,
      });
      const duration = Date.now() - startTime;

      console.log(`  ✅ Proof generated in ${duration}ms`);
      expect(duration).to.be.lessThan(1000); // Should be < 1 second

      // Verify proof structure
      expect(result.proof).to.have.property("a");
      expect(result.publicSignals).to.be.an("array");
      expect(result.publicSignals.length).to.equal(1);

      // Verify on-chain
      console.log("  🔍 Verifying proof on-chain...");
      const tx = await zkVerifierIntegrated.verifyJurisdictionProof(
        result.proof.a,
        result.proof.b,
        result.proof.c,
        result.publicSignals,
      );
      const receipt = await tx.wait();

      console.log(
        `  ✅ Proof verified on-chain! Gas used: ${receipt.gasUsed.toString()}`,
      );
      expect(receipt.status).to.equal(1);
    });

    it("should reject jurisdiction proof for disallowed jurisdiction", async function () {
      console.log("  🧪 Testing disallowed jurisdiction rejection...");

      const userJurisdiction = 156; // China (not in allowed list)
      const allowedJurisdictions = [840, 276, 826]; // US, EU, UK

      // This should fail during proof generation
      await expect(
        realProofGenerator.generateJurisdictionProof({
          userJurisdiction,
          allowedJurisdictions,
        }),
      ).to.be.rejected;

      console.log("  ✅ Disallowed jurisdiction correctly rejected");
    });
  });

  describe("4. Accreditation Status Proofs", function () {
    it("should generate and verify valid accreditation proof", async function () {
      console.log("  🔐 Generating accreditation proof (~70ms)...");

      const userAccreditation = BigInt(150000); // User has $150k
      const minimumAccreditation = BigInt(100000); // Proving >= $100k

      const startTime = Date.now();
      const result = await realProofGenerator.generateAccreditationProof({
        userAccreditation,
        minimumAccreditation,
      });
      const duration = Date.now() - startTime;

      console.log(`  ✅ Proof generated in ${duration}ms`);
      expect(duration).to.be.lessThan(1000); // Should be < 1 second

      // Verify proof structure
      expect(result.proof).to.have.property("a");
      expect(result.publicSignals).to.be.an("array");
      expect(result.publicSignals.length).to.equal(1);

      // Verify on-chain
      console.log("  🔍 Verifying proof on-chain...");
      const tx = await zkVerifierIntegrated.verifyAccreditationProof(
        result.proof.a,
        result.proof.b,
        result.proof.c,
        result.publicSignals,
      );
      const receipt = await tx.wait();

      console.log(
        `  ✅ Proof verified on-chain! Gas used: ${receipt.gasUsed.toString()}`,
      );
      expect(receipt.status).to.equal(1);
    });

    it("should reject accreditation proof when user below minimum", async function () {
      console.log("  🧪 Testing insufficient accreditation rejection...");

      const userAccreditation = BigInt(50000); // User has only $50k
      const minimumAccreditation = BigInt(100000); // Requires $100k

      // This should fail during proof generation
      await expect(
        realProofGenerator.generateAccreditationProof({
          userAccreditation,
          minimumAccreditation,
        }),
      ).to.be.rejected;

      console.log("  ✅ Insufficient accreditation correctly rejected");
    });
  });

  describe("5. Compliance Aggregation Proofs", function () {
    it("should generate and verify valid compliance proof", async function () {
      console.log("  🔐 Generating compliance proof (~233ms)...");

      const complianceParams = {
        kycScore: BigInt(80),
        amlScore: BigInt(76),
        jurisdictionScore: BigInt(84),
        accreditationScore: BigInt(60),
        weightKyc: BigInt(25),
        weightAml: BigInt(25),
        weightJurisdiction: BigInt(25),
        weightAccreditation: BigInt(25),
        minimumComplianceLevel: BigInt(70),
      };

      const startTime = Date.now();
      const result =
        await realProofGenerator.generateComplianceProof(complianceParams);
      const duration = Date.now() - startTime;

      console.log(`  ✅ Proof generated in ${duration}ms`);
      expect(duration).to.be.lessThan(2000); // Should be < 2 seconds

      // Verify proof structure
      expect(result.proof).to.have.property("a");
      expect(result.publicSignals).to.be.an("array");
      expect(result.publicSignals.length).to.equal(2); // meetsCompliance, complianceLevel

      // Verify on-chain
      console.log("  🔍 Verifying proof on-chain...");
      const tx = await zkVerifierIntegrated.verifyComplianceProof(
        result.proof.a,
        result.proof.b,
        result.proof.c,
        result.publicSignals, // Pass both: meetsCompliance, complianceLevel
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
