import { expect } from "chai";
import { ethers } from "hardhat";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import { KeyManager, OnchainID } from "../typechain-types";

describe("KeyManager", function () {
    let keyManager: KeyManager;
    let onchainID: OnchainID;
    let owner: SignerWithAddress;
    let identity: SignerWithAddress;
    let manager: SignerWithAddress;
    let recoveryAgent1: SignerWithAddress;
    let recoveryAgent2: SignerWithAddress;
    let recoveryAgent3: SignerWithAddress;
    let unauthorized: SignerWithAddress;

    // Key purposes
    const MANAGEMENT_KEY = 1;
    const ACTION_KEY = 2;
    const CLAIM_SIGNER_KEY = 3;
    const ENCRYPTION_KEY = 4;

    // Key types
    const ECDSA_TYPE = 1;

    // Time constants
    const DEFAULT_TIMELOCK = 24 * 60 * 60; // 24 hours
    const RECOVERY_TIMELOCK = 48 * 60 * 60; // 48 hours

    beforeEach(async function () {
        [owner, identity, manager, recoveryAgent1, recoveryAgent2, recoveryAgent3, unauthorized] =
            await ethers.getSigners();

        // Deploy KeyManager
        const KeyManagerFactory = await ethers.getContractFactory("KeyManager");
        keyManager = await KeyManagerFactory.deploy(owner.address);
        await keyManager.waitForDeployment();

        // Deploy OnchainID for testing
        const OnchainIDFactory = await ethers.getContractFactory("OnchainID");
        onchainID = await OnchainIDFactory.deploy(identity.address);
        await onchainID.waitForDeployment();

        // Add manager as authorized manager
        await keyManager.connect(owner).addAuthorizedManager(manager.address);

        // Add manager key to OnchainID for testing
        const managerKey = ethers.keccak256(ethers.solidityPacked(["address"], [manager.address]));
        await onchainID.connect(identity).addKey(managerKey, MANAGEMENT_KEY, ECDSA_TYPE);

        // Authorize KeyManager to perform operations on OnchainID
        await onchainID.connect(identity).authorizeManager(await keyManager.getAddress());
    });

    describe("Deployment", function () {
        it("Should set the correct owner", async function () {
            expect(await keyManager.owner()).to.equal(owner.address);
        });

        it("Should have correct default constants", async function () {
            expect(await keyManager.DEFAULT_TIMELOCK()).to.equal(DEFAULT_TIMELOCK);
            expect(await keyManager.RECOVERY_TIMELOCK()).to.equal(RECOVERY_TIMELOCK);
            expect(await keyManager.MAX_RECOVERY_AGENTS()).to.equal(10);
        });
    });

    describe("Authorization Management", function () {
        describe("addAuthorizedManager", function () {
            it("Should allow owner to add authorized manager", async function () {
                await keyManager.connect(owner).addAuthorizedManager(unauthorized.address);
                expect(await keyManager.authorizedManagers(unauthorized.address)).to.be.true;
            });

            it("Should reject adding manager by non-owner", async function () {
                await expect(keyManager.connect(unauthorized).addAuthorizedManager(unauthorized.address))
                    .to.be.revertedWithCustomError(keyManager, "OwnableUnauthorizedAccount");
            });

            it("Should reject adding zero address as manager", async function () {
                await expect(keyManager.connect(owner).addAuthorizedManager(ethers.ZeroAddress))
                    .to.be.revertedWith("KeyManager: Invalid manager");
            });
        });

        describe("removeAuthorizedManager", function () {
            beforeEach(async function () {
                await keyManager.connect(owner).addAuthorizedManager(unauthorized.address);
            });

            it("Should allow owner to remove authorized manager", async function () {
                await keyManager.connect(owner).removeAuthorizedManager(unauthorized.address);
                expect(await keyManager.authorizedManagers(unauthorized.address)).to.be.false;
            });

            it("Should reject removal by non-owner", async function () {
                await expect(keyManager.connect(unauthorized).removeAuthorizedManager(unauthorized.address))
                    .to.be.revertedWithCustomError(keyManager, "OwnableUnauthorizedAccount");
            });
        });
    });

    describe("Key Rotation", function () {
        let oldKey: string;
        let newKey: string;

        beforeEach(async function () {
            oldKey = ethers.keccak256(ethers.solidityPacked(["string"], ["old-key"]));
            newKey = ethers.keccak256(ethers.solidityPacked(["string"], ["new-key"]));

            // Add old key to OnchainID
            await onchainID.connect(identity).addKey(oldKey, ACTION_KEY, ECDSA_TYPE);
        });

        describe("initiateKeyRotation", function () {
            it("Should allow identity manager to initiate key rotation", async function () {
                await expect(keyManager.connect(manager).initiateKeyRotation(
                    await onchainID.getAddress(),
                    oldKey,
                    newKey,
                    ACTION_KEY
                )).to.emit(keyManager, "KeyRotationInitiated")
                    .withArgs(await onchainID.getAddress(), oldKey, newKey, ACTION_KEY);

                const rotationId = ethers.keccak256(ethers.solidityPacked(
                    ["address", "bytes32", "bytes32", "uint256"],
                    [await onchainID.getAddress(), oldKey, newKey, ACTION_KEY]
                ));

                const rotation = await keyManager.getKeyRotation(await onchainID.getAddress(), rotationId);
                expect(rotation.oldKey).to.equal(oldKey);
                expect(rotation.newKey).to.equal(newKey);
                expect(rotation.purpose).to.equal(ACTION_KEY);
                expect(rotation.completed).to.be.false;
                expect(rotation.initiator).to.equal(manager.address);
            });

            it("Should reject initiation with invalid identity", async function () {
                await expect(keyManager.connect(manager).initiateKeyRotation(
                    ethers.ZeroAddress,
                    oldKey,
                    newKey,
                    ACTION_KEY
                )).to.be.reverted;
            });

            it("Should reject initiation with zero keys", async function () {
                await expect(keyManager.connect(manager).initiateKeyRotation(
                    await onchainID.getAddress(),
                    ethers.ZeroHash,
                    newKey,
                    ACTION_KEY
                )).to.be.revertedWith("KeyManager: Invalid old key");

                await expect(keyManager.connect(manager).initiateKeyRotation(
                    await onchainID.getAddress(),
                    oldKey,
                    ethers.ZeroHash,
                    ACTION_KEY
                )).to.be.revertedWith("KeyManager: Invalid new key");
            });

            it("Should reject initiation with same old and new keys", async function () {
                await expect(keyManager.connect(manager).initiateKeyRotation(
                    await onchainID.getAddress(),
                    oldKey,
                    oldKey,
                    ACTION_KEY
                )).to.be.revertedWith("KeyManager: Keys must be different");
            });

            it("Should reject initiation for non-existent old key", async function () {
                const nonExistentKey = ethers.keccak256(ethers.solidityPacked(["string"], ["non-existent"]));
                await expect(keyManager.connect(manager).initiateKeyRotation(
                    await onchainID.getAddress(),
                    nonExistentKey,
                    newKey,
                    ACTION_KEY
                )).to.be.revertedWith("KeyManager: Old key does not have specified purpose");
            });

            it("Should reject initiation by unauthorized user", async function () {
                await expect(keyManager.connect(unauthorized).initiateKeyRotation(
                    await onchainID.getAddress(),
                    oldKey,
                    newKey,
                    ACTION_KEY
                )).to.be.revertedWith("KeyManager: Not identity manager");
            });
        });

        describe("executeKeyRotation", function () {
            let rotationId: string;

            beforeEach(async function () {
                await keyManager.connect(manager).initiateKeyRotation(
                    await onchainID.getAddress(),
                    oldKey,
                    newKey,
                    ACTION_KEY
                );

                rotationId = ethers.keccak256(ethers.solidityPacked(
                    ["address", "bytes32", "bytes32", "uint256"],
                    [await onchainID.getAddress(), oldKey, newKey, ACTION_KEY]
                ));
            });

            it("Should execute key rotation after timelock", async function () {
                // Fast forward time past timelock
                await ethers.provider.send("evm_increaseTime", [DEFAULT_TIMELOCK + 1]);
                await ethers.provider.send("evm_mine", []);

                await expect(keyManager.connect(manager).executeKeyRotation(
                    await onchainID.getAddress(),
                    oldKey,
                    newKey,
                    ACTION_KEY
                )).to.emit(keyManager, "KeyRotationCompleted")
                    .withArgs(await onchainID.getAddress(), oldKey, newKey, ACTION_KEY);

                // Verify old key is removed and new key is added
                expect(await onchainID.keyHasPurpose(oldKey, ACTION_KEY)).to.be.false;
                expect(await onchainID.keyHasPurpose(newKey, ACTION_KEY)).to.be.true;

                // Verify rotation is marked as completed
                const rotation = await keyManager.getKeyRotation(await onchainID.getAddress(), rotationId);
                expect(rotation.completed).to.be.true;
            });

            it("Should reject execution before timelock", async function () {
                await expect(keyManager.connect(manager).executeKeyRotation(
                    await onchainID.getAddress(),
                    oldKey,
                    newKey,
                    ACTION_KEY
                )).to.be.revertedWith("KeyManager: Timelock not expired");
            });

            it("Should reject execution of non-initiated rotation", async function () {
                const nonExistentKey = ethers.keccak256(ethers.solidityPacked(["string"], ["non-existent"]));
                await expect(keyManager.connect(manager).executeKeyRotation(
                    await onchainID.getAddress(),
                    nonExistentKey,
                    newKey,
                    ACTION_KEY
                )).to.be.revertedWith("KeyManager: Rotation not initiated");
            });

            it("Should reject double execution", async function () {
                // Fast forward time and execute once
                await ethers.provider.send("evm_increaseTime", [DEFAULT_TIMELOCK + 1]);
                await ethers.provider.send("evm_mine", []);

                await keyManager.connect(manager).executeKeyRotation(
                    await onchainID.getAddress(),
                    oldKey,
                    newKey,
                    ACTION_KEY
                );

                // Try to execute again
                await expect(keyManager.connect(manager).executeKeyRotation(
                    await onchainID.getAddress(),
                    oldKey,
                    newKey,
                    ACTION_KEY
                )).to.be.revertedWith("KeyManager: Rotation already completed");
            });
        });
    });

    describe("Multi-Signature Key Management", function () {
        let keyId: string;
        let signers: string[];

        beforeEach(async function () {
            keyId = ethers.keccak256(ethers.solidityPacked(["string"], ["multisig-key"]));
            signers = [
                ethers.keccak256(ethers.solidityPacked(["address"], [recoveryAgent1.address])),
                ethers.keccak256(ethers.solidityPacked(["address"], [recoveryAgent2.address])),
                ethers.keccak256(ethers.solidityPacked(["address"], [recoveryAgent3.address]))
            ];
        });

        describe("addMultiSigKey", function () {
            it("Should allow identity manager to add multi-sig key", async function () {
                await expect(keyManager.connect(manager).addMultiSigKey(
                    await onchainID.getAddress(),
                    keyId,
                    signers,
                    2, // 2-of-3 threshold
                    MANAGEMENT_KEY
                )).to.emit(keyManager, "MultiSigKeyAdded")
                    .withArgs(await onchainID.getAddress(), keyId, MANAGEMENT_KEY, 2, signers);

                const [returnedSigners, threshold, purpose, active, signatureCount] =
                    await keyManager.getMultiSigKey(await onchainID.getAddress(), keyId);

                expect(returnedSigners).to.deep.equal(signers);
                expect(threshold).to.equal(2);
                expect(purpose).to.equal(MANAGEMENT_KEY);
                expect(active).to.be.true;
                expect(signatureCount).to.equal(0);
            });

            it("Should reject adding multi-sig key with no signers", async function () {
                await expect(keyManager.connect(manager).addMultiSigKey(
                    await onchainID.getAddress(),
                    keyId,
                    [],
                    1,
                    MANAGEMENT_KEY
                )).to.be.revertedWith("KeyManager: No signers provided");
            });

            it("Should reject adding multi-sig key with invalid threshold", async function () {
                await expect(keyManager.connect(manager).addMultiSigKey(
                    await onchainID.getAddress(),
                    keyId,
                    signers,
                    0, // Invalid threshold
                    MANAGEMENT_KEY
                )).to.be.revertedWith("KeyManager: Invalid threshold");

                await expect(keyManager.connect(manager).addMultiSigKey(
                    await onchainID.getAddress(),
                    keyId,
                    signers,
                    4, // Threshold > signers length
                    MANAGEMENT_KEY
                )).to.be.revertedWith("KeyManager: Invalid threshold");
            });

            it("Should reject adding duplicate multi-sig key", async function () {
                await keyManager.connect(manager).addMultiSigKey(
                    await onchainID.getAddress(),
                    keyId,
                    signers,
                    2,
                    MANAGEMENT_KEY
                );

                await expect(keyManager.connect(manager).addMultiSigKey(
                    await onchainID.getAddress(),
                    keyId,
                    signers,
                    2,
                    MANAGEMENT_KEY
                )).to.be.revertedWith("KeyManager: Multi-sig key already exists");
            });
        });

        describe("signMultiSigOperation", function () {
            let operation: string;

            beforeEach(async function () {
                await keyManager.connect(manager).addMultiSigKey(
                    await onchainID.getAddress(),
                    keyId,
                    signers,
                    2,
                    MANAGEMENT_KEY
                );

                operation = ethers.keccak256(ethers.solidityPacked(["string"], ["test-operation"]));
            });

            it("Should allow valid signer to sign operation", async function () {
                await keyManager.connect(recoveryAgent1).signMultiSigOperation(
                    await onchainID.getAddress(),
                    keyId,
                    operation
                );

                const [, , , , signatureCount] = await keyManager.getMultiSigKey(
                    await onchainID.getAddress(), keyId
                );
                expect(signatureCount).to.equal(1);
            });

            it("Should reject signing by invalid signer", async function () {
                await expect(keyManager.connect(unauthorized).signMultiSigOperation(
                    await onchainID.getAddress(),
                    keyId,
                    operation
                )).to.be.revertedWith("KeyManager: Not a valid signer");
            });

            it("Should reject double signing by same signer", async function () {
                await keyManager.connect(recoveryAgent1).signMultiSigOperation(
                    await onchainID.getAddress(),
                    keyId,
                    operation
                );

                await expect(keyManager.connect(recoveryAgent1).signMultiSigOperation(
                    await onchainID.getAddress(),
                    keyId,
                    operation
                )).to.be.revertedWith("KeyManager: Already signed");
            });

            it("Should reject signing for inactive multi-sig key", async function () {
                const inactiveKeyId = ethers.keccak256(ethers.solidityPacked(["string"], ["inactive-key"]));

                await expect(keyManager.connect(recoveryAgent1).signMultiSigOperation(
                    await onchainID.getAddress(),
                    inactiveKeyId,
                    operation
                )).to.be.revertedWith("KeyManager: Multi-sig key not active");
            });
        });

        describe("checkMultiSigThreshold", function () {
            let operation: string;

            beforeEach(async function () {
                await keyManager.connect(manager).addMultiSigKey(
                    await onchainID.getAddress(),
                    keyId,
                    signers,
                    2,
                    MANAGEMENT_KEY
                );

                operation = ethers.keccak256(ethers.solidityPacked(["string"], ["test-operation"]));
            });

            it("Should return false when threshold not met", async function () {
                await keyManager.connect(recoveryAgent1).signMultiSigOperation(
                    await onchainID.getAddress(),
                    keyId,
                    operation
                );

                expect(await keyManager.checkMultiSigThreshold(
                    await onchainID.getAddress(), keyId
                )).to.be.false;
            });

            it("Should return true when threshold is met", async function () {
                await keyManager.connect(recoveryAgent1).signMultiSigOperation(
                    await onchainID.getAddress(),
                    keyId,
                    operation
                );
                await keyManager.connect(recoveryAgent2).signMultiSigOperation(
                    await onchainID.getAddress(),
                    keyId,
                    operation
                );

                expect(await keyManager.checkMultiSigThreshold(
                    await onchainID.getAddress(), keyId
                )).to.be.true;
            });
        });
    });

    describe("Key Recovery", function () {
        let recoveryAgents: string[];
        let newRecoveryKey: string;

        beforeEach(async function () {
            recoveryAgents = [recoveryAgent1.address, recoveryAgent2.address, recoveryAgent3.address];
            newRecoveryKey = ethers.keccak256(ethers.solidityPacked(["string"], ["recovery-key"]));
        });

        describe("setupKeyRecovery", function () {
            it("Should allow identity manager to setup key recovery", async function () {
                await keyManager.connect(manager).setupKeyRecovery(
                    await onchainID.getAddress(),
                    recoveryAgents,
                    2 // 2-of-3 threshold
                );

                const [agents, threshold, approvalCount, completed] = await keyManager.getKeyRecovery(
                    await onchainID.getAddress()
                );

                expect(agents).to.deep.equal(recoveryAgents);
                expect(threshold).to.equal(2);
                expect(approvalCount).to.equal(0);
                expect(completed).to.be.false;
            });

            it("Should reject setup with no recovery agents", async function () {
                await expect(keyManager.connect(manager).setupKeyRecovery(
                    await onchainID.getAddress(),
                    [],
                    1
                )).to.be.revertedWith("KeyManager: No recovery agents");
            });

            it("Should reject setup with too many recovery agents", async function () {
                const tooManyAgents = Array(11).fill(recoveryAgent1.address);
                await expect(keyManager.connect(manager).setupKeyRecovery(
                    await onchainID.getAddress(),
                    tooManyAgents,
                    1
                )).to.be.revertedWith("KeyManager: Too many recovery agents");
            });

            it("Should reject setup with invalid threshold", async function () {
                await expect(keyManager.connect(manager).setupKeyRecovery(
                    await onchainID.getAddress(),
                    recoveryAgents,
                    0
                )).to.be.revertedWith("KeyManager: Invalid threshold");

                await expect(keyManager.connect(manager).setupKeyRecovery(
                    await onchainID.getAddress(),
                    recoveryAgents,
                    4 // > agents length
                )).to.be.revertedWith("KeyManager: Invalid threshold");
            });
        });

        describe("initiateKeyRecovery", function () {
            beforeEach(async function () {
                await keyManager.connect(manager).setupKeyRecovery(
                    await onchainID.getAddress(),
                    recoveryAgents,
                    2
                );
            });

            it("Should allow recovery agent to initiate recovery", async function () {
                await expect(keyManager.connect(recoveryAgent1).initiateKeyRecovery(
                    await onchainID.getAddress(),
                    newRecoveryKey
                )).to.emit(keyManager, "KeyRecoveryInitiated")
                    .withArgs(await onchainID.getAddress(), newRecoveryKey, recoveryAgent1.address);
            });

            it("Should reject initiation by non-recovery agent", async function () {
                await expect(keyManager.connect(unauthorized).initiateKeyRecovery(
                    await onchainID.getAddress(),
                    newRecoveryKey
                )).to.be.revertedWith("KeyManager: Not a recovery agent");
            });

            it("Should reject initiation when recovery not set up", async function () {
                // Deploy new OnchainID without recovery setup
                const OnchainIDFactory = await ethers.getContractFactory("OnchainID");
                const newOnchainID = await OnchainIDFactory.deploy(identity.address);

                await expect(keyManager.connect(recoveryAgent1).initiateKeyRecovery(
                    await newOnchainID.getAddress(),
                    newRecoveryKey
                )).to.be.revertedWith("KeyManager: Recovery not set up");
            });
        });

        describe("approveKeyRecovery", function () {
            beforeEach(async function () {
                await keyManager.connect(manager).setupKeyRecovery(
                    await onchainID.getAddress(),
                    recoveryAgents,
                    2
                );

                await keyManager.connect(recoveryAgent1).initiateKeyRecovery(
                    await onchainID.getAddress(),
                    newRecoveryKey
                );
            });

            it("Should allow recovery agent to approve recovery", async function () {
                await keyManager.connect(recoveryAgent1).approveKeyRecovery(
                    await onchainID.getAddress()
                );

                const [, , approvalCount] = await keyManager.getKeyRecovery(
                    await onchainID.getAddress()
                );
                expect(approvalCount).to.equal(1);
            });

            it("Should reject approval by non-recovery agent", async function () {
                await expect(keyManager.connect(unauthorized).approveKeyRecovery(
                    await onchainID.getAddress()
                )).to.be.revertedWith("KeyManager: Not a recovery agent");
            });

            it("Should reject double approval by same agent", async function () {
                await keyManager.connect(recoveryAgent1).approveKeyRecovery(
                    await onchainID.getAddress()
                );

                await expect(keyManager.connect(recoveryAgent1).approveKeyRecovery(
                    await onchainID.getAddress()
                )).to.be.revertedWith("KeyManager: Already approved");
            });
        });

        describe("executeKeyRecovery", function () {
            beforeEach(async function () {
                await keyManager.connect(manager).setupKeyRecovery(
                    await onchainID.getAddress(),
                    recoveryAgents,
                    2
                );

                await keyManager.connect(recoveryAgent1).initiateKeyRecovery(
                    await onchainID.getAddress(),
                    newRecoveryKey
                );

                // Get sufficient approvals
                await keyManager.connect(recoveryAgent1).approveKeyRecovery(
                    await onchainID.getAddress()
                );
                await keyManager.connect(recoveryAgent2).approveKeyRecovery(
                    await onchainID.getAddress()
                );
            });

            it("Should execute recovery after timelock and sufficient approvals", async function () {
                // Fast forward time past recovery timelock
                await ethers.provider.send("evm_increaseTime", [RECOVERY_TIMELOCK + 1]);
                await ethers.provider.send("evm_mine", []);

                await expect(keyManager.connect(recoveryAgent1).executeKeyRecovery(
                    await onchainID.getAddress()
                )).to.emit(keyManager, "KeyRecoveryCompleted")
                    .withArgs(await onchainID.getAddress(), newRecoveryKey);

                // Verify recovery key was added as management key
                expect(await onchainID.keyHasPurpose(newRecoveryKey, MANAGEMENT_KEY)).to.be.true;
            });

            it("Should reject execution before timelock", async function () {
                await expect(keyManager.connect(recoveryAgent1).executeKeyRecovery(
                    await onchainID.getAddress()
                )).to.be.revertedWith("KeyManager: Timelock not expired");
            });

            it("Should reject execution with insufficient approvals", async function () {
                // Setup with only one approval (need 2)
                await keyManager.connect(manager).setupKeyRecovery(
                    await onchainID.getAddress(),
                    recoveryAgents,
                    2
                );

                await keyManager.connect(recoveryAgent1).initiateKeyRecovery(
                    await onchainID.getAddress(),
                    newRecoveryKey
                );

                await keyManager.connect(recoveryAgent1).approveKeyRecovery(
                    await onchainID.getAddress()
                );

                // Fast forward time
                await ethers.provider.send("evm_increaseTime", [RECOVERY_TIMELOCK + 1]);
                await ethers.provider.send("evm_mine", []);

                await expect(keyManager.connect(recoveryAgent1).executeKeyRecovery(
                    await onchainID.getAddress()
                )).to.be.revertedWith("KeyManager: Insufficient approvals");
            });
        });
    });

    describe("Batch Operations", function () {
        describe("batchAddKeys", function () {
            it("Should add multiple keys in batch", async function () {
                const keys = [
                    ethers.keccak256(ethers.solidityPacked(["string"], ["key1"])),
                    ethers.keccak256(ethers.solidityPacked(["string"], ["key2"]))
                ];
                const purposes = [ACTION_KEY, CLAIM_SIGNER_KEY];
                const keyTypes = [ECDSA_TYPE, ECDSA_TYPE];

                await keyManager.connect(manager).batchAddKeys(
                    await onchainID.getAddress(),
                    keys,
                    purposes,
                    keyTypes
                );

                expect(await onchainID.keyHasPurpose(keys[0], ACTION_KEY)).to.be.true;
                expect(await onchainID.keyHasPurpose(keys[1], CLAIM_SIGNER_KEY)).to.be.true;
            });

            it("Should reject batch with mismatched array lengths", async function () {
                const keys = [ethers.keccak256(ethers.solidityPacked(["string"], ["key1"]))];
                const purposes = [ACTION_KEY, CLAIM_SIGNER_KEY]; // Wrong length

                await expect(keyManager.connect(manager).batchAddKeys(
                    await onchainID.getAddress(),
                    keys,
                    purposes,
                    [ECDSA_TYPE]
                )).to.be.revertedWith("KeyManager: Array length mismatch");
            });
        });

        describe("batchRemoveKeys", function () {
            let keys: string[];

            beforeEach(async function () {
                keys = [
                    ethers.keccak256(ethers.solidityPacked(["string"], ["key1"])),
                    ethers.keccak256(ethers.solidityPacked(["string"], ["key2"]))
                ];

                // Add keys first
                await onchainID.connect(identity).addKey(keys[0], ACTION_KEY, ECDSA_TYPE);
                await onchainID.connect(identity).addKey(keys[1], CLAIM_SIGNER_KEY, ECDSA_TYPE);
            });

            it("Should remove multiple keys in batch", async function () {
                const purposes = [ACTION_KEY, CLAIM_SIGNER_KEY];

                await keyManager.connect(manager).batchRemoveKeys(
                    await onchainID.getAddress(),
                    keys,
                    purposes
                );

                expect(await onchainID.keyHasPurpose(keys[0], ACTION_KEY)).to.be.false;
                expect(await onchainID.keyHasPurpose(keys[1], CLAIM_SIGNER_KEY)).to.be.false;
            });
        });
    });

    describe("Admin Functions", function () {
        describe("setCustomTimelock", function () {
            it("Should allow owner to set custom timelock", async function () {
                const customTimelock = 12 * 60 * 60; // 12 hours
                await keyManager.connect(owner).setCustomTimelock(
                    await onchainID.getAddress(),
                    customTimelock
                );

                expect(await keyManager.customTimelocks(await onchainID.getAddress()))
                    .to.equal(customTimelock);
            });

            it("Should reject timelock that is too short", async function () {
                const tooShort = 30 * 60; // 30 minutes
                await expect(keyManager.connect(owner).setCustomTimelock(
                    await onchainID.getAddress(),
                    tooShort
                )).to.be.revertedWith("KeyManager: Timelock too short");
            });

            it("Should reject timelock that is too long", async function () {
                const tooLong = 8 * 24 * 60 * 60; // 8 days
                await expect(keyManager.connect(owner).setCustomTimelock(
                    await onchainID.getAddress(),
                    tooLong
                )).to.be.revertedWith("KeyManager: Timelock too long");
            });
        });
    });

    describe("Integration Tests", function () {
        it("Should handle complete key rotation workflow", async function () {
            const oldKey = ethers.keccak256(ethers.solidityPacked(["string"], ["old-action-key"]));
            const newKey = ethers.keccak256(ethers.solidityPacked(["string"], ["new-action-key"]));

            // Add old key to OnchainID
            await onchainID.connect(identity).addKey(oldKey, ACTION_KEY, ECDSA_TYPE);

            // 1. Initiate rotation
            await keyManager.connect(manager).initiateKeyRotation(
                await onchainID.getAddress(),
                oldKey,
                newKey,
                ACTION_KEY
            );

            // 2. Wait for timelock
            await ethers.provider.send("evm_increaseTime", [DEFAULT_TIMELOCK + 1]);
            await ethers.provider.send("evm_mine", []);

            // 3. Execute rotation
            await keyManager.connect(manager).executeKeyRotation(
                await onchainID.getAddress(),
                oldKey,
                newKey,
                ACTION_KEY
            );

            // 4. Verify final state
            expect(await onchainID.keyHasPurpose(oldKey, ACTION_KEY)).to.be.false;
            expect(await onchainID.keyHasPurpose(newKey, ACTION_KEY)).to.be.true;
        });

        it("Should handle complete key recovery workflow", async function () {
            const recoveryAgents = [recoveryAgent1.address, recoveryAgent2.address];
            const recoveryKey = ethers.keccak256(ethers.solidityPacked(["string"], ["emergency-recovery-key"]));

            // 1. Setup recovery
            await keyManager.connect(manager).setupKeyRecovery(
                await onchainID.getAddress(),
                recoveryAgents,
                2
            );

            // 2. Initiate recovery
            await keyManager.connect(recoveryAgent1).initiateKeyRecovery(
                await onchainID.getAddress(),
                recoveryKey
            );

            // 3. Get approvals
            await keyManager.connect(recoveryAgent1).approveKeyRecovery(
                await onchainID.getAddress()
            );
            await keyManager.connect(recoveryAgent2).approveKeyRecovery(
                await onchainID.getAddress()
            );

            // 4. Wait for timelock
            await ethers.provider.send("evm_increaseTime", [RECOVERY_TIMELOCK + 1]);
            await ethers.provider.send("evm_mine", []);

            // 5. Execute recovery
            await keyManager.connect(recoveryAgent1).executeKeyRecovery(
                await onchainID.getAddress()
            );

            // 6. Verify recovery key was added
            expect(await onchainID.keyHasPurpose(recoveryKey, MANAGEMENT_KEY)).to.be.true;
        });
    });
});