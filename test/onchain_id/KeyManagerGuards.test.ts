import { expect } from "chai";
import { ethers } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import { handoverFixture } from "../helpers/governanceFixture";

// Plan v2 §6F Task 2F.2 (M2, M3), from the reviewer's probe-c/p2.
// M2: one recovery agent below threshold re-pointed an approved recovery to
//     its own key; the approvals for the good key carried over.
// M3: a queued rotation executed after its initiator's MANAGEMENT key was
//     revoked; there was no cancel.

const MGMT = 1;
const k = (a: string) => ethers.solidityPackedKeccak256(["address"], [a]);

async function setup() {
  const [holder, A, B, C, good, evil, anyone, m1] = await ethers.getSigners();
  const id = await (
    await ethers.getContractFactory("OnchainID")
  ).deploy(holder.address);
  const idA = await id.getAddress();
  const km = await (await ethers.getContractFactory("KeyManager")).deploy();
  await id.connect(holder).authorizeManager(await km.getAddress());
  await km
    .connect(holder)
    .setupKeyRecovery(idA, [A.address, B.address, C.address], 2);
  return { holder, A, B, C, good, evil, anyone, m1, id, idA, km };
}

describe("KeyManager recovery guards (2F.2, M2, review F2/F3)", function () {
  const DAY2 = 48 * 3600;

  it("a rogue initiation neither erases GOOD's approvals nor executes", async function () {
    const { A, B, C, good, evil, anyone, id, idA, km } = await setup();
    await km.connect(A).initiateKeyRecovery(idA, k(good.address));
    await km.connect(A).approveKeyRecovery(idA, k(good.address));
    await km.connect(B).approveKeyRecovery(idA, k(good.address));

    // C opens its own candidate: a separate tally, GOOD's stays at 2.
    await km.connect(C).initiateKeyRecovery(idA, k(evil.address));
    expect(
      (await km.getRecoveryCandidate(idA, k(good.address))).approvalCount,
    ).to.equal(2);
    expect(
      (await km.getRecoveryCandidate(idA, k(evil.address))).approvalCount,
    ).to.equal(0);
    await time.increase(DAY2 + 1);
    await expect(
      km.connect(anyone).executeKeyRecovery(idA, k(evil.address)),
    ).to.be.revertedWith("KeyManager: Insufficient approvals");
    await km.connect(anyone).executeKeyRecovery(idA, k(good.address));
    expect(await id.keyHasPurpose(k(good.address), MGMT)).to.equal(true);
    expect(await id.keyHasPurpose(k(evil.address), MGMT)).to.equal(false);
  });

  it("three rounds of rogue re-initiation do not delay the honest 2-of-3 (F2)", async function () {
    const { A, B, C, good, evil, anyone, id, idA, km } = await setup();
    await km.connect(A).initiateKeyRecovery(idA, k(good.address));
    await km.connect(A).approveKeyRecovery(idA, k(good.address));
    await km.connect(B).approveKeyRecovery(idA, k(good.address));
    // C keeps trying: re-initiating its own candidate is refused, and
    // re-initiating GOOD's is refused too, so GOOD's timelock never resets.
    await km.connect(C).initiateKeyRecovery(idA, k(evil.address));
    for (let r = 0; r < 3; r++) {
      await time.increase(15 * 3600);
      await expect(
        km.connect(C).initiateKeyRecovery(idA, k(evil.address)),
      ).to.be.revertedWith("KeyManager: Recovery already pending");
      await expect(
        km.connect(C).initiateKeyRecovery(idA, k(good.address)),
      ).to.be.revertedWith("KeyManager: Recovery already pending");
    }
    await time.increase(DAY2 - 45 * 3600 + 1);
    await km.connect(anyone).executeKeyRecovery(idA, k(good.address));
    expect(await id.keyHasPurpose(k(good.address), MGMT)).to.equal(true);
    // Execution bumps the epoch: EVIL's candidate is gone.
    expect(
      (await km.getRecoveryCandidate(idA, k(evil.address))).initiatedAt,
    ).to.equal(0);
    await expect(
      km.connect(C).approveKeyRecovery(idA, k(evil.address)),
    ).to.be.revertedWith("KeyManager: Recovery already completed");
  });

  it("an approval names an open candidate", async function () {
    const { A, B, good, evil, idA, km } = await setup();
    await km.connect(A).initiateKeyRecovery(idA, k(good.address));
    await expect(
      km.connect(B).approveKeyRecovery(idA, k(evil.address)),
    ).to.be.revertedWith("KeyManager: Recovery not initiated");
  });

  it("a legitimate 2-of-3 recovery still completes", async function () {
    const { A, B, good, anyone, id, idA, km } = await setup();
    await km.connect(A).initiateKeyRecovery(idA, k(good.address));
    await km.connect(A).approveKeyRecovery(idA, k(good.address));
    await km.connect(B).approveKeyRecovery(idA, k(good.address));
    await time.increase(DAY2 + 1);
    await km.connect(anyone).executeKeyRecovery(idA, k(good.address));
    expect(await id.keyHasPurpose(k(good.address), MGMT)).to.equal(true);
  });

  it("duplicate agents are refused; one approval never meets threshold 2 (F3)", async function () {
    const { holder, A, B, good, anyone, idA, km } = await setup();
    await expect(
      km
        .connect(holder)
        .setupKeyRecovery(idA, [A.address, A.address, B.address], 2),
    ).to.be.revertedWith("KeyManager: Duplicate agent");
    await km.connect(holder).setupKeyRecovery(idA, [A.address, B.address], 2);
    await km.connect(A).initiateKeyRecovery(idA, k(good.address));
    await km.connect(A).approveKeyRecovery(idA, k(good.address));
    await expect(
      km.connect(A).approveKeyRecovery(idA, k(good.address)),
    ).to.be.revertedWith("KeyManager: Already approved");
    await time.increase(DAY2 + 1);
    await expect(
      km.connect(anyone).executeKeyRecovery(idA, k(good.address)),
    ).to.be.revertedWith("KeyManager: Insufficient approvals");
  });

  it("the holder or the candidate's initiator cancels; others cannot", async function () {
    const { holder, A, B, C, good, evil, anyone, idA, km } = await setup();
    await km.connect(A).initiateKeyRecovery(idA, k(good.address));
    await km.connect(C).initiateKeyRecovery(idA, k(evil.address));
    await km.connect(B).approveKeyRecovery(idA, k(good.address));
    // C initiated EVIL, not GOOD.
    await expect(
      km.connect(C).cancelKeyRecovery(idA, k(good.address)),
    ).to.be.revertedWith("KeyManager: Not allowed to cancel recovery");
    await expect(
      km.connect(anyone).cancelKeyRecovery(idA, k(good.address)),
    ).to.be.revertedWith("KeyManager: Not allowed to cancel recovery");
    await km.connect(A).cancelKeyRecovery(idA, k(good.address));
    await expect(
      km.connect(B).approveKeyRecovery(idA, k(good.address)),
    ).to.be.revertedWith("KeyManager: Recovery not initiated");
    // Cancelling GOOD left EVIL untouched; the holder cancels it.
    expect(
      (await km.getRecoveryCandidate(idA, k(evil.address))).initiatedAt,
    ).to.not.equal(0);
    await km.connect(holder).cancelKeyRecovery(idA, k(evil.address));

    // Re-opened after a cancel: B's earlier approval does not carry over.
    await km.connect(B).initiateKeyRecovery(idA, k(good.address));
    expect(
      (await km.getRecoveryCandidate(idA, k(good.address))).approvalCount,
    ).to.equal(0);
    await km.connect(B).approveKeyRecovery(idA, k(good.address));
    await km.connect(holder).cancelKeyRecovery(idA, k(good.address));
    await time.increase(DAY2 + 1);
    await expect(
      km.connect(anyone).executeKeyRecovery(idA, k(good.address)),
    ).to.be.revertedWith("KeyManager: Recovery not initiated");
  });

  it("re-running setup (after the agents cancel) clears every candidate and its approvals", async function () {
    const { holder, A, B, C, good, anyone, idA, km } = await setup();
    await km.connect(A).initiateKeyRecovery(idA, k(good.address));
    await km.connect(A).approveKeyRecovery(idA, k(good.address));
    await km.connect(B).approveKeyRecovery(idA, k(good.address));
    // Approved: the holder cannot re-seat the agents (Task 4.11) until
    // the agents cancel it at the threshold.
    await expect(
      km.connect(holder).setupKeyRecovery(idA, [C.address], 1),
    ).to.be.revertedWith("KeyManager: recovery approved, setup locked");
    await km.connect(A).cancelKeyRecovery(idA, k(good.address));
    await km.connect(B).cancelKeyRecovery(idA, k(good.address));
    // Holder replaces the agent set: A and B are out.
    await km.connect(holder).setupKeyRecovery(idA, [C.address], 1);
    await time.increase(DAY2 + 1);
    await expect(
      km.connect(anyone).executeKeyRecovery(idA, k(good.address)),
    ).to.be.revertedWith("KeyManager: Recovery not initiated");
    // Re-adding A later does not revive its stale approval.
    await km
      .connect(holder)
      .setupKeyRecovery(idA, [A.address, B.address, C.address], 2);
    expect((await km.keyRecoveries(idA)).initiatedAt).to.equal(0);
    await km.connect(C).initiateKeyRecovery(idA, k(good.address));
    expect((await km.getKeyRecovery(idA)).approvalCount).to.equal(0);
    await km.connect(A).approveKeyRecovery(idA, k(good.address));
    await time.increase(DAY2 + 1);
    await expect(
      km.connect(anyone).executeKeyRecovery(idA, k(good.address)),
    ).to.be.revertedWith("KeyManager: Insufficient approvals");
  });
});

