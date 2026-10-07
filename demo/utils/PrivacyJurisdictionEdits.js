/**
 * @fileoverview Privacy jurisdiction lists: view, add, remove, reset
 * @module PrivacyJurisdictionEdits
 * @description Edits to the allowed and disallowed jurisdiction lists.
 * Moved out of demo/modules/PrivacyModule.js (plan v2 Task 4.8). Each
 * function takes the module instance `mod` first (its state, promptUser,
 * logger and sibling methods) and runs the option's code unchanged.
 */

"use strict";

const { displaySuccess } = require("./DisplayHelpers");

async function viewJurisdictionLists(mod) {
  console.log("\n📋 CURRENT JURISDICTION LISTS (ON-CHAIN)");
  console.log("=".repeat(60));

  // Define jurisdiction names mapping (used for both allowed and disallowed)
  const jurisdictionNames = {
    840: "United States",
    826: "United Kingdom",
    276: "Germany (EU)",
    124: "Canada",
    392: "Japan",
    156: "China",
    356: "India",
    "036": "Australia",
    702: "Singapore",
    756: "Switzerland",
    760: "Syria",
  };

  console.log("\n✅ ALLOWED JURISDICTIONS:");
  if (mod.state.allowedJurisdictions.size === 0) {
    console.log("   (empty)");
  } else {
    for (const code of mod.state.allowedJurisdictions) {
      const name = jurisdictionNames[code.toString()] || "Unknown";
      console.log(`   • ${code} - ${name}`);
    }
  }

  console.log("\n🚫 DISALLOWED JURISDICTIONS:");
  if (mod.state.disallowedJurisdictions.size === 0) {
    console.log("   (empty)");
  } else {
    for (const code of mod.state.disallowedJurisdictions) {
      const name = jurisdictionNames[code.toString()] || "Unknown";
      console.log(`   • ${code} - ${name}`);
    }
  }

  console.log("\n📊 STATISTICS:");
  console.log(`   Total Allowed: ${mod.state.allowedJurisdictions.size}`);
  console.log(`   Total Disallowed: ${mod.state.disallowedJurisdictions.size}`);
}

async function addToAllowedJurisdictions(mod) {
  console.log("\n➕ ADD TO ALLOWED JURISDICTIONS");
  console.log("-".repeat(40));
  console.log("Common ISO 3166-1 Numeric Codes:");
  console.log("  840 = United States");
  console.log("  826 = United Kingdom");
  console.log("  276 = Germany (EU)");
  console.log("  124 = Canada");
  console.log("  392 = Japan");
  console.log("  156 = China");
  console.log("  356 = India");
  console.log("  036 = Australia");
  console.log("  702 = Singapore");
  console.log("  756 = Switzerland");
  console.log("");

  const input = await mod.promptUser(
    "Enter jurisdiction codes (comma-separated): ",
  );
  if (!input.trim()) {
    console.log("❌ No codes entered");
    return;
  }

  const codes = input.split(",").map((c) => BigInt(c.trim()));
  let added = 0;
  let skipped = 0;
  let conflicts = [];

  // First pass: Check for conflicts
  for (const code of codes) {
    if (mod.state.disallowedJurisdictions.has(code)) {
      conflicts.push(code);
    }
  }

  // If conflicts found, ask for confirmation
  if (conflicts.length > 0) {
    console.log("\n⚠️  CONFLICT DETECTED!");
    console.log(
      "The following jurisdictions are currently in the DISALLOWED list:",
    );
    for (const code of conflicts) {
      console.log(`   🚫 ${code}`);
    }
    console.log("");
    console.log(
      "To add them to ALLOWED list, they must first be removed from DISALLOWED list.",
    );
    console.log("");
    console.log("Options:");
    console.log("1. Automatically remove from disallowed and add to allowed");
    console.log("2. Cancel operation");

    const choice = await mod.promptUser("\nSelect option (1-2): ");

    if (choice !== "1") {
      console.log("❌ Operation cancelled");
      return;
    }

    console.log("\n🔄 Resolving conflicts...");
    for (const code of conflicts) {
      mod.state.disallowedJurisdictions.delete(code);
      console.log(`   ✅ Removed ${code} from disallowed list`);
    }
  }

  // Second pass: Add to allowed list
  console.log("\n➕ Adding to allowed list...");
  for (const code of codes) {
    if (mod.state.allowedJurisdictions.has(code)) {
      console.log(`   ⚠️  ${code} already in allowed list`);
      skipped++;
    } else {
      mod.state.allowedJurisdictions.add(code);
      console.log(`   ✅ Added ${code} to allowed list`);
      added++;
    }
  }

  console.log(
    `\n📊 Summary: ${added} added, ${skipped} skipped, ${conflicts.length} conflicts resolved`,
  );
  console.log(
    `   Total allowed jurisdictions: ${mod.state.allowedJurisdictions.size}`,
  );
  console.log(
    `   Total disallowed jurisdictions: ${mod.state.disallowedJurisdictions.size}`,
  );

  // Update on-chain if changes were made
  if (added > 0 || conflicts.length > 0) {
    const token =
      mod.state.getContract("token") || mod.state.getContract("digitalToken");
    const complianceRules = mod.state.getContract("complianceRules");

    if (token && complianceRules) {
      await mod.updateJurisdictionRuleOnChain();
    } else {
      console.log(
        "\n   ℹ️  Changes saved locally (contracts not deployed yet)",
      );
      console.log("   💡 Deploy token and compliance rules to save on-chain");
    }
  }
}

