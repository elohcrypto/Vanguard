/**
 * @fileoverview Deploy options 1 and 1a: the core deploy and the one-click stack
 * @module DeployEverythingFlow
 * @description Runs the deploy steps in order and prints the deploy summary.
 * Moved out of demo/core/ContractDeployer.js (plan v2 Task 4.8). Each
 * function takes the module instance `mod` first (its state, promptUser,
 * logger and sibling methods) and runs the option's code unchanged.
 */

"use strict";

const { ethers } = require("hardhat");
const {
  displaySection,
  displaySuccess,
  displayError,
} = require("./DisplayHelpers");
const {
  DEFAULT_ALLOWED_COUNTRIES,
  DEFAULT_BLOCKED_COUNTRIES,
} = require("./DeployDefaults");

/**
 * Option 1a: One-click deployment of the full stack, in dependency order.
 *
 * WHY A SEPARATE METHOD
 * ---------------------
 * `deployAllContracts()` despite its name deploys only the BASE layer
 * (OnchainID factory, issuers, identity registry, oracles). The digital
 * token, compliance rules, investor types and governance each live behind
 * their own menu option, and they depend on each other in a specific order
 * that the menu does not state.
 *
 * THE ORDER, AND WHY (verified by running the menu, not inferred)
 * ---------------------------------------------------------------
 *   1. deployAllContracts       (menu 1)  OnchainID contracts + ERC-3643
 *                                         registries -> `identityRegistry`,
 *                                         privacy pair -> `privacyManager`
 *   2. deployDigitalTokenSystem (menu 21) -> `digitalToken`, and deploys
 *                                         `complianceRules` itself if absent
 *   3. investor type registry   (menu 51) -> `investorTypeRegistry`
 *   4. governance               (menu 74) REQUIRES identityRegistry AND
 *                                         complianceRules
 *                                         (GovernanceModule.js:80-85)
 *
 * The trap: `deployAllContracts` does NOT register `complianceRules` (that
 * happens in `deployComplianceRulesWithConfig`, line ~318). So `1` then `74`
 * fails with "Deploy ERC-3643 system first (option 21)". Step 2 satisfies it
 * — not because option 21 is magic, but because deployDigitalTokenSystem
 * deploys ComplianceRules on demand with DEFAULT_ALLOWED_COUNTRIES /
 * DEFAULT_BLOCKED_COUNTRIES (DeployDefaults.js).
 *
 * Menu option 13 is NOT required. It deploys the same contract but prompts
 * for country lists; chaining it here with empty lists would leave the
 * one-click path with no blocked jurisdictions at all — more permissive than
 * the normal menu route. Verified: `1 21 51 74` completes with zero errors.
 *
 * Every step below is prompt-free (verified), so this runs unattended.
 *
 * @param {Object} modules - The demo's module registry, for the steps that
 *   live outside ContractDeployer (investor types, governance).
 * @returns {Promise<boolean>} true if every step completed
 */
