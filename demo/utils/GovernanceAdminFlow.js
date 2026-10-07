/**
 * @fileoverview Governance options 78a, 82, 83, 83a, 83b: refunds, workflow, registry, costs
 * @module GovernanceAdminFlow
 * @description Fee refunds, the complete workflow (82), registry management and
 * ownership by vote, and the proposal and voting costs.
 * Moved out of demo/modules/GovernanceModule.js (plan v2 Task 4.8). Each
 * function takes the module instance `mod` first (its state, promptUser,
 * logger and sibling methods) and runs the option's code unchanged.
 */

const {
  displayInfo,
  displaySection,
  displaySuccess,
  displayError,
} = require("./DisplayHelpers");
const { ethers } = require("hardhat");
const { runCompleteWorkflow } = require("./GovernanceWorkflow");

/**
 * Option 82: Demo Complete Governance Workflow (demo/utils/
 * GovernanceWorkflow.js). Returns { proposalId, status } or null.
 */
async function demoCompleteWorkflow(mod) {
  return runCompleteWorkflow({
    state: mod.state,
    promptUser: mod.promptUser,
  });
}

/**
 * Option 83b: governance accepts the InvestorTypeRegistry nomination made
 * by option 74 — by an actual vote. VanguardGovernance can only make
 * external calls through executeProposal, so acceptOwnership() is reachable
 * only through a proposal that clears quorum and approval. The flow is
 * HandoverModule.acceptOwnershipByVote, shared with option 83d.
 */
async function acceptRegistryOwnershipByVote(mod) {
  displaySection("GOVERNANCE ACCEPTS REGISTRY OWNERSHIP (BY VOTE)", "🏛️");
  const investorTypeRegistry = mod.state.getContract("investorTypeRegistry");
  if (!mod.state.getContract("vanguardGovernance") || !investorTypeRegistry) {
    displayError(
      "Deploy the governance system (74) and InvestorTypeRegistry (51) first",
    );
    return;
  }
  const HandoverModule = require("../modules/HandoverModule");
  const done = await new HandoverModule(
    mod.state,
    mod.logger,
    mod.promptUser,
  ).acceptOwnershipByVote({
    target: investorTypeRegistry,
    proposalType: 0,
    label: "InvestorTypeRegistry",
    typeName: "InvestorTypeConfig",
    deployHint:
      "Deploy the registry (option 51) BEFORE governance (option 74).",
    nominateHint: "Run option 74 to nominate it first.",
  });
  if (done) {
    console.log(
      "\n   ⚠️  Note: updateInvestorTypeConfig is onlyOwner and BYPASSES this",
    );
    console.log(
      "      registry's own governor/requiredApprovals system. Config changes",
    );
    console.log(
      "      are protected by the VanguardGovernance vote, not by those governors.",
    );
  }
}

/** Option 83: Manage InvestorTypeRegistry via Governance */
async function manageInvestorTypeRegistry(mod) {
  displaySection("MANAGE INVESTORTYPEREGISTRY VIA GOVERNANCE", "🏛️");

  const vanguardGovernance = mod.state.getContract("vanguardGovernance");
  const investorTypeRegistry = mod.state.getContract("investorTypeRegistry");

  if (!vanguardGovernance) {
    displayError("Deploy Governance Token system first (option 74)");
    return;
  }

  if (!investorTypeRegistry) {
    displayError("Deploy InvestorTypeRegistry first (option 51)");
    return;
  }

  try {
    console.log("\n📊 INVESTOR TYPE REGISTRY GOVERNANCE");
    console.log(
      "This demonstrates using governance to manage InvestorTypeRegistry",
    );
    console.log("");
    console.log("💡 Note: This is a simplified demonstration.");
    console.log("   Use Option 76 to create InvestorTypeConfig proposals");
    console.log("   Use Option 77 to vote on proposals");
    console.log("   Use Option 78 to execute approved proposals");
    console.log("");
    console.log("📋 Current Investor Type Configurations:");

    // Show current configurations for all types
    const types = ["Normal", "Retail", "Accredited", "Institutional"];
    for (let i = 0; i < 4; i++) {
      try {
        const config = await investorTypeRegistry.getInvestorTypeConfig(i);
        console.log(`\n${i}. ${types[i]} Investor:`);
        console.log(
          `   Max Transfer: ${ethers.formatEther(config.maxTransferAmount)} VSC`,
        );
        console.log(
          `   Max Holding: ${ethers.formatEther(config.maxHoldingAmount)} VSC`,
        );
        console.log(`   Cooldown: ${config.transferCooldownMinutes} minutes`);
      } catch (error) {
        console.log(`\n${i}. ${types[i]} Investor: Not configured`);
      }
    }

    console.log("\n💡 To update these configurations via governance:");
    console.log(
      "   1. Use Option 76 (Create Proposal) → Select type 0 (InvestorTypeConfig)",
    );
    console.log("   2. Use Option 77 (Vote on Proposal)");
    console.log("   3. Use Option 79 (Time Travel 9 Days)");
    console.log("   4. Use Option 78 (Execute Proposal)");
  } catch (error) {
    displayError(`Error: ${error.message}`);
  }
}

