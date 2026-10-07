/**
 * @fileoverview Privacy jurisdiction lists: load, validate, update on chain
 * @module PrivacyJurisdictionFlow
 * @description The jurisdiction-list menu, its validation and chain load, and the
 * two update paths (a governance proposal or a direct owner call).
 * Moved out of demo/modules/PrivacyModule.js (plan v2 Task 4.8). Each
 * function takes the module instance `mod` first (its state, promptUser,
 * logger and sibling methods) and runs the option's code unchanged.
 */

const { displaySection, displayError } = require("./DisplayHelpers");
const { ageOrVoterAgeRefusal } = require("./ChainTime");
const { ethers } = require("hardhat");

/** Option 42 -> 7: Manage Jurisdiction Lists */
async function manageJurisdictionLists(mod) {
  displaySection("MANAGE JURISDICTION LISTS", "🌍");

  // Load jurisdiction lists from on-chain ComplianceRules contract
  await mod.loadJurisdictionListsFromContract();

  // If lists are still empty after loading, offer to initialize
  if (
    mod.state.allowedJurisdictions.size === 0 &&
    mod.state.disallowedJurisdictions.size === 0
  ) {
    console.log("\n💡 TIP: Jurisdiction lists are empty");
    console.log("   You can:");
    console.log("   • Add jurisdictions manually (Option 2)");
    console.log(
      "   • Reset to defaults (Option 6) - adds US, UK, Germany, Canada",
    );
    console.log(
      "   • Deploy token and compliance rules first for on-chain storage",
    );
    console.log("");
  }

  console.log("\n🌍 JURISDICTION MANAGEMENT OPTIONS:");
  console.log("1. View Current Lists");
  console.log("2. Add to Allowed List");
  console.log("3. Remove from Allowed List");
  console.log("4. Add to Disallowed List");
  console.log("5. Remove from Disallowed List");
  console.log("6. Reset to Defaults");
  // Review 3.8 L3: the private path needs a bit for a newly allowed code.
  console.log(
    "   ℹ️  A newly allowed code needs a PrivacyManager bit (registerJurisdictionCode: rerun option 21/41, or a PrivacyParameters vote) before investors can attest it",
  );
  console.log("0. Back to Main Menu");

  const choice = await mod.promptUser("\nSelect option (0-6): ");

  try {
    switch (choice) {
      case "1":
        await mod.viewJurisdictionLists();
        break;
      case "2":
        await mod.addToAllowedJurisdictions();
        break;
      case "3":
        await mod.removeFromAllowedJurisdictions();
        break;
      case "4":
        await mod.addToDisallowedJurisdictions();
        break;
      case "5":
        await mod.removeFromDisallowedJurisdictions();
        break;
      case "6":
        await mod.resetJurisdictionLists();
        break;
      case "0":
        return;
      default:
        displayError("Invalid choice");
    }
  } catch (error) {
    displayError(`Jurisdiction management failed: ${error.message}`);
  }
}

/** Helper: Validate jurisdiction lists for conflicts */
function validateJurisdictionLists(mod) {
  const conflicts = [];

  // Check if any jurisdiction is in both allowed and disallowed lists
  for (const code of mod.state.allowedJurisdictions) {
    if (mod.state.disallowedJurisdictions.has(code)) {
      conflicts.push(code);
    }
  }

  return conflicts;
}

