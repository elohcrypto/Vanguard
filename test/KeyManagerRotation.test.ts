import { expect } from "chai";
import { ethers } from "hardhat";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import { KeyManager, OnchainID } from "../typechain-types";
import {
  ACTION_KEY,
  ECDSA_TYPE,
  DEFAULT_TIMELOCK,
  RECOVERY_TIMELOCK,
  deployKeyManager,
} from "./helpers/keyManagerFixture";

describe("KeyManager", function () {
  let keyManager: KeyManager;
  let onchainID: OnchainID;
  let owner: SignerWithAddress;
  let identity: SignerWithAddress;
  let manager: SignerWithAddress;
  let recoveryAgent1: SignerWithAddress;
  let unauthorized: SignerWithAddress;

  beforeEach(async function () {
    ({
      keyManager,
      onchainID,
      owner,
      identity,
      manager,
      recoveryAgent1,
      unauthorized,
    } = await deployKeyManager());
  });

  describe("Deployment", function () {
    it("holds no owner and no allowlist", async function () {
      const km = keyManager as unknown as Record<string, unknown>;
      expect(km.owner).to.equal(undefined);
      expect(km.addAuthorizedManager).to.equal(undefined);
      expect(km.authorizedManagers).to.equal(undefined);
    });

    it("Should have correct default constants", async function () {
      expect(await keyManager.DEFAULT_TIMELOCK()).to.equal(DEFAULT_TIMELOCK);
      expect(await keyManager.RECOVERY_TIMELOCK()).to.equal(RECOVERY_TIMELOCK);
      expect(await keyManager.MAX_RECOVERY_AGENTS()).to.equal(10);
    });
  });

  describe("Per-identity authorization (4.2)", function () {
    let other: OnchainID;
    const oldKey = ethers.keccak256(ethers.toUtf8Bytes("auth-old"));
    const newKey = ethers.keccak256(ethers.toUtf8Bytes("auth-new"));

    beforeEach(async function () {
      // Same manager key, but this identity never authorized KeyManager.
      other = await (
        await ethers.getContractFactory("OnchainID")
      ).deploy(manager.address);
      await other.connect(manager).addKey(oldKey, ACTION_KEY, ECDSA_TYPE);
    });

    it("an identity that did not authorize it cannot be rotated", async function () {
      await expect(
        keyManager
          .connect(manager)
          .initiateKeyRotation(
            await other.getAddress(),
            oldKey,
            newKey,
            ACTION_KEY,
          ),
      ).to.be.revertedWith(
        "KeyManager: Identity has not authorized KeyManager",
      );
      await expect(
        keyManager
          .connect(manager)
          .setupKeyRecovery(
            await other.getAddress(),
            [recoveryAgent1.address],
            1,
          ),
      ).to.be.revertedWithCustomError(keyManager, "NotRecoveryManager");
    });

    it("a non-manager cannot initiate on an authorizing identity", async function () {
      await onchainID.connect(identity).addKey(oldKey, ACTION_KEY, ECDSA_TYPE);
      await expect(
        keyManager
          .connect(unauthorized)
          .initiateKeyRotation(
            await onchainID.getAddress(),
            oldKey,
            newKey,
            ACTION_KEY,
          ),
      ).to.be.revertedWith("KeyManager: Not identity manager");
    });

    it("deauthorizing pauses a pending rotation; cancel still works while withdrawn", async function () {
      const id = await onchainID.getAddress();
      await onchainID.connect(identity).addKey(oldKey, ACTION_KEY, ECDSA_TYPE);
      await keyManager
        .connect(manager)
        .initiateKeyRotation(id, oldKey, newKey, ACTION_KEY);
      await onchainID
        .connect(identity)
        .deauthorizeManager(await keyManager.getAddress());
      await ethers.provider.send("evm_increaseTime", [DEFAULT_TIMELOCK + 1]);
      await ethers.provider.send("evm_mine", []);
      await expect(
        keyManager.executeKeyRotation(id, oldKey, newKey, ACTION_KEY),
      ).to.be.revertedWith(
        "KeyManager: Identity has not authorized KeyManager",
      );
      await expect(
        keyManager
          .connect(manager)
          .cancelKeyRotation(id, oldKey, newKey, ACTION_KEY),
      ).to.emit(keyManager, "KeyRotationCancelled");
      expect(await onchainID.keyHasPurpose(oldKey, ACTION_KEY)).to.equal(true);
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
        await expect(
          keyManager
            .connect(manager)
            .initiateKeyRotation(
              await onchainID.getAddress(),
              oldKey,
              newKey,
              ACTION_KEY,
            ),
        )
          .to.emit(keyManager, "KeyRotationInitiated")
          .withArgs(await onchainID.getAddress(), oldKey, newKey, ACTION_KEY);

        const rotationId = ethers.keccak256(
          ethers.solidityPacked(
            ["address", "bytes32", "bytes32", "uint256"],
            [await onchainID.getAddress(), oldKey, newKey, ACTION_KEY],
          ),
        );

        const rotation = await keyManager.getKeyRotation(
          await onchainID.getAddress(),
          rotationId,
        );
        expect(rotation.oldKey).to.equal(oldKey);
        expect(rotation.newKey).to.equal(newKey);
        expect(rotation.purpose).to.equal(ACTION_KEY);
        expect(rotation.completed).to.be.false;
        expect(rotation.initiator).to.equal(manager.address);
      });

      it("Should reject initiation with invalid identity", async function () {
        await expect(
          keyManager
            .connect(manager)
            .initiateKeyRotation(
              ethers.ZeroAddress,
              oldKey,
              newKey,
              ACTION_KEY,
            ),
        ).to.be.revertedWithoutReason();
      });

      it("Should reject initiation with zero keys", async function () {
        await expect(
          keyManager
            .connect(manager)
            .initiateKeyRotation(
              await onchainID.getAddress(),
              ethers.ZeroHash,
              newKey,
              ACTION_KEY,
            ),
        ).to.be.revertedWith("KeyManager: Invalid old key");

        await expect(
          keyManager
            .connect(manager)
            .initiateKeyRotation(
              await onchainID.getAddress(),
              oldKey,
              ethers.ZeroHash,
              ACTION_KEY,
            ),
        ).to.be.revertedWith("KeyManager: Invalid new key");
      });

      it("Should reject initiation with same old and new keys", async function () {
        await expect(
          keyManager
            .connect(manager)
            .initiateKeyRotation(
              await onchainID.getAddress(),
              oldKey,
              oldKey,
              ACTION_KEY,
            ),
        ).to.be.revertedWith("KeyManager: Keys must be different");
      });

      it("Should reject initiation for non-existent old key", async function () {
        const nonExistentKey = ethers.keccak256(
          ethers.solidityPacked(["string"], ["non-existent"]),
        );
        await expect(
          keyManager
            .connect(manager)
            .initiateKeyRotation(
              await onchainID.getAddress(),
              nonExistentKey,
              newKey,
              ACTION_KEY,
            ),
        ).to.be.revertedWith(
          "KeyManager: Old key does not have specified purpose",
        );
      });

      it("Should reject initiation by unauthorized user", async function () {
        await expect(
          keyManager
            .connect(unauthorized)
            .initiateKeyRotation(
              await onchainID.getAddress(),
              oldKey,
              newKey,
              ACTION_KEY,
            ),
        ).to.be.revertedWith("KeyManager: Not identity manager");
      });
    });

    describe("executeKeyRotation", function () {
      let rotationId: string;

      beforeEach(async function () {
        await keyManager
          .connect(manager)
          .initiateKeyRotation(
            await onchainID.getAddress(),
            oldKey,
            newKey,
            ACTION_KEY,
          );

        rotationId = ethers.keccak256(
          ethers.solidityPacked(
            ["address", "bytes32", "bytes32", "uint256"],
            [await onchainID.getAddress(), oldKey, newKey, ACTION_KEY],
          ),
        );
      });

      it("Should execute key rotation after timelock", async function () {
        // Fast forward time past timelock
        await ethers.provider.send("evm_increaseTime", [DEFAULT_TIMELOCK + 1]);
        await ethers.provider.send("evm_mine", []);

        await expect(
          keyManager
            .connect(manager)
            .executeKeyRotation(
              await onchainID.getAddress(),
              oldKey,
              newKey,
              ACTION_KEY,
            ),
        )
          .to.emit(keyManager, "KeyRotationCompleted")
          .withArgs(await onchainID.getAddress(), oldKey, newKey, ACTION_KEY);

        // Verify old key is removed and new key is added
        expect(await onchainID.keyHasPurpose(oldKey, ACTION_KEY)).to.be.false;
        expect(await onchainID.keyHasPurpose(newKey, ACTION_KEY)).to.be.true;

        // Verify rotation is marked as completed
        const rotation = await keyManager.getKeyRotation(
          await onchainID.getAddress(),
          rotationId,
        );
        expect(rotation.completed).to.be.true;
      });

      it("Should reject execution before timelock", async function () {
        await expect(
          keyManager
            .connect(manager)
            .executeKeyRotation(
              await onchainID.getAddress(),
              oldKey,
              newKey,
              ACTION_KEY,
            ),
        ).to.be.revertedWith("KeyManager: Timelock not expired");
      });

      it("Should reject execution of non-initiated rotation", async function () {
        const nonExistentKey = ethers.keccak256(
          ethers.solidityPacked(["string"], ["non-existent"]),
        );
        await expect(
          keyManager
            .connect(manager)
            .executeKeyRotation(
              await onchainID.getAddress(),
              nonExistentKey,
              newKey,
              ACTION_KEY,
            ),
        ).to.be.revertedWith("KeyManager: Rotation not initiated");
      });

      it("Should reject double execution", async function () {
        // Fast forward time and execute once
        await ethers.provider.send("evm_increaseTime", [DEFAULT_TIMELOCK + 1]);
        await ethers.provider.send("evm_mine", []);

        await keyManager
          .connect(manager)
          .executeKeyRotation(
            await onchainID.getAddress(),
            oldKey,
            newKey,
            ACTION_KEY,
          );

        // Try to execute again
        await expect(
          keyManager
            .connect(manager)
            .executeKeyRotation(
              await onchainID.getAddress(),
              oldKey,
              newKey,
              ACTION_KEY,
            ),
        ).to.be.revertedWith("KeyManager: Rotation already completed");
      });
    });
  });
});