async function deployEverything(mod, modules) {
  displaySection("ONE-CLICK DEPLOY — FULL STACK", "🚀");

  console.log("\nDeploys the whole system in dependency order:");
  console.log("   1. Core contracts (OnchainID, issuers, ERC-3643 registries,");
  console.log("      ZKVerifierIntegrated + PrivacyManager)");
  console.log(
    "   2. ERC-3643 digital token — also deploys ComplianceRules and",
  );
  console.log("      wires the ZK allow list (mode OracleOnly: OFF)");
  console.log(
    `      whitelist: ${DEFAULT_ALLOWED_COUNTRIES.length} countries incl. Hong Kong (344)`,
  );
  console.log(
    `      blacklist: ${DEFAULT_BLOCKED_COUNTRIES.length} countries incl. Russia (643)`,
  );
  console.log("   3. Investor Type Registry");
  console.log("   4. Governance (nominates itself as registry owner)");
  console.log("");

  const steps = [
    {
      name: "Core contracts",
      run: () => mod.deployAllContracts(),
      expect: "identityRegistry",
    },
    {
      // deployDigitalTokenSystem already deploys ComplianceRules itself when
      // it is missing (see the "Step 1: Deploying ComplianceRules" branch
      // below), using the shared DEFAULT_* country lists. Do NOT deploy it
      // separately here: passing a different config would silently give the
      // one-click path a MORE PERMISSIVE compliance setup than menu option
      // 21, which is the wrong default for a compliance demo.
      name: "ERC-3643 token + ComplianceRules",
      run: () => mod.deployDigitalTokenSystem(),
      expect: "digitalToken",
    },
    {
      name: "Investor Type Registry",
      run: () => modules.investorType.deployInvestorTypeSystem(),
      expect: "investorTypeRegistry",
    },
    {
      name: "Governance system",
      run: () => modules.governance.deployGovernanceSystem(),
      expect: "vanguardGovernance",
    },
  ];

  const done = [];
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    console.log("\n" + "=".repeat(70));
    console.log(`STEP ${i + 1}/${steps.length}: ${step.name}`);
    console.log("=".repeat(70));

    try {
      await step.run();
    } catch (error) {
      displayError(`Step ${i + 1} (${step.name}) threw: ${error.message}`);
      mod._reportDeploySummary(done, steps, i);
      return false;
    }

    // Verify by reading state back, not by assuming the call worked: the
    // demo's modules catch their own errors and return normally, so a step
    // can "succeed" while registering nothing.
    const contract = mod.state.getContract(step.expect);
    if (!contract) {
      displayError(
        `Step ${i + 1} (${step.name}) did not register '${step.expect}' — stopping.`,
      );
      console.log(
        "   Later steps depend on it; continuing would fail confusingly.",
      );
      mod._reportDeploySummary(done, steps, i);
      return false;
    }
    done.push({ name: step.name, address: await contract.getAddress() });
  }

  mod._reportDeploySummary(done, steps, steps.length);
  return true;
}

/**
 * Print what deployed and what did not.
 * @private
 */
function _reportDeploySummary(mod, done, steps, reached) {
  console.log("\n" + "=".repeat(70));
  if (reached === steps.length) {
    displaySuccess("FULL STACK DEPLOYED");
  } else {
    displayError(`STOPPED AT STEP ${reached + 1} OF ${steps.length}`);
  }
  console.log("=".repeat(70));

  for (const d of done) {
    console.log(`   ✅ ${d.name.padEnd(26)} ${d.address}`);
    if (d.name === "Core contracts") {
      // The privacy pair deploys with the core layer (Task 3.6).
      for (const [label, key] of [
        ["KeyManager", "keyManager"],
        ["ZKVerifierIntegrated", "zkVerifierIntegrated"],
        ["PrivacyManager", "privacyManager"],
      ]) {
        const c = mod.state.getContract(key);
        if (c) console.log(`   ✅ ${label.padEnd(26)} ${c.target}`);
      }
    }
  }
  for (let i = done.length; i < steps.length; i++) {
    console.log(`   ⏭️  ${steps[i].name.padEnd(26)} not deployed`);
  }

  if (reached === steps.length) {
    console.log("\n💡 Next steps:");
    console.log("   • Option 23 or 24 — onboard users (creates OnchainIDs)");
    console.log(
      "   • Options 6 and 7 — KYC/AML claims for any still unverified",
    );
    console.log("   • Option 75 — distribute VGT so they can pay vote fees");
    console.log(
      "   • Option 83b — governance accepts registry ownership by vote",
    );
    console.log(
      "\n   ℹ️  83b needs at least 2 KYC/AML-verified signers holding VGT.",
    );
    console.log(
      "      A fresh deploy registers only the governance contract itself.",
    );
  }
}

/**
 * Deploy all contracts for the demo
 *
 * @returns {Promise<void>}
 *
 * @example
 * await deployer.deployAllContracts();
 */
async function deployAllContracts(mod) {
  displaySection("DEPLOYING ALL CONTRACTS", "🏗️");

  try {
    // Initialize logger with provider
    mod.logger.initialize(ethers.provider);

    // Deploy core OnchainID contracts
    await mod.deployOnchainIDContracts();

    // Deploy ERC-3643 registries
    await mod.deployERC3643Registries();

    // The privacy pair (plan v2 Task 3.6): option 21 wires it into
    // ComplianceRules for VSC, option 42 -> 1 uses it on the live token.
    await mod.deployPrivacyPair();

    displaySuccess("ALL CONTRACTS DEPLOYED SUCCESSFULLY!");

    // Display comprehensive deployment summary
    mod.logger.getDeploymentSummary();
  } catch (error) {
    displayError(`Contract deployment failed: ${error.message}`);
    throw error;
  }
}

module.exports = {
  deployEverything,
  _reportDeploySummary,
  deployAllContracts,
};
