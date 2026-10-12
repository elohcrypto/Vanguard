import { expect } from "chai";
import { ethers } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import { handoverFixture } from "../helpers/governanceFixture";

// Task 4.15 (C §2 GovernanceProposals and GovernanceConfig rows; C §3
// N62, N69). The vote window closes at votingEnds (inclusive), a vote
// needs the proposal Active and the voter's VGT for the fee; the cost and
// list-manager setters are the owner's and bounded.
const SYS = 4; // ProposalType.SystemParameters

describe("Voting and config guards (Task 4.15)", function () {
  async function setup() {
    const f = await handoverFixture();
    const { c, deployer, ops, proposer, voters } = f;
    const gov = c.governance;
    for (const s of [proposer, ...voters])
      await c.governanceToken.connect(s).approve(f.govAddr, ethers.MaxUint256);
    await c.governanceToken.addAgent(ops.address);
    const noop = gov.interface.encodeFunctionData("setVotingCost", [
      ethers.parseEther("10"),
    ]);
    const propose = async () => {
      await gov.connect(proposer).createProposal(SYS, "t", "", f.govAddr, noop);
      return gov.proposalCount();
    };
    return {
      ...f,
      gov,
      propose,
      deployer,
      ops,
      bob: voters[0],
      carol: voters[1],
    };
  }

  it("a vote lands at votingEnds and is refused one second later (N62)", async function () {
    const { gov, propose, bob, carol } = await setup();
    const id = await propose();
    const [p] = await gov.getProposal(id);
    await time.setNextBlockTimestamp(p.votingEnds);
    await gov.connect(bob).castVote(id, true, "");
    expect(await gov.hasVoted(id, bob.address)).to.equal(true);
    await time.setNextBlockTimestamp(p.votingEnds + 1n);
    await expect(gov.connect(carol).castVote(id, true, "")).to.be.revertedWith(
      "Voting period ended",
    );
    expect(await gov.hasVoted(id, carol.address)).to.equal(false);
  });

  it("a vote on a cancelled proposal: Proposal not active (198)", async function () {
    const { gov, propose, bob } = await setup();
    const id = await propose();
    await gov.cancelProposal(id);
    await expect(gov.connect(bob).castVote(id, true, "")).to.be.revertedWith(
      "Proposal not active",
    );
    await expect(
      gov.connect(bob).castVote(id + 1n, true, ""),
    ).to.be.revertedWith("Proposal not active");
  });

  it("a verified holder short of the voting cost: Insufficient tokens for voting (210)", async function () {
    const { gov, propose, bob, ops, c } = await setup();
    const id = await propose();
    const cost: bigint = await gov.votingCost();
    const bal: bigint = await c.governanceToken.balanceOf(bob.address);
    await c.governanceToken
      .connect(ops)
      ["burn(address,uint256)"](bob.address, bal - cost + 1n);
    await expect(gov.connect(bob).castVote(id, true, "")).to.be.revertedWith(
      "Insufficient tokens for voting",
    );
    await c.governanceToken.mint(bob.address, 1n);
    await gov.connect(bob).castVote(id, true, "");
    expect(await gov.hasVoted(id, bob.address)).to.equal(true);
  });

  it("the cost setters are the owner's and bounded (N69)", async function () {
    const { gov, stranger } = await setup();
    const max = await gov.MAX_COST();
    for (const call of [
      async () => gov.connect(stranger).setProposalCreationCost(1n),
      async () => gov.connect(stranger).setVotingCost(1n),
    ])
      await expect(call())
        .to.be.revertedWithCustomError(gov, "OwnableUnauthorizedAccount")
        .withArgs(stranger.address);
    for (const bad of [0n, max + 1n]) {
      await expect(gov.setProposalCreationCost(bad))
        .to.be.revertedWithCustomError(gov, "CostOutOfRange")
        .withArgs(bad, max);
      await expect(gov.setVotingCost(bad))
        .to.be.revertedWithCustomError(gov, "CostOutOfRange")
        .withArgs(bad, max);
    }
    await expect(gov.setVotingCost(max))
      .to.emit(gov, "VotingCostUpdated")
      .withArgs(await gov.proposalCreationCost(), max);
    expect(await gov.votingCost()).to.equal(max);
  });

  it("setDynamicListManager is the owner's and refuses zero (320-321)", async function () {
    const { gov, stranger, c } = await setup();
    const dlm = await c.dynamicListManager.getAddress();
    await expect(gov.connect(stranger).setDynamicListManager(dlm))
      .to.be.revertedWithCustomError(gov, "OwnableUnauthorizedAccount")
      .withArgs(stranger.address);
    await expect(
      gov.setDynamicListManager(ethers.ZeroAddress),
    ).to.be.revertedWith("Invalid address");
    expect(await gov.dynamicListManager()).to.equal(dlm);
  });
});
