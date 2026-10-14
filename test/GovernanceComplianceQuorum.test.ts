import { expect } from "chai";
import { ethers } from "hardhat";
import { ageVoters, NOOP } from "./helpers/governanceFixture";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import {
  VGT,
  deployComplianceGovernance,
} from "./helpers/complianceGovernanceFixture";

describe("Governance → ComplianceRules Integration Test", function () {
  let governanceToken: any;
  let vanguardGovernance: any;
  let identityRegistry: any;
  let complianceRules: any;
  let token: any;
  let voter1: SignerWithAddress;
  let voter2: SignerWithAddress;
  let setupIdentity: (signer: SignerWithAddress) => Promise<void>;

  beforeEach(async function () {
    ({
      governanceToken,
      vanguardGovernance,
      identityRegistry,
      complianceRules,
      token,
      voter1,
      voter2,
      setupIdentity,
    } = await deployComplianceGovernance());
  });

  describe("Quorum enforcement", function () {
    // Before the quorum fix, executeProposal checked only
    // `require(totalVotes > 0)` plus a hardcoded 51% of votes CAST. One
    // voter was therefore a 100% approval and could execute the arbitrary
    // `proposal.target.call(proposal.callData)` in the execution path.
    //
    // Quorum is now a share of eligible voters (registered identities),
    // because votes are counted one per verified person, not by token
    // weight. This test proves the gate blocks a lone voter.
    it("Should reject a proposal that does not reach quorum", async function () {
      // Thresholds are set at construction and have no setter, so the
      // quorum cannot be raised. Instead grow the eligible-voter set
      // until one vote is below the configured 25% (ComplianceRules tier):
      // with >5 registered identities, 1 vote < 25%.
      const before = await identityRegistry.registeredIdentityCount();
      const signers = await ethers.getSigners();
      let added = 0;
      for (const s of signers.slice(10)) {
        if (before + BigInt(added) >= 10n) break;
        await setupIdentity(s);
        added++;
      }
      const eligible = await identityRegistry.registeredIdentityCount();
      expect(eligible).to.be.greaterThanOrEqual(6n);
      // Only identities older than minVoterAge count toward quorum (D25).
      await ageVoters(vanguardGovernance);

      await governanceToken.transfer(voter1.address, ethers.parseEther("1000"));
      // createProposal and castVote both pull their fee via transferFrom.
      await governanceToken
        .connect(voter1)
        .approve(
          await vanguardGovernance.getAddress(),
          ethers.parseEther("1000"),
        );

      const callData = NOOP;
      await vanguardGovernance.connect(voter1).createProposal(
        1, // ComplianceRules: the bound target below is complianceRules
        "Low turnout proposal",
        "Only one voter participates",
        await complianceRules.getAddress(),
        callData,
      );
      const proposalId = 1;

      // A single vote from someone other than the proposer (proposers
      // may not vote on their own proposal) — far below the 20% quorum.
      await governanceToken.transfer(voter2.address, ethers.parseEther("1000"));
      await governanceToken
        .connect(voter2)
        .approve(
          await vanguardGovernance.getAddress(),
          ethers.parseEther("1000"),
        );
      await vanguardGovernance
        .connect(voter2)
        .castVote(proposalId, true, "yes");

      await time.increase(9 * 24 * 60 * 60);

      // Failing quorum must REJECT AND REFUND, not revert.
      //
      // This previously asserted revertedWith("Quorum not met"), which encoded
      // a real bug as expected behaviour: the quorum require ran before the
      // rejection branch that returns locked VGT, so a low-turnout proposal
      // could never be settled and every deposit was trapped permanently.
      const proposerBefore = await governanceToken.balanceOf(voter1.address);
      const voterBefore = await governanceToken.balanceOf(voter2.address);
      const locked = await vanguardGovernance.getLockedTokens(proposalId);
      expect(
        locked,
        "deposits must be locked before settlement",
      ).to.be.greaterThan(0n);

      await vanguardGovernance.executeProposal(proposalId);

      const [after] = await vanguardGovernance.getProposal(proposalId);
      expect(after.status, "3 = Rejected").to.equal(3n);

      // Every participant pulls their stake back, and nothing stays locked.
      await vanguardGovernance.connect(voter1).claimRefund(proposalId);
      await vanguardGovernance.connect(voter2).claimRefund(proposalId);
      expect(
        await governanceToken.balanceOf(voter1.address),
        "proposer must be refunded",
      ).to.be.greaterThan(proposerBefore);
      expect(
        await governanceToken.balanceOf(voter2.address),
        "voter must be refunded",
      ).to.be.greaterThan(voterBefore);

      console.log(
        `✅ Below quorum: rejected and refunded ${ethers.formatEther(locked)} VGT`,
      );
    });

    // A proposal nobody votes on must also settle. This was the same defect in
    // its plainest form: `require(totalVotes > 0, "No votes cast")` reverted
    // before the refund branch, so an ignored proposal locked the proposer's
    // stake forever — on the ordinary path, with no attacker involved.
    it("Should refund the proposer when a proposal receives no votes at all", async function () {
      await governanceToken.transfer(voter1.address, ethers.parseEther("1000"));
      await governanceToken
        .connect(voter1)
        .approve(
          await vanguardGovernance.getAddress(),
          ethers.parseEther("1000"),
        );

      const before = await governanceToken.balanceOf(voter1.address);
      await vanguardGovernance.connect(voter1).createProposal(
        1, // ComplianceRules: the bound target below is complianceRules
        "Ignored proposal",
        "Nobody votes on this",
        await complianceRules.getAddress(),
        NOOP,
      );
      const proposalId = 1;

      await time.increase(9 * 24 * 60 * 60);
      await vanguardGovernance.executeProposal(proposalId);

      const [after] = await vanguardGovernance.getProposal(proposalId);
      expect(after.status, "3 = Rejected").to.equal(3n);
      await vanguardGovernance.connect(voter1).claimRefund(proposalId);
      expect(
        await governanceToken.balanceOf(voter1.address),
        "proposer's stake must be returned",
      ).to.equal(before);

      console.log("✅ Zero-vote proposal rejected, proposer refunded in full");
    });

    // Quorum must be measured against the eligible-voter count FROZEN at
    // creation. Reading it live let an agent change an already-cast vote's
    // outcome by registering identities mid-vote to push turnout below the bar.
    it("Should not let identities registered mid-vote change the outcome", async function () {
      await governanceToken.transfer(voter1.address, ethers.parseEther("1000"));
      await governanceToken
        .connect(voter1)
        .approve(
          await vanguardGovernance.getAddress(),
          ethers.parseEther("1000"),
        );
      await governanceToken.transfer(voter2.address, ethers.parseEther("1000"));
      await governanceToken
        .connect(voter2)
        .approve(
          await vanguardGovernance.getAddress(),
          ethers.parseEther("1000"),
        );

      const eligibleAtCreation =
        await identityRegistry.registeredIdentityCount();
      await vanguardGovernance.connect(voter1).createProposal(
        1, // ComplianceRules: the bound target below is complianceRules
        "Snapshot test",
        "Quorum must use the creation-time count",
        await complianceRules.getAddress(),
        NOOP,
      );
      const proposalId = 1;

      const [created] = await vanguardGovernance.getProposal(proposalId);
      expect(created.eligibleVotersAtCreation).to.equal(eligibleAtCreation);

      await vanguardGovernance
        .connect(voter2)
        .castVote(proposalId, true, "yes");
      const [, , turnoutBefore] =
        await vanguardGovernance.getProposal(proposalId);

      // Flood the registry AFTER the vote is cast. With a live denominator
      // this would dilute turnout; with the snapshot it must not move.
      const signers = await ethers.getSigners();
      const OID = await ethers.getContractFactory("OnchainID");
      for (const s of signers.slice(12, 18)) {
        // One OnchainID each: the wallet must control its identity (D41).
        const sid = await (await OID.deploy(s.address)).getAddress();
        await identityRegistry.registerIdentity(s.address, sid, 840);
      }
      expect(
        await identityRegistry.registeredIdentityCount(),
        "registry must actually have grown",
      ).to.be.greaterThan(eligibleAtCreation);

      const [, , turnoutAfter] =
        await vanguardGovernance.getProposal(proposalId);
      expect(
        turnoutAfter,
        "turnout must not change when identities are added mid-vote",
      ).to.equal(turnoutBefore);

      console.log(
        `✅ Registry grew ${eligibleAtCreation} -> ${await identityRegistry.registeredIdentityCount()}, turnout unchanged at ${Number(turnoutAfter) / 100}%`,
      );
    });

    // getProposal() is the ADVISORY view every UI reads to decide whether to
    // show an "Execute" button. executeProposal() is the ENFORCEMENT path.
    // If they disagree, a UI enables a button on a transaction that reverts.
    //
    // This probe measures that agreement directly: it builds the exact
    // scenario the test above proves is unexecutable, then asserts the
    // advisory view says the same thing.
    it("getProposal().canExecute must agree with executeProposal()", async function () {
      const before = await identityRegistry.registeredIdentityCount();
      const signers = await ethers.getSigners();
      let added = 0;
      for (const s of signers.slice(10)) {
        if (before + BigInt(added) >= 10n) break;
        await setupIdentity(s);
        added++;
      }
      const eligible = await identityRegistry.registeredIdentityCount();
      expect(eligible).to.be.greaterThanOrEqual(6n);
      // Only identities older than minVoterAge count toward quorum (D25).
      await ageVoters(vanguardGovernance);

      await governanceToken.transfer(voter1.address, ethers.parseEther("1000"));
      await governanceToken
        .connect(voter1)
        .approve(
          await vanguardGovernance.getAddress(),
          ethers.parseEther("1000"),
        );
      await vanguardGovernance.connect(voter1).createProposal(
        1, // ComplianceRules: the bound target below is complianceRules
        "Advisory vs enforcement",
        "One voter only",
        await complianceRules.getAddress(),
        NOOP,
      );
      const proposalId = 1;

      await governanceToken.transfer(voter2.address, ethers.parseEther("1000"));
      await governanceToken
        .connect(voter2)
        .approve(
          await vanguardGovernance.getAddress(),
          ethers.parseEther("1000"),
        );
      await vanguardGovernance
        .connect(voter2)
        .castVote(proposalId, true, "yes");

      await time.increase(9 * 24 * 60 * 60);

      const view = await vanguardGovernance.getProposal(proposalId);
      const canExecute = view[3];
      const participationRate = view[2];

      // Ground truth: does the proposal actually PASS?
      //
      // This previously used "does executeProposal revert?" as the ground
      // truth, which only worked while a failed quorum reverted. Now that
      // every settled proposal executes — passing ones run their callData,
      // failing ones refund — the honest comparison is against the resulting
      // status. That is also the stronger assertion: it holds for approval
      // failures too, not just quorum failures.
      await vanguardGovernance.executeProposal(proposalId);
      const [settled] = await vanguardGovernance.getProposal(proposalId);
      const actuallyPassed = settled.status === 4n; // 4 = Executed, 3 = Rejected

      console.log(
        `   advisory canExecute=${canExecute}  actual outcome=${actuallyPassed ? "Executed" : "Rejected"}`,
      );
      console.log(
        `   participationRate=${participationRate} (bps)  eligible=${eligible}  votes=1`,
      );

      expect(
        canExecute,
        "advisory view must match the outcome enforcement produces",
      ).to.equal(actuallyPassed);
      expect(
        actuallyPassed,
        "precondition: one vote must be below the configured quorum",
      ).to.equal(false);

      // 1 vote of >=6 eligible voters is >=1000 bps (10%). A zero here means
      // the metric is arithmetically dead, not merely low.
      expect(
        participationRate,
        "participationRate must reflect real turnout, not collapse to 0",
      ).to.be.greaterThan(0n);
    });
  });
});