async function removeFromAllowedJurisdictions(mod) {
  console.log("\n➖ REMOVE FROM ALLOWED JURISDICTIONS");
  console.log("-".repeat(40));

  if (mod.state.allowedJurisdictions.size === 0) {
    console.log("❌ Allowed list is empty");
    return;
  }

  console.log("Current allowed jurisdictions:");
  for (const code of mod.state.allowedJurisdictions) {
    console.log(`   • ${code}`);
  }

  const input = await mod.promptUser(
    "\nEnter jurisdiction codes to remove (comma-separated): ",
  );
  if (!input.trim()) {
    console.log("❌ No codes entered");
    return;
  }

  const codes = input.split(",").map((c) => BigInt(c.trim()));
  let removed = 0;
  let notFound = 0;

  for (const code of codes) {
    if (mod.state.allowedJurisdictions.has(code)) {
      mod.state.allowedJurisdictions.delete(code);
      console.log(`   ✅ Removed ${code} from allowed list`);
      removed++;
    } else {
      console.log(`   ⚠️  ${code} not found in allowed list`);
      notFound++;
    }
  }

  console.log(`\n📊 Summary: ${removed} removed, ${notFound} not found`);
  console.log(
    `   Total allowed jurisdictions: ${mod.state.allowedJurisdictions.size}`,
  );

  // Update on-chain if changes were made
  if (removed > 0) {
    const token =
      mod.state.getContract("token") || mod.state.getContract("digitalToken");
    const complianceRules = mod.state.getContract("complianceRules");

    if (token && complianceRules) {
      await mod.updateJurisdictionRuleOnChain();
    } else {
      console.log(
        "\n   ℹ️  Changes saved locally (contracts not deployed yet)",
      );
    }
  }
}

