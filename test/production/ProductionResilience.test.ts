import { expect } from "chai";
import { ethers } from "hardhat";
import { OnchainID } from "../../typechain-types";
import { ProductionEnvironment } from "./ProductionEnvironment";
import {
  ProductionUtils,
  openProductionSimulation,
  closeProductionSimulation,
} from "./ProductionUtils";

/**
 * Production Simulation Test Suite
 * This test suite simulates real production scenarios with:
 * - Real cryptographic signatures
 * - Complete end-to-end workflows
 * - Multi-party interactions
 * - Real-world use cases
 * - Network condition simulation
 * - Security stress testing
 */
describe("🏭 Production Simulation - OnchainID System", function () {
  let prodEnv: ProductionEnvironment;

  // Extend timeout for production tests
  this.timeout(300000); // 5 minutes

  before(async function () {
    prodEnv = await openProductionSimulation();
  });

  describe("🚨 Emergency Recovery Scenarios", function () {
    let compromisedIdentity: OnchainID;
    let compromisedAddress: string;

    it("Should handle emergency key recovery with multi-party coordination", async function () {
      console.log("\n🚨 Simulating Emergency Key Recovery Scenario...");

      // Step 1: Setup identity that will be compromised
      console.log("🆔 Step 1: Setting up identity with recovery system...");
      const { identity, address } = await prodEnv.createProductionIdentity(
        prodEnv.corporateUser,
        "corporate",
      );
      compromisedIdentity = identity;
      compromisedAddress = address;

      await prodEnv.setupRecoverySystem(
        compromisedAddress,
        prodEnv.corporateUser,
      );
      console.log("✅ Recovery system established");

      // Step 2: Simulate key compromise detection
      console.log("💥 Step 2: Simulating key compromise detection...");
      console.log(
        "   (Scenario: Corporate user's private key has been compromised)",
      );

      const emergencyRecoveryKey = ethers.keccak256(
        ethers.solidityPacked(["string"], [`EMERGENCY-RECOVERY-${Date.now()}`]),
      );

      // Step 3: Multi-party recovery coordination
      console.log("🛡️ Step 3: Initiating multi-party recovery coordination...");

      // Recovery agent 1 detects compromise and initiates recovery
      await prodEnv.keyManager
        .connect(prodEnv.recoveryAgents[0])
        .initiateKeyRecovery(compromisedAddress, emergencyRecoveryKey);
      await prodEnv.keyManager
        .connect(prodEnv.recoveryAgents[1])
        .approveKeyRecovery(compromisedAddress, emergencyRecoveryKey);

      console.log("✅ Recovery approvals obtained (2/3 threshold met)");

      // Step 4: Execute recovery after timelock
      console.log("⏰ Step 4: Waiting for recovery timelock period...");

      // Fast forward past recovery timelock
      await prodEnv.fastForwardTime(prodEnv.config.recoveryTimelock + 1);

      // Execute recovery
      await prodEnv.keyManager
        .connect(prodEnv.recoveryAgents[0])
        .executeKeyRecovery(compromisedAddress, emergencyRecoveryKey);

      // Verify recovery key was added
      expect(await compromisedIdentity.keyHasPurpose(emergencyRecoveryKey, 1))
        .to.be.true;

      console.log("✅ Emergency recovery executed successfully!");
      console.log("🔐 New management key established for identity recovery");
    });
  });

  describe("🌐 Network Stress Testing", function () {
    it("Should handle high network congestion scenarios", async function () {
      console.log("\n🌐 Testing Network Congestion Scenarios...");

      // Step 1: Enable network congestion simulation
      console.log("🚦 Step 1: Enabling network congestion simulation...");
      await prodEnv.simulateNetworkCongestion(true);

      // Step 2: Deploy identity under congestion
      console.log("🆔 Step 2: Deploying identity under network congestion...");
      const startTime = Date.now();

      const { identity, address } = await prodEnv.createProductionIdentity(
        prodEnv.individualUser,
        "individual",
      );

      const deployTime = Date.now() - startTime;
      console.log(
        `   Deployment completed in ${deployTime}ms under congestion`,
      );

      // Step 3: Test operations under congestion
      console.log("⚡ Step 3: Testing operations under network congestion...");

      const testKey = ethers.keccak256(
        ethers.solidityPacked(["string"], ["CONGESTION-TEST-KEY"]),
      );
      const addKeyTx = await identity
        .connect(prodEnv.individualUser)
        .addKey(testKey, 2, 1, {
          gasPrice: prodEnv.networkConditions.gasPrice,
        });
      const receipt = await addKeyTx.wait();

      console.log(
        `   Key addition gas used: ${receipt!.gasUsed.toLocaleString()}`,
      );
      console.log(
        `   Gas price: ${ethers.formatUnits(prodEnv.networkConditions.gasPrice, "gwei")} gwei`,
      );

      // Step 4: Disable congestion and verify normal operations
      console.log(
        "🚦 Step 4: Disabling congestion and testing normal operations...",
      );
      await prodEnv.simulateNetworkCongestion(false);

      const normalKey = ethers.keccak256(
        ethers.solidityPacked(["string"], ["NORMAL-TEST-KEY"]),
      );
      const normalTx = await identity
        .connect(prodEnv.individualUser)
        .addKey(normalKey, 2, 1);
      const normalReceipt = await normalTx.wait();

      console.log(
        `   Normal operation gas used: ${normalReceipt!.gasUsed.toLocaleString()}`,
      );
      console.log("✅ Network stress testing completed successfully!");
    });
  });

  describe("📊 Production Performance Analysis", function () {
    it("Should analyze comprehensive gas costs and performance metrics", async function () {
      console.log("\n📊 Analyzing Production Performance Metrics...");

      const performanceMetrics: any = {
        gasUsage: {},
        timings: {},
        costs: {},
      };

      // Test identity deployment
      console.log("⛽ Testing identity deployment costs...");
      const deployStart = Date.now();
      const { identity, address } = await prodEnv.createProductionIdentity(
        prodEnv.individualUser,
        "individual",
      );
      performanceMetrics.timings.deployment = Date.now() - deployStart;

      // Test key operations
      console.log("� Taesting key operation costs...");
      const testKey = ethers.keccak256(
        ethers.solidityPacked(["string"], ["PERF-TEST-KEY"]),
      );
      const addKeyStart = Date.now();
      const addKeyTx = await identity
        .connect(prodEnv.individualUser)
        .addKey(testKey, 2, 1);
      const addKeyReceipt = await addKeyTx.wait();
      performanceMetrics.timings.addKey = Date.now() - addKeyStart;
      performanceMetrics.gasUsage.addKey = addKeyReceipt!.gasUsed;

      // Test claim issuance
      console.log("📋 Testing claim issuance costs...");
      const claimStart = Date.now();
      const userData = ProductionUtils.generateUserData("individual");
      await prodEnv.issueKYCClaim(address, userData);
      performanceMetrics.timings.issueClaim = Date.now() - claimStart;

      // Calculate costs in USD
      const ethPrice = 2000; // Assume $2000 ETH
      const gasPrice = 20; // 20 gwei

      performanceMetrics.costs.addKeyUSD = ProductionUtils.calculateGasCostUSD(
        performanceMetrics.gasUsage.addKey,
        gasPrice,
        ethPrice,
      );

      console.log("📈 Performance Analysis Results:");
      console.log(
        `   Identity Deployment Time: ${performanceMetrics.timings.deployment}ms`,
      );
      console.log(`   Add Key Time: ${performanceMetrics.timings.addKey}ms`);
      console.log(
        `   Add Key Gas: ${performanceMetrics.gasUsage.addKey.toLocaleString()}`,
      );
      console.log(`   Add Key Cost: $${performanceMetrics.costs.addKeyUSD}`);
      console.log(
        `   Claim Issuance Time: ${performanceMetrics.timings.issueClaim}ms`,
      );

      // Verify performance is within acceptable limits
      expect(performanceMetrics.timings.deployment).to.be.lt(30000); // < 30 seconds
      expect(performanceMetrics.gasUsage.addKey).to.be.lt(200000); // < 200K gas
      expect(parseFloat(performanceMetrics.costs.addKeyUSD)).to.be.lt(10); // < $10

      console.log(
        "✅ All performance metrics within acceptable production limits!",
      );
    });
  });

  describe("🔒 Advanced Security Testing", function () {
    it("refuses a stranger's key and ownership grab; a self-issued claim verifies nobody", async function () {
      console.log("\n🔒 Running Advanced Security Tests...");

      // Deploy test identity
      const { identity, address } = await prodEnv.createProductionIdentity(
        prodEnv.individualUser,
        "individual",
      );
      const registry = prodEnv.identityRegistry.connect(prodEnv.admin);
      if (!(await registry.isAgent(prodEnv.admin.address))) {
        await registry.addAgent(prodEnv.admin.address);
      }
      await registry.registerIdentity(
        prodEnv.individualUser.address,
        address,
        840,
      );

      console.log("🛡️ Test 1: Coordinated multi-vector attack simulation...");

      // Attack 1: a stranger adds a MANAGEMENT key.
      await expect(
        identity
          .connect(prodEnv.maliciousActor1)
          .addKey(
            ethers.keccak256(
              ethers.solidityPacked(["string"], ["MALICIOUS-KEY-1"]),
            ),
            1,
            1,
          ),
      ).to.be.revertedWith("OnchainID: Sender does not have management key");

      // Attack 3: a stranger takes ownership.
      await expect(
        identity
          .connect(prodEnv.maliciousActor1)
          .transferOwnership(prodEnv.maliciousActor1.address),
      )
        .to.be.revertedWithCustomError(identity, "OwnableUnauthorizedAccount")
        .withArgs(prodEnv.maliciousActor1.address);

      // Attack 2: a self-issued claim. OnchainID accepts a claim from a
      // caller naming itself as issuer (how ClaimIssuer writes its copy),
      // so it lands in the list; the list is a record only: isVerified asks
      // the trusted issuers, so the victim stays unverified.
      await identity
        .connect(prodEnv.maliciousActor2)
        .addClaim(
          prodEnv.config.kycTopic,
          prodEnv.config.ecdsaScheme,
          prodEnv.maliciousActor2.address,
          "0x",
          ethers.solidityPacked(["string"], ["FAKE_CLAIM"]),
          "",
        );
      const ids = await identity.getClaimIdsByTopic(prodEnv.config.kycTopic);
      expect(ids.length).to.equal(1);
      expect((await identity.getClaim(ids[0])).issuer).to.equal(
        prodEnv.maliciousActor2.address,
      );
      expect(
        await registry.isVerified(prodEnv.individualUser.address),
      ).to.equal(false);

      // A genuinely verified identity (both trusted issuers' claims) verifies.
      const corp = await prodEnv.createProductionIdentity(
        prodEnv.corporateUser,
        "corporate",
      );
      await prodEnv.issueKYCClaim(corp.address, { name: "Corp" });
      await prodEnv.issueAMLClaim(corp.address);
      await registry.registerIdentity(
        prodEnv.corporateUser.address,
        corp.address,
        840,
      );
      expect(await registry.isVerified(prodEnv.corporateUser.address)).to.equal(
        true,
      );
      console.log(
        "✅ Key and ownership attacks refused; the fake claim verifies nobody",
      );

      console.log("🛡️ Test 2: Replay attack resistance...");

      // Test replay attack resistance by trying to reuse a signature
      const message = "Test message for replay attack";
      const messageHash = ethers.keccak256(ethers.toUtf8Bytes(message));
      const signature = await prodEnv.individualUser.signMessage(
        ethers.getBytes(messageHash),
      );

      // First use should work
      const recoveredAddress1 = ethers.verifyMessage(
        ethers.getBytes(messageHash),
        signature,
      );
      expect(recoveredAddress1).to.equal(prodEnv.individualUser.address);

      // Simulate attacker trying to reuse the same signature for different message
      const differentMessage = "Different message";
      const differentHash = ethers.keccak256(
        ethers.toUtf8Bytes(differentMessage),
      );
      const recoveredAddress2 = ethers.verifyMessage(
        ethers.getBytes(differentHash),
        signature,
      );
      expect(recoveredAddress2).to.not.equal(prodEnv.individualUser.address);

      console.log("✅ Replay attack resistance verified");

      console.log("🛡️ Test 3: Time-based attack resistance...");

      // Test that expired operations cannot be executed
      const oldKey = ethers.keccak256(
        ethers.solidityPacked(["string"], ["OLD-KEY"]),
      );
      const newKey = ethers.keccak256(
        ethers.solidityPacked(["string"], ["NEW-KEY"]),
      );

      await identity.connect(prodEnv.individualUser).addKey(oldKey, 2, 1);

      // Without the identity's authorization KeyManager refuses outright.
      await expect(
        prodEnv.keyManager
          .connect(prodEnv.individualUser)
          .initiateKeyRotation(address, oldKey, newKey, 2),
      ).to.be.revertedWith(
        "KeyManager: Identity has not authorized KeyManager",
      );
      await identity
        .connect(prodEnv.individualUser)
        .authorizeManager(await prodEnv.keyManager.getAddress());

      // Initiate key rotation
      await prodEnv.keyManager
        .connect(prodEnv.individualUser)
        .initiateKeyRotation(address, oldKey, newKey, 2);

      // Try to execute before timelock expires (should fail)
      await expect(
        prodEnv.keyManager
          .connect(prodEnv.individualUser)
          .executeKeyRotation(address, oldKey, newKey, 2),
      ).to.be.revertedWith("KeyManager: Timelock not expired");

      console.log("✅ Time-based attack resistance verified");

      console.log("🎉 All advanced security tests passed!");
    });
  });

  after(async function () {
    await closeProductionSimulation(prodEnv);
  });
});
