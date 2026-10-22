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
const { missingWiring } = require("./DeployWiring");

/**
 * Option 1a: One-click deployment of the full stack, in dependency order.
 *
 * WHY A SEPARATE METHOD
 * ---------------------
 * `deployAllContracts()` (menu 1) deploys only the BASE layer: OnchainID
 * factory, issuers, ERC-3643 registries and the privacy pair. The token,
 * the oracles, the investor types and governance each live behind their
 * own menu option, and they depend on each other in an order the menu
 * does not state.
 *
 * THE ORDER, AND WHY (verified by running the menu, not inferred)
 * ---------------------------------------------------------------
 *   1. deployAllContracts       (menu 1)  OnchainID + registries ->
 *                                         `identityRegistry`, privacy pair
 *   2. deployDigitalTokenSystem (menu 21) -> `digitalToken`; deploys
 *                                         `complianceRules` itself if absent
 *   3. deployOracleSystem       (menu 31) -> `oracleManager`, list oracles,
 *                                         ConsensusOracle; binds the
 *                                         blacklist oracle to VSC (needs 21)
 *   4. investor type registry   (menu 51) -> `investorTypeRegistry`
 *   5. governance               (menu 74) REQUIRES identityRegistry AND
 *                                         complianceRules, and binds the
 *                                         OracleManager and the registry
 *                                         at construction: deployed last
 *
 * Step 3 is D57 (Task 4.16): governance binds boundTarget(2) to the
 * OracleManager it is constructed with, so a stack deployed without the
 * oracles could never govern or hand them over (83c refused). Step 2
 * deploys ComplianceRules on demand with DEFAULT_ALLOWED_COUNTRIES /
 * DEFAULT_BLOCKED_COUNTRIES (DeployDefaults.js); menu option 13 is not
 * used here because it prompts for country lists, and chaining it with
 * empty lists would leave the one-click path with no blocked jurisdiction.
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
  console.log("   3. Oracle system (manager, list oracles, consensus engine;");
  console.log("      the blacklist oracle gates VSC)");
  console.log("   4. Investor Type Registry");
  console.log("   5. Governance (bound to every contract above)");
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
      // D57: after the token (the blacklist binding needs it), before
      // governance (which binds the OracleManager at construction).
      name: "Oracle system",
      run: () => mod.deployOracleSystem(),
      expect: "oracleManager",
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

    // Verify by reading back, not by assuming the call worked: a step
    // that returns without registering its contract, or registers it with
    // a link missing on chain (review F-3), stops the deploy.
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
    const missing = await missingWiring(mod.state);
    if (missing.length) {
      displayError(
        `Step ${i + 1} (${step.name}): the deploy stopped; missing wiring: ${missing.join(", ")}`,
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
    console.log("   • Option 75a — mint VGT so they can pay vote fees");
    console.log(
      "   • Options 83c, 83d, 83e — the handover ceremony (deployer out,",
    );
    console.log("      governance accepts every contract by vote, verify)");
    console.log(
      "\n   ℹ️  83d needs at least 2 KYC/AML-verified signers holding VGT.",
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