async function addToDisallowedJurisdictions(mod) {
  console.log("\n➕ ADD TO DISALLOWED JURISDICTIONS");
  console.log("-".repeat(40));
  console.log(
    "⚠️  WARNING: Disallowing a jurisdiction will prevent proof generation!",
  );
  console.log("");

  const input = await mod.promptUser(
    "Enter jurisdiction codes to disallow (comma-separated): ",
  );
  if (!input.trim()) {
    console.log("❌ No codes entered");
    return;
  }

  const codes = input.split(",").map((c) => BigInt(c.trim()));
  let added = 0;
  let skipped = 0;
  let conflicts = [];

  // First pass: Check for conflicts
  for (const code of codes) {
    if (mod.state.allowedJurisdictions.has(code)) {
      conflicts.push(code);
    }
  }

  // If conflicts found, ask for confirmation
  if (conflicts.length > 0) {
    console.log("\n⚠️  CONFLICT DETECTED!");
    console.log(
      "The following jurisdictions are currently in the ALLOWED list:",
    );
    for (const code of conflicts) {
      console.log(`   ✅ ${code}`);
    }
    console.log("");
    console.log("⚠️  IMPORTANT: Adding these to DISALLOWED will:");
    console.log("   • Remove them from ALLOWED list");
    console.log("   • Block all proof generation for these jurisdictions");
    console.log(
      "   • Prevent users from these jurisdictions from participating",
    );
    console.log("");
    console.log("Options:");
    console.log("1. Automatically remove from allowed and add to disallowed");
    console.log("2. Cancel operation");

    const choice = await mod.promptUser("\nSelect option (1-2): ");

    if (choice !== "1") {
      console.log("❌ Operation cancelled");
      return;
    }

    // Double confirmation for critical action
    console.log("\n🚨 FINAL CONFIRMATION");
    console.log(
      `You are about to DISALLOW ${conflicts.length} jurisdiction(s).`,
    );
    console.log("This will block proof generation for these jurisdictions.");

    const finalConfirm = await mod.promptUser('Type "CONFIRM" to proceed: ');
    if (finalConfirm !== "CONFIRM") {
      console.log("❌ Operation cancelled");
      return;
    }

    console.log("\n🔄 Resolving conflicts...");
    for (const code of conflicts) {
      mod.state.allowedJurisdictions.delete(code);
      console.log(`   ✅ Removed ${code} from allowed list`);
    }
  }

  // Second pass: Add to disallowed list
  console.log("\n🚫 Adding to disallowed list...");
  for (const code of codes) {
    if (mod.state.disallowedJurisdictions.has(code)) {
      console.log(`   ⚠️  ${code} already in disallowed list`);
      skipped++;
    } else {
      mod.state.disallowedJurisdictions.add(code);
      console.log(`   ✅ Added ${code} to disallowed list`);
      added++;
    }
  }

  console.log(
    `\n📊 Summary: ${added} added, ${skipped} skipped, ${conflicts.length} conflicts resolved`,
  );
  console.log(
    `   Total allowed jurisdictions: ${mod.state.allowedJurisdictions.size}`,
  );
  console.log(
    `   Total disallowed jurisdictions: ${mod.state.disallowedJurisdictions.size}`,
  );

  if (added > 0) {
    console.log(
      "\n⚠️  Users from disallowed jurisdictions will be blocked from generating proofs!",
    );
  }

  // Update on-chain if changes were made
  if (added > 0 || conflicts.length > 0) {
    const token =
      mod.state.getContract("token") || mod.state.getContract("digitalToken");
    const complianceRules = mod.state.getContract("complianceRules");

    if (token && complianceRules) {
      await mod.updateJurisdictionRuleOnChain();
    } else {
      console.log(
        "\n   ℹ️  Changes saved locally (contracts not deployed yet)",
      );
    }
  }
}

