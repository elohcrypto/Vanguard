import { expect } from "chai";
import { ethers } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";

// Plan v2 Task 4.14: the A2 deep-review probes as regressions (P2, P3,
// P4, P7, P7b, P10; P1 lives in KeyRecoveryEviction) and the surviving
// mutants M16, M17, N33, N35 of the C review, killed. Every fact is read
// from the chain.

const MGMT = 1;
const ACTION = 2;
const DAY = 24 * 3600;
const k = (a: string) => ethers.solidityPackedKeccak256(["address"], [a]);

async function setup(threshold = 2) {
  const [owner, A, B, C, rogue, rescued, anyone, thief2, user] =
    await ethers.getSigners();
  const id = await (
    await ethers.getContractFactory("OnchainID")
  ).deploy(owner.address);
  const idA = await id.getAddress();
  const km = await (await ethers.getContractFactory("KeyManager")).deploy();
  const kmA = await km.getAddress();
  await id.authorizeManager(kmA);
  await id.pinRecoveryManager(kmA);
  await id.addKey(k(rogue.address), MGMT, 1);
  await km.setupKeyRecovery(idA, [A.address, B.address, C.address], threshold);
  return {
    owner,
    A,
    B,
    C,
    rogue,
    rescued,
    anyone,
    thief2,
    user,
    id,
    idA,
    km,
    kmA,
  };
}
type F = Awaited<ReturnType<typeof setup>>;

/** A opens (its approval), B approves, 48h, anyone executes. */
async function executed(f: F, key = k(f.rescued.address)) {
  await f.km.connect(f.A).initiateKeyRecovery(f.idA, key);
  await f.km.connect(f.B).approveKeyRecovery(f.idA, key);
  const t = BigInt(await time.latest());
  await time.increase(2 * DAY + 1);
  await f.km.connect(f.anyone).executeKeyRecovery(f.idA, key);
  return t;
}

