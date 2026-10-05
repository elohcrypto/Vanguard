import { expect } from "chai";
import { ethers } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";

// Plan v2 Task 4.2 fix round (review M1, L6). Withdrawing an identity's
// authorization pauses KeyManager; cancel stops an item; an item not run
// within EXECUTION_WINDOW (7 days) after its executionTime is dead, so a
// paused item cannot revive when the identity re-authorizes later.

const MGMT = 1;
const DAY = 24 * 3600;
const k = (a: string) => ethers.solidityPackedKeccak256(["address"], [a]);
const NOT_AUTH = "KeyManager: Identity has not authorized KeyManager";
const EXPIRED = "KeyManager: execution window passed, re-initiate";

async function setup() {
  const [holder, a1, a2, x, y, other] = await ethers.getSigners();
  const OID = await ethers.getContractFactory("OnchainID");
  const id = await OID.deploy(holder.address);
  const idA = await id.getAddress();
  const km = await (await ethers.getContractFactory("KeyManager")).deploy();
  const kmA = await km.getAddress();
  await id.authorizeManager(kmA);
  return { holder, a1, a2, x, y, other, OID, id, idA, km, kmA };
}

describe("KeyManager withdrawal and execution window (4.2 M1)", function () {
  it("the window is 7 days", async function () {
    const { km } = await setup();
    expect(await km.EXECUTION_WINDOW()).to.equal(7n * BigInt(DAY));
  });

  it("a stale recovery candidate does not revive after 30 days withdrawn (P1)", async function () {
    const { a1, a2, x, y, id, idA, km, kmA } = await setup();
    await km.setupKeyRecovery(idA, [a1.address, a2.address], 2);
    const evil = k(x.address);
    await km.connect(a1).initiateKeyRecovery(idA, evil);
    await km.connect(a1).approveKeyRecovery(idA, evil);
    await km.connect(a2).approveKeyRecovery(idA, evil);
    await id.deauthorizeManager(kmA);
    await time.increase(49 * 3600);
    await expect(
      km.connect(y).executeKeyRecovery(idA, evil),
    ).to.be.revertedWith(NOT_AUTH);
    await time.increase(30 * DAY);
    await id.authorizeManager(kmA);
    await expect(
      km.connect(y).executeKeyRecovery(idA, evil),
    ).to.be.revertedWith(EXPIRED);
    expect(await id.keyHasPurpose(evil, MGMT)).to.equal(false);
  });

  it("a stale rotation does not revive after 60 days withdrawn (P2)", async function () {
    const { x, y, id, idA, km, kmA } = await setup();
    const o = ethers.id("old");
    const n = k(x.address);
    await id.addKey(o, MGMT, 1);
    await km.initiateKeyRotation(idA, o, n, MGMT);
    await id.deauthorizeManager(kmA);
    await time.increase(60 * DAY);
    await id.authorizeManager(kmA);
    await expect(
      km.connect(y).executeKeyRotation(idA, o, n, MGMT),
    ).to.be.revertedWith(EXPIRED);
    expect(await id.keyHasPurpose(n, MGMT)).to.equal(false);
    // Re-initiating starts a fresh timelock and then runs.
    await km.initiateKeyRotation(idA, o, n, MGMT);
    await time.increase(DAY + 1);
    await km.connect(y).executeKeyRotation(idA, o, n, MGMT);
    expect(await id.keyHasPurpose(n, MGMT)).to.equal(true);
  });

  it("re-authorized inside the window, a paused item runs: cancel is the stop", async function () {
    const { a1, x, y, id, idA, km, kmA } = await setup();
    await km.setupKeyRecovery(idA, [a1.address], 1);
    const key = k(x.address);
    await km.connect(a1).initiateKeyRecovery(idA, key);
    await km.connect(a1).approveKeyRecovery(idA, key);
    await id.deauthorizeManager(kmA);
    await time.increase(2 * DAY + 6 * DAY);
    await id.authorizeManager(kmA);
    await km.connect(y).executeKeyRecovery(idA, key);
    expect(await id.keyHasPurpose(key, MGMT)).to.equal(true);
  });

  it("execution works up to the window's end and not one second after", async function () {
    const { x, y, id, idA, km } = await setup();
    const o = ethers.id("o2");
    await id.addKey(o, MGMT, 1);
    await km.initiateKeyRotation(idA, o, k(x.address), MGMT);
    const r = await km.getKeyRotation(
      idA,
      ethers.solidityPackedKeccak256(
        ["address", "bytes32", "bytes32", "uint256"],
        [idA, o, k(x.address), MGMT],
      ),
    );
    await time.setNextBlockTimestamp(r.executionTime + 7n * BigInt(DAY) + 1n);
    await expect(
      km.connect(y).executeKeyRotation(idA, o, k(x.address), MGMT),
    ).to.be.revertedWith(EXPIRED);
    const o3 = ethers.id("o3");
    await id.addKey(o3, MGMT, 1);
    await km.initiateKeyRotation(idA, o3, k(y.address), MGMT);
    const t = BigInt(await time.latest());
    await time.setNextBlockTimestamp(t + BigInt(DAY) + 7n * BigInt(DAY));
    await km.connect(y).executeKeyRotation(idA, o3, k(y.address), MGMT);
    expect(await id.keyHasPurpose(k(y.address), MGMT)).to.equal(true);
  });

  it("an expired candidate can be re-opened; old approvals do not carry over", async function () {
    const { a1, a2, x, y, idA, km } = await setup();
    await km.setupKeyRecovery(idA, [a1.address, a2.address], 2);
    const key = k(x.address);
    await km.connect(a1).initiateKeyRecovery(idA, key);
    await km.connect(a1).approveKeyRecovery(idA, key);
    await expect(
      km.connect(a2).initiateKeyRecovery(idA, key),
    ).to.be.revertedWith("KeyManager: Recovery already pending");
    await time.increase(10 * DAY);
    await km.connect(a2).initiateKeyRecovery(idA, key);
    expect((await km.getRecoveryCandidate(idA, key)).approvalCount).to.equal(0);
    expect(await km.hasApprovedRecovery(idA, key, a1.address)).to.equal(false);
    await km.connect(a2).approveKeyRecovery(idA, key);
    await time.increase(2 * DAY + 1);
    await expect(km.connect(y).executeKeyRecovery(idA, key)).to.be.revertedWith(
      "KeyManager: Insufficient approvals",
    );
  });

  it("while withdrawn, agents can neither open nor approve; the holder cancels", async function () {
    const { holder, a1, a2, x, idA, id, km, kmA } = await setup();
    await km.setupKeyRecovery(idA, [a1.address, a2.address], 2);
    const key = k(x.address);
    await km.connect(a1).initiateKeyRecovery(idA, key);
    await id.deauthorizeManager(kmA);
    await expect(
      km.connect(a2).initiateKeyRecovery(idA, ethers.id("other")),
    ).to.be.revertedWith(NOT_AUTH);
    await expect(
      km.connect(a2).approveKeyRecovery(idA, key),
    ).to.be.revertedWith(NOT_AUTH);
    await expect(km.connect(holder).cancelKeyRecovery(idA, key)).to.emit(
      km,
      "KeyRecoveryCancelled",
    );
    expect((await km.getRecoveryCandidate(idA, key)).initiatedAt).to.equal(0);
  });
});