/** Helper: Load jurisdiction lists from on-chain ComplianceRules contract */
async function loadJurisdictionListsFromContract(mod) {
  try {
    const complianceRules = mod.state.getContract("complianceRules");
    // Try both 'token' (Option 1) and 'digitalToken' (Option 21)
    const token =
      mod.state.getContract("token") || mod.state.getContract("digitalToken");

    // Debug: Check what we got
    console.log("\n🔍 Checking contract availability...");
    console.log(
      `   ComplianceRules: ${complianceRules ? "✅ Found" : "❌ Not found"}`,
    );
    console.log(`   Token: ${token ? "✅ Found" : "❌ Not found"}`);

    // Check if contracts are deployed
    if (!complianceRules || !token) {
      console.log("\n⚠️  Compliance system not fully deployed");
      console.log("   ℹ️  Please deploy the token and compliance rules first:");
      console.log("      • Option 1: Deploy Token");
      console.log("      • Option 13: Create Compliance Rules");
      console.log("");
      console.log("   📝 Using empty jurisdiction lists for now...");

      // Initialize empty lists
      if (!mod.state.allowedJurisdictions) {
        mod.state.allowedJurisdictions = new Set();
      }
      if (!mod.state.disallowedJurisdictions) {
        mod.state.disallowedJurisdictions = new Set();
      }
      return;
    }

    console.log("\n🔄 Loading jurisdiction lists from blockchain...");

    // Get jurisdiction rule from contract
    const [isActive, allowedCountries, blockedCountries, lastUpdated] =
      await complianceRules.getJurisdictionRule(token.target);

    // Convert to Sets for easy management
    mod.state.allowedJurisdictions = new Set(
      allowedCountries.map((c) => BigInt(c)),
    );
    mod.state.disallowedJurisdictions = new Set(
      blockedCountries.map((c) => BigInt(c)),
    );

    console.log(
      `   ✅ Loaded ${allowedCountries.length} allowed jurisdictions`,
    );
    if (allowedCountries.length > 0) {
      console.log("   📋 Allowed:");
      for (const code of allowedCountries) {
        console.log(`      • ${code}`);
      }
    }
    console.log(
      `   ✅ Loaded ${blockedCountries.length} disallowed jurisdictions`,
    );
    if (blockedCountries.length > 0) {
      console.log("   📋 Disallowed:");
      for (const code of blockedCountries) {
        console.log(`      • ${code}`);
      }
    }
    console.log(
      `   📅 Last updated: ${new Date(Number(lastUpdated) * 1000).toLocaleString()}`,
    );
    console.log(
      `   ${isActive ? "✅ Rules are ACTIVE" : "⚠️  Rules are INACTIVE"}`,
    );
  } catch (error) {
    console.log(`   ⚠️  Could not load from contract: ${error.message}`);
    console.log(`   ℹ️  Using empty jurisdiction lists...`);

    // Fallback to empty lists if contract read fails
    if (!mod.state.allowedJurisdictions) {
      mod.state.allowedJurisdictions = new Set();
    }
    if (!mod.state.disallowedJurisdictions) {
      mod.state.disallowedJurisdictions = new Set();
    }
  }
}

/** Helper: Update jurisdiction rule on-chain via governance proposal */
async function updateJurisdictionRuleOnChain(mod) {
  try {
    console.log("\n📝 Updating jurisdiction rules on blockchain...");
    console.log(
      "   🗳️  This requires creating a governance proposal and voting",
    );
    console.log("");
    console.log("   OPTIONS:");
    console.log("   1. Create Governance Proposal (Recommended - Democratic)");
    console.log("   2. Direct Update (Owner Only - For Testing)");
    console.log("   3. Skip On-Chain Update (Local Only)");

    const choice = await mod.promptUser("\n   Select option (1-3): ");

    if (choice === "1") {
      await mod.createJurisdictionProposal();
    } else if (choice === "2") {
      await mod.directUpdateJurisdictionRule();
    } else {
      console.log("   ℹ️  Skipped on-chain update - changes are local only");
    }
  } catch (error) {
    console.log(`   ❌ Failed to update on-chain: ${error.message}`);
    console.log(`   ℹ️  Changes are saved locally but not on blockchain`);
  }
}

