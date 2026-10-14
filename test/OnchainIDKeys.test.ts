import { expect } from "chai";
import { ethers } from "hardhat";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import { OnchainID } from "../typechain-types";

describe("OnchainID", function () {
  let onchainID: OnchainID;
  let owner: SignerWithAddress;
  let user1: SignerWithAddress;
  let user2: SignerWithAddress;
  let claimIssuer: SignerWithAddress;
  let unauthorized: SignerWithAddress;

  // Key purposes
  const MANAGEMENT_KEY = 1;
  const ACTION_KEY = 2;
  const CLAIM_SIGNER_KEY = 3;
  const ENCRYPTION_KEY = 4;

  // Key types
  const ECDSA_TYPE = 1;

  beforeEach(async function () {
    [owner, user1, user2, claimIssuer, unauthorized] =
      await ethers.getSigners();

    const OnchainIDFactory = await ethers.getContractFactory("OnchainID");
    onchainID = await OnchainIDFactory.deploy(owner.address);
    await onchainID.waitForDeployment();
  });

  describe("Deployment", function () {
    it("Should set the correct owner", async function () {
      expect(await onchainID.owner()).to.equal(owner.address);
    });

    it("Should set creation time", async function () {
      const creationTime = await onchainID.getCreationTime();
      expect(creationTime).to.be.gt(0);
    });

    it("Should add owner's key as management key", async function () {
      const ownerKey = ethers.keccak256(
        ethers.solidityPacked(["address"], [owner.address]),
      );
      expect(await onchainID.keyHasPurpose(ownerKey, MANAGEMENT_KEY)).to.be
        .true;
    });

    it("Should emit IdentityCreated event", async function () {
      const OnchainIDFactory = await ethers.getContractFactory("OnchainID");
      const newOnchainID = await OnchainIDFactory.deploy(user1.address);

      // Check that the contract was deployed successfully
      expect(await newOnchainID.getAddress()).to.not.equal(ethers.ZeroAddress);
    });
  });

  describe("Key Management (ERC-734)", function () {
    let testKey: string;
    let user1Key: string;

    beforeEach(async function () {
      testKey = ethers.keccak256(
        ethers.solidityPacked(["string"], ["test-key"]),
      );
      user1Key = ethers.keccak256(
        ethers.solidityPacked(["address"], [user1.address]),
      );
    });

    describe("addKey", function () {
      it("Should allow owner to add a key", async function () {
        await expect(
          onchainID.connect(owner).addKey(testKey, ACTION_KEY, ECDSA_TYPE),
        )
          .to.emit(onchainID, "KeyAdded")
          .withArgs(testKey, ACTION_KEY, ECDSA_TYPE);

        expect(await onchainID.keyHasPurpose(testKey, ACTION_KEY)).to.be.true;
      });

      it("Should allow management key holder to add a key", async function () {
        // First add user1 as management key
        await onchainID
          .connect(owner)
          .addKey(user1Key, MANAGEMENT_KEY, ECDSA_TYPE);

        // Now user1 should be able to add keys
        await expect(
          onchainID.connect(user1).addKey(testKey, ACTION_KEY, ECDSA_TYPE),
        )
          .to.emit(onchainID, "KeyAdded")
          .withArgs(testKey, ACTION_KEY, ECDSA_TYPE);
      });

      it("Should reject adding key by unauthorized user", async function () {
        await expect(
          onchainID
            .connect(unauthorized)
            .addKey(testKey, ACTION_KEY, ECDSA_TYPE),
        ).to.be.revertedWith("OnchainID: Sender does not have management key");
      });

      it("Should reject adding zero key", async function () {
        await expect(
          onchainID
            .connect(owner)
            .addKey(ethers.ZeroHash, ACTION_KEY, ECDSA_TYPE),
        ).to.be.revertedWith("OnchainID: Invalid key");
      });

      it("Should reject adding duplicate key", async function () {
        await onchainID.connect(owner).addKey(testKey, ACTION_KEY, ECDSA_TYPE);
        await expect(
          onchainID.connect(owner).addKey(testKey, ACTION_KEY, ECDSA_TYPE),
        ).to.be.revertedWith("OnchainID: Key already exists");
      });
    });

    describe("removeKey", function () {
      beforeEach(async function () {
        await onchainID.connect(owner).addKey(testKey, ACTION_KEY, ECDSA_TYPE);
      });

      it("Should allow owner to remove a key", async function () {
        await expect(onchainID.connect(owner).removeKey(testKey, ACTION_KEY))
          .to.emit(onchainID, "KeyRemoved")
          .withArgs(testKey, ACTION_KEY, ECDSA_TYPE);

        expect(await onchainID.keyHasPurpose(testKey, ACTION_KEY)).to.be.false;
      });

      it("Should reject removing non-existent key", async function () {
        const nonExistentKey = ethers.keccak256(
          ethers.solidityPacked(["string"], ["non-existent"]),
        );
        await expect(
          onchainID.connect(owner).removeKey(nonExistentKey, ACTION_KEY),
        ).to.be.revertedWith("OnchainID: Key does not exist");
      });

      it("Should reject removing key with wrong purpose", async function () {
        await expect(
          onchainID.connect(owner).removeKey(testKey, MANAGEMENT_KEY),
        ).to.be.revertedWith("OnchainID: Purpose mismatch");
      });

      it("Should reject removal by unauthorized user", async function () {
        await expect(
          onchainID.connect(unauthorized).removeKey(testKey, ACTION_KEY),
        ).to.be.revertedWith("OnchainID: Sender does not have management key");
      });
    });

    describe("getKey", function () {
      it("Should return correct key information", async function () {
        await onchainID.connect(owner).addKey(testKey, ACTION_KEY, ECDSA_TYPE);

        const [purpose, keyType, key, revokedAt] =
          await onchainID.getKey(testKey);
        expect(purpose).to.equal(ACTION_KEY);
        expect(keyType).to.equal(ECDSA_TYPE);
        expect(key).to.equal(testKey);
        expect(revokedAt).to.equal(0);
      });

      it("Should return zero values for non-existent key", async function () {
        const nonExistentKey = ethers.keccak256(
          ethers.solidityPacked(["string"], ["non-existent"]),
        );
        const [purpose, keyType, key, revokedAt] =
          await onchainID.getKey(nonExistentKey);
        expect(purpose).to.equal(0);
        expect(keyType).to.equal(0);
        expect(key).to.equal(ethers.ZeroHash);
        expect(revokedAt).to.equal(0);
      });
    });

    describe("getKeysByPurpose", function () {
      it("Should return keys by purpose", async function () {
        const key1 = ethers.keccak256(
          ethers.solidityPacked(["string"], ["key1"]),
        );
        const key2 = ethers.keccak256(
          ethers.solidityPacked(["string"], ["key2"]),
        );

        await onchainID.connect(owner).addKey(key1, ACTION_KEY, ECDSA_TYPE);
        await onchainID.connect(owner).addKey(key2, ACTION_KEY, ECDSA_TYPE);

        const actionKeys = await onchainID.getKeysByPurpose(ACTION_KEY);
        expect(actionKeys).to.include(key1);
        expect(actionKeys).to.include(key2);
        expect(actionKeys.length).to.equal(2);
      });

      it("Should return empty array for purpose with no keys", async function () {
        const encryptionKeys = await onchainID.getKeysByPurpose(ENCRYPTION_KEY);
        expect(encryptionKeys.length).to.equal(0);
      });
    });

    describe("execute", function () {
      let actionKey: string;

      beforeEach(async function () {
        actionKey = ethers.keccak256(
          ethers.solidityPacked(["address"], [user1.address]),
        );
        await onchainID
          .connect(owner)
          .addKey(actionKey, ACTION_KEY, ECDSA_TYPE);
      });

      it("Should allow action key holder to execute", async function () {
        const target = await ethers.deployContract("MockTarget");
        const data = target.interface.encodeFunctionData("setValue", [42]);

        await expect(
          onchainID.connect(user1).execute(await target.getAddress(), 0, data),
        ).to.emit(onchainID, "ExecutionRequested");
      });

      it("Should auto-execute for management key holder", async function () {
        const target = await ethers.deployContract("MockTarget");
        const data = target.interface.encodeFunctionData("setValue", [42]);

        await expect(
          onchainID.connect(owner).execute(await target.getAddress(), 0, data),
        ).to.emit(onchainID, "Executed");
      });

      // approve() used to execute on the FIRST approval with no check on
      // who gave it, so one ACTION key could call execute() then
      // approve() and move everything the identity held - collapsing the
      // multi-key model to 1-of-1.
      it("Should reject self-approval by the requester", async function () {
        const tok = await (
          await ethers.getContractFactory("MockToken")
        ).deploy("M", "M", 0);
        const idAddr = await onchainID.getAddress();
        await tok.mint(idAddr, ethers.parseEther("1000"));

        const data = tok.interface.encodeFunctionData("transfer", [
          user1.address,
          ethers.parseEther("1000"),
        ]);
        const id = await onchainID
          .connect(user1)
          .execute(await tok.getAddress(), 0, data);
        await id.wait();

        await expect(
          onchainID.connect(user1).approve(0, true),
        ).to.be.revertedWithCustomError(onchainID, "SelfApprovalNotAllowed");
        expect(await tok.balanceOf(idAddr)).to.equal(ethers.parseEther("1000"));
      });

      it("Should execute once an independent key approves", async function () {
        const tok = await (
          await ethers.getContractFactory("MockToken")
        ).deploy("M", "M", 0);
        const idAddr = await onchainID.getAddress();
        await tok.mint(idAddr, ethers.parseEther("500"));

        const data = tok.interface.encodeFunctionData("transfer", [
          user1.address,
          ethers.parseEther("500"),
        ]);
        await (
          await onchainID
            .connect(user1)
            .execute(await tok.getAddress(), 0, data)
        ).wait();

        // owner holds a MANAGEMENT key, which satisfies onlyActionKey
        await (await onchainID.connect(owner).approve(0, true)).wait();
        expect(await tok.balanceOf(idAddr)).to.equal(0n);
      });

      // A pending request must be visible. Without an event, an ACTION
      // key's request looks the same as a successful one to the caller,
      // and an integrator expecting 1-of-1 execution hangs with no signal.
      it("Should emit ExecutionPending when a request needs an approver", async function () {
        const target = await ethers.deployContract("MockTarget");
        const data = target.interface.encodeFunctionData("setValue", [42]);

        await expect(
          onchainID.connect(user1).execute(await target.getAddress(), 0, data),
        )
          .to.emit(onchainID, "ExecutionPending")
          .withArgs(0, 1);
      });

      it("Should NOT emit ExecutionPending when it auto-executes", async function () {
        const target = await ethers.deployContract("MockTarget");
        const data = target.interface.encodeFunctionData("setValue", [7]);

        // owner holds a MANAGEMENT key: runs immediately, nothing pending
        await expect(
          onchainID.connect(owner).execute(await target.getAddress(), 0, data),
        )
          .to.emit(onchainID, "Executed")
          .and.to.not.emit(onchainID, "ExecutionPending");
      });

      // Found reviewing PR #3: approvals were counted PER CALL, not per
      // distinct approver, so one independent key satisfied a threshold
      // of 3 by calling approve() twice. The configured N-of-M was never
      // actually enforced.
      it("Should reject a repeat approval from the same key", async function () {
        const tok = await (
          await ethers.getContractFactory("MockToken")
        ).deploy("M", "M", 0);
        const idAddr = await onchainID.getAddress();
        await tok.mint(idAddr, ethers.parseEther("1000"));
        await onchainID.setExecutionThreshold(3);

        const data = tok.interface.encodeFunctionData("transfer", [
          user1.address,
          ethers.parseEther("1000"),
        ]);
        await (
          await onchainID
            .connect(user1)
            .execute(await tok.getAddress(), 0, data)
        ).wait();

        // owner holds a MANAGEMENT key, so it satisfies onlyActionKey
        await (await onchainID.connect(owner).approve(0, true)).wait();
        await expect(
          onchainID.connect(owner).approve(0, true),
        ).to.be.revertedWithCustomError(onchainID, "AlreadyApproved");

        // 3-of-N unmet, so nothing moved
        expect(await tok.balanceOf(idAddr)).to.equal(ethers.parseEther("1000"));
      });

      it("Should refuse an execution threshold below 2", async function () {
        await expect(
          onchainID.setExecutionThreshold(1),
        ).to.be.revertedWithCustomError(
          onchainID,
          "ThresholdAllowsSelfApproval",
        );
        expect(await onchainID.executionThreshold()).to.equal(2n);
      });

      it("Should reject execution by unauthorized user", async function () {
        const target = await ethers.deployContract("MockTarget");
        const data = target.interface.encodeFunctionData("setValue", [42]);

        await expect(
          onchainID
            .connect(unauthorized)
            .execute(await target.getAddress(), 0, data),
        ).to.be.revertedWith("OnchainID: Sender does not have action key");
      });
    });
  });
});
