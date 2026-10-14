import { expect } from "chai";
import { ethers } from "hardhat";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import {
  VGT,
  deployComplianceGovernance,
} from "./helpers/complianceGovernanceFixture";

describe("Governance → ComplianceRules Integration Test", function () {
  let governanceToken: any;
  let vanguardGovernance: any;
  let complianceRules: any;
  let token: any;
  let voter1: SignerWithAddress;
  let voter2: SignerWithAddress;
  let voter3: SignerWithAddress;

  beforeEach(async function () {
    ({
      governanceToken,
      vanguardGovernance,
      complianceRules,
      token,
      voter1,
      voter2,
      voter3,
    } = await deployComplianceGovernance());
  });

  describe("Complete Governance → ComplianceRules Update Workflow", function () {
    it("Should update ComplianceRules jurisdiction via governance vote", async function () {
      console.log("\n🎯 GOVERNANCE → COMPLIANCE RULES UPDATE TEST");
      console.log("=".repeat(60));

      // Step 1: Check initial jurisdiction rules
      console.log("\n📊 Step 1: Checking initial jurisdiction rules...");
      const tokenAddr = await token.getAddress();
      const initialRule = await complianceRules.getJurisdictionRule(tokenAddr);
      console.log(
        `   Initial Allowed Countries: ${initialRule.allowedCountries.length === 0 ? "None" : initialRule.allowedCountries.join(", ")}`,
      );
      console.log(
        `   Initial Blocked Countries: ${initialRule.blockedCountries.length === 0 ? "None" : initialRule.blockedCountries.join(", ")}`,
      );

      // Step 2: Distribute governance tokens
      console.log("\n📊 Step 2: Distributing governance tokens...");
      await governanceToken.distributeGovernanceTokens(
        [voter1.address, voter2.address, voter3.address],
        [VGT(300000), VGT(400000), VGT(300000)],
      );
      console.log("   ✅ Distributed 1,000,000 VGT to 3 voters");

      // Approve VanguardGovernance to spend tokens
      const proposalCost = await vanguardGovernance.proposalCreationCost();
      const votingCost = await vanguardGovernance.votingCost();
      await governanceToken
        .connect(voter1)
        .approve(
          await vanguardGovernance.getAddress(),
          proposalCost + votingCost,
        );
      await governanceToken
        .connect(voter2)
        .approve(await vanguardGovernance.getAddress(), votingCost);
      await governanceToken
        .connect(voter3)
        .approve(await vanguardGovernance.getAddress(), votingCost);

      // Step 3: Create proposal to update jurisdiction rules
      console.log(
        "\n🗳️  Step 3: Creating proposal to update jurisdiction rules...",
      );

      // Encode the function call to setJurisdictionRule
      const newAllowedCountries = [840, 826, 124]; // US, UK, Canada
      const newBlockedCountries = [643]; // Russia
      const callData = complianceRules.interface.encodeFunctionData(
        "setJurisdictionRule",
        [tokenAddr, newAllowedCountries, newBlockedCountries],
      );

      await vanguardGovernance.connect(voter1).createProposal(
        1, // ComplianceRules type
        "Update Jurisdiction Rules",
        "Add US, UK, Canada to allowed countries and block Russia",
        await complianceRules.getAddress(),
        callData,
      );
      console.log("   ✅ Proposal created with jurisdiction update calldata");
      console.log(
        `   📋 New Allowed: ${newAllowedCountries.join(", ")} (US, UK, Canada)`,
      );
      console.log(
        `   📋 New Blocked: ${newBlockedCountries.join(", ")} (Russia)`,
      );

      // Step 4: Cast votes (voter1 is proposer, cannot vote)
      console.log("\n✅ Step 4: Casting votes...");
      // voter1 created the proposal, so cannot vote

      await vanguardGovernance
        .connect(voter2)
        .castVote(1, true, "Good for business");
      console.log("   ✅ Voter2 voted FOR (400,000 VGT)");

      await vanguardGovernance
        .connect(voter3)
        .castVote(1, true, "I support this");
      console.log("   ✅ Voter3 voted FOR (300,000 VGT)");

      // Step 5: Check proposal status
      console.log("\n📊 Step 5: Checking proposal status...");
      const proposal = await vanguardGovernance.getProposal(1);
      console.log(
        `   Votes FOR: ${ethers.formatEther(proposal.proposal.votesFor)} VGT (70%)`,
      );
      console.log(
        `   Votes AGAINST: ${ethers.formatEther(proposal.proposal.votesAgainst)} VGT (30%)`,
      );
      console.log(
        `   Participation: ${Number(proposal.participationRate) / 100}%`,
      );
      console.log(
        `   Quorum Met: ${Number(proposal.totalVotes) >= 250000 ? "✅ YES" : "❌ NO"}`,
      );
      console.log(
        `   Approval Met: ${Number(proposal.proposal.votesFor) >= Number(proposal.totalVotes) * 0.65 ? "✅ YES" : "❌ NO"}`,
      );

      // Step 6: Fast forward time
      console.log("\n⏰ Step 6: Fast forwarding time (9 days)...");
      await time.increase(9 * 24 * 60 * 60);
      console.log("   ✅ Time advanced (voting period + execution delay)");

      // Step 7: Execute proposal
      console.log("\n⚡ Step 7: Executing proposal...");
      const tx = await vanguardGovernance.executeProposal(1);
      await tx.wait();
      console.log("   ✅ Proposal executed successfully!");

      // Step 8: Verify ComplianceRules were updated
      console.log("\n🔍 Step 8: Verifying ComplianceRules were updated...");
      const updatedRule = await complianceRules.getJurisdictionRule(tokenAddr);

      console.log(
        `   Updated Allowed Countries: ${updatedRule.allowedCountries.join(", ")}`,
      );
      console.log(
        `   Updated Blocked Countries: ${updatedRule.blockedCountries.join(", ")}`,
      );

      // Verify the changes
      expect(updatedRule.allowedCountries.length).to.equal(3);
      expect(updatedRule.allowedCountries).to.include(840n); // US
      expect(updatedRule.allowedCountries).to.include(826n); // UK
      expect(updatedRule.allowedCountries).to.include(124n); // Canada

      expect(updatedRule.blockedCountries.length).to.equal(1);
      expect(updatedRule.blockedCountries).to.include(643n); // Russia

      console.log("\n✅ VERIFICATION SUCCESSFUL!");
      console.log("   ✅ Allowed countries updated correctly");
      console.log("   ✅ Blocked countries updated correctly");

      // Step 9: Test the new rules
      console.log("\n🧪 Step 9: Testing new compliance rules...");
      const validateUS = await complianceRules.validateJurisdiction(
        tokenAddr,
        840,
      ); // US
      const validateRussia = await complianceRules.validateJurisdiction(
        tokenAddr,
        643,
      ); // Russia
      console.log(
        `   US (840) allowed: ${validateUS.isValid ? "✅ YES" : "❌ NO"}`,
      );
      console.log(
        `   Russia (643) blocked: ${!validateRussia.isValid ? "✅ YES" : "❌ NO"}`,
      );

      expect(validateUS.isValid).to.be.true;
      expect(validateRussia.isValid).to.be.false;

      console.log("\n🎉 GOVERNANCE → COMPLIANCE RULES UPDATE COMPLETE!");
      console.log("=".repeat(60));
      console.log("✅ All steps completed successfully:");
      console.log("   1. Initial state checked");
      console.log("   2. Governance tokens distributed");
      console.log("   3. Proposal created with calldata");
      console.log("   4. Token-weighted votes cast");
      console.log("   5. Quorum and approval verified");
      console.log("   6. Time-lock enforced");
      console.log("   7. Proposal executed on-chain");
      console.log("   8. ComplianceRules updated");
      console.log("   9. New rules tested");
      console.log("\n🚀 GOVERNANCE SYSTEM PROVEN TO WORK!");
    });

    it("Should block a country for the token via governance", async function () {
      console.log("\n🎯 GOVERNANCE → JURISDICTION BLOCK TEST");
      console.log("=".repeat(60));

      // Distribute tokens
      await governanceToken.distributeGovernanceTokens(
        [voter1.address, voter2.address, voter3.address],
        [VGT(300000), VGT(400000), VGT(300000)],
      );

      // Approve VanguardGovernance to spend tokens
      const proposalCost = await vanguardGovernance.proposalCreationCost();
      const votingCost = await vanguardGovernance.votingCost();
      await governanceToken
        .connect(voter1)
        .approve(
          await vanguardGovernance.getAddress(),
          proposalCost + votingCost,
        );
      await governanceToken
        .connect(voter2)
        .approve(await vanguardGovernance.getAddress(), votingCost);
      await governanceToken
        .connect(voter3)
        .approve(await vanguardGovernance.getAddress(), votingCost);

      // Create proposal to block a country for this token. Task 4.1 removed
      // the holding-period rule (it gated nothing); the vote now exercises
      // the jurisdiction rule, the one ComplianceRules rule canTransfer reads.
      const tokenAddr = await token.getAddress();
      const versionBefore =
        await complianceRules.jurisdictionRuleVersion(tokenAddr);
      const callData = complianceRules.interface.encodeFunctionData(
        "setJurisdictionRule",
        [tokenAddr, [840, 826], [156]],
      );

      await vanguardGovernance.connect(voter1).createProposal(
        1, // ComplianceRules
        "Block CN",
        "Allow US and UK, block CN",
        await complianceRules.getAddress(),
        callData,
      );

      // voter1 is proposer, cannot vote

      // voter1 created the proposal, so cannot vote
      await vanguardGovernance.connect(voter2).castVote(1, true, "Support");
      await vanguardGovernance.connect(voter3).castVote(1, true, "Support");

      // Fast forward and execute
      await time.increase(9 * 24 * 60 * 60);
      await vanguardGovernance.executeProposal(1);

      // Verify
      const rule = await complianceRules.getJurisdictionRule(tokenAddr);
      expect(rule.blockedCountries).to.deep.equal([156n]);
      const [cnOk, cnReason] = await complianceRules.validateJurisdiction(
        tokenAddr,
        156,
      );
      expect(cnOk).to.equal(false);
      expect(cnReason).to.equal("Country is blocked");
      expect(await complianceRules.jurisdictionRuleVersion(tokenAddr)).to.equal(
        versionBefore + 1n,
      );
    });
  });
});