/** Helper: Create governance proposal for jurisdiction rule update */
async function createJurisdictionProposal(mod) {
  try {
    console.log("\n🗳️  CREATING GOVERNANCE PROPOSAL");
    console.log("=".repeat(60));

    // CRITICAL: Validate no conflicts between allowed and disallowed lists
    console.log("\n🔍 PRE-SUBMISSION VALIDATION...");
    const conflicts = mod.validateJurisdictionLists();

    if (conflicts.length > 0) {
      console.log("\n❌ VALIDATION FAILED: CONFLICTS DETECTED!");
      console.log(
        "   The following jurisdictions are in BOTH allowed and disallowed lists:",
      );
      for (const code of conflicts) {
        console.log(`      ⚠️  ${code}`);
      }
      console.log("");
      console.log(
        "   🚫 Cannot create proposal with conflicting jurisdictions!",
      );
      console.log(
        "   💡 Please resolve conflicts first using the management menu",
      );
      console.log("");
      console.log("   RESOLUTION OPTIONS:");
      console.log("   1. Remove from allowed list (Option 42 → 7 → 3)");
      console.log("   2. Remove from disallowed list (Option 42 → 7 → 5)");
      return;
    }

    console.log("   ✅ No conflicts detected");
    console.log("   ✅ Allowed and disallowed lists are mutually exclusive");

    // Try both 'governance' and 'vanguardGovernance' (Option 74 uses 'vanguardGovernance')
    const governance =
      mod.state.getContract("governance") ||
      mod.state.getContract("vanguardGovernance");
    const complianceRules = mod.state.getContract("complianceRules");
    const token =
      mod.state.getContract("token") || mod.state.getContract("digitalToken");
    const governanceToken = mod.state.getContract("governanceToken");
    const proposer = mod.state.signers[0]; // Use first signer as proposer

    // Check if governance system is deployed
    if (!governance || !governanceToken) {
      console.log("\n   ❌ Governance system not deployed!");
      console.log("   ℹ️  Please deploy the governance system first:");
      console.log("      • Option 74: Deploy Governance System");
      console.log("      • Option 75: Distribute Governance Tokens");
      console.log("");
      console.log("   💡 Or use Direct Update (Option 2) for testing");
      return;
    }

    // Convert Sets to Arrays
    const allowedArray = Array.from(mod.state.allowedJurisdictions);
    const blockedArray = Array.from(mod.state.disallowedJurisdictions);

    // Encode the function call
    const callData = complianceRules.interface.encodeFunctionData(
      "setJurisdictionRule",
      [token.target, allowedArray, blockedArray],
    );

    // Get proposal creation cost
    const proposalCost = await governance.proposalCreationCost();

    console.log("\n📋 PROPOSAL DETAILS:");
    console.log(`   📊 Allowed Jurisdictions: ${allowedArray.length}`);
    for (const code of allowedArray) {
      console.log(`      ✅ ${code}`);
    }
    console.log(`   📊 Blocked Jurisdictions: ${blockedArray.length}`);
    for (const code of blockedArray) {
      console.log(`      🚫 ${code}`);
    }
    console.log(
      `   💰 Proposal Cost: ${ethers.formatEther(proposalCost)} VGT tokens`,
    );
    console.log("");

    // Check if proposer has enough tokens
    const balance = await governanceToken.balanceOf(proposer.address);
    if (balance < proposalCost) {
      console.log(`   ❌ Insufficient VGT tokens!`);
      console.log(`      Balance: ${ethers.formatEther(balance)} VGT`);
      console.log(`      Required: ${ethers.formatEther(proposalCost)} VGT`);
      console.log(`      💡 Use Option 75 to distribute governance tokens`);
      return;
    }

    // Approve governance contract to spend tokens
    console.log("   🔓 Approving governance contract to spend VGT tokens...");
    const approveTx = await governanceToken
      .connect(proposer)
      .approve(governance.target, proposalCost);
    await approveTx.wait();
    console.log("   ✅ Approval confirmed");

    // Create proposal
    const title =
      (await mod.promptUser("\n   Enter proposal title: ")) ||
      "Update Jurisdiction Rules";
    const description =
      (await mod.promptUser("   Enter proposal description: ")) ||
      `Update allowed jurisdictions to [${allowedArray.join(", ")}] and blocked jurisdictions to [${blockedArray.join(", ")}]`;

    // D25: the proposer's identity must be minVoterAge old.
    const tooNew = await ageOrVoterAgeRefusal(
      governance,
      mod.state.getContract("identityRegistry"),
      [proposer],
    );
    if (tooNew) {
      console.log(`   ❌ ${tooNew}`);
      return;
    }

    console.log("\n   📝 Creating proposal...");
    const tx = await governance.connect(proposer).createProposal(
      1, // ProposalType.ComplianceRules
      title,
      description,
      complianceRules.target,
      callData,
    );

    console.log("   ⏳ Waiting for transaction confirmation...");
    const receipt = await tx.wait();

    // Get proposal ID from event
    const event = receipt.logs.find((log) => {
      try {
        const parsed = governance.interface.parseLog(log);
        return parsed.name === "ProposalCreated";
      } catch {
        return false;
      }
    });

    const proposalId = event
      ? governance.interface.parseLog(event).args.proposalId
      : null;

    console.log("\n   ✅ GOVERNANCE PROPOSAL CREATED!");
    console.log(`   🆔 Proposal ID: ${proposalId}`);
    console.log(`   🔗 Transaction: ${receipt.hash}`);
    console.log(`   🧱 Block: ${receipt.blockNumber}`);
    console.log(`   💰 Gas Used: ${receipt.gasUsed.toLocaleString()}`);
    console.log("");
    console.log("   📅 NEXT STEPS:");
    console.log("   1. Wait for voting period to start");
    console.log("   2. Vote on the proposal (Option 20a)");
    console.log("   3. Execute proposal after voting ends (Option 20c)");
    console.log("");
    console.log(`   💡 Use "View Proposal ${proposalId}" to check status`);
  } catch (error) {
    console.log(`   ❌ Failed to create proposal: ${error.message}`);
  }
}