describe("KeyManager rotation guards (2F.2, M3)", function () {
  it("a revoked initiator's queued rotation cannot execute", async function () {
    const { holder, evil, anyone, m1, id, idA, km } = await setup();
    await id.connect(holder).addKey(k(m1.address), MGMT, 1);
    await km
      .connect(m1)
      .initiateKeyRotation(idA, k(holder.address), k(evil.address), MGMT);
    await id.connect(holder).removeKey(k(m1.address), MGMT);
    await time.increase(24 * 3600 + 1);
    await expect(
      km
        .connect(anyone)
        .executeKeyRotation(idA, k(holder.address), k(evil.address), MGMT),
    ).to.be.revertedWith("KeyManager: Initiator no longer a manager");
    expect(await id.keyHasPurpose(k(evil.address), MGMT)).to.equal(false);
  });

  it("any current MANAGEMENT key cancels a rotation; others cannot", async function () {
    const { holder, good, anyone, m1, idA, id, km } = await setup();
    await id.connect(holder).addKey(k(m1.address), MGMT, 1);
    await km
      .connect(m1)
      .initiateKeyRotation(idA, k(holder.address), k(good.address), MGMT);
    await expect(
      km
        .connect(anyone)
        .cancelKeyRotation(idA, k(holder.address), k(good.address), MGMT),
    ).to.be.revertedWith("KeyManager: Not identity manager");
    await km
      .connect(holder)
      .cancelKeyRotation(idA, k(holder.address), k(good.address), MGMT);
    await time.increase(24 * 3600 + 1);
    await expect(
      km
        .connect(anyone)
        .executeKeyRotation(idA, k(holder.address), k(good.address), MGMT),
    ).to.be.revertedWith("KeyManager: Rotation not initiated");
  });

  it("a legitimate rotation still completes", async function () {
    const { holder, good, anyone, m1, idA, id, km } = await setup();
    await id.connect(holder).addKey(k(m1.address), MGMT, 1);
    await km
      .connect(holder)
      .initiateKeyRotation(idA, k(m1.address), k(good.address), MGMT);
    await time.increase(24 * 3600 + 1);
    await km
      .connect(anyone)
      .executeKeyRotation(idA, k(m1.address), k(good.address), MGMT);
    expect(await id.keyHasPurpose(k(good.address), MGMT)).to.equal(true);
    expect(await id.keyHasPurpose(k(m1.address), MGMT)).to.equal(false);
  });
});