describe("KeyManager manager writes: per identity (4.2 L6)", function () {
  it("a manager of another identity, or of a non-authorizing one, is refused", async function () {
    const { holder, other, OID, idA, km, kmA } = await setup();
    // `other` manages its own identity, which authorized KeyManager.
    const mine = await OID.deploy(other.address);
    await mine.connect(other).authorizeManager(kmA);
    const writes = (who: any, target: string) => [
      () => km.connect(who).setCustomTimelock(target, 3600),
      () => km.connect(who).batchAddKeys(target, [ethers.id("a")], [2], [1]),
      () => km.connect(who).batchRemoveKeys(target, [k(holder.address)], [1]),
      () =>
        km
          .connect(who)
          .addMultiSigKey(target, ethers.id("m"), [ethers.id("s")], 1, 1),
    ];
    for (const w of writes(other, idA)) {
      await expect(w()).to.be.revertedWith("KeyManager: Not identity manager");
    }
    // The holder's identity withdraws: its own manager is refused too.
    const id = await ethers.getContractAt("OnchainID", idA);
    await id.deauthorizeManager(kmA);
    for (const w of writes(holder, idA)) {
      await expect(w()).to.be.revertedWith(NOT_AUTH);
    }
    // Sanity: `other` still writes on its own identity.
    await km.connect(other).setCustomTimelock(await mine.getAddress(), 3600);
  });
});