/** Helper: Direct update (owner only - for testing) */
async function directUpdateJurisdictionRule(mod) {
  try {
    console.log("\n⚠️  DIRECT UPDATE (OWNER ONLY)");
    console.log("   This bypasses governance and updates immediately");
    console.log("   Only use for testing purposes!");
    console.log("");

    // CRITICAL: Validate no conflicts before direct update
    console.log("🔍 PRE-UPDATE VALIDATION...");
    const conflicts = mod.validateJurisdictionLists();

    if (conflicts.length > 0) {
      console.log("\n❌ VALIDATION FAILED: CONFLICTS DETECTED!");
      console.log(
        "   The following jurisdictions are in BOTH allowed and disallowed lists:",
      );
      for (const code of conflicts) {
        console.log(`      ⚠️  ${code}`);
      }
      console.log("");
      console.log("   🚫 Cannot update with conflicting jurisdictions!");
      console.log(
        "   💡 Please resolve conflicts first using the management menu",
      );
      return;
    }

    console.log("   ✅ No conflicts detected");
    console.log("");

    const confirm = await mod.promptUser('   Type "CONFIRM" to proceed: ');
    if (confirm !== "CONFIRM") {
      console.log("   ❌ Direct update cancelled");
      return;
    }

    const complianceRules = mod.state.getContract("complianceRules");
    const token =
      mod.state.getContract("token") || mod.state.getContract("digitalToken");
    const owner = mod.state.signers[0];

    // Convert Sets to Arrays
    const allowedArray = Array.from(mod.state.allowedJurisdictions);
    const blockedArray = Array.from(mod.state.disallowedJurisdictions);

    console.log(`   📊 Allowed: ${allowedArray.length} jurisdictions`);
    console.log(`   📊 Blocked: ${blockedArray.length} jurisdictions`);

    // Call setJurisdictionRule (requires governance/owner)
    const tx = await complianceRules
      .connect(owner)
      .setJurisdictionRule(token.target, allowedArray, blockedArray);

    console.log(`   ⏳ Waiting for transaction confirmation...`);
    const receipt = await tx.wait();

    console.log(`   ✅ Jurisdiction rules updated on-chain!`);
    console.log(`   🔗 Transaction: ${receipt.hash}`);
    console.log(`   🧱 Block: ${receipt.blockNumber}`);
    console.log(`   💰 Gas Used: ${receipt.gasUsed.toLocaleString()}`);
  } catch (error) {
    console.log(`   ❌ Failed to update directly: ${error.message}`);
    console.log(`   💡 Tip: Make sure you have owner permissions`);
  }
}

module.exports = {
  manageJurisdictionLists,
  validateJurisdictionLists,
  loadJurisdictionListsFromContract,
  updateJurisdictionRuleOnChain,
  createJurisdictionProposal,
  directUpdateJurisdictionRule,
};
