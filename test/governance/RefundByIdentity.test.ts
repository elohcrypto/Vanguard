import { expect } from "chai";
import { ethers } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import { handoverFixture } from "../helpers/governanceFixture";

// Plan v2 Task 5.2 (A1 deep L2, Q6): refundable deposits are keyed by
// identity, as votes are (D25 b). A VGT holder whose wallet is recovered
// while a proposal is open claims the refund from the new wallet; the
// lost wallet cannot, even while it still holds a key on the identity.
const SYS = 4; // ProposalType.SystemParameters
const ACTION_KEY = 2;
const keyOf = (a: string) =>
  ethers.keccak256(ethers.solidityPacked(["address"], [a]));

describe("Refunds keyed by identity (Task 5.2, Q6)", function () {
  async function setup() {
    const f = await handoverFixture();
    const { c, deployer, proposer, voters, govAddr } = f;
    const gov = c.governance;
    const ir = c.identityRegistry;
    const vgt = c.governanceToken;
    for (const s of [proposer, ...voters])
      await vgt.connect(s).approve(govAddr, ethers.MaxUint256);
    await ir.addAgent(await vgt.getAddress()); // recoveryAddress moves the entry
    const noop = gov.interface.encodeFunctionData("setVotingCost", [
      ethers.parseEther("10"),
    ]);
    await gov.connect(proposer).createProposal(SYS, "t", "", govAddr, noop);
    const id = await gov.proposalCount();
    /** `lost`'s identity gains a key for a fresh wallet; VGT recovers onto it. */
    const recover = async (lost: any) => {
      const nw = ethers.Wallet.createRandom().connect(ethers.provider);
      await deployer.sendTransaction({
        to: nw.address,
        value: ethers.parseEther("1"),
      });
      const idAddr = await ir.identity(lost.address);
      const oid = await ethers.getContractAt("OnchainID", idAddr);
      await oid.connect(lost).addKey(keyOf(nw.address), ACTION_KEY, 1);
      await vgt.recoveryAddress(lost.address, nw.address, idAddr);
      return { nw, idAddr };
    };
    const reject = async () => {
      await time.increase(30n * 86400n);
      await expect(gov.executeProposal(id)).to.emit(gov, "ProposalRejected");
    };
    return { ...f, gov, ir, vgt, id, recover, reject };
  }

  it("a voter recovered mid-proposal claims from the new wallet; the lost wallet cannot", async function () {
    const { gov, vgt, id, voters, recover, reject } = await setup();
    const [bob] = voters;
    const cost = await gov.votingCost();
    await gov.connect(bob).castVote(id, false, "n");
    const { nw, idAddr } = await recover(bob);
    expect(await gov.getVoterLockedTokens(id, idAddr)).to.equal(cost);
    await reject();
    expect(await gov.getClaimableRefund(id, idAddr)).to.equal(cost);
    // The lost wallet still holds its MANAGEMENT key and owns the identity,
    // but the registry binds the identity to the new wallet now.
    await expect(gov.connect(bob).claimRefund(id)).to.be.revertedWith(
      "Nothing to claim",
    );
    const b0 = await vgt.balanceOf(nw.address);
    await expect(gov.connect(nw).claimRefund(id))
      .to.emit(gov, "RefundClaimed")
      .withArgs(id, nw.address, cost);
    expect(await vgt.balanceOf(nw.address)).to.equal(b0 + cost);
    await expect(gov.connect(nw).claimRefund(id)).to.be.revertedWith(
      "Nothing to claim",
    );
    expect(await gov.getClaimableRefund(id, idAddr)).to.equal(0n);
  });

  it("the proposer's deposit follows the identity too", async function () {
    const { gov, id, proposer, recover, reject } = await setup();
    const cost = await gov.proposalCreationCost();
    const { nw, idAddr } = await recover(proposer);
    await reject();
    expect(await gov.getClaimableRefund(id, idAddr)).to.equal(cost);
    await expect(gov.connect(proposer).claimRefund(id)).to.be.revertedWith(
      "Nothing to claim",
    );
    await expect(gov.connect(nw).claimRefund(id))
      .to.emit(gov, "RefundClaimed")
      .withArgs(id, nw.address, cost);
  });

  it("a bound wallet that no longer controls its identity cannot claim", async function () {
    const { gov, id, voters, ir, recover, reject } = await setup();
    const [bob] = voters;
    await gov.connect(bob).castVote(id, false, "n");
    const { nw, idAddr } = await recover(bob);
    // The identity's owner withdraws the new wallet's key after the move.
    const oid = await ethers.getContractAt("OnchainID", idAddr);
    await oid.connect(bob).removeKey(keyOf(nw.address), ACTION_KEY);
    expect(await ir.identity(nw.address)).to.equal(idAddr);
    await reject();
    await expect(gov.connect(nw).claimRefund(id)).to.be.revertedWith(
      "Wallet does not control its identity",
    );
  });
});
