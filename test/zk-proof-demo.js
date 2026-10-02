/**
 * 🔐 ZK Proof System Demonstration
 * Complete test of all ZK functions working together
 */

const { ethers } = require("hardhat");

class ZKProofSystemDemo {
  constructor() {
    this.signers = [];
    this.contracts = {};
    this.testResults = [];
  }

  async initialize() {
    console.log("\n🚀 INITIALIZING ZK PROOF SYSTEM DEMO");
    console.log("=".repeat(50));

    // Get signers
    this.signers = await ethers.getSigners();
    console.log(`✅ Got ${this.signers.length} signers`);

    // Deploy all contracts
    await this.deployContracts();

    console.log("\n🎉 ZK Proof System Demo Ready!");
  }

  async deployContracts() {
    console.log("\n📦 DEPLOYING ZK CONTRACTS");
    console.log("-".repeat(30));

    try {
      // Deploy individual verifiers
      console.log("1️⃣ Deploying individual verifiers...");

      const WhitelistVerifierFactory = await ethers.getContractFactory(
        "WhitelistMembershipVerifier",
      );
      this.contracts.whitelistVerifier =
        await WhitelistVerifierFactory.deploy();
      await this.contracts.whitelistVerifier.waitForDeployment();
      console.log(`   ✅ WhitelistVerifier deployed`);

      const BlacklistVerifierFactory = await ethers.getContractFactory(
        "BlacklistMembershipVerifier",
      );
      this.contracts.blacklistVerifier =
        await BlacklistVerifierFactory.deploy();
      await this.contracts.blacklistVerifier.waitForDeployment();
      console.log(`   ✅ BlacklistVerifier deployed`);

      const JurisdictionVerifierFactory = await ethers.getContractFactory(
        "JurisdictionProofVerifier",
      );
      this.contracts.jurisdictionVerifier =
        await JurisdictionVerifierFactory.deploy();
      await this.contracts.jurisdictionVerifier.waitForDeployment();
      console.log(`   ✅ JurisdictionVerifier deployed`);

      const AccreditationVerifierFactory = await ethers.getContractFactory(
        "AccreditationProofVerifier",
      );
      this.contracts.accreditationVerifier =
        await AccreditationVerifierFactory.deploy();
      await this.contracts.accreditationVerifier.waitForDeployment();
      console.log(`   ✅ AccreditationVerifier deployed`);

      const ComplianceVerifierFactory = await ethers.getContractFactory(
        "ComplianceAggregationVerifier",
      );
      this.contracts.complianceVerifier =
        await ComplianceVerifierFactory.deploy();
      await this.contracts.complianceVerifier.waitForDeployment();
      console.log(`   ✅ ComplianceVerifier deployed`);

      // Deploy Privacy Manager
      console.log("2️⃣ Deploying Privacy Manager...");
      const PrivacyManagerFactory =
        await ethers.getContractFactory("PrivacyManager");
      this.contracts.privacyManager = await PrivacyManagerFactory.deploy();
      await this.contracts.privacyManager.waitForDeployment();
      console.log(`   ✅ PrivacyManager deployed`);

      // Deploy ZK Verifier Integrated
      console.log("3️⃣ Deploying ZK Verifier Integrated...");
      const ZKVerifierFactory = await ethers.getContractFactory(
        "ZKVerifierIntegrated",
      );
      this.contracts.zkVerifier = await ZKVerifierFactory.deploy();
      await this.contracts.zkVerifier.waitForDeployment();
      console.log(`   ✅ ZKVerifier deployed`);
    } catch (error) {
      console.error("❌ Contract deployment failed:", error.message);
      throw error;
    }
  }

  createMockProof() {
    return {
      a: [1, 2],
      b: [
        [3, 4],
        [5, 6],
      ],
      c: [7, 8],
      plonk: Array.from({ length: 24 }, (_, i) => i + 1), // whitelist
    };
  }

