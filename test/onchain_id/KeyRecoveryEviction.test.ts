import { expect } from "chai";
import { ethers } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";

// Plan v2 Task 4.11 (D38 = c): KeyManager recovery evicts a live rogue
// MANAGEMENT key and, behind OWNER_TRANSFER_TIMELOCK, moves the identity's
// ownership to the recovered wallet. Every fact is read from the chain.

const MGMT = 1;
const ACTION = 2;
const CLAIM = 3;
const HOUR = 3600;
const DAY = 24 * HOUR;
const k = (a: string) => ethers.solidityPackedKeccak256(["address"], [a]);
const LOCKED = "OnchainID: frozen by an approved recovery";

async function setup() {
  const [owner, A, B, C, rogue, rescued, anyone, stranger, actionHolder] =
    await ethers.getSigners();
  const id = await (
    await ethers.getContractFactory("OnchainID")
  ).deploy(owner.address);
  const idA = await id.getAddress();
  const km = await (await ethers.getContractFactory("KeyManager")).deploy();
  const kmA = await km.getAddress();
  await id.authorizeManager(kmA);
  // A live rogue MANAGEMENT key, plus keys recovery must not touch.
  await id.addKey(k(rogue.address), MGMT, 1);
  await id.addKey(k(actionHolder.address), ACTION, 1);
  await id.addKey(ethers.id("claim-signer"), CLAIM, 1);
  await km.setupKeyRecovery(idA, [A.address, B.address, C.address], 2);
  return {
    owner,
    A,
    B,
    C,
    rogue,
    rescued,
    anyone,
    stranger,
    actionHolder,
    id,
    idA,
    km,
    kmA,
  };
}

/** Opens and approves (2 of 3) a recovery onto `rescued`; returns the approval time. */
async function approved(f: Awaited<ReturnType<typeof setup>>) {
  const key = k(f.rescued.address);
  await f.km.connect(f.A).initiateKeyRecovery(f.idA, key);
  await f.km.connect(f.A).approveKeyRecovery(f.idA, key);
  await f.km.connect(f.B).approveKeyRecovery(f.idA, key);
  return BigInt(await time.latest());
}