describe("Recovered wallet votes after KeyManager recovery (2F.1 + 2F.2)", function () {
  it("refused until the new wallet holds a key on its OnchainID, then accepted", async function () {
    const f = await handoverFixture();
    const { c, proposer, voters } = f;
    const [bob] = voters;
    const signers = await ethers.getSigners();
    const [agentA, agentB, newBob] = [signers[7], signers[8], signers[9]];
    const gov = c.governance;

    const bobId = await c.identityRegistry.identity(bob.address);
    const id = await ethers.getContractAt("OnchainID", bobId);
    const km = await (await ethers.getContractFactory("KeyManager")).deploy();
    // Bob opted in to recovery before losing his wallet.
    await id.connect(bob).authorizeManager(await km.getAddress());
    await km
      .connect(bob)
      .setupKeyRecovery(bobId, [agentA.address, agentB.address], 2);

    // Bob loses his wallet; the token agent recovers onto newBob. The
    // registry now binds newBob to Bob's identity, but the OnchainID's
    // owner and keys are unchanged.
    await c.identityRegistry.addAgent(await c.token.getAddress());
    await c.token.recoveryAddress(bob.address, newBob.address, bobId);
    expect(await c.identityRegistry.identity(newBob.address)).to.equal(bobId);
    await c.governanceToken.mint(newBob.address, ethers.parseEther("100"));
    for (const w of [proposer, newBob])
      await c.governanceToken.connect(w).approve(f.govAddr, ethers.MaxUint256);

    // The agents start recovery for newBob's key and wait out the timelock.
    await km.connect(agentA).initiateKeyRecovery(bobId, k(newBob.address));
    await km.connect(agentA).approveKeyRecovery(bobId, k(newBob.address));
    await km.connect(agentB).approveKeyRecovery(bobId, k(newBob.address));
    await time.increase(48 * 3600 + 1);

    const SYS = 4; // ProposalType.SystemParameters
    const noop = gov.interface.encodeFunctionData("setVotingCost", [
      ethers.parseEther("10"),
    ]);
    await gov.connect(proposer).createProposal(SYS, "t", "", f.govAddr, noop);
    const pid = await gov.proposalCount();

    await expect(
      gov.connect(newBob).castVote(pid, true, ""),
    ).to.be.revertedWith("Wallet does not control its identity");

    // KeyManager recovery adds newBob's key as MANAGEMENT on Bob's identity.
    await km.executeKeyRecovery(bobId, k(newBob.address));
    expect(await id.keyHasPurpose(k(newBob.address), MGMT)).to.equal(true);

    await expect(gov.connect(newBob).castVote(pid, true, "")).to.not.be
      .reverted;
  });
});