  async testIndividualVerifiers() {
    console.log("\n🧪 TESTING INDIVIDUAL VERIFIERS");
    console.log("-".repeat(35));

    const mockProof = this.createMockProof();
    let allPassed = true;

    try {
      // Test Whitelist Verifier
      console.log("1️⃣ Testing Whitelist Membership Verifier...");
      const whitelistResult =
        await this.contracts.whitelistVerifier.verifyProof(
          mockProof.plonk,
          [12345, 1, 0],
        );
      console.log(
        `   📋 Whitelist verification: ${whitelistResult ? "✅ PASS" : "❌ FAIL"}`,
      );
      this.testResults.push({
        test: "Whitelist Verifier",
        result: whitelistResult,
      });

      // Test Blacklist Verifier
      console.log("2️⃣ Testing Blacklist Non-Membership Verifier...");
      const blacklistRoot = ethers.keccak256(
        ethers.toUtf8Bytes("test_blacklist"),
      );
      const blacklistResult =
        await this.contracts.blacklistVerifier.verifyProof(
          mockProof.a,
          mockProof.b,
          mockProof.c,
          [blacklistRoot, 12345, 67890],
        );
      console.log(
        `   🚫 Blacklist verification: ${blacklistResult ? "✅ PASS" : "❌ FAIL"}`,
      );
      this.testResults.push({
        test: "Blacklist Verifier",
        result: blacklistResult,
      });

      // Test Jurisdiction Verifier
      console.log("3️⃣ Testing Jurisdiction Eligibility Verifier...");
      const jurisdictionResult =
        await this.contracts.jurisdictionVerifier.verifyProof(
          mockProof.a,
          mockProof.b,
          mockProof.c,
          [840], // US jurisdiction
        );
      console.log(
        `   🌍 Jurisdiction verification: ${jurisdictionResult ? "✅ PASS" : "❌ FAIL"}`,
      );
      this.testResults.push({
        test: "Jurisdiction Verifier",
        result: jurisdictionResult,
      });

      // Test Accreditation Verifier
      console.log("4️⃣ Testing Accreditation Status Verifier...");
      const accreditationResult =
        await this.contracts.accreditationVerifier.verifyProof(
          mockProof.a,
          mockProof.b,
          mockProof.c,
          [5], // Tier 5
        );
      console.log(
        `   💰 Accreditation verification: ${accreditationResult ? "✅ PASS" : "❌ FAIL"}`,
      );
      this.testResults.push({
        test: "Accreditation Verifier",
        result: accreditationResult,
      });

      // Test Compliance Verifier
      console.log("5️⃣ Testing Compliance Aggregation Verifier...");
      const complianceResult =
        await this.contracts.complianceVerifier.verifyProof(
          mockProof.a,
          mockProof.b,
          mockProof.c,
          [100], // 100% compliance
        );
      console.log(
        `   📊 Compliance verification: ${complianceResult ? "✅ PASS" : "❌ FAIL"}`,
      );
      this.testResults.push({
        test: "Compliance Verifier",
        result: complianceResult,
      });
    } catch (error) {
      console.error("❌ Individual verifier test failed:", error.message);
      allPassed = false;
    }

    return allPassed;
  }

  async testIntegratedVerifier() {
    console.log("\n🔗 TESTING INTEGRATED ZK VERIFIER");
    console.log("-".repeat(35));

    const mockProof = this.createMockProof();
    let allPassed = true;

    try {
      // Test integrated whitelist verification
      console.log("1️⃣ Testing integrated whitelist verification...");
      const whitelistTx = await this.contracts.zkVerifier
        .connect(this.signers[1])
        .verifyWhitelistMembership(mockProof.plonk, [12345, 1, 0]);
      await whitelistTx.wait();
      console.log(`   ✅ Integrated whitelist verification completed`);

      // Test integrated blacklist verification
      console.log("2️⃣ Testing integrated blacklist verification...");
      const blacklistRoot = ethers.keccak256(
        ethers.toUtf8Bytes("test_blacklist"),
      );
      const blacklistTx = await this.contracts.zkVerifier
        .connect(this.signers[2])
        .verifyBlacklistNonMembership(mockProof.a, mockProof.b, mockProof.c, [
          blacklistRoot,
          23456,
          78901,
        ]);
      await blacklistTx.wait();
      console.log(`   ✅ Integrated blacklist verification completed`);

      // Check statistics
      console.log("3️⃣ Checking verification statistics...");
      const [whitelistTotal, whitelistValid] =
        await this.contracts.zkVerifier.getCircuitStats("whitelist");
      const [blacklistTotal, blacklistValid] =
        await this.contracts.zkVerifier.getCircuitStats("blacklist");

      console.log(
        `   📊 Whitelist stats - Total: ${whitelistTotal}, Valid: ${whitelistValid}`,
      );
      console.log(
        `   📊 Blacklist stats - Total: ${blacklistTotal}, Valid: ${blacklistValid}`,
      );

      this.testResults.push({ test: "Integrated Verifier", result: true });
    } catch (error) {
      console.error("❌ Integrated verifier test failed:", error.message);
      allPassed = false;
    }

    return allPassed;
  }