/** Option 83a: Change Governance Costs */
async function changeGovernanceCosts(mod) {
  displaySection("CHANGE GOVERNANCE COSTS", "💰");
  console.log(
    "This allows the owner to change proposal creation and voting costs",
  );
  console.log("");

  const vanguardGovernance = mod.state.getContract("vanguardGovernance");
  if (!vanguardGovernance) {
    displayError("Deploy Governance system first (option 74)");
    return;
  }

  try {
    // Show current costs
    const currentProposalCost = await vanguardGovernance.proposalCreationCost();
    const currentVotingCost = await vanguardGovernance.votingCost();

    console.log("\n📊 CURRENT COSTS:");
    console.log("=".repeat(70));
    console.log(
      `   Proposal Creation: ${ethers.formatEther(currentProposalCost)} VGT`,
    );
    console.log(
      `   Voting: ${ethers.formatEther(currentVotingCost)} VGT per vote`,
    );
    console.log("");

    console.log("🎯 WHAT WOULD YOU LIKE TO CHANGE?");
    console.log("1. Change Proposal Creation Cost");
    console.log("2. Change Voting Cost");
    console.log("3. Change Both Costs");
    console.log("0. Back to Main Menu");
    console.log("");

    const choice = await mod.promptUser("Select option (0-3): ");

    switch (choice) {
      case "1":
        await mod._changeProposalCreationCost(currentProposalCost);
        break;
      case "2":
        await mod._changeVotingCost(currentVotingCost);
        break;
      case "3":
        await mod._changeProposalCreationCost(currentProposalCost);
        await mod._changeVotingCost(currentVotingCost);
        break;
      case "0":
        return;
      default:
        console.log("Invalid choice");
    }
  } catch (error) {
    displayError(`Error: ${error.message}`);
  }
}

/**
 * Helper: Change proposal creation cost
 * @private
 */
async function _changeProposalCreationCost(mod, currentCost) {
  console.log("\n💰 CHANGE PROPOSAL CREATION COST");
  console.log(`   Current: ${ethers.formatEther(currentCost)} VGT`);

  const newCost = await mod.promptUser("Enter new cost (VGT): ");
  const newCostWei = ethers.parseEther(newCost);

  const confirm = await mod.promptUser(
    `\nChange from ${ethers.formatEther(currentCost)} to ${newCost} VGT? (y/n): `,
  );
  if (confirm.toLowerCase() !== "y") {
    console.log("❌ Change cancelled");
    return;
  }

  const vanguardGovernance = mod.state.getContract("vanguardGovernance");
  const tx = await vanguardGovernance.setProposalCreationCost(newCostWei);
  await tx.wait();

  displaySuccess(`Proposal creation cost changed to ${newCost} VGT`);
}

/**
 * Helper: Change voting cost
 * @private
 */
