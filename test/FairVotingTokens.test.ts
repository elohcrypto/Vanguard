import { expect } from "chai";
import { ethers } from "hardhat";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import {
  GovernanceToken,
  VanguardGovernance,
  InvestorTypeRegistry,
} from "../typechain-types";
import {
  PROPOSAL_CREATION_COST,
  VOTING_COST,
  createInvestorTypeConfig,
  seedFirstTwoProposals,
  deployFairVoting,
} from "./helpers/fairVotingFixture";

describe("Fair Voting System (1 Person = 1 Vote)", function () {
  let governanceToken: GovernanceToken;
  let vanguardGovernance: VanguardGovernance;
  let investorTypeRegistry: InvestorTypeRegistry;
  let alice: SignerWithAddress;
  let bob: SignerWithAddress;
  let carol: SignerWithAddress;
  let dave: SignerWithAddress;

  before(async function () {
    ({
      governanceToken,
      vanguardGovernance,
      investorTypeRegistry,
      alice,
      bob,
      carol,
      dave,
    } = await deployFairVoting());
    // Its tests start where FairVotingCosts.test.ts leaves the chain
    // (they hard-code proposal id 3).
    await seedFirstTwoProposals({
      vanguardGovernance,
      investorTypeRegistry,
      alice,
      bob,
      carol,
      dave,
    });
  });

  describe("Token Burning on Passed Proposal", function () {
    let proposalId: number;
    let totalSupplyBefore: bigint;
    let snapshotId: string;

    before(async function () {
      // Take a snapshot before this test suite to isolate time manipulation
      snapshotId = await ethers.provider.send("evm_snapshot", []);
    });

    after(async function () {
      // Revert to snapshot after this test suite to reset blockchain time
      await ethers.provider.send("evm_revert", [snapshotId]);
    });

    it("Should burn tokens when proposal passes (≥51%)", async function () {
      // Create new proposal
      const callData = investorTypeRegistry.interface.encodeFunctionData(
        "updateInvestorTypeConfig",
        [
          2, // Accredited investor
          createInvestorTypeConfig("100000", "1000000"),
        ],
      );

      await vanguardGovernance
        .connect(alice)
        .createProposal(
          0,
          "Update Accredited Investor Limits",
          "Increase limits",
          await investorTypeRegistry.getAddress(),
          callData,
        );
      proposalId = 3;

      // Vote: 3 FOR, 0 AGAINST = 100% FOR (≥51%)
      await vanguardGovernance.connect(bob).castVote(proposalId, true, "FOR");
      await vanguardGovernance.connect(carol).castVote(proposalId, true, "FOR");
      await vanguardGovernance.connect(dave).castVote(proposalId, true, "FOR");

      // Get total supply before execution
      totalSupplyBefore = await governanceToken.totalSupply();

      // Fast forward time to end voting period and execution delay
      // executionTime = createdAt + votingPeriod (7 days) + executionDelay (2 days) = 9 days
      await ethers.provider.send("evm_increaseTime", [9 * 24 * 60 * 60 + 60]); // 9 days + 1 minute buffer
      await ethers.provider.send("evm_mine", []);

      // Execute proposal
      const lockedTokens = await vanguardGovernance.getLockedTokens(proposalId);
      await vanguardGovernance.executeProposal(proposalId);

      // Check tokens were burned
      const totalSupplyAfter = await governanceToken.totalSupply();
      expect(totalSupplyBefore - totalSupplyAfter).to.equal(lockedTokens);
    });
  });

  describe("Token Returning on Failed Proposal", function () {
    let proposalId: number;
    let aliceBalanceBefore: bigint;
    let bobBalanceBefore: bigint;
    let carolBalanceBefore: bigint;
    let daveBalanceBefore: bigint;

    it("Should return tokens when proposal fails (<51%)", async function () {
      // This test now works because the previous test suite uses snapshot/revert
      // to reset blockchain time, preventing time manipulation from carrying over

      // Create new proposal
      const callData = investorTypeRegistry.interface.encodeFunctionData(
        "updateInvestorTypeConfig",
        [
          3, // Institutional investor
          createInvestorTypeConfig("1000000", "10000000"),
        ],
      );

      const tx = await vanguardGovernance
        .connect(alice)
        .createProposal(
          0,
          "Update Institutional Investor Limits",
          "Increase limits",
          await investorTypeRegistry.getAddress(),
          callData,
        );

      // Get proposal ID from event
      const receipt = await tx.wait();
      const event = receipt?.logs.find((log: any) => {
        try {
          return (
            vanguardGovernance.interface.parseLog(log)?.name ===
            "ProposalCreated"
          );
        } catch {
          return false;
        }
      });

      if (!event) {
        throw new Error("ProposalCreated event not found");
      }

      const parsedEvent = vanguardGovernance.interface.parseLog(event);
      proposalId = Number(parsedEvent?.args[0]);

      // Vote: 1 FOR, 2 AGAINST = 33.3% FOR (<51%)
      await vanguardGovernance.connect(bob).castVote(proposalId, true, "FOR");
      await vanguardGovernance
        .connect(carol)
        .castVote(proposalId, false, "AGAINST");
      await vanguardGovernance
        .connect(dave)
        .castVote(proposalId, false, "AGAINST");

      // Record balances AFTER proposal creation and voting (before execution)
      aliceBalanceBefore = await governanceToken.balanceOf(alice.address);
      bobBalanceBefore = await governanceToken.balanceOf(bob.address);
      carolBalanceBefore = await governanceToken.balanceOf(carol.address);
      daveBalanceBefore = await governanceToken.balanceOf(dave.address);

      // Fast forward time to end voting period (no need to wait for execution delay for failed proposals)
      // But we still need to wait past votingEnds
      await ethers.provider.send("evm_increaseTime", [7 * 24 * 60 * 60 + 60]); // 7 days + 1 minute buffer
      await ethers.provider.send("evm_mine", []);

      // Execute proposal (should fail; deposits become claimable, not pushed)
      await vanguardGovernance.executeProposal(proposalId);
      for (const s of [alice, bob, carol, dave])
        await vanguardGovernance.connect(s).claimRefund(proposalId);

      // Check tokens were returned
      const aliceBalanceAfter = await governanceToken.balanceOf(alice.address);
      const bobBalanceAfter = await governanceToken.balanceOf(bob.address);
      const carolBalanceAfter = await governanceToken.balanceOf(carol.address);
      const daveBalanceAfter = await governanceToken.balanceOf(dave.address);

      // Alice should get back proposal creation cost
      expect(aliceBalanceAfter - aliceBalanceBefore).to.equal(
        PROPOSAL_CREATION_COST,
      );

      // Bob, Carol, Dave should get back voting cost
      expect(bobBalanceAfter - bobBalanceBefore).to.equal(VOTING_COST);
      expect(carolBalanceAfter - carolBalanceBefore).to.equal(VOTING_COST);
      expect(daveBalanceAfter - daveBalanceBefore).to.equal(VOTING_COST);

      // Check proposal status is Rejected
      const [proposal] = await vanguardGovernance.getProposal(proposalId);
      expect(proposal.status).to.equal(3); // Rejected
    });
  });
});