async function removeFromDisallowedJurisdictions(mod) {
  console.log("\n➖ REMOVE FROM DISALLOWED JURISDICTIONS");
  console.log("-".repeat(40));

  if (mod.state.disallowedJurisdictions.size === 0) {
    console.log("❌ Disallowed list is empty");
    return;
  }

  console.log("Current disallowed jurisdictions:");
  for (const code of mod.state.disallowedJurisdictions) {
    console.log(`   • ${code}`);
  }

  const input = await mod.promptUser(
    "\nEnter jurisdiction codes to remove (comma-separated): ",
  );
  if (!input.trim()) {
    console.log("❌ No codes entered");
    return;
  }

  const codes = input.split(",").map((c) => BigInt(c.trim()));
  let removed = 0;
  let notFound = 0;

  for (const code of codes) {
    if (mod.state.disallowedJurisdictions.has(code)) {
      mod.state.disallowedJurisdictions.delete(code);
      console.log(`   ✅ Removed ${code} from disallowed list`);
      removed++;
    } else {
      console.log(`   ⚠️  ${code} not found in disallowed list`);
      notFound++;
    }
  }

  console.log(`\n📊 Summary: ${removed} removed, ${notFound} not found`);
  console.log(
    `   Total disallowed jurisdictions: ${mod.state.disallowedJurisdictions.size}`,
  );

  // Update on-chain if changes were made
  if (removed > 0) {
    const token =
      mod.state.getContract("token") || mod.state.getContract("digitalToken");
    const complianceRules = mod.state.getContract("complianceRules");

    if (token && complianceRules) {
      await mod.updateJurisdictionRuleOnChain();
    } else {
      console.log(
        "\n   ℹ️  Changes saved locally (contracts not deployed yet)",
      );
    }
  }
}

async function resetJurisdictionLists(mod) {
  console.log("\n🔄 RESET JURISDICTION LISTS");
  console.log("-".repeat(40));
  console.log("This will reset to default configuration:");
  console.log("  Allowed: US (840), UK (826), Germany (276), Canada (124)");
  console.log("  Disallowed: (empty)");
  console.log("");

  const confirm = await mod.promptUser("Confirm reset? (yes/no): ");
  if (confirm.toLowerCase() !== "yes") {
    console.log("❌ Reset cancelled");
    return;
  }

  mod.state.allowedJurisdictions = new Set([
    BigInt(840),
    BigInt(826),
    BigInt(276),
    BigInt(124),
  ]);
  mod.state.disallowedJurisdictions = new Set();

  console.log(
    "   📝 Local lists set to the defaults (840, 826, 276, 124; none",
  );
  console.log("      disallowed); the chain is read back after the update.");
  console.log("");

  // Check if contracts are deployed before trying to update on-chain
  const token =
    mod.state.getContract("token") || mod.state.getContract("digitalToken");
  const complianceRules = mod.state.getContract("complianceRules");

  if (token && complianceRules) {
    console.log("   📝 Contracts detected - updating on-chain...");
    await mod.updateJurisdictionRuleOnChain();
    // The verdict is what VSC's rule holds now, not the local lists: a
    // proposal (option 1 above) changes it only once it passes.
    const [, allowed, blocked] = await complianceRules.getJurisdictionRule(
      token.target,
    );
    const want = ["124", "276", "826", "840"];
    const got = allowed.map((c) => c.toString()).sort();
    console.log(
      `   Chain (getJurisdictionRule): allowed [${allowed.join(", ")}], disallowed [${blocked.join(", ")}]`,
    );
    if (got.join() === want.join() && blocked.length === 0) {
      displaySuccess("JURISDICTION LISTS RESET TO DEFAULTS (chain)");
    } else {
      console.log(
        "   ℹ️  VSC's rule is not the defaults yet (update skipped, refused, or a proposal pending)",
      );
    }
  } else {
    console.log("   ℹ️  Changes saved locally (contracts not deployed yet)");
    console.log("   💡 Deploy token and compliance rules to save on-chain:");
    console.log(
      "      • Option 21: Deploy the ERC-3643 system (VSC + ComplianceRules)",
    );
  }
}

module.exports = {
  viewJurisdictionLists,
  addToAllowedJurisdictions,
  removeFromAllowedJurisdictions,
  addToDisallowedJurisdictions,
  removeFromDisallowedJurisdictions,
  resetJurisdictionLists,
};
