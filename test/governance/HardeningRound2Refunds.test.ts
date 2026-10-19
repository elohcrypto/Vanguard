import { expect } from "chai";
import { ethers } from "hardhat";
import { ageVoters, govFixture, NOOP } from "../helpers/governanceFixture";

/**
 * One behavioural test per contract change in hardening round 2. Each was
 * reproduced as a defect before the change; the "before" shape is noted.
 */
describe("Hardening round 2 — contract changes", () => {
  describe("B1: cancelProposal refunds every locked VGT", () => {
    it("returns proposer and voter deposits and zeroes the lock", async () => {
      const { owner, alice, bob, gt, gov, govAddr } = await govFixture();
      const a0 = await gt.balanceOf(alice.address),
        b0 = await gt.balanceOf(bob.address);
      await gov.connect(alice).createProposal(0, "t", "d", owner.address, NOOP);
      const id = await gov.proposalCount();
      await gov.connect(bob).castVote(id, true, "yes");
      expect(await gov.getLockedTokens(id)).to.equal(ethers.parseEther("20"));
      // Before: cancel flipped status only; 20 VGT stayed in governance forever.
      // Now: cancel settles (no transfer), and each participant pulls their own.
      await expect(gov.connect(owner).cancelProposal(id))
        .to.emit(gov, "ProposalCancelled")
        .withArgs(id);
      expect(await gov.getLockedTokens(id)).to.equal(0n);
      const [p] = await gov.getProposal(id);
      expect(p.status).to.equal(5n);
      await gov.connect(alice).claimRefund(id);
      await gov.connect(bob).claimRefund(id);
      expect(await gt.balanceOf(alice.address)).to.equal(a0);
      expect(await gt.balanceOf(bob.address)).to.equal(b0);
      expect(await gt.balanceOf(govAddr)).to.equal(0n);
    });

    it("cannot be refunded twice via a later execute or a second claim", async () => {
      const { owner, alice, gov } = await govFixture();
      await gov.connect(alice).createProposal(0, "t", "d", owner.address, NOOP);
      const id = await gov.proposalCount();
      await gov.connect(owner).cancelProposal(id);
      await expect(gov.executeProposal(id)).to.be.revertedWith(
        "Proposal not active",
      );
      await gov.connect(alice).claimRefund(id);
      await expect(gov.connect(alice).claimRefund(id)).to.be.revertedWith(
        "Nothing to claim",
      );
    });
  });

  describe("R3: a passed proposal whose target call reverts is settled, not stuck", () => {
    const D = 9 * 86400 + 60;
    async function passedBadProposal() {
      const { owner, alice, bob, carol, gt, gov, govAddr } = await govFixture();
      // Calldata that reverts at execution. Governance does not own itself
      // in this fixture (nor after the demo's option 74), so its own
      // setVotingCost call fails onlyOwner with OwnableUnauthorizedAccount.
      // That is exactly the shape of a real-world stuck proposal.
      const cd = gov.interface.encodeFunctionData("setVotingCost", [
        ethers.parseEther("5000"),
      ]);
      await gov
        .connect(alice)
        .createProposal(
          4 /* SystemParameters: target is governance itself */,
          "bad",
          "d",
          govAddr,
          cd,
        );
      const id = await gov.proposalCount();
      await gov.connect(bob).castVote(id, true, "y");
      await gov.connect(carol).castVote(id, true, "y");
      await ethers.provider.send("evm_increaseTime", [D]);
      await ethers.provider.send("evm_mine", []);
      return { owner, alice, bob, carol, gt, gov, govAddr, id };
    }

    it("refunds every deposit, marks Rejected, and logs the target's revert data", async () => {
      const { alice, bob, carol, gt, gov, govAddr, id } =
        await passedBadProposal();
      const a0 = await gt.balanceOf(alice.address),
        b0 = await gt.balanceOf(bob.address),
        c0 = await gt.balanceOf(carol.address);
      expect(await gov.getLockedTokens(id)).to.equal(ethers.parseEther("30"));
      // Before: reverted "Proposal execution failed", proposal stayed Active,
      // 30 VGT locked forever, and a rescue vote calling cancelProposal also
      // reverted (shared reentrancy lock).
      await expect(gov.executeProposal(id))
        .to.emit(gov, "ProposalExecutionFailed")
        .withArgs(id, (data: string) => {
          // The raw revert data must decode to the target's actual error,
          // with its argument intact, so the failure is diagnosable off-chain.
          const err = gov.interface.parseError(data);
          expect(err?.name, `decoded ${data.slice(0, 10)}`).to.equal(
            "OwnableUnauthorizedAccount",
          );
          expect(err?.args[0]).to.equal(govAddr);
          return true;
        });
      const [p] = await gov.getProposal(id);
      expect(p.status).to.equal(3n); // Rejected
      expect(await gov.getLockedTokens(id)).to.equal(0n);
      for (const s of [alice, bob, carol]) await gov.connect(s).claimRefund(id);
      expect(await gt.balanceOf(alice.address)).to.equal(
        a0 + ethers.parseEther("10"),
      );
      expect(await gt.balanceOf(bob.address)).to.equal(
        b0 + ethers.parseEther("10"),
      );
      expect(await gt.balanceOf(carol.address)).to.equal(
        c0 + ethers.parseEther("10"),
      );
      expect(await gt.balanceOf(govAddr)).to.equal(0n);
      // The bad call had no effect.
      expect(await gov.votingCost()).to.equal(ethers.parseEther("10"));
    });

    it("is terminal: cannot be executed or cancelled afterwards", async () => {
      const { owner, gov, id } = await passedBadProposal();
      await gov.executeProposal(id);
      await expect(gov.executeProposal(id)).to.be.revertedWith(
        "Proposal not active",
      );
      await expect(gov.connect(owner).cancelProposal(id)).to.be.revertedWith(
        "Cannot cancel proposal",
      );
    });

    it("a successful target call still executes and burns", async () => {
      const { alice, bob, carol, gt, gov, govAddr } = await govFixture();
      const supply0 = await gt.totalSupply();
      const cd = gov.interface.encodeFunctionData("setVotingCost", [
        ethers.parseEther("20"),
      ]);
      await gov
        .connect(alice)
        .createProposal(
          4 /* SystemParameters: target is governance itself */,
          "ok",
          "d",
          govAddr,
          cd,
        );
      const id = await gov.proposalCount();
      await gov.connect(bob).castVote(id, true, "y");
      await gov.connect(carol).castVote(id, true, "y");
      await ethers.provider.send("evm_increaseTime", [D]);
      await ethers.provider.send("evm_mine", []);
      // Governance is not its own owner in this fixture, so the call reverts
      // with OwnableUnauthorizedAccount — that is a FAILED execution too.
      // Make governance own itself first, the same way the demo's option 83b
      // does for the registry: nominate, then accept by vote.
      // (Kept in this test so the "success" path is exercised, not assumed.)
      await gov.transferOwnership(govAddr);
      const cd2 = gov.interface.encodeFunctionData("acceptOwnership");
      await gov
        .connect(alice)
        .createProposal(
          4 /* SystemParameters: target is governance itself */,
          "own",
          "d",
          govAddr,
          cd2,
        );
      const id2 = await gov.proposalCount();
      await gov.connect(bob).castVote(id2, true, "y");
      await gov.connect(carol).castVote(id2, true, "y");
      await ethers.provider.send("evm_increaseTime", [D]);
      await ethers.provider.send("evm_mine", []);
      await expect(gov.executeProposal(id2))
        .to.emit(gov, "ProposalExecuted")
        .withArgs(id2);
      expect(await gov.owner()).to.equal(govAddr);
      await expect(gov.executeProposal(id))
        .to.emit(gov, "ProposalExecuted")
        .withArgs(id);
      expect(await gov.votingCost()).to.equal(ethers.parseEther("20"));
      // 30 VGT burned per passed proposal, two passed.
      expect(await gt.totalSupply()).to.equal(
        supply0 - ethers.parseEther("60"),
      );
    });
  });

  describe("R4: refunds are pulled, so one unpayable recipient cannot block the rest", () => {
    const D = 9 * 86400 + 60;
    async function rejectedWithTwoVoters() {
      const { owner, alice, bob, carol, ir, gt, gov, govAddr, ids } =
        await govFixture();
      await gov.connect(alice).createProposal(0, "t", "d", owner.address, NOOP);
      const id = await gov.proposalCount();
      await gov.connect(bob).castVote(id, false, "n");
      await gov.connect(carol).castVote(id, false, "n");
      await ethers.provider.send("evm_increaseTime", [D]);
      await ethers.provider.send("evm_mine", []);
      return { owner, alice, bob, carol, ir, gt, gov, govAddr, ids, id };
    }

    it("settles even when a voter was de-verified, and the others can claim", async () => {
      const { alice, bob, carol, ir, gt, gov, govAddr, ids, id } =
        await rejectedWithTwoVoters();
      await ir.deleteIdentity(bob.address);
      const a0 = await gt.balanceOf(alice.address),
        c0 = await gt.balanceOf(carol.address);
      // Before: executeProposal reverted "Recipient not verified" on bob's
      // transfer, so alice's and carol's deposits were also stuck, forever.
      await expect(gov.executeProposal(id))
        .to.emit(gov, "ProposalRejected")
        .withArgs(id);
      const [p] = await gov.getProposal(id);
      expect(p.status).to.equal(3n);
      // Nothing moved at settlement; every deposit is now claimable.
      expect(await gt.balanceOf(govAddr)).to.equal(ethers.parseEther("30"));
      expect(await gov.getClaimableRefund(id, ids.alice)).to.equal(
        ethers.parseEther("10"),
      );
      expect(await gov.getClaimableRefund(id, ids.bob)).to.equal(
        ethers.parseEther("10"),
      );
      expect(await gov.getClaimableRefund(id, ids.carol)).to.equal(
        ethers.parseEther("10"),
      );
      await expect(gov.connect(alice).claimRefund(id))
        .to.emit(gov, "RefundClaimed")
        .withArgs(id, alice.address, ids.alice, ethers.parseEther("10"));
      await expect(gov.connect(carol).claimRefund(id))
        .to.emit(gov, "RefundClaimed")
        .withArgs(id, carol.address, ids.carol, ethers.parseEther("10"));
      expect(await gt.balanceOf(alice.address)).to.equal(
        a0 + ethers.parseEther("10"),
      );
      expect(await gt.balanceOf(carol.address)).to.equal(
        c0 + ethers.parseEther("10"),
      );
      // Bob's deposit waits for him. That a de-verified voter cannot pull it
      // is ComplianceRules' counterparty check on the trusted path (D21),
      // which this permissive mock does not run: TrustedGovernance.test.ts
      // proves it on real ComplianceRules.
      expect(await gov.getClaimableRefund(id, ids.bob)).to.equal(
        ethers.parseEther("10"),
      );
      expect(await gt.balanceOf(govAddr)).to.equal(ethers.parseEther("10"));
      await ir.registerIdentity(bob.address, ids.bob, 840);
      await gov.connect(bob).claimRefund(id);
      expect(await gt.balanceOf(govAddr)).to.equal(0n);
    });

    it("cancel and execution-failure settle the same way", async () => {
      const { owner, alice, bob, carol, ir, gt, gov, govAddr, ids } =
        await govFixture();
      // Cancel with a de-verified voter.
      await gov.connect(alice).createProposal(0, "t", "d", owner.address, NOOP);
      const c = await gov.proposalCount();
      await gov.connect(bob).castVote(c, true, "y");
      await ir.deleteIdentity(bob.address);
      await expect(gov.connect(owner).cancelProposal(c))
        .to.emit(gov, "ProposalCancelled")
        .withArgs(c);
      expect(await gov.getClaimableRefund(c, ids.bob)).to.equal(
        ethers.parseEther("10"),
      );
      await ir.registerIdentity(bob.address, ids.bob, 840);
      // Re-registration restarts Bob's identity age (review 2F.1 M-1).
      await ageVoters(gov);
      // Execution failure with a de-verified voter.
      const cd = gov.interface.encodeFunctionData("setVotingCost", [
        ethers.parseEther("5000"),
      ]);
      await gov
        .connect(alice)
        .createProposal(
          4 /* SystemParameters: target is governance itself */,
          "bad",
          "d",
          govAddr,
          cd,
        );
      const e = await gov.proposalCount();
      await gov.connect(bob).castVote(e, true, "y");
      // SystemParameters (governance targets itself) needs 25% quorum: 1 of 4.
      await gov.connect(carol).castVote(e, true, "y");
      await ir.deleteIdentity(bob.address);
      await ethers.provider.send("evm_increaseTime", [D]);
      await ethers.provider.send("evm_mine", []);
      await expect(gov.executeProposal(e)).to.emit(
        gov,
        "ProposalExecutionFailed",
      );
      expect(await gov.getClaimableRefund(e, ids.bob)).to.equal(
        ethers.parseEther("10"),
      );
      expect(await gov.getClaimableRefund(e, ids.alice)).to.equal(
        ethers.parseEther("10"),
      );
      await gov.connect(alice).claimRefund(c);
      await gov.connect(alice).claimRefund(e);
      await gov.connect(carol).claimRefund(e);
      expect(await gt.balanceOf(govAddr)).to.equal(ethers.parseEther("20")); // bob's two deposits wait
    });

    it("claim is once, only after settlement, and never on a passed proposal", async () => {
      const { owner, alice, bob, carol, gt, gov, id, ids } =
        await rejectedWithTwoVoters();
      await expect(gov.connect(alice).claimRefund(id)).to.be.revertedWith(
        "Proposal not settled",
      );
      await gov.executeProposal(id);
      await gov.connect(alice).claimRefund(id);
      await expect(gov.connect(alice).claimRefund(id)).to.be.revertedWith(
        "Nothing to claim",
      );
      await expect(gov.connect(owner).claimRefund(id)).to.be.revertedWith(
        "Nothing to claim",
      );
      // A passed proposal burns; there is nothing to claim.
      await gov
        .connect(alice)
        .createProposal(0, "ok", "d", owner.address, NOOP);
      const ok = await gov.proposalCount();
      await gov.connect(bob).castVote(ok, true, "y");
      await gov.connect(carol).castVote(ok, true, "y");
      await ethers.provider.send("evm_increaseTime", [D]);
      await ethers.provider.send("evm_mine", []);
      const s0 = await gt.totalSupply();
      await expect(gov.executeProposal(ok)).to.emit(gov, "ProposalExecuted");
      expect(s0 - (await gt.totalSupply())).to.equal(ethers.parseEther("30"));
      expect(await gov.getClaimableRefund(ok, ids.bob)).to.equal(0n);
      await expect(gov.connect(bob).claimRefund(ok)).to.be.revertedWith(
        "Proposal not settled",
      );
    });
  });
});