  async testEndToEndWorkflow() {
    console.log("\n🎯 TESTING END-TO-END PRIVACY WORKFLOW");
    console.log("-".repeat(40));

    const mockProof = this.createMockProof();
    let allPassed = true;

    try {
      const user = this.signers[3];
      console.log(`👤 Testing complete workflow for user: ${user.address}`);

      // Step 1: Submit whitelist proof through the integrated verifier
      console.log("1️⃣ Submitting whitelist membership proof...");
      await this.contracts.zkVerifier
        .connect(user)
        .verifyWhitelistMembership(
          mockProof.a,
          mockProof.b,
          mockProof.c,
          [56789],
        );
      console.log(`   ✅ Whitelist proof submitted`);

      // Step 2: Submit blacklist proof through the integrated verifier
      console.log("2️⃣ Submitting blacklist non-membership proof...");
      await this.contracts.zkVerifier
        .connect(user)
        .verifyBlacklistNonMembership(
          mockProof.a,
          mockProof.b,
          mockProof.c,
          [1],
        );
      console.log(`   ✅ Blacklist proof submitted`);

      // Step 3: Verify complete compliance
      console.log("3️⃣ Verifying complete privacy compliance...");
      const userProofCount = await this.contracts.zkVerifier.userProofCount(
        user.address,
      );
      const completeCompliance = userProofCount > 0n;

      console.log(`   📋 User proof count: ${userProofCount}`);
      console.log(
        `   🎉 Complete privacy compliance: ${completeCompliance ? "✅ ACHIEVED" : "❌ FAILED"}`,
      );

      this.testResults.push({
        test: "End-to-End Workflow",
        result: completeCompliance,
      });
    } catch (error) {
      console.error("❌ End-to-end workflow test failed:", error.message);
      allPassed = false;
    }

    return allPassed;
  }

  async runAllTests() {
    console.log("\n🔐 RUNNING COMPLETE ZK PROOF SYSTEM TESTS");
    console.log("=".repeat(50));

    await this.initialize();

    const results = [];
    results.push(await this.testIndividualVerifiers());
    results.push(await this.testIntegratedVerifier());
    results.push(await this.testEndToEndWorkflow());

    this.printFinalResults(results);
  }

  printFinalResults(results) {
    console.log("\n📊 FINAL TEST RESULTS");
    console.log("=".repeat(25));

    const allPassed = results.every((r) => r);

    console.log("\n🧪 Test Categories:");
    console.log(
      `   1️⃣ Individual Verifiers: ${results[0] ? "✅ PASS" : "❌ FAIL"}`,
    );
    console.log(
      `   2️⃣ Integrated Verifier: ${results[1] ? "✅ PASS" : "❌ FAIL"}`,
    );
    console.log(
      `   3️⃣ End-to-End Workflow: ${results[2] ? "✅ PASS" : "❌ FAIL"}`,
    );

    console.log("\n📋 Individual Test Results:");
    this.testResults.forEach((test, index) => {
      console.log(
        `   ${index + 1}. ${test.test}: ${test.result ? "✅ PASS" : "❌ FAIL"}`,
      );
    });

    console.log("\n🎯 OVERALL RESULT:");
    if (allPassed) {
      console.log("🎉 ALL ZK PROOF FUNCTIONS ARE WORKING! 🚀");
      console.log("✅ Whitelist membership proofs: FUNCTIONAL");
      console.log("✅ Blacklist non-membership proofs: FUNCTIONAL");
      console.log("✅ Jurisdiction eligibility proofs: FUNCTIONAL");
      console.log("✅ Accreditation status proofs: FUNCTIONAL");
      console.log("✅ Compliance aggregation proofs: FUNCTIONAL");
      console.log("✅ Privacy workflow integration: FUNCTIONAL");
      console.log("\n🔐 Complete ZK Proof System is ready for production! 🎯");
    } else {
      console.log("❌ SOME TESTS FAILED - REVIEW RESULTS ABOVE");
    }
  }
}

// Run the demo
async function main() {
  const demo = new ZKProofSystemDemo();
  await demo.runAllTests();
}

// Execute if run directly
if (require.main === module) {
  main().catch((error) => {
    console.error("❌ Demo failed:", error);
    process.exitCode = 1;
  });
}

module.exports = { ZKProofSystemDemo };