async function _changeVotingCost(mod, currentCost) {
  console.log("\n💰 CHANGE VOTING COST");
  console.log(`   Current: ${ethers.formatEther(currentCost)} VGT per vote`);

  const newCost = await mod.promptUser("Enter new cost (VGT): ");
  const newCostWei = ethers.parseEther(newCost);

  const confirm = await mod.promptUser(
    `\nChange from ${ethers.formatEther(currentCost)} to ${newCost} VGT? (y/n): `,
  );
  if (confirm.toLowerCase() !== "y") {
    console.log("❌ Change cancelled");
    return;
  }

  const vanguardGovernance = mod.state.getContract("vanguardGovernance");
  const tx = await vanguardGovernance.setVotingCost(newCostWei);
  await tx.wait();

  displaySuccess(`Voting cost changed to ${newCost} VGT per vote`);
}

/**
 * Option 78a: Claim Refund.
 *
 * Settlement (reject, cancel, execution failure) no longer pushes VGT
 * back. It records what each participant is owed, and each one pulls it
 * here. A participant the token refuses to pay (identity deleted, address
 * frozen) blocks only their own claim, not everyone else's; before this,
 * one such participant froze every deposit on the proposal forever.
 */
async function claimRefund(mod) {
  displaySection("CLAIM GOVERNANCE REFUND", "💰");

  const vanguardGovernance = mod.state.getContract("vanguardGovernance");
  const governanceToken = mod.state.getContract("governanceToken");
  if (!vanguardGovernance || !governanceToken) {
    displayError("Deploy Governance Token system first (option 74)");
    return;
  }

  try {
    const signers = mod.state.signers;
    const count = Number(await vanguardGovernance.proposalCount());
    if (count === 0) {
      displayError("No proposals exist yet");
      return;
    }

    // Scan every settled proposal for every signer; list what is owed.
    const claimable = [];
    for (let id = 1; id <= count; id++) {
      const [p] = await vanguardGovernance.getProposal(id);
      const status = Number(p.status);
      if (status !== 3 && status !== 5) continue; // Rejected, Cancelled
      for (let i = 0; i < signers.length; i++) {
        const owed = await vanguardGovernance.getClaimableRefund(
          id,
          signers[i].address,
        );
        if (owed > 0n) claimable.push({ id, i, owed, title: p.title, status });
      }
    }

    if (claimable.length === 0) {
      displayInfo(
        "Nothing to claim: no settled proposal holds a deposit for any signer",
      );
      return;
    }

    console.log("\n📋 CLAIMABLE DEPOSITS:");
    claimable.forEach((c, n) => {
      console.log(
        `${n + 1}. Proposal ${c.id} "${c.title}" (${c.status === 3 ? "Rejected" : "Cancelled"}) — signer ${c.i} ${signers[c.i].address.slice(0, 10)}… owed ${ethers.formatEther(c.owed)} VGT`,
      );
    });

    const pick = await mod.promptUser("\nClaim which (number, or 'all'): ");
    const chosen =
      pick.trim().toLowerCase() === "all"
        ? claimable
        : [claimable[parseInt(pick) - 1]].filter(Boolean);
    if (chosen.length === 0) {
      displayError("Invalid choice");
      return;
    }

    for (const c of chosen) {
      try {
        const tx = await vanguardGovernance
          .connect(signers[c.i])
          .claimRefund(c.id);
        await tx.wait();
        displaySuccess(
          `Signer ${c.i} claimed ${ethers.formatEther(c.owed)} VGT from proposal ${c.id}`,
        );
      } catch (error) {
        // The token's compliance gate can refuse this one recipient. That
        // is the case the pull design exists for: nobody else is affected.
        displayError(
          `Signer ${c.i} could not claim from proposal ${c.id}: ${error.message}`,
        );
        console.log(
          "   Deposit stays claimable; retry once the signer is verified/unfrozen.",
        );
      }
    }
  } catch (error) {
    displayError(`Claim failed: ${error.message}`);
  }
}

module.exports = {
  demoCompleteWorkflow,
  acceptRegistryOwnershipByVote,
  manageInvestorTypeRegistry,
  changeGovernanceCosts,
  _changeProposalCreationCost,
  _changeVotingCost,
  claimRefund,
};
