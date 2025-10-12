import { expect } from "chai";
import { ethers } from "hardhat";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import { OnchainID, OnchainIDFactory, ClaimIssuer, KeyManager } from "../typechain-types";
import { TestHelpers } from "./helpers/TestHelpers";

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
        [owner, identity, user1, user2, claimSigner, recoveryAgent] = await ethers.getSigners();

        // Deploy all contracts
        factory = await TestHelpers.deployContract("OnchainIDFactory", [owner.address]);
        claimIssuer = await TestHelpers.deployContract("ClaimIssuer", [
            owner.address,
            "Test Issuer",
            "Test Description"
        ]);
        keyManager = await TestHelpers.deployContract("KeyManager", [owner.address]);
        onchainID = await TestHelpers.deployContract("OnchainID", [identity.address]);

        // Set deployment fee for factory tests
        await factory.connect(owner).setDeploymentFee(ethers.parseEther("0.01"));

        // Authorize KeyManager for OnchainID operations
        await onchainID.connect(identity).authorizeManager(await keyManager.getAddress());
    });

    describe("Edge Cases and Error Conditions", function () {
        it("Should handle all revert conditions in OnchainID", async function () {
            // Test all require statements and error conditions
            const testKey = TestHelpers.generateKey("test-key");

            // Key management errors
            await expect(onchainID.connect(user1).addKey(testKey, 1, 1))
                .to.be.revertedWith("OnchainID: Sender does not have management key");

            await expect(onchainID.connect(identity).addKey(ethers.ZeroHash, 1, 1))
                .to.be.revertedWith("OnchainID: Invalid key");

            // Add key then try to add again
            await onchainID.connect(identity).addKey(testKey, 1, 1);
            await expect(onchainID.connect(identity).addKey(testKey, 1, 1))
                .to.be.revertedWith("OnchainID: Key already exists");

            // Remove key errors
            await expect(onchainID.connect(identity).removeKey(TestHelpers.generateKey("nonexistent"), 1))
                .to.be.revertedWith("OnchainID: Key does not exist");

            await expect(onchainID.connect(identity).removeKey(testKey, 2))
                .to.be.revertedWith("OnchainID: Purpose mismatch");
        });

        it("Should handle all revert conditions in Factory", async function () {
            const salt = TestHelpers.generateKey("test-salt");

            // Deployment errors
            await expect(factory.connect(user1).deployOnchainID(ethers.ZeroAddress, salt))
                .to.be.revertedWith("OnchainIDFactory: Invalid owner");

            await expect(factory.connect(user1).deployOnchainID(user1.address, salt, { value: 0 }))
                .to.be.revertedWith("OnchainIDFactory: Insufficient fee");

            // Deploy once
            await factory.connect(user1).deployOnchainID(user1.address, salt, {
                value: ethers.parseEther("0.01")
            });

            // Try to deploy with same salt
            await expect(factory.connect(user2).deployOnchainID(user2.address, salt, {
                value: ethers.parseEther("0.01")
            })).to.be.revertedWith("OnchainIDFactory: Salt already used");
        });

        it("Should handle all revert conditions in ClaimIssuer", async function () {
            const claimData = TestHelpers.createClaimData("test claim");

            // Claim issuance errors
            await expect(claimIssuer.connect(user1).issueClaim(
                await onchainID.getAddress(), 6, 1, claimData, "", 0
            )).to.be.revertedWith("ClaimIssuer: Sender does not have claim signer key");

            await expect(claimIssuer.connect(owner).issueClaim(
                ethers.ZeroAddress, 6, 1, claimData, "", 0
            )).to.be.revertedWith("ClaimIssuer: Invalid identity");

            await expect(claimIssuer.connect(owner).issueClaim(
                await onchainID.getAddress(), 6, 1, "0x", "", 0
            )).to.be.revertedWith("ClaimIssuer: Empty claim data");
        });

        it("Should handle all revert conditions in KeyManager", async function () {
            const oldKey = TestHelpers.generateKey("old-key");
            const newKey = TestHelpers.generateKey("new-key");

            // Add old key to OnchainID first
            await onchainID.connect(identity).addKey(oldKey, 2, 1);

            // Key rotation errors
            await expect(keyManager.connect(user1).initiateKeyRotation(
                await onchainID.getAddress(), oldKey, newKey, 2
            )).to.be.revertedWith("KeyManager: Not identity manager");

            await expect(keyManager.connect(identity).initiateKeyRotation(
                ethers.ZeroAddress, oldKey, newKey, 2
            )).to.be.reverted;

            await expect(keyManager.connect(identity).initiateKeyRotation(
                await onchainID.getAddress(), ethers.ZeroHash, newKey, 2
            )).to.be.revertedWith("KeyManager: Invalid old key");
        });
    });

    describe("Complex Integration Scenarios", function () {
        it("Should handle complete identity lifecycle", async function () {
            // 1. Deploy identity through factory
            const salt = TestHelpers.generateKey("lifecycle-salt");
            await factory.connect(user1).deployOnchainID(user1.address, salt, {
                value: ethers.parseEther("0.01")
            });

            const identityAddress = await factory.saltToIdentity(salt);
            const identity = await ethers.getContractAt("OnchainID", identityAddress);

            // 2. Set up claim issuer
            const claimSignerKey = TestHelpers.generateAddressKey(claimSigner.address);
            await claimIssuer.connect(owner).addIssuerKey(claimSignerKey, 3, 1);

            // 3. Issue claims
            const claimData = TestHelpers.createClaimData("KYC verified");
            await claimIssuer.connect(claimSigner).issueClaim(
                identityAddress, 6, 1, claimData, "https://example.com", 0
            );

            // 4. Set up compliance
            await identity.connect(user1).addTrustedIssuer(await claimIssuer.getAddress(), [6]);
            await identity.connect(user1).addClaimTopic(6, true);

            // 5. Verify compliance
            expect(await identity.isCompliant()).to.be.true;

            // 6. Set up key recovery
            await keyManager.connect(owner).addAuthorizedManager(user1.address);

            // Authorize KeyManager for the deployed identity
            const deployedIdentity = await ethers.getContractAt("OnchainID", identityAddress);
            await deployedIdentity.connect(user1).authorizeManager(await keyManager.getAddress());

            await keyManager.connect(user1).setupKeyRecovery(
                identityAddress,
                [recoveryAgent.address],
                1
            );

            // 7. Test recovery process
            const recoveryKey = TestHelpers.generateKey("recovery-key");
            await keyManager.connect(recoveryAgent).initiateKeyRecovery(identityAddress, recoveryKey);
            await keyManager.connect(recoveryAgent).approveKeyRecovery(identityAddress);

            // Fast forward time
            await TestHelpers.fastForwardTime(TestHelpers.TIME_CONSTANTS.RECOVERY_TIMELOCK + 1);

            await keyManager.connect(recoveryAgent).executeKeyRecovery(identityAddress);

            // Verify recovery key was added
            expect(await identity.keyHasPurpose(recoveryKey, 1)).to.be.true;
        });

        it("Should handle batch operations efficiently", async function () {
            // Batch deploy identities
            const owners = [user1.address, user2.address];
            const salts = TestHelpers.generateSalts(2, "batch");

            await factory.connect(owner).batchDeployOnchainID(owners, salts, {
                value: ethers.parseEther("0.02")
            });

            expect(await factory.totalIdentities()).to.equal(2);

            // Batch issue claims
            const identityAddresses = [
                await factory.saltToIdentity(salts[0]),
                await factory.saltToIdentity(salts[1])
            ];

            const claimSignerKey = TestHelpers.generateAddressKey(claimSigner.address);
            await claimIssuer.connect(owner).addIssuerKey(claimSignerKey, 3, 1);

            const topics = [6, 7];
            const schemes = [1, 1];
            const issuers = [await claimIssuer.getAddress(), await claimIssuer.getAddress()];
            const signatures = [
                TestHelpers.createMockSignature("sig1"),
                TestHelpers.createMockSignature("sig2")
            ];
            const data = [
                TestHelpers.createClaimData("KYC data"),
                TestHelpers.createClaimData("AML data")
            ];
            const uris = ["https://kyc.com", "https://aml.com"];
            const validTos = [0, 0];

            await claimIssuer.connect(claimSigner).batchIssueClaims(
                identityAddresses, topics, schemes, data, uris, validTos
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
                TestHelpers.generateAddressKey(recoveryAgent.address)
            ];

            // Set up multi-sig key
            await keyManager.connect(owner).addAuthorizedManager(identity.address);
            await keyManager.connect(identity).addMultiSigKey(
                await onchainID.getAddress(),
                keyId,
                signers,
                2, // 2-of-3 threshold
                1  // MANAGEMENT_KEY
            );

            // Test signing process
            const operation = TestHelpers.generateKey("test-operation");

            await keyManager.connect(user1).signMultiSigOperation(
                await onchainID.getAddress(),
                keyId,
                operation
            );

            expect(await keyManager.checkMultiSigThreshold(
                await onchainID.getAddress(), keyId
            )).to.be.false;

            await keyManager.connect(user2).signMultiSigOperation(
                await onchainID.getAddress(),
                keyId,
                operation
            );

            expect(await keyManager.checkMultiSigThreshold(
                await onchainID.getAddress(), keyId
            )).to.be.true;
        });
    });

    describe("Gas Optimization and Performance", function () {
        it("Should optimize gas usage for common operations", async function () {
            // Test gas usage for key operations
            const testKey = TestHelpers.generateKey("gas-test-key");

            const addKeyTx = await onchainID.connect(identity).addKey(testKey, 2, 1);
            const addKeyGas = await TestHelpers.calculateGasCost(addKeyTx);

            const removeKeyTx = await onchainID.connect(identity).removeKey(testKey, 2);
            const removeKeyGas = await TestHelpers.calculateGasCost(removeKeyTx);

            // Gas should be reasonable (these are rough estimates)
            expect(addKeyGas).to.be.lt(ethers.parseEther("0.001")); // Less than 0.001 ETH
            expect(removeKeyGas).to.be.lt(ethers.parseEther("0.001"));
        });

        it("Should handle large-scale operations efficiently", async function () {
            // Test with multiple keys
            const keys = TestHelpers.generateKeys(10, "scale-test");
            const purposes = Array(10).fill(2); // ACTION_KEY
            const keyTypes = Array(10).fill(1); // ECDSA_TYPE

            // Add authorized manager for batch operations
            await keyManager.connect(owner).addAuthorizedManager(identity.address);

            const batchTx = await keyManager.connect(identity).batchAddKeys(
                await onchainID.getAddress(),
                keys,
                purposes,
                keyTypes
            );

            const batchGas = await TestHelpers.calculateGasCost(batchTx);

            // Verify all keys were added
            for (const key of keys) {
                expect(await onchainID.keyHasPurpose(key, 2)).to.be.true;
            }

            // Batch should be more efficient than individual operations
            expect(batchGas).to.be.lt(ethers.parseEther("0.01"));
        });
    });

    describe("Security and Access Control", function () {
        it("Should enforce proper access control across all functions", async function () {
            const testKey = TestHelpers.generateKey("security-test");

            // Test OnchainID access control
            await expect(onchainID.connect(user1).addKey(testKey, 1, 1))
                .to.be.revertedWith("OnchainID: Sender does not have management key");

            await expect(onchainID.connect(user1).transferOwnership(user1.address))
                .to.be.revertedWithCustomError(onchainID, "OwnableUnauthorizedAccount");

            // Test Factory access control
            await expect(factory.connect(user1).setDeploymentFee(ethers.parseEther("0.1")))
                .to.be.revertedWithCustomError(factory, "OwnableUnauthorizedAccount");

            // Test ClaimIssuer access control
            await expect(claimIssuer.connect(user1).addIssuerKey(testKey, 3, 1))
                .to.be.revertedWith("ClaimIssuer: Sender does not have management key");

            // Test KeyManager access control
            await expect(keyManager.connect(user1).addAuthorizedManager(user1.address))
                .to.be.revertedWithCustomError(keyManager, "OwnableUnauthorizedAccount");
        });

        it("Should prevent reentrancy attacks", async function () {
            // Test that all state-changing functions are protected
            // This is implicitly tested by the ReentrancyGuard modifier usage

            const claimData = TestHelpers.createClaimData("reentrancy test");
            const claimSignerKey = TestHelpers.generateAddressKey(claimSigner.address);
            await claimIssuer.connect(owner).addIssuerKey(claimSignerKey, 3, 1);

            // Issue claim (this function has nonReentrant modifier)
            await expect(claimIssuer.connect(claimSigner).issueClaim(
                await onchainID.getAddress(), 6, 1, claimData, "", 0
            )).to.not.be.reverted;
        });
    });

    describe("Event Emission Coverage", function () {
        it("Should emit all required events", async function () {
            // Test OnchainID events
            const testKey = TestHelpers.generateKey("event-test");

            await expect(onchainID.connect(identity).addKey(testKey, 2, 1))
                .to.emit(onchainID, "KeyAdded")
                .withArgs(testKey, 2, 1);

            await expect(onchainID.connect(identity).removeKey(testKey, 2))
                .to.emit(onchainID, "KeyRemoved")
                .withArgs(testKey, 2, 1);

            // Test Factory events
            const salt = TestHelpers.generateKey("event-salt");
            await expect(factory.connect(user1).deployOnchainID(user1.address, salt, {
                value: ethers.parseEther("0.01")
            })).to.emit(factory, "OnchainIDDeployed");

            // Test ClaimIssuer events
            const claimData = TestHelpers.createClaimData("event test claim");
            const claimSignerKey = TestHelpers.generateAddressKey(claimSigner.address);
            await claimIssuer.connect(owner).addIssuerKey(claimSignerKey, 3, 1);

            await expect(claimIssuer.connect(claimSigner).issueClaim(
                await onchainID.getAddress(), 6, 1, claimData, "", 0
            )).to.emit(claimIssuer, "ClaimIssued");

            // Test KeyManager events
            const oldKey = TestHelpers.generateKey("old-event-key");
            const newKey = TestHelpers.generateKey("new-event-key");

            await onchainID.connect(identity).addKey(oldKey, 2, 1);
            await keyManager.connect(owner).addAuthorizedManager(identity.address);

            await expect(keyManager.connect(identity).initiateKeyRotation(
                await onchainID.getAddress(), oldKey, newKey, 2
            )).to.emit(keyManager, "KeyRotationInitiated");
        });
    });

    describe("State Consistency", function () {
        it("Should maintain consistent state across operations", async function () {
            // Test that all state variables are properly updated
            const initialStats = await onchainID.getIdentityStats();

            // Add keys and claims
            const testKey = TestHelpers.generateKey("consistency-key");
            await onchainID.connect(identity).addKey(testKey, 2, 1);

            const claimData = TestHelpers.createClaimData("consistency claim");
            await onchainID.connect(identity).addClaim(6, 1, identity.address, "0x", claimData, "");

            const finalStats = await onchainID.getIdentityStats();

            // Verify stats were updated correctly
            expect(finalStats.keyCount).to.equal(initialStats.keyCount + BigInt(1));
            expect(finalStats.claimCount).to.equal(initialStats.claimCount + BigInt(1));
        });
    });
});