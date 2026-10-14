import { expect } from "chai";
import { ethers } from "hardhat";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import { KeyManager, OnchainID } from "../typechain-types";
import {
  MANAGEMENT_KEY,
  ACTION_KEY,
  CLAIM_SIGNER_KEY,
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
  let recoveryAgent2: SignerWithAddress;
  let unauthorized: SignerWithAddress;

  beforeEach(async function () {
    ({
      keyManager,
      onchainID,
      owner,
      identity,
      manager,
      recoveryAgent1,
      recoveryAgent2,
      unauthorized,
    } = await deployKeyManager());
  });

  describe("Batch Operations", function () {
    describe("batchAddKeys", function () {
      it("Should add multiple keys in batch", async function () {
        const keys = [
          ethers.keccak256(ethers.solidityPacked(["string"], ["key1"])),
          ethers.keccak256(ethers.solidityPacked(["string"], ["key2"])),
        ];
        const purposes = [ACTION_KEY, CLAIM_SIGNER_KEY];
        const keyTypes = [ECDSA_TYPE, ECDSA_TYPE];

        await keyManager
          .connect(manager)
          .batchAddKeys(await onchainID.getAddress(), keys, purposes, keyTypes);

        expect(await onchainID.keyHasPurpose(keys[0], ACTION_KEY)).to.be.true;
        expect(await onchainID.keyHasPurpose(keys[1], CLAIM_SIGNER_KEY)).to.be
          .true;
      });

      it("Should reject batch with mismatched array lengths", async function () {
        const keys = [
          ethers.keccak256(ethers.solidityPacked(["string"], ["key1"])),
        ];
        const purposes = [ACTION_KEY, CLAIM_SIGNER_KEY]; // Wrong length

        await expect(
          keyManager
            .connect(manager)
            .batchAddKeys(await onchainID.getAddress(), keys, purposes, [
              ECDSA_TYPE,
            ]),
        ).to.be.revertedWith("KeyManager: Array length mismatch");
      });
    });

    describe("batchRemoveKeys", function () {
      let keys: string[];

      beforeEach(async function () {
        keys = [
          ethers.keccak256(ethers.solidityPacked(["string"], ["key1"])),
          ethers.keccak256(ethers.solidityPacked(["string"], ["key2"])),
        ];

        // Add keys first
        await onchainID
          .connect(identity)
          .addKey(keys[0], ACTION_KEY, ECDSA_TYPE);
        await onchainID
          .connect(identity)
          .addKey(keys[1], CLAIM_SIGNER_KEY, ECDSA_TYPE);
      });

      it("Should remove multiple keys in batch", async function () {
        const purposes = [ACTION_KEY, CLAIM_SIGNER_KEY];

        await keyManager
          .connect(manager)
          .batchRemoveKeys(await onchainID.getAddress(), keys, purposes);

        expect(await onchainID.keyHasPurpose(keys[0], ACTION_KEY)).to.be.false;
        expect(await onchainID.keyHasPurpose(keys[1], CLAIM_SIGNER_KEY)).to.be
          .false;
      });
    });
  });

  describe("Custom timelock (per identity)", function () {
    describe("setCustomTimelock", function () {
      it("the identity's manager sets it and rotations use it", async function () {
        const id = await onchainID.getAddress();
        const customTimelock = 12 * 60 * 60; // 12 hours
        await expect(
          keyManager.connect(manager).setCustomTimelock(id, customTimelock),
        )
          .to.emit(keyManager, "CustomTimelockSet")
          .withArgs(id, customTimelock);
        expect(await keyManager.customTimelocks(id)).to.equal(customTimelock);

        const oldKey = ethers.keccak256(ethers.toUtf8Bytes("tl-old"));
        const newKey = ethers.keccak256(ethers.toUtf8Bytes("tl-new"));
        await onchainID
          .connect(identity)
          .addKey(oldKey, ACTION_KEY, ECDSA_TYPE);
        await keyManager
          .connect(manager)
          .initiateKeyRotation(id, oldKey, newKey, ACTION_KEY);
        const rotationId = ethers.keccak256(
          ethers.solidityPacked(
            ["address", "bytes32", "bytes32", "uint256"],
            [id, oldKey, newKey, ACTION_KEY],
          ),
        );
        const r = await keyManager.getKeyRotation(id, rotationId);
        expect(r.executionTime - r.initiatedAt).to.equal(customTimelock);
      });

      it("a non-manager (the deployer included) cannot set it", async function () {
        for (const who of [owner, unauthorized]) {
          await expect(
            keyManager
              .connect(who)
              .setCustomTimelock(await onchainID.getAddress(), 2 * 3600),
          ).to.be.revertedWith("KeyManager: Not identity manager");
        }
      });

      it("Should reject timelock that is too short", async function () {
        const tooShort = 30 * 60; // 30 minutes
        await expect(
          keyManager
            .connect(manager)
            .setCustomTimelock(await onchainID.getAddress(), tooShort),
        ).to.be.revertedWith("KeyManager: Timelock too short");
      });

      it("Should reject timelock that is too long", async function () {
        const tooLong = 8 * 24 * 60 * 60; // 8 days
        await expect(
          keyManager
            .connect(manager)
            .setCustomTimelock(await onchainID.getAddress(), tooLong),
        ).to.be.revertedWith("KeyManager: Timelock too long");
      });
    });
  });

  describe("Integration Tests", function () {
    it("Should handle complete key rotation workflow", async function () {
      const oldKey = ethers.keccak256(
        ethers.solidityPacked(["string"], ["old-action-key"]),
      );
      const newKey = ethers.keccak256(
        ethers.solidityPacked(["string"], ["new-action-key"]),
      );

      // Add old key to OnchainID
      await onchainID.connect(identity).addKey(oldKey, ACTION_KEY, ECDSA_TYPE);

      // 1. Initiate rotation
      await keyManager
        .connect(manager)
        .initiateKeyRotation(
          await onchainID.getAddress(),
          oldKey,
          newKey,
          ACTION_KEY,
        );

      // 2. Wait for timelock
      await ethers.provider.send("evm_increaseTime", [DEFAULT_TIMELOCK + 1]);
      await ethers.provider.send("evm_mine", []);

      // 3. Execute rotation
      await keyManager
        .connect(manager)
        .executeKeyRotation(
          await onchainID.getAddress(),
          oldKey,
          newKey,
          ACTION_KEY,
        );

      // 4. Verify final state
      expect(await onchainID.keyHasPurpose(oldKey, ACTION_KEY)).to.be.false;
      expect(await onchainID.keyHasPurpose(newKey, ACTION_KEY)).to.be.true;
    });

    it("Should handle complete key recovery workflow", async function () {
      const recoveryAgents = [recoveryAgent1.address, recoveryAgent2.address];
      const recoveryKey = ethers.keccak256(
        ethers.solidityPacked(["string"], ["emergency-recovery-key"]),
      );

      // 1. Setup recovery
      await keyManager
        .connect(identity)
        .setupKeyRecovery(await onchainID.getAddress(), recoveryAgents, 2);

      // 2. Initiate recovery
      await keyManager
        .connect(recoveryAgent1)
        .initiateKeyRecovery(await onchainID.getAddress(), recoveryKey);
      await keyManager
        .connect(recoveryAgent2)
        .approveKeyRecovery(await onchainID.getAddress(), recoveryKey);

      // 4. Wait for timelock
      await ethers.provider.send("evm_increaseTime", [RECOVERY_TIMELOCK + 1]);
      await ethers.provider.send("evm_mine", []);

      // 5. Execute recovery
      await keyManager
        .connect(recoveryAgent1)
        .executeKeyRecovery(await onchainID.getAddress(), recoveryKey);

      // 6. Verify recovery key was added
      expect(await onchainID.keyHasPurpose(recoveryKey, MANAGEMENT_KEY)).to.be
        .true;
    });
  });
});
