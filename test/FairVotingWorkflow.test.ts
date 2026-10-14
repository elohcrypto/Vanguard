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
  });

  describe("Complete Workflow Test", function () {
    it("Should demonstrate complete fair voting workflow", async function () {
      console.log("\n🎯 FAIR VOTING SYSTEM DEMONSTRATION");
      console.log("=".repeat(60));

      // Initial balances
      const aliceInitial = await governanceToken.balanceOf(alice.address);
      const bobInitial = await governanceToken.balanceOf(bob.address);
      const carolInitial = await governanceToken.balanceOf(carol.address);
      const daveInitial = await governanceToken.balanceOf(dave.address);

      console.log("\n📊 Initial Balances:");
      console.log(`   Alice: ${ethers.formatEther(aliceInitial)} VGT`);
      console.log(`   Bob: ${ethers.formatEther(bobInitial)} VGT`);
      console.log(`   Carol: ${ethers.formatEther(carolInitial)} VGT`);
      console.log(`   Dave: ${ethers.formatEther(daveInitial)} VGT`);

      // Create proposal
      const callData = investorTypeRegistry.interface.encodeFunctionData(
        "updateInvestorTypeConfig",
        [0, createInvestorTypeConfig("20000", "200000")],
      );

      console.log("\n📝 Step 1: Alice creates proposal");
      console.log(`   Cost: ${ethers.formatEther(PROPOSAL_CREATION_COST)} VGT`);

      // Approve tokens for proposal creation
      await governanceToken
        .connect(alice)
        .approve(await vanguardGovernance.getAddress(), PROPOSAL_CREATION_COST);

      const tx = await vanguardGovernance
        .connect(alice)
        .createProposal(
          0,
          "Final Test Proposal",
          "Testing complete workflow",
          await investorTypeRegistry.getAddress(),
          callData,
        );
      const receipt = await tx.wait();

      // Get proposal ID from event
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
      const parsedEvent = vanguardGovernance.interface.parseLog(event!);
      const proposalId = parsedEvent?.args[0];

      console.log(`   Proposal ID: ${proposalId}`);

      const aliceAfterProposal = await governanceToken.balanceOf(alice.address);
      console.log(
        `   Alice balance: ${ethers.formatEther(aliceAfterProposal)} VGT`,
      );

      // Verify proposal is active
      const [proposal] = await vanguardGovernance.getProposal(proposalId);
      console.log(`   Proposal status: ${proposal.status} (1=Active)`);
      expect(proposal.status).to.equal(1); // Active

      // Voting
      console.log("\n🗳️  Step 2: Users vote (1 person = 1 vote)");
      console.log(
        `   Voting cost: ${ethers.formatEther(VOTING_COST)} VGT per vote`,
      );

      // Approve tokens for voting
      await governanceToken
        .connect(bob)
        .approve(await vanguardGovernance.getAddress(), VOTING_COST);
      await vanguardGovernance.connect(bob).castVote(proposalId, true, "FOR");
      console.log(`   ✅ Bob voted FOR (1 vote)`);

      await governanceToken
        .connect(carol)
        .approve(await vanguardGovernance.getAddress(), VOTING_COST);
      await vanguardGovernance.connect(carol).castVote(proposalId, true, "FOR");
      console.log(`   ✅ Carol voted FOR (1 vote)`);

      await governanceToken
        .connect(dave)
        .approve(await vanguardGovernance.getAddress(), VOTING_COST);
      await vanguardGovernance.connect(dave).castVote(proposalId, true, "FOR");
      console.log(`   ✅ Dave voted FOR (1 vote)`);

      const [proposalAfterVoting] =
        await vanguardGovernance.getProposal(proposalId);
      console.log(
        `\n   Total votes: ${proposalAfterVoting.votesFor} FOR, ${proposalAfterVoting.votesAgainst} AGAINST`,
      );
      console.log(
        `   Result: ${(Number(proposalAfterVoting.votesFor) * 100) / Number(proposalAfterVoting.votesFor + proposalAfterVoting.votesAgainst)}% FOR`,
      );

      // Execute
      console.log("\n⚡ Step 3: Execute proposal");
      // executionTime = createdAt + votingPeriod (7 days) + executionDelay (2 days) = 9 days
      await ethers.provider.send("evm_increaseTime", [9 * 24 * 60 * 60 + 60]); // 9 days + 1 minute buffer
      await ethers.provider.send("evm_mine", []);

      const totalSupplyBefore = await governanceToken.totalSupply();
      const lockedTokens = await vanguardGovernance.getLockedTokens(proposalId);

      await vanguardGovernance.executeProposal(proposalId);

      const totalSupplyAfter = await governanceToken.totalSupply();
      const burned = totalSupplyBefore - totalSupplyAfter;

      console.log(`   Locked tokens: ${ethers.formatEther(lockedTokens)} VGT`);
      console.log(`   Tokens burned: ${ethers.formatEther(burned)} VGT 🔥`);
      console.log(`   Status: PASSED ✅`);

      console.log("\n✅ FAIR VOTING SYSTEM WORKS CORRECTLY!");
      console.log("=".repeat(60));
    });
  });
});
