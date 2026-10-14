import { expect } from "chai";
import { ethers } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";

// Plan v2 Task 5.3: identity, key-manager and identity-factory guards no
// test reached before (4.17 had filed most "defensive"), each reachable
// by its caller and asserted by its reason.
describe("Identity, key and identity-factory guards (Task 5.3)", function () {
  const Z = ethers.ZeroAddress;
  const ACTION = 2;
  const FEE = ethers.parseEther("0.01");
  const deployC = async (name: string, ...a: unknown[]): Promise<any> =>
    (await ethers.getContractFactory(name)).deploy(...a);

  async function identity() {
    const [holder, other] = await ethers.getSigners();
    const id = await deployC("OnchainID", holder.address);
    const km = await deployC("KeyManager");
    await id.authorizeManager(km.target);
    await id.pinRecoveryManager(km.target);
    return { holder, other, id, km };
  }

  it("KeyManager: a completed rotation cannot be queued again", async function () {
    const { id, km } = await identity();
    const [oldKey, newKey] = [ethers.id("old"), ethers.id("new")];
    await id.addKey(oldKey, ACTION, 1);
    await km.initiateKeyRotation(id.target, oldKey, newKey, ACTION);
    await time.increase(24 * 3600 + 1);
    await km.executeKeyRotation(id.target, oldKey, newKey, ACTION);
    await id.addKey(oldKey, ACTION, 1); // the old key is back
    await expect(
      km.initiateKeyRotation(id.target, oldKey, newKey, ACTION),
    ).to.be.revertedWith("KeyManager: Rotation already completed");
  });

  it("KeyManager: batchRemoveKeys refuses arrays of different lengths", async function () {
    const { id, km } = await identity();
    await expect(
      km.batchRemoveKeys(id.target, [ethers.id("a")], []),
    ).to.be.revertedWith("KeyManager: Array length mismatch");
  });

  it("KeyManager: cancelKeyRecovery refuses a key no recovery was opened for", async function () {
    const { other, id, km } = await identity();
    await expect(
      km.connect(other).cancelKeyRecovery(id.target, ethers.id("none")),
    ).to.be.revertedWith("KeyManager: Recovery not initiated");
  });

  describe("KeyManager recovery", function () {
    const k = (a: string) => ethers.solidityPackedKeccak256(["address"], [a]);
    async function seated() {
      const f = await identity();
      const [, , A, B, C, good, evil] = await ethers.getSigners();
      await f.km.setupKeyRecovery(
        f.id.target,
        [A.address, B.address, C.address],
        2,
      );
      return { ...f, A, B, C, good, evil };
    }

    it("approveKeyRecovery refuses another candidate once one is approved", async function () {
      const { id, km, A, B, C, good, evil } = await seated();
      await km.connect(A).initiateKeyRecovery(id.target, k(good.address));
      await km.connect(C).initiateKeyRecovery(id.target, k(evil.address));
      await km.connect(B).approveKeyRecovery(id.target, k(good.address));
      await expect(
        km.connect(A).approveKeyRecovery(id.target, k(evil.address)),
      ).to.be.revertedWithCustomError(km, "AnotherRecoveryApproved");
    });

    it("veto and drop refuse when no re-seat is pending", async function () {
      const { id, km, A } = await seated();
      await expect(
        km.connect(A).vetoKeyRecoverySetup(id.target),
      ).to.be.revertedWithCustomError(km, "NoPendingSetup");
      await expect(
        km.connect(A).dropStaleRecoverySetup(id.target),
      ).to.be.revertedWithCustomError(km, "NoPendingSetup");
    });
  });

  // Task 5.3 fix round (M-1): any caller may name an identity contract of
  // its own; one that passes KeyManager's view checks and returns false
  // from addKey/removeKey reaches the four "Failed to" requires.
  describe("KeyManager against an identity that returns false", function () {
    const [k1, k2] = [ethers.id("k1"), ethers.id("k2")];
    async function fake() {
      const km = await deployC("KeyManager");
      const id = await deployC("FalseReturningIdentity");
      return { km, id };
    }

    it("batchAddKeys refuses a false addKey", async function () {
      const { km, id } = await fake();
      await expect(
        km.batchAddKeys(id.target, [k1], [ACTION], [1]),
      ).to.be.revertedWith("KeyManager: Failed to add key");
    });

    it("batchRemoveKeys refuses a false removeKey", async function () {
      const { km, id } = await fake();
      await expect(
        km.batchRemoveKeys(id.target, [k1], [ACTION]),
      ).to.be.revertedWith("KeyManager: Failed to remove key");
    });

    it("executeKeyRotation refuses a false removeKey, then a false addKey", async function () {
      const { km, id } = await fake();
      await km.initiateKeyRotation(id.target, k1, k2, ACTION);
      await time.increase(24 * 3600 + 1);
      await expect(
        km.executeKeyRotation(id.target, k1, k2, ACTION),
      ).to.be.revertedWith("KeyManager: Failed to remove old key");
      await id.setRemoveOk(true);
      await expect(
        km.executeKeyRotation(id.target, k1, k2, ACTION),
      ).to.be.revertedWith("KeyManager: Failed to add new key");
    });
  });

  it("OnchainID: removeKeyWithProof refuses a key it does not hold", async function () {
    const { id } = await identity();
    await expect(
      id.removeKeyWithProof(ethers.id("absent"), ACTION, "0x"),
    ).to.be.revertedWith("OnchainID: Key does not exist");
  });

  describe("OnchainIDFactory", function () {
    async function factory() {
      const [owner, user, other] = await ethers.getSigners();
      const fac = await deployC(
        "OnchainIDFactory",
        owner.address,
        ethers.ZeroHash,
      );
      return { owner, user, other, fac };
    }

    it("deployOnchainIDWithKey refuses a zero owner, a short fee and a used salt", async function () {
      const { user, other, fac } = await factory();
      const key = ethers.id("k");
      await expect(
        fac.deployOnchainIDWithKey(Z, key, ethers.id("s0")),
      ).to.be.revertedWith("OnchainIDFactory: Invalid owner");
      await fac.deployOnchainID(user.address, ethers.id("used"));
      await expect(
        fac
          .connect(other)
          .deployOnchainIDWithKey(other.address, key, ethers.id("used")),
      ).to.be.revertedWith("OnchainIDFactory: Salt already used");
      await fac.setDeploymentFee(FEE);
      await expect(
        fac
          .connect(other)
          .deployOnchainIDWithKey(other.address, key, ethers.id("s1"), {
            value: FEE - 1n,
          }),
      ).to.be.revertedWith("OnchainIDFactory: Insufficient fee");
    });

    it("batchDeployOnchainID refuses empty arrays, a zero owner and a used salt", async function () {
      const { user, other, fac } = await factory();
      await expect(fac.batchDeployOnchainID([], [])).to.be.revertedWith(
        "OnchainIDFactory: Empty arrays",
      );
      await expect(
        fac.batchDeployOnchainID([Z], [ethers.id("b0")]),
      ).to.be.revertedWith("OnchainIDFactory: Invalid owner");
      await fac.deployOnchainID(user.address, ethers.id("used"));
      await expect(
        fac.batchDeployOnchainID([other.address], [ethers.id("used")]),
      ).to.be.revertedWith("OnchainIDFactory: Salt already used");
    });

    it("withdrawFees and emergencyWithdrawTo fail loudly on a refusing recipient", async function () {
      const { owner, user, fac } = await factory();
      const rec = await deployC("RefusingFeeRecipient");
      const sink = await deployC("RefusingFeeRecipient"); // refuses ETH
      await fac.setDeploymentFee(FEE);
      await fac.setFeeRecipient(rec.target);
      await fac.connect(user).deployOnchainID(user.address, ethers.id("f"), {
        value: FEE,
      }); // the push is refused, so the fee is owed to rec
      await expect(rec.pull(fac.target, sink.target)).to.be.revertedWith(
        "OnchainIDFactory: Withdraw failed",
      );
      await expect(fac.emergencyWithdrawTo(Z)).to.be.revertedWith(
        "OnchainIDFactory: Invalid recipient",
      );
      await owner.sendTransaction({ to: fac.target, value: 7n });
      await expect(fac.emergencyWithdrawTo(sink.target)).to.be.revertedWith(
        "OnchainIDFactory: Withdraw failed",
      );
    });
  });
});
