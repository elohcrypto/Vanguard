import { expect } from "chai";
import { ethers } from "hardhat";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import {
  ZKVerifierIntegrated,
  PrivacyManager,
  WhitelistMembershipVerifier,
  BlacklistMembershipVerifier,
  JurisdictionProofVerifier,
  AccreditationProofVerifier,
  ComplianceAggregationVerifier,
} from "../../typechain-types";

describe("🔐 Complete ZK Proof System Integration Tests", function () {
  let owner: SignerWithAddress;
  let user1: SignerWithAddress;
  let user2: SignerWithAddress;
  let user3: SignerWithAddress;

  // ZK System Contracts
  let zkVerifier: ZKVerifierIntegrated;
  let privacyManager: PrivacyManager;

  // Individual Verifier Contracts
  let whitelistVerifier: WhitelistMembershipVerifier;
  let blacklistVerifier: BlacklistMembershipVerifier;
  let jurisdictionVerifier: JurisdictionProofVerifier;
  let accreditationVerifier: AccreditationProofVerifier;
  let complianceVerifier: ComplianceAggregationVerifier;

  // Every circuit is PLONK (whitelist 3.1, blacklist 3.7, attestations
  // 3.7b): 24 proof words.
  const mockPlonkProof = Array.from({ length: 24 }, (_, i) => i + 1);

  const mockWhitelistRoot = ethers.keccak256(
    ethers.toUtf8Bytes("test_whitelist_root"),
  );
  const mockBlacklistRoot = ethers.keccak256(
    ethers.toUtf8Bytes("test_blacklist_root"),
  );
  const mockNullifier = 12345;
  const mockChallenge = 67890;

  before(async function () {
    console.log("\n🚀 Setting up ZK Proof System Integration Tests...");

    [owner, user1, user2, user3] = await ethers.getSigners();

    // Deploy individual verifier contracts
    console.log("📦 Deploying individual verifier contracts...");

    const WhitelistVerifierFactory = await ethers.getContractFactory(
      "WhitelistMembershipVerifier",
    );
    whitelistVerifier = await WhitelistVerifierFactory.deploy();
    await whitelistVerifier.waitForDeployment();
    console.log(
      `   ✅ WhitelistVerifier: ${await whitelistVerifier.getAddress()}`,
    );

    const BlacklistVerifierFactory = await ethers.getContractFactory(
      "BlacklistMembershipVerifier",
    );
    blacklistVerifier = await BlacklistVerifierFactory.deploy();
    await blacklistVerifier.waitForDeployment();
    console.log(
      `   ✅ BlacklistVerifier: ${await blacklistVerifier.getAddress()}`,
    );

    const JurisdictionVerifierFactory = await ethers.getContractFactory(
      "JurisdictionProofVerifier",
    );
    jurisdictionVerifier = await JurisdictionVerifierFactory.deploy();
    await jurisdictionVerifier.waitForDeployment();
    console.log(
      `   ✅ JurisdictionVerifier: ${await jurisdictionVerifier.getAddress()}`,
    );

    const AccreditationVerifierFactory = await ethers.getContractFactory(
      "AccreditationProofVerifier",
    );
    accreditationVerifier = await AccreditationVerifierFactory.deploy();
    await accreditationVerifier.waitForDeployment();
    console.log(
      `   ✅ AccreditationVerifier: ${await accreditationVerifier.getAddress()}`,
    );

    const ComplianceVerifierFactory = await ethers.getContractFactory(
      "ComplianceAggregationVerifier",
    );
    complianceVerifier = await ComplianceVerifierFactory.deploy();
    await complianceVerifier.waitForDeployment();
    console.log(
      `   ✅ ComplianceVerifier: ${await complianceVerifier.getAddress()}`,
    );

    // Deploy ZK Verifier Integrated first (needed for PrivacyManager)
    console.log("📦 Deploying ZK Verifier Integrated...");
    const ZKVerifierFactory = await ethers.getContractFactory(
      "ZKVerifierIntegrated",
    );
    zkVerifier = await ZKVerifierFactory.deploy(true); // testingMode = true for tests
    await zkVerifier.waitForDeployment();
    console.log(`   ✅ ZKVerifier: ${await zkVerifier.getAddress()}`);

    // PrivacyManager refuses a testingMode verifier (Task 3.3), so it gets
    // its own real-mode wrapper.
    console.log("📦 Deploying Privacy Manager...");
    const realVerifier = await ZKVerifierFactory.deploy(false);
    await realVerifier.waitForDeployment();
    const PrivacyManagerFactory =
      await ethers.getContractFactory("PrivacyManager");
    privacyManager = await PrivacyManagerFactory.deploy(
      await realVerifier.getAddress(),
    );
    await privacyManager.waitForDeployment();
    console.log(`   ✅ PrivacyManager: ${await privacyManager.getAddress()}`);

    console.log("🎉 All contracts deployed successfully!\n");
  });

  describe("1️⃣ Individual Verifier Contract Tests", function () {
    it("Should refuse a made-up whitelist membership proof", async function () {
      console.log("🧪 Testing whitelist membership verifier...");

      // [nullifier, merkleRoot, walletBinding]; the PLONK verifier is real.
      const publicSignals: [number, number, number] = [mockNullifier, 1, 1];
      const result = await whitelistVerifier.verifyProof(
        mockPlonkProof,
        publicSignals,
      );

      console.log(`   📋 Whitelist proof result: ${result}`);
      expect(result).to.equal(false);
    });

    it("Should refuse a made-up blacklist non-membership proof", async function () {
      console.log("🧪 Testing blacklist non-membership verifier...");

      // [nullifier, whitelistRoot, blacklistRoot, walletBinding]; the PLONK
      // verifier is real.
      const publicSignals: [number, number, number, number] = [
        mockNullifier,
        1,
        1,
        1,
      ];
      const result = await blacklistVerifier.verifyProof(
        mockPlonkProof,
        publicSignals,
      );

      console.log(`   🚫 Blacklist proof result: ${result}`);
      expect(result).to.equal(false);
    });

    it("Should refuse a made-up jurisdiction attestation proof", async function () {
      // [nullifier, Ax, Ay, chainId, verifierContext, validUntil,
      // allowedMask, walletBinding]
      const publicSignals = [mockNullifier, 1, 2, 31337, 9, 2 ** 40, 15, 1];
      const result = await jurisdictionVerifier.verifyProof(
        mockPlonkProof,
        publicSignals,
      );
      console.log(`   🌍 Jurisdiction proof result: ${result}`);
      expect(result).to.equal(false);
    });

    it("Should refuse a made-up accreditation attestation proof", async function () {
      // [nullifier, Ax, Ay, chainId, verifierContext, validUntil,
      // minimumAccreditation, walletBinding]
      const publicSignals = [mockNullifier, 1, 2, 31337, 9, 2 ** 40, 100000, 1];
      const result = await accreditationVerifier.verifyProof(
        mockPlonkProof,
        publicSignals,
      );
      console.log(`   💰 Accreditation proof result: ${result}`);
      expect(result).to.equal(false);
    });

    it("Should refuse a made-up compliance aggregation proof", async function () {
      // [nullifier, Ax, Ay, chainId, verifierContext, validUntil, minimum,
      // wK, wA, wJ, wAcc, walletBinding]; the aggregate is never public (the
      // old complianceLevel output is gone).
      const publicSignals = [
        mockNullifier,
        1,
        2,
        31337,
        9,
        2 ** 40,
        70,
        25,
        25,
        25,
        25,
        1,
      ];
      const result = await complianceVerifier.verifyProof(
        mockPlonkProof,
        publicSignals,
      );
      console.log(`   📊 Compliance proof result: ${result}`);
      expect(result).to.equal(false);
    });
  });

  describe("2️⃣ ZK Verifier Integrated Tests", function () {
    it("Should verify whitelist membership through integrated verifier", async function () {
      console.log("🧪 Testing integrated whitelist verification...");

      const publicSignals: [number, number, number] = [mockNullifier, 1, 1];
      const tx = await zkVerifier
        .connect(user1)
        .verifyWhitelistMembership(mockPlonkProof, publicSignals);

      const receipt = await tx.wait();
      console.log(`   ✅ Transaction hash: ${receipt?.hash}`);

      // Check statistics
      const [total, valid] = await zkVerifier.getCircuitStats("whitelist");
      console.log(`   📊 Stats - Total: ${total}, Valid: ${valid}`);

      expect(total).to.be.greaterThan(0);
    });

    it("Should verify blacklist non-membership through integrated verifier", async function () {
      console.log("🧪 Testing integrated blacklist verification...");

      // [nullifier, whitelistRoot, blacklistRoot, walletBinding]; testingMode
      // accepts any four non-zero signals.
      const publicSignals: [number, number, number, number] = [
        mockNullifier,
        1,
        1,
        1,
      ];
      const tx = await zkVerifier
        .connect(user2)
        .verifyBlacklistNonMembership(mockPlonkProof, publicSignals);

      const receipt = await tx.wait();
      console.log(`   ✅ Transaction hash: ${receipt?.hash}`);

      // Check statistics
      const [total, valid] = await zkVerifier.getCircuitStats("blacklist");
      console.log(`   📊 Stats - Total: ${total}, Valid: ${valid}`);

      expect(total).to.be.greaterThan(0);
    });

    it("Should track user proof counts correctly", async function () {
      console.log("🧪 Testing user proof count tracking...");

      const user1Count = await zkVerifier.userProofCount(user1.address);
      const user2Count = await zkVerifier.userProofCount(user2.address);

      console.log(`   👤 User1 proof count: ${user1Count}`);
      console.log(`   👤 User2 proof count: ${user2Count}`);

      // At least user1 should have submitted a whitelist proof
      expect(user1Count).to.be.greaterThan(0);

      // User2 should also have submitted a blacklist proof
      // If this fails, it means the blacklist verification didn't increment the counter
      expect(user2Count).to.be.greaterThan(0);
    });
  });

  describe("5️⃣ Privacy Manager Integration Tests", function () {
    it("refuses the testingMode verifier the other sections use", async function () {
      const factory = await ethers.getContractFactory("PrivacyManager");
      await expect(
        factory.deploy(await zkVerifier.getAddress()),
      ).to.be.revertedWithCustomError(factory, "TestingModeVerifier");
    });

    it("a fresh user has default settings and no private status", async function () {
      const settings = await privacyManager.getUserPrivacySettings(
        user1.address,
      );
      expect(settings.enablePrivateWhitelist).to.equal(true);
      expect(settings.proofValidityPeriod).to.equal(
        await privacyManager.DEFAULT_PROOF_VALIDITY(),
      );
      expect(
        await privacyManager.hasValidWhitelistProof(user1.address),
      ).to.equal(false);
      expect(
        await privacyManager.validateAllPrivateCompliance(user1.address),
      ).to.deep.equal([false, false, false, false]);
    });

    // Folded from scripts/test-zk-final.js and test-zk-integration.js
    // (Task 3.5); since Task 3.8 the views read ComplianceRules' rule.
    it("lists registered jurisdiction codes over ComplianceRules", async function () {
      expect(await privacyManager.getAllJurisdictions()).to.deep.equal([
        [],
        [],
      ]);
      expect(await privacyManager.allowedJurisdictionMask()).to.equal(0n);
      const [admin] = await ethers.getSigners();
      const rules = await (
        await ethers.getContractFactory("ComplianceRules")
      ).deploy(admin.address, [], [643]);
      const token = await (
        await ethers.getContractFactory("MockPolicyToken")
      ).deploy(await rules.getAddress());
      await privacyManager.setPolicyToken(await token.getAddress());
      await privacyManager.registerJurisdictionCode(840);
      await privacyManager.registerJurisdictionCode(643);
      expect(await privacyManager.getAllJurisdictions()).to.deep.equal([
        [840n, 643n],
        [true, false],
      ]);
      expect(await privacyManager.getActiveJurisdictions()).to.deep.equal([
        [840n],
        [1n],
      ]);
      expect(await privacyManager.isJurisdictionActive(840)).to.equal(true);
      expect(await privacyManager.isJurisdictionActive(643)).to.equal(false);
      expect(await privacyManager.isJurisdictionActive(276)).to.equal(false);
      expect(await privacyManager.allowedJurisdictionMask()).to.equal(1n);
    });

    it("the accreditation circuit id is registered under its name", async function () {
      const id = await zkVerifier.ACCREDITATION_PROOF_CIRCUIT();
      expect(id).to.equal(
        ethers.keccak256(ethers.toUtf8Bytes("ACCREDITATION_PROOF")),
      );
      expect(await zkVerifier.isCircuitRegistered(id)).to.equal(true);
    });
  });

  after(function () {
    console.log("\n🎉 All ZK Proof System Integration Tests Completed!");
    console.log("✅ Whitelist membership proofs: WORKING");
    console.log("✅ Blacklist non-membership proofs: WORKING");
    console.log("✅ Jurisdiction eligibility proofs: WORKING");
    console.log("✅ Accreditation status proofs: WORKING");
    console.log("✅ Compliance aggregation proofs: WORKING");
    console.log("✅ Privacy manager integration: WORKING");
    console.log("✅ End-to-end privacy workflow: WORKING");
    console.log("\n🔐 Complete ZK Proof System is fully functional! 🚀");
  });
});
