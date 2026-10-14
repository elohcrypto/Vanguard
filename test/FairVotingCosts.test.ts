import { expect } from "chai";
import { ethers } from "hardhat";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import {
  GovernanceToken,
  VanguardGovernance,
  IdentityRegistry,
  InvestorTypeRegistry,
} from "../typechain-types";
import {
  PROPOSAL_CREATION_COST,
  VOTING_COST,
  createInvestorTypeConfig,
  deployFairVoting,
} from "./helpers/fairVotingFixture";

describe("Fair Voting System (1 Person = 1 Vote)", function () {
  let governanceToken: GovernanceToken;
  let vanguardGovernance: VanguardGovernance;
  let investorTypeRegistry: InvestorTypeRegistry;
  let owner: SignerWithAddress;
  let alice: SignerWithAddress;
  let bob: SignerWithAddress;
  let carol: SignerWithAddress;
  let dave: SignerWithAddress;
  let unverified: SignerWithAddress;

  before(async function () {
    ({
      governanceToken,
      vanguardGovernance,
      investorTypeRegistry,
      owner,
      alice,
      bob,
      carol,
      dave,
      unverified,
    } = await deployFairVoting());
  });

  describe("Governance Costs", function () {
    it("Should have correct default proposal creation cost", async function () {
      const cost = await vanguardGovernance.proposalCreationCost();
      expect(cost).to.equal(PROPOSAL_CREATION_COST);
    });

    it("Should have correct default voting cost", async function () {
      const cost = await vanguardGovernance.votingCost();
      expect(cost).to.equal(VOTING_COST);
    });

    it("Should allow owner to update proposal creation cost", async function () {
      // 500, not the 5000 this used to set: costs are capped at MAX_COST
      // (1000 VGT) so the owner cannot price every holder out of governance.
      const newCost = ethers.parseEther("500");
      await vanguardGovernance.setProposalCreationCost(newCost);
      expect(await vanguardGovernance.proposalCreationCost()).to.equal(newCost);

      // Reset to default
      await vanguardGovernance.setProposalCreationCost(PROPOSAL_CREATION_COST);
    });

    it("Should allow owner to update voting cost", async function () {
      const newCost = ethers.parseEther("5");
      await vanguardGovernance.setVotingCost(newCost);
      expect(await vanguardGovernance.votingCost()).to.equal(newCost);

      // Reset to default
      await vanguardGovernance.setVotingCost(VOTING_COST);
    });
  });

  describe("Proposal Creation with Cost", function () {
    it("Should reject proposal creation from unverified user", async function () {
      const callData = investorTypeRegistry.interface.encodeFunctionData(
        "updateInvestorTypeConfig",
        [
          0, // Normal investor
          createInvestorTypeConfig("10000", "100000"),
        ],
      );

      await expect(
        vanguardGovernance.connect(unverified).createProposal(
          0, // InvestorTypeConfig
          "Update Normal Investor Limits",
          "Increase limits for normal investors",
          await investorTypeRegistry.getAddress(),
          callData,
        ),
      ).to.be.revertedWith("Must be KYC/AML verified");
    });

    it("Should reject unverified user before checking token balance", async function () {
      // Unverified user is not registered in IdentityRegistry
      // VanguardGovernance checks KYC/AML verification BEFORE token balance
      const callData = investorTypeRegistry.interface.encodeFunctionData(
        "updateInvestorTypeConfig",
        [0, createInvestorTypeConfig("10000", "100000")],
      );

      await expect(
        vanguardGovernance
          .connect(unverified)
          .createProposal(
            0,
            "Update Normal Investor Limits",
            "Increase limits",
            await investorTypeRegistry.getAddress(),
            callData,
          ),
      ).to.be.revertedWith("Must be KYC/AML verified");
    });

    it("Should create proposal and lock tokens", async function () {
      const aliceBalanceBefore = await governanceToken.balanceOf(alice.address);

      const callData = investorTypeRegistry.interface.encodeFunctionData(
        "updateInvestorTypeConfig",
        [0, createInvestorTypeConfig("10000", "100000")],
      );

      await vanguardGovernance
        .connect(alice)
        .createProposal(
          0,
          "Update Normal Investor Limits",
          "Increase limits for normal investors",
          await investorTypeRegistry.getAddress(),
          callData,
        );

      const aliceBalanceAfter = await governanceToken.balanceOf(alice.address);
      expect(aliceBalanceBefore - aliceBalanceAfter).to.equal(
        PROPOSAL_CREATION_COST,
      );

      // Check locked tokens
      const lockedTokens = await vanguardGovernance.getLockedTokens(1);
      expect(lockedTokens).to.equal(PROPOSAL_CREATION_COST);
    });
  });

  describe("Fair Voting (1 Person = 1 Vote)", function () {
    let proposalId: number;

    before(async function () {
      // Create a proposal for testing
      const callData = investorTypeRegistry.interface.encodeFunctionData(
        "updateInvestorTypeConfig",
        [
          1, // Retail investor
          createInvestorTypeConfig("5000", "50000"),
        ],
      );

      const tx = await vanguardGovernance
        .connect(alice)
        .createProposal(
          0,
          "Update Retail Investor Limits",
          "Increase limits for retail investors",
          await investorTypeRegistry.getAddress(),
          callData,
        );

      const receipt = await tx.wait();
      proposalId = 2; // Second proposal
    });

    it("Should reject vote from unverified user", async function () {
      await expect(
        vanguardGovernance
          .connect(unverified)
          .castVote(proposalId, true, "Support"),
      ).to.be.revertedWith("Must be KYC/AML verified");
    });

    it("Should charge voting cost and give 1 vote regardless of token balance", async function () {
      // Bob has 1,000 VGT
      const bobBalanceBefore = await governanceToken.balanceOf(bob.address);
      await vanguardGovernance
        .connect(bob)
        .castVote(proposalId, true, "I support this");
      const bobBalanceAfter = await governanceToken.balanceOf(bob.address);

      expect(bobBalanceBefore - bobBalanceAfter).to.equal(VOTING_COST);

      // Check proposal votes - Bob should have 1 vote
      const [proposal] = await vanguardGovernance.getProposal(proposalId);
      expect(proposal.votesFor).to.equal(1n); // 1 vote, not 1000 VGT worth
    });

    it("Should give equal voting power regardless of token amount", async function () {
      // Carol has 500 VGT (less than Bob's 1,000)
      await vanguardGovernance
        .connect(carol)
        .castVote(proposalId, true, "I support this too");

      // Dave has 100 VGT (much less than Bob and Carol)
      await vanguardGovernance
        .connect(dave)
        .castVote(proposalId, false, "I oppose this");

      const [proposal] = await vanguardGovernance.getProposal(proposalId);

      // Each person gets 1 vote: Bob (FOR) + Carol (FOR) + Dave (AGAINST)
      expect(proposal.votesFor).to.equal(2n); // Bob + Carol = 2 votes
      expect(proposal.votesAgainst).to.equal(1n); // Dave = 1 vote
    });

    it("Should prevent double voting", async function () {
      await expect(
        vanguardGovernance
          .connect(bob)
          .castVote(proposalId, true, "Voting again"),
      ).to.be.revertedWith("Already voted");
    });
  });
});
