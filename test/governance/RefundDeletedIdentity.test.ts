import { expect } from "chai";
import { ethers } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import { handoverFixture } from "../helpers/governanceFixture";

// Task 5.17 slice D (deep review contracts L-1, Q23): a voter whose
// identity an agent deleted from the registry has no bound wallet, so the
// one-argument claimRefund finds nothing and the deposit stayed locked.
// claimRefundFor(proposalId, identity) pays a wallet that controls the
// identity (IdentityControl) while no wallet is bound; while one is bound
// only that wallet claims (Q6: a recovery's lost wallet may hold a key).
const SYS = 4; // ProposalType.SystemParameters
const ACTION_KEY = 2;
const keyOf = (a: string) =>
  ethers.keccak256(ethers.solidityPacked(["address"], [a]));

describe("Refund of a deleted identity's deposit (Task 5.17, contracts L-1)", function () {
  async function setup() {
    const f = await handoverFixture();
    const { c, proposer, voters, govAddr, ops } = f;
    const gov = c.governance;
    const ir = c.identityRegistry;
    const vgt = c.governanceToken;
    for (const s of [proposer, ...voters])
      await vgt.connect(s).approve(govAddr, ethers.MaxUint256);
    const noop = gov.interface.encodeFunctionData("setVotingCost", [
      ethers.parseEther("10"),
    ]);
    await gov.connect(proposer).createProposal(SYS, "t", "", govAddr, noop);
    const id = await gov.proposalCount();
    const [bob] = voters;
    await gov.connect(bob).castVote(id, false, "n");
    const idAddr = await ir.identity(bob.address);
    const reject = async () => {
      await time.increase(30n * 86400n);
      await expect(gov.executeProposal(id)).to.emit(gov, "ProposalRejected");
    };
    return { ...f, gov, ir, vgt, id, bob, idAddr, reject, ops };
  }

  it("pays a controlling wallet after the identity was deleted; once", async function () {
    const { gov, ir, vgt, id, bob, idAddr, reject, deployer, voters } =
      await setup();
    const cost = await gov.votingCost();
    await reject();
    await ir.connect(deployer).deleteIdentity(bob.address);
    expect(await ir.identity(bob.address)).to.equal(ethers.ZeroAddress);
    expect(await ir.walletOf(idAddr)).to.equal(ethers.ZeroAddress);
    // The one-argument form finds no identity for bob now.
    await expect(gov.connect(bob).claimRefund(id)).to.be.revertedWith(
      "Nothing to claim",
    );
    // A VGT transfer needs a verified receiver: bob's identity gives an
    // ACTION key to a verified wallet (carol's), which claims for it.
    const carol = voters[1];
    const oid = await ethers.getContractAt("OnchainID", idAddr);
    await oid.connect(bob).addKey(keyOf(carol.address), ACTION_KEY, 1);
    const c0 = await vgt.balanceOf(carol.address);
    await expect(gov.connect(carol).claimRefundFor(id, idAddr))
      .to.emit(gov, "RefundClaimed")
      .withArgs(id, carol.address, cost);
    expect(await vgt.balanceOf(carol.address)).to.equal(c0 + cost);
    expect(await gov.getClaimableRefund(id, idAddr)).to.equal(0n);
    await expect(
      gov.connect(carol).claimRefundFor(id, idAddr),
    ).to.be.revertedWith("Nothing to claim");
  });

  it("a wallet that does not control the identity cannot claim its deposit", async function () {
    const { gov, ir, id, bob, idAddr, reject, deployer, voters } =
      await setup();
    await reject();
    await ir.connect(deployer).deleteIdentity(bob.address);
    const carol = voters[1];
    await expect(
      gov.connect(carol).claimRefundFor(id, idAddr),
    ).to.be.revertedWith("Wallet does not control its identity");
  });

  it("while a wallet is bound, only it claims: a recovery's lost wallet cannot, even with a key", async function () {
    const { gov, ir, vgt, id, bob, idAddr, reject, deployer } = await setup();
    await ir.addAgent(await vgt.getAddress());
    const nw = ethers.Wallet.createRandom().connect(ethers.provider);
    await deployer.sendTransaction({
      to: nw.address,
      value: ethers.parseEther("1"),
    });
    const oid = await ethers.getContractAt("OnchainID", idAddr);
    await oid.connect(bob).addKey(keyOf(nw.address), ACTION_KEY, 1);
    await vgt.recoveryAddress(bob.address, nw.address, idAddr);
    await reject();
    // bob still owns the identity, but the registry binds it to nw.
    await expect(
      gov.connect(bob).claimRefundFor(id, idAddr),
    ).to.be.revertedWith("Identity is bound to another wallet");
    await expect(gov.connect(nw).claimRefundFor(id, idAddr))
      .to.emit(gov, "RefundClaimed")
      .withArgs(id, nw.address, await gov.votingCost());
  });

  it("refuses an unsettled proposal and an identity with nothing locked", async function () {
    const { gov, id, bob, idAddr, voters } = await setup();
    await expect(
      gov.connect(bob).claimRefundFor(id, idAddr),
    ).to.be.revertedWith("Proposal not settled");
    await time.increase(30n * 86400n);
    await gov.executeProposal(id);
    const carolId = await (
      await ethers.getContractAt(
        "IdentityRegistry",
        await gov.identityRegistry(),
      )
    ).identity(voters[1].address);
    await expect(
      gov.connect(voters[1]).claimRefundFor(id, carolId),
    ).to.be.revertedWith("Nothing to claim");
  });
});
