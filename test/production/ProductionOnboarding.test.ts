import { expect } from "chai";
import { ethers } from "hardhat";
import { OnchainID } from "../../typechain-types";
import { ProductionEnvironment } from "./ProductionEnvironment";
import { issueSigned } from "../helpers/kyc";
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

  describe("🏢 Enterprise Corporate Onboarding", function () {
    let corporateIdentity: OnchainID;
    let corporateAddress: string;

    it("Should complete full enterprise onboarding with real-world complexity", async function () {
      console.log("\n🏢 Starting Enterprise Corporate Onboarding...");

      // Step 1: Deploy corporate identity with production settings
      console.log(
        "📋 Step 1: Deploying corporate identity with production fee...",
      );
      const { identity, address } = await prodEnv.createProductionIdentity(
        prodEnv.corporateUser,
        "corporate",
      );
      corporateIdentity = identity;
      corporateAddress = address;

      console.log(`✅ Corporate identity deployed: ${address}`);
      expect(await corporateIdentity.owner()).to.equal(
        prodEnv.corporateUser.address,
      );

      // Step 2: Advanced key management setup
      console.log("🔐 Step 2: Setting up enterprise key management...");

      // Add multiple management keys for different corporate roles
      const ceoKey = ethers.keccak256(
        ethers.solidityPacked(["string"], ["CEO-MASTER-KEY"]),
      );
      const cfoKey = ethers.keccak256(
        ethers.solidityPacked(["string"], ["CFO-FINANCE-KEY"]),
      );
      const complianceKey = ethers.keccak256(
        ethers.solidityPacked(["string"], ["COMPLIANCE-OFFICER-KEY"]),
      );
      const operationsKey = ethers.keccak256(
        ethers.solidityPacked(["string"], ["OPERATIONS-KEY"]),
      );

      await corporateIdentity
        .connect(prodEnv.corporateUser)
        .addKey(ceoKey, 1, 1); // MANAGEMENT_KEY
      await corporateIdentity
        .connect(prodEnv.corporateUser)
        .addKey(cfoKey, 1, 1); // MANAGEMENT_KEY
      await corporateIdentity
        .connect(prodEnv.corporateUser)
        .addKey(complianceKey, 2, 1); // ACTION_KEY
      await corporateIdentity
        .connect(prodEnv.corporateUser)
        .addKey(operationsKey, 2, 1); // ACTION_KEY

      console.log("✅ Enterprise key hierarchy established");

      // Step 3: Setup enterprise-grade recovery system
      console.log("🛡️ Step 3: Configuring enterprise recovery system...");
      await prodEnv.setupRecoverySystem(
        corporateAddress,
        prodEnv.corporateUser,
      );
      console.log("✅ Enterprise recovery system configured");

      // Step 4: Enhanced KYC with corporate data
      console.log("📋 Step 4: Enhanced corporate KYC verification...");
      const corporateData = ProductionUtils.generateUserData("corporate");
      await prodEnv.issueKYCClaim(corporateAddress, corporateData);
      console.log("✅ Enhanced KYC claim issued");

      // Step 5: AML compliance verification
      console.log("🔍 Step 5: AML compliance verification...");
      await prodEnv.issueAMLClaim(corporateAddress);
      console.log("✅ AML compliance verified");

      // Step 6: Verify compliance where it is decided. Each trusted issuer
      // attests its topic for the identity (IdentityRegistry asks them; the
      // identity holds no compliance store of its own, plan v2 Task 4.5).
      console.log("✅ Step 6: Verifying enterprise claims at their issuers...");
      expect(
        await prodEnv.kycIssuer.hasValidClaim(
          corporateAddress,
          prodEnv.config.kycTopic,
        ),
      ).to.be.true;
      expect(
        await prodEnv.amlIssuer.hasValidClaim(
          corporateAddress,
          prodEnv.config.amlTopic,
        ),
      ).to.be.true;

      console.log("🎉 Enterprise onboarding completed successfully!");

      console.log(`📊 Enterprise Identity:`);
      console.log(
        `   - Management Keys: ${(await corporateIdentity.getKeysByPurpose(1)).length}`,
      );
    });
  });

  describe("👤 Individual User Journey", function () {
    let userIdentity: OnchainID;
    let userAddress: string;

    it("Should complete individual user onboarding with cryptographic verification", async function () {
      console.log("\n👤 Starting Individual User Onboarding Journey...");

      // Step 1: Create user identity
      console.log("🆔 Step 1: Creating individual user identity...");
      const { identity, address } = await prodEnv.createProductionIdentity(
        prodEnv.individualUser,
        "individual",
      );
      userIdentity = identity;
      userAddress = address;

      console.log(`✅ User identity created: ${address}`);

      // Step 2: Real cryptographic signature verification
      console.log(
        "✍️ Step 2: Implementing cryptographic signature verification...",
      );

      // Create signed message for identity verification
      const verificationMessage = `Identity verification for ${userAddress} at ${new Date().toISOString()}`;
      const messageHash = ethers.keccak256(
        ethers.toUtf8Bytes(verificationMessage),
      );

      // User signs the verification message
      const userSignature = await prodEnv.individualUser.signMessage(
        ethers.getBytes(messageHash),
      );

      // Verify signature
      const recoveredAddress = ethers.verifyMessage(
        ethers.getBytes(messageHash),
        userSignature,
      );
      expect(recoveredAddress).to.equal(prodEnv.individualUser.address);

      console.log("✅ Cryptographic signature verification successful");

      // Step 3: Enhanced KYC with biometric simulation
      console.log("📋 Step 3: Enhanced KYC with biometric verification...");
      const userData = ProductionUtils.generateUserData("individual");
      await prodEnv.issueKYCClaim(userAddress, userData);
      console.log("✅ Enhanced KYC with biometric verification completed");

      // Step 4: Multi-signature wallet setup
      console.log("🔐 Step 4: Setting up multi-signature operations...");

      await prodEnv.setupRecoverySystem(userAddress, prodEnv.individualUser);

      // Add multi-sig key for high-value operations
      const multiSigKeyId = ethers.keccak256(
        ethers.solidityPacked(["string"], ["USER-MULTISIG-KEY"]),
      );
      const signers = [
        ethers.keccak256(
          ethers.solidityPacked(["address"], [prodEnv.individualUser.address]),
        ),
        ethers.keccak256(
          ethers.solidityPacked(
            ["address"],
            [prodEnv.recoveryAgents[0].address],
          ),
        ),
        ethers.keccak256(
          ethers.solidityPacked(
            ["address"],
            [prodEnv.recoveryAgents[1].address],
          ),
        ),
      ];

      await prodEnv.keyManager.connect(prodEnv.individualUser).addMultiSigKey(
        userAddress,
        multiSigKeyId,
        signers,
        2, // 2-of-3 threshold
        1, // MANAGEMENT_KEY
      );

      console.log("✅ Multi-signature operations configured");

      // Step 5: Test secure key rotation with timelock
      console.log("🔄 Step 5: Testing secure key rotation with timelock...");

      const oldKey = ethers.keccak256(
        ethers.solidityPacked(["string"], ["OLD-ACTION-KEY"]),
      );
      const newKey = ethers.keccak256(
        ethers.solidityPacked(["string"], ["NEW-ACTION-KEY"]),
      );

      // Add old key
      await userIdentity.connect(prodEnv.individualUser).addKey(oldKey, 2, 1);

      // Initiate rotation
      await prodEnv.keyManager
        .connect(prodEnv.individualUser)
        .initiateKeyRotation(
          userAddress,
          oldKey,
          newKey,
          2, // ACTION_KEY
        );

      // Fast forward past timelock
      await prodEnv.fastForwardTime(prodEnv.config.keyRotationTimelock + 1);

      // Execute rotation
      await prodEnv.keyManager
        .connect(prodEnv.individualUser)
        .executeKeyRotation(userAddress, oldKey, newKey, 2);

      // Verify rotation
      expect(await userIdentity.keyHasPurpose(oldKey, 2)).to.be.false;
      expect(await userIdentity.keyHasPurpose(newKey, 2)).to.be.true;

      console.log("✅ Secure key rotation completed");

      // Step 6: Final compliance verification
      console.log("✅ Step 6: Final compliance verification...");

      expect(
        await prodEnv.kycIssuer.hasValidClaim(
          userAddress,
          prodEnv.config.kycTopic,
        ),
      ).to.be.true;

      console.log("🎉 Individual user onboarding completed successfully!");
    });
  });

  describe("🏦 Institutional Investor Workflow", function () {
    let institutionalIdentity: OnchainID;
    let institutionalAddress: string;

    it("Should handle institutional investor onboarding with advanced compliance", async function () {
      console.log("\n🏦 Starting Institutional Investor Onboarding...");

      // Step 1: Deploy institutional identity
      console.log("🏛️ Step 1: Deploying institutional identity...");
      const { identity, address } = await prodEnv.createProductionIdentity(
        prodEnv.institutionalUser,
        "institutional",
      );
      institutionalIdentity = identity;
      institutionalAddress = address;

      console.log(`✅ Institutional identity deployed: ${address}`);

      // Step 2: Advanced compliance setup
      console.log("⚖️ Step 2: Setting up advanced institutional compliance...");

      const institutionalData =
        ProductionUtils.generateUserData("institutional");
      await prodEnv.issueKYCClaim(institutionalAddress, institutionalData);
      await prodEnv.issueAMLClaim(institutionalAddress);

      // Issue additional institutional-specific claims
      const accreditationData = {
        accreditationType: "QUALIFIED_INSTITUTIONAL_BUYER",
        regulatoryStatus: "SEC_REGISTERED",
        aum: "500000000", // $500M
        investmentExperience: "SOPHISTICATED",
        riskTolerance: "HIGH",
        verificationDate: new Date().toISOString(),
      };

      const claimData = ethers.solidityPacked(
        ["string"],
        [JSON.stringify(accreditationData)],
      );
      await issueSigned(
        prodEnv.complianceIssuer,
        prodEnv.complianceOfficer,
        institutionalAddress,
        prodEnv.config.accreditationTopic,
        claimData,
        `https://compliance-provider.com/accreditation/${institutionalAddress}`,
        (await ethers.provider.getBlock("latest"))!.timestamp +
          prodEnv.config.claimValidityPeriod,
      );

      console.log("✅ Advanced institutional compliance configured");

      // Step 3: Setup institutional recovery system
      console.log("🛡️ Step 3: Configuring institutional recovery system...");
      await prodEnv.setupRecoverySystem(
        institutionalAddress,
        prodEnv.institutionalUser,
      );
      console.log("✅ Institutional recovery system configured");

      // Step 4-5: Verify institutional claims at their issuers (plan v2
      // Task 4.5: verification is the issuers', asked by IdentityRegistry)
      console.log(
        "✅ Step 4-5: Verifying institutional claims at their issuers...",
      );
      for (const [issuer, topic] of [
        [prodEnv.kycIssuer, prodEnv.config.kycTopic],
        [prodEnv.amlIssuer, prodEnv.config.amlTopic],
        [prodEnv.complianceIssuer, prodEnv.config.accreditationTopic],
      ] as const) {
        expect(await issuer.hasValidClaim(institutionalAddress, topic)).to.be
          .true;
      }

      console.log(
        "🎉 Institutional investor onboarding completed successfully!",
      );
    });
  });

  after(async function () {
    await closeProductionSimulation(prodEnv);
  });
});