describe("Recovery robustness (4.14): A2 probes and killed mutants", function () {
  it("P2: opening counts as the opener's approval; its explicit approve is refused", async function () {
    const f = await setup();
    const key = k(f.rescued.address);
    await expect(f.km.connect(f.A).initiateKeyRecovery(f.idA, key))
      .to.emit(f.km, "KeyRecoveryInitiated")
      .withArgs(f.idA, key, f.A.address);
    expect(
      (await f.km.getRecoveryCandidate(f.idA, key)).approvalCount,
    ).to.equal(1);
    expect(await f.km.hasApprovedRecovery(f.idA, key, f.A.address)).to.equal(
      true,
    );
    expect(await f.km.hasApprovedRecovery(f.idA, key, f.B.address)).to.equal(
      false,
    );
    await expect(
      f.km.connect(f.A).approveKeyRecovery(f.idA, key),
    ).to.be.revertedWith("KeyManager: Already approved");
    expect((await f.km.getRecoveryApproval(f.idA)).locked).to.equal(false);
    // The second agent's approval reaches the threshold.
    await expect(f.km.connect(f.B).approveKeyRecovery(f.idA, key)).to.emit(
      f.km,
      "KeyRecoveryApproved",
    );
    expect((await f.km.getRecoveryApproval(f.idA)).locked).to.equal(true);
  });

  it("P3: at threshold 1 the open approves and locks in one transaction", async function () {
    const f = await setup(1);
    const key = k(f.rescued.address);
    const tx = f.km.connect(f.C).initiateKeyRecovery(f.idA, key);
    await expect(tx).to.emit(f.km, "KeyRecoveryInitiated");
    await expect(tx).to.emit(f.km, "KeyRecoveryApproved");
    const t = BigInt(await time.latest());
    const a = await f.km.getRecoveryApproval(f.idA);
    expect(a.key).to.equal(key);
    expect(a.approvedAt).to.equal(t);
    expect(a.locked).to.equal(true);
    expect(await f.id.ownershipFrozen()).to.equal(true);
    // The owner cannot race it: no cancel before, none after.
    await expect(
      f.km.connect(f.owner).cancelKeyRecovery(f.idA, key),
    ).to.be.revertedWithCustomError(f.km, "ApprovedRecoveryAgentsOnly");
  });

  it("P7: a lapsed owner transfer re-opens on the next open (D52), not before the lapse", async function () {
    const f = await setup();
    const key = k(f.rescued.address);
    const t = await executed(f);
    const epoch = (await f.km.getKeyRecovery(f.idA)).epoch;
    // Inside the transfer window: still closed.
    await time.setNextBlockTimestamp(t + 10n * BigInt(DAY));
    await expect(
      f.km.connect(f.A).initiateKeyRecovery(f.idA, key),
    ).to.be.revertedWith("KeyManager: Recovery already completed");
    // The thief waits out the window, re-arms its key and removes K.
    await time.setNextBlockTimestamp(t + 14n * BigInt(DAY) + 1n);
    await f.id.connect(f.owner).addKey(k(f.rogue.address), MGMT, 1);
    await f.id.connect(f.owner).removeKey(key, MGMT);
    expect(await f.km.recoveryLocked(f.idA)).to.equal(false);
    // The agents re-open: new epoch, their candidate opened in it.
    const tx = f.km.connect(f.A).initiateKeyRecovery(f.idA, key);
    await expect(tx)
      .to.emit(f.km, "KeyRecoveryReopened")
      .withArgs(f.idA, epoch + 1n);
    await expect(tx).to.emit(f.km, "KeyRecoveryInitiated");
    const r = await f.km.getKeyRecovery(f.idA);
    expect(r.completed).to.equal(false);
    expect(r.epoch).to.equal(epoch + 1n);
    expect(r.approvalCount).to.equal(1);
    expect((await f.km.getRecoveryApproval(f.idA)).key).to.equal(
      ethers.ZeroHash,
    );
    // The second recovery runs to the end.
    await f.km.connect(f.B).approveKeyRecovery(f.idA, key);
    const t2 = BigInt(await time.latest());
    await time.increase(2 * DAY + 1);
    await f.km.connect(f.anyone).executeKeyRecovery(f.idA, key);
    expect(await f.id.keyHasPurpose(k(f.rogue.address), MGMT)).to.equal(false);
    await time.setNextBlockTimestamp(t2 + 7n * BigInt(DAY));
    await f.km.connect(f.anyone).executeOwnerTransfer(f.idA, f.rescued.address);
    await f.id.connect(f.rescued).acceptOwnership();
    expect(await f.id.owner()).to.equal(f.rescued.address);
  });

  it("P7b: the honest case, nobody moved the owner in time: re-opened and moved in the second window", async function () {
    const f = await setup();
    const key = k(f.rescued.address);
    const t = await executed(f);
    // The recovered key is the only MANAGEMENT key; owner() is the lost key.
    expect(await f.id.getKeysByPurpose(MGMT)).to.deep.equal([key]);
    expect(await f.id.owner()).to.equal(f.owner.address);
    await time.setNextBlockTimestamp(t + 14n * BigInt(DAY) + 1n);
    await expect(
      f.km.connect(f.anyone).executeOwnerTransfer(f.idA, f.rescued.address),
    ).to.be.revertedWith("KeyManager: execution window passed, re-initiate");
    // Re-opened by an agent, onto the same key: it stays, execution keeps it.
    await expect(f.km.connect(f.B).initiateKeyRecovery(f.idA, key)).to.emit(
      f.km,
      "KeyRecoveryReopened",
    );
    await f.km.connect(f.C).approveKeyRecovery(f.idA, key);
    const t2 = BigInt(await time.latest());
    await time.increase(2 * DAY + 1);
    await f.km.connect(f.anyone).executeKeyRecovery(f.idA, key);
    expect(await f.id.getKeysByPurpose(MGMT)).to.deep.equal([key]);
    await time.setNextBlockTimestamp(t2 + 7n * BigInt(DAY));
    await f.km.connect(f.anyone).executeOwnerTransfer(f.idA, f.rescued.address);
    await f.id.connect(f.rescued).acceptOwnership();
    expect(await f.id.owner()).to.equal(f.rescued.address);
    expect(await f.km.recoveryLocked(f.idA)).to.equal(false);
  });

  it("P4: a re-seat proposed by a previous owner is stale after an ordinary transfer; anyone drops it (M-B)", async function () {
    const f = await setup();
    // A second seating is pending 48h (R-411-16).
    await f.km.setupKeyRecovery(f.idA, [f.thief2.address], 1);
    expect(
      (await f.km.getPendingRecoverySetup(f.idA)).effectiveAt,
    ).to.not.equal(0);
    await expect(
      f.km.connect(f.anyone).dropStaleRecoverySetup(f.idA),
    ).to.be.revertedWithCustomError(f.km, "ReseatNotStale");
    // The identity changes hands the ordinary way.
    await f.id.transferOwnership(f.user.address);
    await f.id.connect(f.user).acceptOwnership();
    await time.increase(2 * DAY + 1);
    await expect(
      f.km.connect(f.anyone).applyKeyRecoverySetup(f.idA),
    ).to.be.revertedWithCustomError(f.km, "StaleReseat");
    await expect(f.km.connect(f.anyone).dropStaleRecoverySetup(f.idA))
      .to.emit(f.km, "KeyRecoverySetupDropped")
      .withArgs(f.idA);
    expect((await f.km.getPendingRecoverySetup(f.idA)).effectiveAt).to.equal(0);
    await expect(
      f.km.connect(f.anyone).applyKeyRecoverySetup(f.idA),
    ).to.be.revertedWithCustomError(f.km, "NoPendingSetup");
    // The seated agents stand; the new owner proposes its own re-seat.
    expect((await f.km.getKeyRecovery(f.idA)).recoveryAgents).to.deep.equal([
      f.A.address,
      f.B.address,
      f.C.address,
    ]);
    await f.km.connect(f.user).setupKeyRecovery(f.idA, [f.anyone.address], 1);
    await time.increase(2 * DAY + 1);
    await f.km.connect(f.anyone).applyKeyRecoverySetup(f.idA);
    expect((await f.km.getKeyRecovery(f.idA)).recoveryAgents).to.deep.equal([
      f.anyone.address,
    ]);
  });

  it("M-C: a wallet nominated before the approval cannot accept while frozen; the recovery's pending owner can", async function () {
    const f = await setup();
    await f.id.transferOwnership(f.thief2.address);
    const key = k(f.rescued.address);
    await f.km.connect(f.A).initiateKeyRecovery(f.idA, key);
    await f.km.connect(f.B).approveKeyRecovery(f.idA, key);
    const t = BigInt(await time.latest());
    expect(await f.id.ownershipFrozen()).to.equal(true);
    await expect(
      f.id.connect(f.thief2).acceptOwnership(),
    ).to.be.revertedWithCustomError(f.id, "FrozenByRecovery");
    expect(await f.id.keyHasPurpose(k(f.thief2.address), MGMT)).to.equal(false);
    await time.increase(2 * DAY + 1);
    await f.km.connect(f.anyone).executeKeyRecovery(f.idA, key);
    await time.setNextBlockTimestamp(t + 7n * BigInt(DAY));
    await f.km.connect(f.anyone).executeOwnerTransfer(f.idA, f.rescued.address);
    // Still frozen until the owner moves; the recovery's nominee accepts.
    expect(await f.id.ownershipFrozen()).to.equal(true);
    await f.id.connect(f.rescued).acceptOwnership();
    expect(await f.id.owner()).to.equal(f.rescued.address);
    await expect(f.id.connect(f.thief2).acceptOwnership()).to.be.reverted;
  });

  it("P10/L-A: a manager answering the word 2 is read as no, without reverting; 1 is yes (M16 killed)", async function () {
    const [owner, x] = await ethers.getSigners();
    const id = await (
      await ethers.getContractFactory("OnchainID")
    ).deploy(owner.address);
    const idA = await id.getAddress();
    const odd = await (
      await ethers.getContractFactory("OddRecoveryManager")
    ).deploy();
    await odd.setWord(2);
    await id.pinRecoveryManager(await odd.getAddress());
    expect(await id.ownershipFrozen()).to.equal(false);
    await id.transferOwnership(x.address); // not frozen: no revert
    await expect(odd.propose(idA, x.address))
      .to.be.revertedWithCustomError(id, "NoRecoveryForOwner")
      .withArgs(x.address);
    // M16: a pinned manager reporting no recovery cannot move ownership.
    await odd.setWord(0);
    await expect(odd.propose(idA, x.address)).to.be.revertedWithCustomError(
      id,
      "NoRecoveryForOwner",
    );
    await odd.setWord(1);
    expect(await id.ownershipFrozen()).to.equal(true);
    await expect(odd.propose(idA, x.address))
      .to.emit(id, "RecoveryOwnerProposed")
      .withArgs(await odd.getAddress(), x.address);
  });

  it("P10/L-A: a trusted issuer answering the word 2 does not revert the registry's walk", async function () {
    const [owner, investor] = await ethers.getSigners();
    const factory = await (
      await ethers.getContractFactory("OnchainIDFactory")
    ).deploy(owner.address, ethers.ZeroHash);
    const registry = await (
      await ethers.getContractFactory("IdentityRegistry")
    ).deploy();
    await factory.deployOnchainID(investor.address, ethers.randomBytes(32));
    const identityAddr = await factory.getIdentityByOwner(investor.address);
    await registry.registerIdentity(investor.address, identityAddr, 344);
    const odd = await (
      await ethers.getContractFactory("OddRecoveryManager")
    ).deploy();
    await odd.setWord(2);
    await registry.addTrustedIssuer(await odd.getAddress(), [1]);
    await registry.addClaimTopic(1);
    expect(await registry.isVerified(investor.address)).to.equal(false);
    await odd.setWord(1);
    expect(await registry.isVerified(investor.address)).to.equal(true);
  });

  it("L-1: a lapsed recovery's nominee cannot accept during a later recovery's freeze (R-414-12)", async function () {
    const f = await setup();
    const k1 = f.rescued;
    const k2 = f.user;
    const t = await executed(f, k(k1.address));
    await time.setNextBlockTimestamp(t + 7n * BigInt(DAY));
    await f.km.connect(f.anyone).executeOwnerTransfer(f.idA, k1.address);
    expect(await f.id.pendingOwner()).to.equal(k1.address);
    // Nobody accepts; the window lapses; the agents re-open onto K2.
    await time.setNextBlockTimestamp(t + 14n * BigInt(DAY) + 1n);
    await expect(
      f.km.connect(f.A).initiateKeyRecovery(f.idA, k(k2.address)),
    ).to.emit(f.km, "KeyRecoveryReopened");
    await f.km.connect(f.B).approveKeyRecovery(f.idA, k(k2.address));
    const t2 = BigInt(await time.latest());
    expect(await f.id.ownershipFrozen()).to.equal(true);
    // K1 is still Ownable2Step's pending owner, but no longer the
    // recovery's nominee: the freeze holds against it.
    await expect(
      f.id.connect(k1).acceptOwnership(),
    ).to.be.revertedWithCustomError(f.id, "FrozenByRecovery");
    expect(await f.id.owner()).to.equal(f.owner.address);
    // K2's recovery completes.
    await time.increase(2 * DAY + 1);
    await f.km.connect(f.anyone).executeKeyRecovery(f.idA, k(k2.address));
    await time.setNextBlockTimestamp(t2 + 7n * BigInt(DAY));
    await f.km.connect(f.anyone).executeOwnerTransfer(f.idA, k2.address);
    await f.id.connect(k2).acceptOwnership();
    expect(await f.id.owner()).to.equal(k2.address);
    expect(await f.id.getKeysByPurpose(MGMT)).to.deep.equal([k(k2.address)]);
    await expect(f.id.connect(k1).acceptOwnership()).to.be.reverted;
  });

  it("L-2: an agent given MANAGEMENT later can neither open nor approve (R-414-10)", async function () {
    const f = await setup();
    const key = k(f.rescued.address);
    await f.id.addKey(k(f.A.address), MGMT, 1);
    await expect(f.km.connect(f.A).initiateKeyRecovery(f.idA, key))
      .to.be.revertedWithCustomError(f.km, "AgentControlsIdentity")
      .withArgs(f.A.address);
    await f.km.connect(f.B).initiateKeyRecovery(f.idA, key);
    await expect(f.km.connect(f.A).approveKeyRecovery(f.idA, key))
      .to.be.revertedWithCustomError(f.km, "AgentControlsIdentity")
      .withArgs(f.A.address);
    // The two agents without control still reach the threshold.
    await expect(f.km.connect(f.C).approveKeyRecovery(f.idA, key)).to.emit(
      f.km,
      "KeyRecoveryApproved",
    );
  });

  it("L-2: an agent that became owner by an ordinary transfer cannot open", async function () {
    const f = await setup();
    await f.id.transferOwnership(f.A.address);
    await f.id.connect(f.A).acceptOwnership();
    await expect(
      f.km.connect(f.A).initiateKeyRecovery(f.idA, k(f.rescued.address)),
    )
      .to.be.revertedWithCustomError(f.km, "AgentControlsIdentity")
      .withArgs(f.A.address);
    await f.km.connect(f.B).initiateKeyRecovery(f.idA, k(f.rescued.address));
  });

  it("L-2: a re-seat whose proposed agent gained MANAGEMENT meanwhile is refused at apply", async function () {
    const f = await setup();
    await f.km.setupKeyRecovery(f.idA, [f.user.address, f.anyone.address], 1);
    await f.id.addKey(k(f.user.address), MGMT, 1);
    await time.increase(2 * DAY + 1);
    await expect(f.km.connect(f.anyone).applyKeyRecoverySetup(f.idA))
      .to.be.revertedWithCustomError(f.km, "AgentControlsIdentity")
      .withArgs(f.user.address);
    await f.id.removeKey(k(f.user.address), MGMT);
    await f.km.connect(f.anyone).applyKeyRecoverySetup(f.idA);
    expect((await f.km.getKeyRecovery(f.idA)).recoveryAgents).to.deep.equal([
      f.user.address,
      f.anyone.address,
    ]);
  });

  it("M17: a second executeKeyRecovery is refused", async function () {
    const f = await setup();
    const key = k(f.rescued.address);
    await executed(f, key);
    await expect(
      f.km.connect(f.anyone).executeKeyRecovery(f.idA, key),
    ).to.be.revertedWith("KeyManager: Recovery already completed");
  });

  it("N33: a zero recovery key is refused", async function () {
    const f = await setup();
    await expect(
      f.km.connect(f.A).initiateKeyRecovery(f.idA, ethers.ZeroHash),
    ).to.be.revertedWith("KeyManager: Invalid recovery key");
  });

  it("N35: the owner transfer is refused once the wallet owns (AlreadyOwner)", async function () {
    const f = await setup();
    const t = await executed(f);
    await time.setNextBlockTimestamp(t + 7n * BigInt(DAY));
    await f.km.connect(f.anyone).executeOwnerTransfer(f.idA, f.rescued.address);
    await f.id.connect(f.rescued).acceptOwnership();
    await expect(
      f.km.connect(f.anyone).executeOwnerTransfer(f.idA, f.rescued.address),
    ).to.be.revertedWithCustomError(f.km, "AlreadyOwner");
  });

  it("D53: the owner and a MANAGEMENT key cannot be seated as agents; an ACTION key can", async function () {
    const f = await setup();
    const [, , , , , , , , , actionHolder] = await ethers.getSigners();
    await f.id.addKey(k(actionHolder.address), ACTION, 1);
    for (const bad of [f.owner, f.rogue]) {
      await expect(f.km.setupKeyRecovery(f.idA, [f.A.address, bad.address], 1))
        .to.be.revertedWithCustomError(f.km, "AgentControlsIdentity")
        .withArgs(bad.address);
    }
    await f.km.setupKeyRecovery(f.idA, [f.A.address, actionHolder.address], 1);
    expect((await f.km.getPendingRecoverySetup(f.idA)).agents).to.deep.equal([
      f.A.address,
      actionHolder.address,
    ]);
  });
});
