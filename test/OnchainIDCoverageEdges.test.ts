import { expect } from "chai";
import { ethers } from "hardhat";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import {
  OnchainID,
  OnchainIDFactory,
  ClaimIssuer,
  KeyManager,
} from "../typechain-types";
import { TestHelpers } from "./helpers/TestHelpers";
import { issueSigned, signClaim } from "./helpers/kyc";

/**
 * Comprehensive test suite for OnchainID system coverage
 * This test ensures >95% code coverage across all OnchainID contracts
 */
describe("OnchainID System - Coverage Tests", function () {
  let onchainID: OnchainID;
  let factory: OnchainIDFactory;
  let claimIssuer: ClaimIssuer;
  let keyManager: KeyManager;

  let owner: SignerWithAddress;
  let identity: SignerWithAddress;
  let user1: SignerWithAddress;
  let user2: SignerWithAddress;
  let claimSigner: SignerWithAddress;
  let recoveryAgent: SignerWithAddress;

  beforeEach(async function () {
    [owner, identity, user1, user2, claimSigner, recoveryAgent] =
      await ethers.getSigners();

    // Deploy all contracts
    factory = await TestHelpers.deployContract("OnchainIDFactory", [
      owner.address,
      ethers.ZeroHash,
    ]);
    claimIssuer = await TestHelpers.deployContract("ClaimIssuer", [
      owner.address,
      "Test Issuer",
      "Test Description",
    ]);
    keyManager = await TestHelpers.deployContract("KeyManager", []);
    onchainID = await TestHelpers.deployContract("OnchainID", [
      identity.address,
    ]);

    // Set deployment fee for factory tests
    await factory.connect(owner).setDeploymentFee(ethers.parseEther("0.01"));

    // Authorize KeyManager for OnchainID operations
    await onchainID
      .connect(identity)
      .authorizeManager(await keyManager.getAddress());
    await onchainID
      .connect(identity)
      .pinRecoveryManager(await keyManager.getAddress());
  });

  describe("Edge Cases and Error Conditions", function () {
    it("Should handle all revert conditions in OnchainID", async function () {
      // Test all require statements and error conditions
      const testKey = TestHelpers.generateKey("test-key");

      // Key management errors
      await expect(
        onchainID.connect(user1).addKey(testKey, 1, 1),
      ).to.be.revertedWith("OnchainID: Sender does not have management key");

      await expect(
        onchainID.connect(identity).addKey(ethers.ZeroHash, 1, 1),
      ).to.be.revertedWith("OnchainID: Invalid key");

      // Add key then try to add again
      await onchainID.connect(identity).addKey(testKey, 1, 1);
      await expect(
        onchainID.connect(identity).addKey(testKey, 1, 1),
      ).to.be.revertedWith("OnchainID: Key already exists");

      // Remove key errors
      await expect(
        onchainID
          .connect(identity)
          .removeKey(TestHelpers.generateKey("nonexistent"), 1),
      ).to.be.revertedWith("OnchainID: Key does not exist");

      await expect(
        onchainID.connect(identity).removeKey(testKey, 2),
      ).to.be.revertedWith("OnchainID: Purpose mismatch");
    });

    it("Should handle all revert conditions in Factory", async function () {
      const salt = TestHelpers.generateKey("test-salt");

      // Deployment errors
      await expect(
        factory.connect(user1).deployOnchainID(ethers.ZeroAddress, salt),
      ).to.be.revertedWith("OnchainIDFactory: Invalid owner");

      await expect(
        factory
          .connect(user1)
          .deployOnchainID(user1.address, salt, { value: 0 }),
      ).to.be.revertedWith("OnchainIDFactory: Insufficient fee");

      // Deploy once
      await factory.connect(user1).deployOnchainID(user1.address, salt, {
        value: ethers.parseEther("0.01"),
      });

      // Try to deploy with same salt
      await expect(
        factory.connect(user2).deployOnchainID(user2.address, salt, {
          value: ethers.parseEther("0.01"),
        }),
      ).to.be.revertedWith("OnchainIDFactory: Salt already used");
    });

    it("Should handle all revert conditions in ClaimIssuer", async function () {
      const claimData = TestHelpers.createClaimData("test claim");

      // Claim issuance errors
      await expect(
        issueSigned(
          claimIssuer,
          user1,
          await onchainID.getAddress(),
          6,
          claimData,
          "",
          0,
        ),
      ).to.be.revertedWith(
        "ClaimIssuer: Sender does not have claim signer key",
      );

      await expect(
        issueSigned(
          claimIssuer,
          owner,
          ethers.ZeroAddress,
          6,
          claimData,
          "",
          0,
        ),
      ).to.be.revertedWith("ClaimIssuer: Invalid identity");

      await expect(
        issueSigned(
          claimIssuer,
          owner,
          await onchainID.getAddress(),
          6,
          "0x",
          "",
          0,
        ),
      ).to.be.revertedWith("ClaimIssuer: Empty claim data");
    });

    it("Should handle all revert conditions in KeyManager", async function () {
      const oldKey = TestHelpers.generateKey("old-key");
      const newKey = TestHelpers.generateKey("new-key");

      // Add old key to OnchainID first
      await onchainID.connect(identity).addKey(oldKey, 2, 1);

      // Key rotation errors
      await expect(
        keyManager
          .connect(user1)
          .initiateKeyRotation(await onchainID.getAddress(), oldKey, newKey, 2),
      ).to.be.revertedWith("KeyManager: Not identity manager");

      await expect(
        keyManager
          .connect(identity)
          .initiateKeyRotation(ethers.ZeroAddress, oldKey, newKey, 2),
      ).to.be.revertedWithoutReason();

      await expect(
        keyManager
          .connect(identity)
          .initiateKeyRotation(
            await onchainID.getAddress(),
            ethers.ZeroHash,
            newKey,
            2,
          ),
      ).to.be.revertedWith("KeyManager: Invalid old key");
    });
  });

  describe("Complex Integration Scenarios", function () {
    it("Should handle complete identity lifecycle", async function () {
      // 1. Deploy identity through factory
      const salt = TestHelpers.generateKey("lifecycle-salt");
      await factory.connect(user1).deployOnchainID(user1.address, salt, {
        value: ethers.parseEther("0.01"),
      });

      const identityAddress = await factory.saltToIdentity(salt);
      const identity = await ethers.getContractAt("OnchainID", identityAddress);

      // 2. Set up claim issuer
      const claimSignerKey = TestHelpers.generateAddressKey(
        claimSigner.address,
      );
      await claimIssuer.connect(owner).addIssuerKey(claimSignerKey, 3, 1);

      // 3. Issue claims
      const claimData = TestHelpers.createClaimData("KYC verified");
      await issueSigned(
        claimIssuer,
        claimSigner,
        identityAddress,
        6,
        claimData,
        "https://example.com",
        0,
      );

      // 4-5. The issuer attests the claim (IdentityRegistry asks it; the
      // identity holds no compliance store of its own, Task 4.5)
      expect(await claimIssuer.hasValidClaim(identityAddress, 6)).to.be.true;

      // 6. Set up key recovery: authorize and pin KeyManager, seat 2-of-2
      const kmA = await keyManager.getAddress();
      await identity.connect(user1).authorizeManager(kmA);
      await identity.connect(user1).pinRecoveryManager(kmA);
      const agents = [recoveryAgent.address, user2.address];
      await keyManager
        .connect(user1)
        .setupKeyRecovery(identityAddress, agents, 2);

      // 7. Test recovery process
      const recoveryKey = TestHelpers.generateKey("recovery-key");
      await keyManager
        .connect(recoveryAgent)
        .initiateKeyRecovery(identityAddress, recoveryKey);
      await keyManager
        .connect(user2)
        .approveKeyRecovery(identityAddress, recoveryKey);

      // Fast forward time
      await TestHelpers.fastForwardTime(
        TestHelpers.TIME_CONSTANTS.RECOVERY_TIMELOCK + 1,
      );

      await keyManager
        .connect(recoveryAgent)
        .executeKeyRecovery(identityAddress, recoveryKey);

      // Verify recovery key was added
      expect(await identity.keyHasPurpose(recoveryKey, 1)).to.be.true;
    });

    it("Should handle batch operations efficiently", async function () {
      // Batch deploy identities
      const owners = [user1.address, user2.address];
      const salts = TestHelpers.generateSalts(2, "batch");

      await factory.connect(owner).batchDeployOnchainID(owners, salts, {
        value: ethers.parseEther("0.02"),
      });

      expect(await factory.totalIdentities()).to.equal(2);

      // Batch issue claims
      const identityAddresses = [
        await factory.saltToIdentity(salts[0]),
        await factory.saltToIdentity(salts[1]),
      ];

      const claimSignerKey = TestHelpers.generateAddressKey(
        claimSigner.address,
      );
      await claimIssuer.connect(owner).addIssuerKey(claimSignerKey, 3, 1);

      const topics = [6, 7];
      const schemes = [1, 1];
      const issuers = [
        await claimIssuer.getAddress(),
        await claimIssuer.getAddress(),
      ];
      const signatures = [
        TestHelpers.createMockSignature("sig1"),
        TestHelpers.createMockSignature("sig2"),
      ];
      const data = [
        TestHelpers.createClaimData("KYC data"),
        TestHelpers.createClaimData("AML data"),
      ];
      const uris = ["https://kyc.com", "https://aml.com"];
      const validTos = [0, 0];
      const [ci, ids] = [claimIssuer, identityAddresses];
      const sign = (i: number) =>
        signClaim(claimSigner, ci, ids[i], topics[i], data[i], {
          uri: uris[i],
        });
      const claimSigs = [await sign(0), await sign(1)];
      await claimIssuer
        .connect(claimSigner)
        .batchIssueClaims(
          identityAddresses,
          topics,
          schemes,
          data,
          uris,
          validTos,
          claimSigs,
        );

      // Verify claims were issued
      const kycClaims = await claimIssuer.getClaimsByTopic(6);
      const amlClaims = await claimIssuer.getClaimsByTopic(7);
      expect(kycClaims.length).to.equal(1);
      expect(amlClaims.length).to.equal(1);
    });

    it("Should handle multi-signature operations", async function () {
      const keyId = TestHelpers.generateKey("multisig-key");
      const signers = [
        TestHelpers.generateAddressKey(user1.address),
        TestHelpers.generateAddressKey(user2.address),
        TestHelpers.generateAddressKey(recoveryAgent.address),
      ];

      // Set up multi-sig key
      await keyManager.connect(identity).addMultiSigKey(
        await onchainID.getAddress(),
        keyId,
        signers,
        2, // 2-of-3 threshold
        1, // MANAGEMENT_KEY
      );

      // Test signing process
      const operation = TestHelpers.generateKey("test-operation");

      await keyManager
        .connect(user1)
        .signMultiSigOperation(await onchainID.getAddress(), keyId, operation);

      expect(
        await keyManager.checkMultiSigThreshold(
          await onchainID.getAddress(),
          keyId,
        ),
      ).to.be.false;

      await keyManager
        .connect(user2)
        .signMultiSigOperation(await onchainID.getAddress(), keyId, operation);

      expect(
        await keyManager.checkMultiSigThreshold(
          await onchainID.getAddress(),
          keyId,
        ),
      ).to.be.true;
    });
  });
});