describe("KeyManager recovery evicts and moves ownership (4.11, D38 c)", function () {
  it("timelocks: 48h to execution, 7 days to the owner transfer, both from the approval", async function () {
    const f = await setup();
    expect(await f.km.RECOVERY_TIMELOCK()).to.equal(48n * 3600n);
    expect(await f.km.OWNER_TRANSFER_TIMELOCK()).to.equal(7n * BigInt(DAY));
    const key = k(f.rescued.address);
    await f.km.connect(f.A).initiateKeyRecovery(f.idA, key);
    await time.increase(3 * DAY);
    await f.km.connect(f.A).approveKeyRecovery(f.idA, key);
    await expect(f.km.connect(f.B).approveKeyRecovery(f.idA, key)).to.emit(
      f.km,
      "KeyRecoveryApproved",
    );
    const t = BigInt(await time.latest());
    const a = await f.km.getRecoveryApproval(f.idA);
    expect(a.key).to.equal(key);
    expect(a.approvedAt).to.equal(t);
    expect(a.executionTime).to.equal(t + 48n * 3600n);
    expect(a.ownerTransferTime).to.equal(t + 7n * BigInt(DAY));
    expect(a.locked).to.equal(true);
    // Three days since the initiation, not 48h since the approval: refused.
    await expect(
      f.km.connect(f.anyone).executeKeyRecovery(f.idA, key),
    ).to.be.revertedWith("KeyManager: Timelock not expired");
  });

  it("a rogue MANAGEMENT key can neither cancel nor re-seat an approved recovery", async function () {
    const f = await setup();
    await approved(f);
    const key = k(f.rescued.address);
    await expect(
      f.km.connect(f.rogue).cancelKeyRecovery(f.idA, key),
    ).to.be.revertedWith(
      "KeyManager: approved recovery, only its agents cancel",
    );
    await expect(
      f.km.connect(f.rogue).setupKeyRecovery(f.idA, [f.rogue.address], 1),
    ).to.be.revertedWith(
      "KeyManager: only the identity owner sets up recovery",
    );
    // Not even before an approval: a MANAGEMENT key cancels nothing.
    await f.km.connect(f.C).initiateKeyRecovery(f.idA, ethers.id("other"));
    await expect(
      f.km.connect(f.rogue).cancelKeyRecovery(f.idA, ethers.id("other")),
    ).to.be.revertedWith("KeyManager: Not allowed to cancel recovery");
  });

  it("the owner cancels before the approval, not after; setup is locked after", async function () {
    const f = await setup();
    const key = k(f.rescued.address);
    await f.km.connect(f.A).initiateKeyRecovery(f.idA, key);
    await f.km.connect(f.A).approveKeyRecovery(f.idA, key);
    await expect(f.km.connect(f.owner).cancelKeyRecovery(f.idA, key))
      .to.emit(f.km, "KeyRecoveryCancelled")
      .withArgs(f.idA, key, f.owner.address);
    await approved(f);
    await expect(
      f.km.connect(f.owner).cancelKeyRecovery(f.idA, key),
    ).to.be.revertedWith(
      "KeyManager: approved recovery, only its agents cancel",
    );
    await expect(
      f.km.connect(f.owner).setupKeyRecovery(f.idA, [f.C.address], 1),
    ).to.be.revertedWith("KeyManager: recovery approved, setup locked");
  });

  it("the agents cancel an approved recovery at the threshold, one vote each", async function () {
    const f = await setup();
    await approved(f);
    const key = k(f.rescued.address);
    await expect(f.km.connect(f.C).cancelKeyRecovery(f.idA, key))
      .to.emit(f.km, "KeyRecoveryCancelVote")
      .withArgs(f.idA, key, f.C.address, 1n);
    await expect(
      f.km.connect(f.C).cancelKeyRecovery(f.idA, key),
    ).to.be.revertedWith("KeyManager: Already voted to cancel");
    expect((await f.km.getRecoveryApproval(f.idA)).locked).to.equal(true);
    await expect(f.km.connect(f.A).cancelKeyRecovery(f.idA, key))
      .to.emit(f.km, "KeyRecoveryCancelled")
      .withArgs(f.idA, key, f.A.address);
    expect(await f.km.recoveryLocked(f.idA)).to.equal(false);
    await time.increase(2 * DAY + 1);
    await expect(
      f.km.connect(f.anyone).executeKeyRecovery(f.idA, key),
    ).to.be.revertedWith("KeyManager: Recovery not initiated");
    // The owner may re-seat again.
    await f.km.setupKeyRecovery(f.idA, [f.A.address], 1);
  });

  it("one candidate is approved at a time", async function () {
    const f = await setup();
    await approved(f);
    const other = ethers.id("other");
    await f.km.connect(f.C).initiateKeyRecovery(f.idA, other);
    await expect(
      f.km.connect(f.C).approveKeyRecovery(f.idA, other),
    ).to.be.revertedWith("KeyManager: another recovery is approved");
  });

  it("while approved the owner cannot withdraw KeyManager, add a manager or transfer", async function () {
    const f = await setup();
    await approved(f);
    expect(await f.id.ownershipFrozen()).to.equal(true);
    await expect(f.id.deauthorizeManager(f.kmA)).to.be.revertedWith(LOCKED);
    await expect(f.id.authorizeManager(f.stranger.address)).to.be.revertedWith(
      LOCKED,
    );
    await expect(f.id.transferOwnership(f.stranger.address)).to.be.revertedWith(
      LOCKED,
    );
  });

  it("execution after 48h evicts every other MANAGEMENT key, one event each", async function () {
    const f = await setup();
    await approved(f);
    const key = k(f.rescued.address);
    await time.increase(2 * DAY + 1);
    const before = await f.id.getKeysByPurpose(MGMT);
    expect([...before]).to.have.members([k(f.owner.address), k(f.rogue.address)]);
    const tx = f.km.connect(f.anyone).executeKeyRecovery(f.idA, key);
    await expect(tx)
      .to.emit(f.km, "KeyRecoveryKeyEvicted")
      .withArgs(f.idA, k(f.rogue.address), key);
    await expect(tx)
      .to.emit(f.km, "KeyRecoveryKeyEvicted")
      .withArgs(f.idA, k(f.owner.address), key);
    await expect(tx).to.emit(f.km, "KeyRecoveryCompleted").withArgs(f.idA, key);
    expect(await f.id.getKeysByPurpose(MGMT)).to.deep.equal([key]);
    expect(await f.id.keyHasPurpose(k(f.rogue.address), MGMT)).to.equal(false);
    expect((await f.id.getKey(k(f.rogue.address))).revokedAt).to.be.gt(0n);
    // ACTION and CLAIM keys are untouched.
    expect(
      await f.id.keyHasPurpose(k(f.actionHolder.address), ACTION),
    ).to.equal(true);
    expect(await f.id.keyHasPurpose(ethers.id("claim-signer"), CLAIM)).to.equal(
      true,
    );
    // The rogue key no longer manages anything.
    await expect(f.id.connect(f.rogue).removeKey(key, MGMT)).to.be.revertedWith(
      "OnchainID: Sender does not have management key",
    );
  });

  it("execution is refused before the timelock and after the window", async function () {
    const f = await setup();
    const t = await approved(f);
    const key = k(f.rescued.address);
    await time.setNextBlockTimestamp(t + 48n * 3600n - 1n);
    await expect(
      f.km.connect(f.anyone).executeKeyRecovery(f.idA, key),
    ).to.be.revertedWith("KeyManager: Timelock not expired");
    await time.setNextBlockTimestamp(t + 48n * 3600n + 7n * BigInt(DAY) + 1n);
    await expect(
      f.km.connect(f.anyone).executeKeyRecovery(f.idA, key),
    ).to.be.revertedWith("KeyManager: execution window passed, re-initiate");
    // A dead approval no longer locks the identity.
    expect(await f.km.recoveryLocked(f.idA)).to.equal(false);
    await f.id.deauthorizeManager(f.kmA);
  });

  it("a recovered key held for another purpose becomes the MANAGEMENT key", async function () {
    const f = await setup();
    const key = k(f.actionHolder.address);
    await f.km.connect(f.A).initiateKeyRecovery(f.idA, key);
    await f.km.connect(f.A).approveKeyRecovery(f.idA, key);
    await f.km.connect(f.B).approveKeyRecovery(f.idA, key);
    await time.increase(2 * DAY + 1);
    await f.km.connect(f.anyone).executeKeyRecovery(f.idA, key);
    expect(await f.id.getKeysByPurpose(MGMT)).to.deep.equal([key]);
    expect(await f.id.keyHasPurpose(key, ACTION)).to.equal(false);
  });

  it("the owner transfer: only after 7 days, only to the recovered wallet, accepted by it", async function () {
    const f = await setup();
    const t = await approved(f);
    const key = k(f.rescued.address);
    await expect(
      f.km.executeOwnerTransfer(f.idA, f.rescued.address),
    ).to.be.revertedWith("KeyManager: no executed recovery");
    await time.increase(2 * DAY + 1);
    await f.km.connect(f.anyone).executeKeyRecovery(f.idA, key);
    // Executed, still locked: the owner cannot hand the identity on.
    expect(await f.km.recoveryLocked(f.idA)).to.equal(true);
    await expect(f.id.transferOwnership(f.stranger.address)).to.be.revertedWith(
      LOCKED,
    );
    await expect(
      f.km.executeOwnerTransfer(f.idA, f.stranger.address),
    ).to.be.revertedWith("KeyManager: not the recovered wallet");
    await time.setNextBlockTimestamp(t + 7n * BigInt(DAY) - 1n);
    await expect(
      f.km.executeOwnerTransfer(f.idA, f.rescued.address),
    ).to.be.revertedWith("KeyManager: Timelock not expired");
    await time.setNextBlockTimestamp(t + 7n * BigInt(DAY));
    const tx = f.km
      .connect(f.anyone)
      .executeOwnerTransfer(f.idA, f.rescued.address);
    await expect(tx)
      .to.emit(f.km, "RecoveryOwnerTransferProposed")
      .withArgs(f.idA, f.rescued.address, key);
    await expect(tx)
      .to.emit(f.id, "RecoveryOwnerProposed")
      .withArgs(f.kmA, f.rescued.address);
    expect(await f.id.pendingOwner()).to.equal(f.rescued.address);
    // The old owner can neither accept nor re-transfer.
    await expect(f.id.connect(f.owner).acceptOwnership()).to.be.reverted;
    await expect(
      f.id.connect(f.owner).transferOwnership(f.owner.address),
    ).to.be.revertedWith(LOCKED);
    // Keys the old owner adds meanwhile go on acceptance.
    await f.id.connect(f.owner).addKey(ethers.id("late"), MGMT, 1);
    await f.id.connect(f.rescued).acceptOwnership();
    expect(await f.id.owner()).to.equal(f.rescued.address);
    expect(await f.id.getKeysByPurpose(MGMT)).to.deep.equal([key]);
    expect(await f.km.recoveryLocked(f.idA)).to.equal(false);
    expect(await f.id.ownershipFrozen()).to.equal(false);
    await expect(
      f.id.connect(f.owner).transferOwnership(f.owner.address),
    ).to.be.revertedWithCustomError(f.id, "OwnableUnauthorizedAccount");
    // The new owner holds every owner power again.
    await f.km.connect(f.rescued).setupKeyRecovery(f.idA, [f.A.address], 1);
    await f.id.connect(f.rescued).deauthorizeManager(f.kmA);
  });

  it("the owner transfer is refused after its window", async function () {
    const f = await setup();
    const t = await approved(f);
    await time.increase(2 * DAY + 1);
    await f.km.executeKeyRecovery(f.idA, k(f.rescued.address));
    await time.setNextBlockTimestamp(t + 14n * BigInt(DAY) + 1n);
    await expect(
      f.km.executeOwnerTransfer(f.idA, f.rescued.address),
    ).to.be.revertedWith("KeyManager: execution window passed, re-initiate");
    expect(await f.km.recoveryLocked(f.idA)).to.equal(false);
  });

  it("only an authorized manager reporting the recovery can move ownership", async function () {
    const f = await setup();
    const t = await approved(f);
    await time.increase(2 * DAY + 1);
    await f.km.executeKeyRecovery(f.idA, k(f.rescued.address));
    await time.setNextBlockTimestamp(t + 7n * BigInt(DAY));
    // A stranger KeyManager (not authorized by the identity).
    const km2 = await (await ethers.getContractFactory("KeyManager")).deploy();
    await expect(
      km2.executeOwnerTransfer(f.idA, f.rescued.address),
    ).to.be.revertedWith("KeyManager: no executed recovery");
    // Calling the hook directly: an EOA, then the authorized manager's
    // view for another wallet.
    await expect(
      f.id.connect(f.stranger).transferOwnershipByRecovery(f.stranger.address),
    ).to.be.revertedWith("OnchainID: not an authorized manager");
    expect(await f.km.isRecoveryOwner(f.idA, f.stranger.address)).to.equal(
      false,
    );
    expect(await f.km.isRecoveryOwner(f.idA, f.rescued.address)).to.equal(true);
    expect(await f.id.owner()).to.equal(f.owner.address);
  });

  it("an authorized manager without an approved recovery cannot move ownership", async function () {
    const [owner, , , , , rescued] = await ethers.getSigners();
    const id = await (
      await ethers.getContractFactory("OnchainID")
    ).deploy(owner.address);
    const km = await (await ethers.getContractFactory("KeyManager")).deploy();
    await id.authorizeManager(await km.getAddress());
    await expect(
      km.executeOwnerTransfer(await id.getAddress(), rescued.address),
    ).to.be.revertedWith("KeyManager: no executed recovery");
    expect(await id.ownershipFrozen()).to.equal(false);
  });

  it("without a recovery the owner's transferOwnership works as before", async function () {
    const f = await setup();
    await f.id.transferOwnership(f.stranger.address);
    expect(await f.id.pendingOwner()).to.equal(f.stranger.address);
    await f.id.connect(f.stranger).acceptOwnership();
    expect(await f.id.owner()).to.equal(f.stranger.address);
    // The ordinary acceptance retires only the old owner's key.
    expect(await f.id.keyHasPurpose(k(f.rogue.address), MGMT)).to.equal(true);
    await expect(
      f.id.connect(f.rogue).transferOwnership(f.rogue.address),
    ).to.be.revertedWithCustomError(f.id, "OwnableUnauthorizedAccount");
  });

  it("only the owner sets up recovery; an EOA manager does not freeze ownership", async function () {
    const f = await setup();
    await expect(
      f.km.connect(f.rogue).setupKeyRecovery(f.idA, [f.rogue.address], 1),
    ).to.be.revertedWith(
      "KeyManager: only the identity owner sets up recovery",
    );
    await f.id.authorizeManager(f.stranger.address);
    expect(await f.id.ownershipFrozen()).to.equal(false);
    await f.id.deauthorizeManager(f.stranger.address);
  });
});
