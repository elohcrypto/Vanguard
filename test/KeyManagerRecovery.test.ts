import { expect } from "chai";
import { ethers } from "hardhat";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import { KeyManager, OnchainID } from "../typechain-types";
import {
  MANAGEMENT_KEY,
  RECOVERY_TIMELOCK,
  deployKeyManager,
} from "./helpers/keyManagerFixture";

describe("KeyManager", function () {
  let keyManager: KeyManager;
  let onchainID: OnchainID;
  let owner: SignerWithAddress;
  let identity: SignerWithAddress;
  let recoveryAgent1: SignerWithAddress;
  let recoveryAgent2: SignerWithAddress;
  let recoveryAgent3: SignerWithAddress;
  let unauthorized: SignerWithAddress;

  beforeEach(async function () {
    ({
      keyManager,
      onchainID,
      owner,
      identity,
      recoveryAgent1,
      recoveryAgent2,
      recoveryAgent3,
      unauthorized,
    } = await deployKeyManager());
  });

  describe("Key Recovery", function () {
    let recoveryAgents: string[];
    let newRecoveryKey: string;

    beforeEach(async function () {
      recoveryAgents = [
        recoveryAgent1.address,
        recoveryAgent2.address,
        recoveryAgent3.address,
      ];
      newRecoveryKey = ethers.keccak256(
        ethers.solidityPacked(["string"], ["recovery-key"]),
      );
    });

    describe("setupKeyRecovery", function () {
      it("Should allow the identity owner to setup key recovery", async function () {
        await keyManager.connect(identity).setupKeyRecovery(
          await onchainID.getAddress(),
          recoveryAgents,
          2, // 2-of-3 threshold
        );

        const [agents, threshold, approvalCount, completed] =
          await keyManager.getKeyRecovery(await onchainID.getAddress());

        expect(agents).to.deep.equal(recoveryAgents);
        expect(threshold).to.equal(2);
        expect(approvalCount).to.equal(0);
        expect(completed).to.be.false;
      });

      it("Should reject setup with no recovery agents", async function () {
        await expect(
          keyManager
            .connect(identity)
            .setupKeyRecovery(await onchainID.getAddress(), [], 1),
        ).to.be.revertedWith("KeyManager: No recovery agents");
      });

      it("Should reject setup with too many recovery agents", async function () {
        const tooManyAgents = Array(11).fill(recoveryAgent1.address);
        await expect(
          keyManager
            .connect(identity)
            .setupKeyRecovery(await onchainID.getAddress(), tooManyAgents, 1),
        ).to.be.revertedWith("KeyManager: Too many recovery agents");
      });

      it("Should reject setup with invalid threshold", async function () {
        const idA = await onchainID.getAddress();
        const km = keyManager.connect(identity);
        // D59 (a): one agent key alone may never move the identity.
        for (const t of [0, 1]) {
          await expect(
            km.setupKeyRecovery(idA, recoveryAgents, t),
          ).to.be.revertedWithCustomError(km, "ThresholdBelowTwo");
        }
        await expect(
          km.setupKeyRecovery(idA, recoveryAgents, 4), // > agents length
        ).to.be.revertedWith("KeyManager: Invalid threshold");
      });
    });

    describe("initiateKeyRecovery", function () {
      beforeEach(async function () {
        await keyManager
          .connect(identity)
          .setupKeyRecovery(await onchainID.getAddress(), recoveryAgents, 2);
      });

      it("Should allow recovery agent to initiate recovery", async function () {
        await expect(
          keyManager
            .connect(recoveryAgent1)
            .initiateKeyRecovery(await onchainID.getAddress(), newRecoveryKey),
        )
          .to.emit(keyManager, "KeyRecoveryInitiated")
          .withArgs(
            await onchainID.getAddress(),
            newRecoveryKey,
            recoveryAgent1.address,
          );
      });

      it("Should reject initiation by non-recovery agent", async function () {
        await expect(
          keyManager
            .connect(unauthorized)
            .initiateKeyRecovery(await onchainID.getAddress(), newRecoveryKey),
        ).to.be.revertedWith("KeyManager: Not a recovery agent");
      });

      it("Should reject initiation when recovery not set up", async function () {
        // Deploy new OnchainID without recovery setup
        const OnchainIDFactory = await ethers.getContractFactory("OnchainID");
        const newOnchainID = await OnchainIDFactory.deploy(identity.address);

        await expect(
          keyManager
            .connect(recoveryAgent1)
            .initiateKeyRecovery(
              await newOnchainID.getAddress(),
              newRecoveryKey,
            ),
        ).to.be.revertedWith("KeyManager: Recovery not set up");
      });
    });

    describe("approveKeyRecovery", function () {
      beforeEach(async function () {
        await keyManager
          .connect(identity)
          .setupKeyRecovery(await onchainID.getAddress(), recoveryAgents, 2);

        await keyManager
          .connect(recoveryAgent1)
          .initiateKeyRecovery(await onchainID.getAddress(), newRecoveryKey);
      });

      it("Should allow recovery agent to approve recovery", async function () {
        // The opener's approval counted at open (D39): two with agent 2's.
        await keyManager
          .connect(recoveryAgent2)
          .approveKeyRecovery(await onchainID.getAddress(), newRecoveryKey);

        const [, , approvalCount] = await keyManager.getKeyRecovery(
          await onchainID.getAddress(),
        );
        expect(approvalCount).to.equal(2);
      });

      it("Should reject approval by non-recovery agent", async function () {
        await expect(
          keyManager
            .connect(unauthorized)
            .approveKeyRecovery(await onchainID.getAddress(), newRecoveryKey),
        ).to.be.revertedWith("KeyManager: Not a recovery agent");
      });

      it("Should reject double approval by same agent", async function () {
        // The opener already approved by opening (D39).
        await expect(
          keyManager
            .connect(recoveryAgent1)
            .approveKeyRecovery(await onchainID.getAddress(), newRecoveryKey),
        ).to.be.revertedWith("KeyManager: Already approved");
        await keyManager
          .connect(recoveryAgent2)
          .approveKeyRecovery(await onchainID.getAddress(), newRecoveryKey);
        await expect(
          keyManager
            .connect(recoveryAgent2)
            .approveKeyRecovery(await onchainID.getAddress(), newRecoveryKey),
        ).to.be.revertedWith("KeyManager: Already approved");
      });
    });

    describe("executeKeyRecovery", function () {
      beforeEach(async function () {
        await keyManager
          .connect(identity)
          .setupKeyRecovery(await onchainID.getAddress(), recoveryAgents, 2);

        await keyManager
          .connect(recoveryAgent1)
          .initiateKeyRecovery(await onchainID.getAddress(), newRecoveryKey);
        await keyManager
          .connect(recoveryAgent2)
          .approveKeyRecovery(await onchainID.getAddress(), newRecoveryKey);
      });

      it("Should execute recovery after timelock and sufficient approvals", async function () {
        // Fast forward time past recovery timelock
        await ethers.provider.send("evm_increaseTime", [RECOVERY_TIMELOCK + 1]);
        await ethers.provider.send("evm_mine", []);

        await expect(
          keyManager
            .connect(recoveryAgent1)
            .executeKeyRecovery(await onchainID.getAddress(), newRecoveryKey),
        )
          .to.emit(keyManager, "KeyRecoveryCompleted")
          .withArgs(await onchainID.getAddress(), newRecoveryKey);

        // Verify recovery key was added as management key
        expect(await onchainID.keyHasPurpose(newRecoveryKey, MANAGEMENT_KEY)).to
          .be.true;
      });

      it("Should reject execution before timelock", async function () {
        await expect(
          keyManager
            .connect(recoveryAgent1)
            .executeKeyRecovery(await onchainID.getAddress(), newRecoveryKey),
        ).to.be.revertedWith("KeyManager: Timelock not expired");
      });

      it("Should reject execution with insufficient approvals", async function () {
        // The beforeEach candidate is approved: setup is locked until its
        // agents cancel it at the threshold (Task 4.11).
        for (const agent of [recoveryAgent1, recoveryAgent2]) {
          await keyManager
            .connect(agent)
            .cancelKeyRecovery(await onchainID.getAddress(), newRecoveryKey);
        }
        // Setup with only one approval (need 2)
        await keyManager
          .connect(identity)
          .setupKeyRecovery(await onchainID.getAddress(), recoveryAgents, 2);

        await keyManager

          .connect(recoveryAgent1)

          .initiateKeyRecovery(await onchainID.getAddress(), newRecoveryKey);

        // Fast forward time
        await ethers.provider.send("evm_increaseTime", [RECOVERY_TIMELOCK + 1]);
        await ethers.provider.send("evm_mine", []);

        await expect(
          keyManager
            .connect(recoveryAgent1)
            .executeKeyRecovery(await onchainID.getAddress(), newRecoveryKey),
        ).to.be.revertedWith("KeyManager: Insufficient approvals");
      });
    });
  });
});
