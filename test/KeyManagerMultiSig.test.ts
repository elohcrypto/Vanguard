import { expect } from "chai";
import { ethers } from "hardhat";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import { KeyManager, OnchainID } from "../typechain-types";
import { MANAGEMENT_KEY, deployKeyManager } from "./helpers/keyManagerFixture";

describe("KeyManager", function () {
  let keyManager: KeyManager;
  let onchainID: OnchainID;
  let identity: SignerWithAddress;
  let manager: SignerWithAddress;
  let recoveryAgent1: SignerWithAddress;
  let recoveryAgent2: SignerWithAddress;
  let recoveryAgent3: SignerWithAddress;
  let unauthorized: SignerWithAddress;

  beforeEach(async function () {
    ({
      keyManager,
      onchainID,
      identity,
      manager,
      recoveryAgent1,
      recoveryAgent2,
      recoveryAgent3,
      unauthorized,
    } = await deployKeyManager());
  });

  describe("Multi-Signature Key Management", function () {
    let keyId: string;
    let signers: string[];

    beforeEach(async function () {
      keyId = ethers.keccak256(
        ethers.solidityPacked(["string"], ["multisig-key"]),
      );
      signers = [
        ethers.keccak256(
          ethers.solidityPacked(["address"], [recoveryAgent1.address]),
        ),
        ethers.keccak256(
          ethers.solidityPacked(["address"], [recoveryAgent2.address]),
        ),
        ethers.keccak256(
          ethers.solidityPacked(["address"], [recoveryAgent3.address]),
        ),
      ];
    });

    describe("addMultiSigKey", function () {
      it("Should allow identity manager to add multi-sig key", async function () {
        await expect(
          keyManager.connect(manager).addMultiSigKey(
            await onchainID.getAddress(),
            keyId,
            signers,
            2, // 2-of-3 threshold
            MANAGEMENT_KEY,
          ),
        )
          .to.emit(keyManager, "MultiSigKeyAdded")
          .withArgs(
            await onchainID.getAddress(),
            keyId,
            MANAGEMENT_KEY,
            2,
            signers,
          );

        const [returnedSigners, threshold, purpose, active, signatureCount] =
          await keyManager.getMultiSigKey(await onchainID.getAddress(), keyId);

        expect(returnedSigners).to.deep.equal(signers);
        expect(threshold).to.equal(2);
        expect(purpose).to.equal(MANAGEMENT_KEY);
        expect(active).to.be.true;
        expect(signatureCount).to.equal(0);
      });

      it("Should reject adding multi-sig key with no signers", async function () {
        await expect(
          keyManager
            .connect(manager)
            .addMultiSigKey(
              await onchainID.getAddress(),
              keyId,
              [],
              1,
              MANAGEMENT_KEY,
            ),
        ).to.be.revertedWith("KeyManager: No signers provided");
      });

      it("Should reject adding multi-sig key with invalid threshold", async function () {
        await expect(
          keyManager.connect(manager).addMultiSigKey(
            await onchainID.getAddress(),
            keyId,
            signers,
            0, // Invalid threshold
            MANAGEMENT_KEY,
          ),
        ).to.be.revertedWith("KeyManager: Invalid threshold");

        await expect(
          keyManager.connect(manager).addMultiSigKey(
            await onchainID.getAddress(),
            keyId,
            signers,
            4, // Threshold > signers length
            MANAGEMENT_KEY,
          ),
        ).to.be.revertedWith("KeyManager: Invalid threshold");
      });

      it("Should reject adding duplicate multi-sig key", async function () {
        await keyManager
          .connect(manager)
          .addMultiSigKey(
            await onchainID.getAddress(),
            keyId,
            signers,
            2,
            MANAGEMENT_KEY,
          );

        await expect(
          keyManager
            .connect(manager)
            .addMultiSigKey(
              await onchainID.getAddress(),
              keyId,
              signers,
              2,
              MANAGEMENT_KEY,
            ),
        ).to.be.revertedWith("KeyManager: Multi-sig key already exists");
      });
    });

    describe("signMultiSigOperation", function () {
      let operation: string;

      beforeEach(async function () {
        await keyManager
          .connect(manager)
          .addMultiSigKey(
            await onchainID.getAddress(),
            keyId,
            signers,
            2,
            MANAGEMENT_KEY,
          );

        operation = ethers.keccak256(
          ethers.solidityPacked(["string"], ["test-operation"]),
        );
      });

      it("Should allow valid signer to sign operation", async function () {
        await keyManager
          .connect(recoveryAgent1)
          .signMultiSigOperation(
            await onchainID.getAddress(),
            keyId,
            operation,
          );

        const [, , , , signatureCount] = await keyManager.getMultiSigKey(
          await onchainID.getAddress(),
          keyId,
        );
        expect(signatureCount).to.equal(1);
      });

      it("Should reject signing by invalid signer", async function () {
        await expect(
          keyManager
            .connect(unauthorized)
            .signMultiSigOperation(
              await onchainID.getAddress(),
              keyId,
              operation,
            ),
        ).to.be.revertedWith("KeyManager: Not a valid signer");
      });

      it("Should reject double signing by same signer", async function () {
        await keyManager
          .connect(recoveryAgent1)
          .signMultiSigOperation(
            await onchainID.getAddress(),
            keyId,
            operation,
          );

        await expect(
          keyManager
            .connect(recoveryAgent1)
            .signMultiSigOperation(
              await onchainID.getAddress(),
              keyId,
              operation,
            ),
        ).to.be.revertedWith("KeyManager: Already signed");
      });

      it("Should reject signing for inactive multi-sig key", async function () {
        const inactiveKeyId = ethers.keccak256(
          ethers.solidityPacked(["string"], ["inactive-key"]),
        );

        await expect(
          keyManager
            .connect(recoveryAgent1)
            .signMultiSigOperation(
              await onchainID.getAddress(),
              inactiveKeyId,
              operation,
            ),
        ).to.be.revertedWith("KeyManager: Multi-sig key not active");
      });
    });

    describe("checkMultiSigThreshold", function () {
      let operation: string;

      beforeEach(async function () {
        await keyManager
          .connect(manager)
          .addMultiSigKey(
            await onchainID.getAddress(),
            keyId,
            signers,
            2,
            MANAGEMENT_KEY,
          );

        operation = ethers.keccak256(
          ethers.solidityPacked(["string"], ["test-operation"]),
        );
      });

      it("Should return false when threshold not met", async function () {
        await keyManager
          .connect(recoveryAgent1)
          .signMultiSigOperation(
            await onchainID.getAddress(),
            keyId,
            operation,
          );

        expect(
          await keyManager.checkMultiSigThreshold(
            await onchainID.getAddress(),
            keyId,
          ),
        ).to.be.false;
      });

      it("Should return true when threshold is met", async function () {
        await keyManager
          .connect(recoveryAgent1)
          .signMultiSigOperation(
            await onchainID.getAddress(),
            keyId,
            operation,
          );
        await keyManager
          .connect(recoveryAgent2)
          .signMultiSigOperation(
            await onchainID.getAddress(),
            keyId,
            operation,
          );

        expect(
          await keyManager.checkMultiSigThreshold(
            await onchainID.getAddress(),
            keyId,
          ),
        ).to.be.true;
      });
    });
  });
});
