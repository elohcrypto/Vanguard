/**
 * @fileoverview Privacy options 41-50: the menu entries
 * @module PrivacyOptionsFlow
 * @description Attach and status (41, 41b), the proof submenu (42), the chain views
 * behind 43-46, settings (47), statistics (48), the integration checks
 * (49) and the VSC wiring (50).
 * Moved out of demo/modules/PrivacyModule.js (plan v2 Task 4.8). Each
 * function takes the module instance `mod` first (its state, promptUser,
 * logger and sibling methods) and runs the option's code unchanged.
 */

const {
  displaySection,
  displaySuccess,
  displayError,
} = require("./DisplayHelpers");
const { attestationStatus } = require("./AttestationFlow");
const ContractDeployer = require("../core/ContractDeployer");
const {
  showVerifierStats,
  runIntegrationChecks,
  showTokenIntegration,
} = require("./PrivacyChainViews");
const settings = require("./PrivacySettingsFlow");

/**
 * Initialise the real proof generator (idempotent) and return it. Every
 * proof action calls this: since Task 3.6 option 1 deploys the verifier,
 * so a proof action can run before option 41 ever did.
 */
async function realGenerator(mod) {
  await mod.proofGenerator.initializeRealProofGenerator();
  return mod.state.realProofGenerator;
}

/**
 * Option 41: attach the privacy system. Option 1 deploys the pair
 * (ZKVerifierIntegrated with testingMode off, PrivacyManager on it) and
 * option 21 wires it into ComplianceRules for VSC; this uses that pair,
 * deploys the same real pair only when option 1 has not, wires it if VSC
 * exists, initialises the real proof generator and prints the wiring.
 * There is no mock mode: mocks live in test/ only (plan v2 Task 3.6).
 */
async function deployPrivacySystem(mod) {
  displaySection("ATTACH PRIVACY & ZK VERIFICATION SYSTEM", "🏗️");

  try {
    const had = !!mod.state.getContract("privacyManager");
    const deployer = new ContractDeployer(mod.state, mod.logger);
    const { zkVerifier, privacyManager } = await deployer.deployPrivacyPair();
    console.log(
      had
        ? "✅ Using the privacy pair option 1 deployed"
        : "✅ Option 1 had not deployed the privacy pair: deployed it now",
    );
    const zkAddr = await zkVerifier.getAddress();
    const pmAddr = await privacyManager.getAddress();
    console.log(`   🌍 ZKVerifierIntegrated: ${zkAddr}`);
    console.log(`      testingMode: ${await zkVerifier.testingMode()}`);
    console.log(`   🕵️ PrivacyManager:       ${pmAddr}`);
    console.log(
      `      verifier: ${await privacyManager.zkVerifier()}, root version ${await privacyManager.whitelistVersion()}`,
    );

    console.log("\n🔗 ComplianceRules wiring for VSC:");
    await deployer.wirePrivacyManager();

    try {
      await mod.realGenerator();
      console.log("✅ Real proof generator ready (PLONK, all five circuits)");
    } catch (error) {
      console.log(
        `   ⚠️  Real proof generator failed to initialise: ${error.message}`,
      );
    }
    console.log(
      "   ℹ️  Proofs need compiled circuits: run `npm run setup:zk` once (option 41b checks them)",
    );

    displaySuccess("PRIVACY & ZK VERIFICATION SYSTEM ATTACHED");
    console.log("\n🔐 ZK Proof Capabilities:");
    console.log(
      "   ✅ Whitelist Membership Proofs (bind a wallet on VSC, option 42 -> 1)",
    );
    console.log(
      "   ✅ Blacklist Non-Membership Proofs (Privacy-preserving, non-gating: D2; needs a binding from 42 -> 1)",
    );
    console.log(
      "   ✅ Jurisdiction / Accreditation / Compliance Aggregation Proofs: issuer-signed attestations (EdDSA), bound on PrivacyManager (option 42 -> 3, 4, 5)",
    );
  } catch (error) {
    displayError(`Privacy system attach failed: ${error.message}`);
  }
}

/** Option 41b: ZK status (real proofs only; folds the old 41c notes). */
async function viewZKModeStatus(mod) {
  displaySection("ZK STATUS", "📊");

  const zkVerifier = mod.state.getContract("zkVerifierIntegrated");
  const pm = mod.state.getContract("privacyManager");
  if (!zkVerifier) {
    displayError("No ZK verifier: run option 1 (or 41)");
    return;
  }
  console.log(`\n🌍 ZKVerifierIntegrated: ${await zkVerifier.getAddress()}`);
  console.log(
    `   testingMode: ${await zkVerifier.testingMode()} (immutable; the demo never deploys true)`,
  );
  console.log(
    `   proof cache expiry: ${await zkVerifier.proofCacheExpiry()} s (a repeated proof is served from the cache)`,
  );
  if (pm) {
    console.log(`🕵️ PrivacyManager: ${await pm.getAddress()}`);
    console.log(
      `   whitelist root version ${await pm.whitelistVersion()}, list operator ${await pm.listOperator()}`,
    );
  }

  // Circuits built by `npm run setup:zk`: wasm, zkey and vkey each.
  const { RealProofGenerator } = require("../../scripts/generate-real-proofs");
  const files = new RealProofGenerator();
  console.log("\n🔐 Circuits (build/circuits):");
  for (const [name, system] of [
    ["whitelist_membership", "PLONK"],
    ["blacklist_membership", "PLONK"],
    ["jurisdiction_proof", "PLONK"],
    ["accreditation_proof", "PLONK"],
    ["compliance_aggregation", "PLONK"],
  ]) {
    const ok = files.verifyCircuitFiles(name);
    console.log(
      `   ${ok ? "✅" : "❌"} ${name} (${system})${ok ? "" : ": run npm run setup:zk"}`,
    );
  }
  console.log(
    `\n⚙️  Proof generator: ${mod.state.realProofGenerator ? "ready" : "not initialised (option 41, or the first proof action, does it)"}`,
  );
  console.log(
    "   Batch verification: verifyBatchWhitelistMembership / verifyBatchProofs on the verifier",
  );

  if (mod.state.proofGenerationTimes.size > 0) {
    console.log("\n📈 Proof Generation Statistics:");
    for (const [proofType, time] of mod.state.proofGenerationTimes.entries()) {
      console.log(`   • ${proofType}: ${time}ms`);
    }
  }

  if (mod.state.gasTracker.size > 0) {
    console.log("\n💰 Gas Cost Statistics:");
    let totalGas = 0n;
    for (const [proofType, gas] of mod.state.gasTracker.entries()) {
      console.log(`   • ${proofType}: ${gas.toLocaleString()} gas`);
      totalGas += gas;
    }
    console.log(`   • Total: ${totalGas.toLocaleString()} gas`);
  }
}

/** Option 42: Submit Private Compliance Proofs */
async function submitPrivateProofs(mod) {
  displaySection("SUBMIT PRIVATE COMPLIANCE PROOFS", "🔒");

  const zkVerifier = mod.state.getContract("zkVerifier");
  if (!zkVerifier) {
    displayError("No ZK verifier: run option 1 (or 41)");
    return;
  }

  console.log("\n🎯 PRIVATE PROOF SUBMISSION OPTIONS:");
  console.log("1. Submit Whitelist Membership Proof");
  console.log("2. Submit Blacklist Non-Membership Proof");
  console.log("3. Submit Jurisdiction Eligibility Proof");
  console.log("4. Submit Accreditation Status Proof");
  console.log("5. Submit Compliance Aggregation Proof");
  console.log("6. Submit All Proofs (Batch)");
  console.log("");
  console.log("🌍 JURISDICTION MANAGEMENT:");
  console.log("7. Manage Jurisdiction Lists (Add/Remove Allowed/Disallowed)");
  console.log("");
  console.log("0. Back to Main Menu");

  const choice = await mod.promptUser("Select option (0-7): ");

  try {
    switch (choice) {
      case "1":
        await mod.submitWhitelistMembershipProof();
        break;
      case "2":
        await mod.submitBlacklistNonMembershipProof();
        break;
      case "3":
        await mod.submitJurisdictionEligibilityProof();
        break;
      case "4":
        await mod.submitAccreditationStatusProof();
        break;
      case "5":
        await mod.submitComplianceAggregationProof();
        break;
      case "6":
        await mod.submitAllPrivateProofs();
        break;
      case "7":
        await mod.manageJurisdictionLists();
        break;
      case "0":
        return;
      default:
        displayError("Invalid choice");
    }
  } catch (error) {
    displayError(`Private proof submission failed: ${error.message}`);
  }
}

/**
 * Option 43: whitelist status as ComplianceRules reads it. Since Task 3.3
 * PrivacyManager calls the verifier, so ProofVerified names PrivacyManager,
 * never the wallet; the truth is the wallet's binding on PrivacyManager
 * (version, nullifier, expiresAt) against the current root version.
 */
async function verifyWhitelistMembership(mod) {
  displaySection("VERIFY PRIVATE WHITELIST MEMBERSHIP", "🕵️");

  const pm = mod.state.getContract("privacyManager");
  if (!pm) {
    displayError("No PrivacyManager: run option 1 (or 41)");
    return;
  }

  try {
    const current = await pm.whitelistVersion();
    console.log(`🔍 PrivacyManager: ${await pm.getAddress()}`);
    console.log(`   📜 Current whitelist root version: ${current}`);
    let found = 0;
    for (const [i, s] of mod.state.signers.entries()) {
      const b = await pm.whitelistBindings(s.address);
      if (b.version === 0n) continue;
      found++;
      const valid = await pm.hasValidWhitelistProof(s.address);
      const why = valid
        ? "valid"
        : b.version !== current
          ? `lapsed: bound under version ${b.version}, the root was rotated since`
          : "expired";
      console.log(
        `\n   ${valid ? "✅" : "❌"} wallet ${i} ${s.address}: ${why}`,
      );
      console.log(`      🔢 nullifier ${b.nullifier}`);
      console.log(
        `      ⏳ expires ${new Date(Number(b.expiresAt) * 1000).toISOString()} (root version ${b.version})`,
      );
    }
    if (found === 0) {
      displayError("NO WALLET HAS A WHITELIST BINDING");
      console.log("   💡 Prove and bind a wallet first (option 42 -> 1)");
    } else {
      console.log(
        "\n🕵️ Only the binding is public: no identity, secret or list position",
      );
    }
  } catch (error) {
    displayError(`Private whitelist verification failed: ${error.message}`);
  }
}

/**
 * Options 44 and 45: the attestation records on PrivacyManager for every
 * demo wallet, with the validator's answer (Task 3.7b). PrivacyManager,
 * not the wallet, calls the verifier, so the verifier's events cannot say
 * who holds a valid proof (R-3R-27): the records and validators can.
 */
async function attestationView(mod, circuit, title, emoji, option) {
  displaySection(title, emoji);
  try {
    const rows = await attestationStatus({ state: mod.state, circuit });
    if (rows.some((r) => r.valid)) {
      displaySuccess(
        `${rows.filter((r) => r.valid).length} WALLET(S) HOLD A VALID ${circuit.toUpperCase()} ATTESTATION`,
      );
      console.log(
        "   🕵️ Only the record is public: no attribute, salt or signature",
      );
    } else {
      displayError(`NO VALID ${circuit.toUpperCase()} ATTESTATION`);
      console.log(`   💡 Sign, prove and bind one first (option ${option})`);
    }
  } catch (error) {
    displayError(`${title} failed: ${error.message}`);
  }
}

/** Option 44: Verify Private Jurisdiction Eligibility */
async function verifyJurisdiction(mod) {
  await mod.attestationView(
    "jurisdiction",
    "VERIFY PRIVATE JURISDICTION ELIGIBILITY",
    "🌍",
    "42 -> 3",
  );
}

/** Option 45: Verify Private Accreditation Status */
async function verifyAccreditation(mod) {
  await mod.attestationView(
    "accreditation",
    "VERIFY PRIVATE ACCREDITATION STATUS",
    "💰",
    "42 -> 4",
  );
}

/**
 * Option 46: Privacy-Preserving Compliance Validation, read from
 * PrivacyManager.validateAllPrivateCompliance for every demo wallet with
 * any status: the whitelist binding and the three attestation records
 * (each under the user's preference flags).
 */
async function privacyPreservingValidation(mod) {
  displaySection("PRIVACY-PRESERVING COMPLIANCE VALIDATION", "📊");

  const pm = mod.state.getContract("privacyManager");
  if (!pm) {
    displayError("No PrivacyManager: run option 1 (or 41)");
    return;
  }

  try {
    console.log(
      "🔍 PrivacyManager.validateAllPrivateCompliance per wallet (whitelist, jurisdiction, accreditation, compliance):\n",
    );
    const mark = (b) => (b ? "✅" : "❌");
    let shown = 0;
    let full = 0;
    for (const [i, s] of mod.state.signers.entries()) {
      const [w, j, a, c] = await pm.validateAllPrivateCompliance(s.address);
      if (!(w || j || a || c)) continue;
      shown++;
      if (w && j && a && c) full++;
      console.log(
        `   wallet ${i} ${s.address}: whitelist ${mark(w)} jurisdiction ${mark(j)} accreditation ${mark(a)} compliance ${mark(c)}`,
      );
    }
    console.log("");
    if (shown === 0) {
      displayError("NO WALLET HOLDS ANY PRIVATE COMPLIANCE STATUS");
      console.log(
        "   💡 Bind a whitelist proof (42 -> 1) and attestations (42 -> 3, 4, 5)",
      );
    } else if (full > 0) {
      const rules = mod.state.getContract("complianceRules");
      const vsc = mod.state.getContract("digitalToken");
      const mode =
        rules && vsc
          ? ["OracleOnly", "ZkOnly", "Either"][
              Number(await rules.whitelistMode(await vsc.getAddress()))
            ]
          : "no VSC";
      displaySuccess(
        `${full} WALLET(S) HOLD ALL FOUR PRIVATE RECORDS (validateAllPrivateCompliance); VSC transfers read only the whitelist binding, and only in ZkOnly/Either (now ${mode})`,
      );
      console.log("   🔒 Identities and attributes remain private");
    } else {
      displayError("NO WALLET HOLDS ALL FOUR PRIVATE RECORDS");
      console.log("   💡 Complete the missing ones (option 42)");
    }
  } catch (error) {
    displayError(`Privacy-preserving validation failed: ${error.message}`);
  }
}

/** Option 47: privacy settings, read and set on chain (PrivacySettingsFlow.js) */
async function managePrivacySettings(mod) {
  displaySection("MANAGE PRIVACY SETTINGS", "⚙️");

  console.log("\n🔐 PRIVACY SETTINGS OPTIONS:");
  console.log("1. View Current Privacy Settings");
  console.log("2. Set Proof Cache Expiry (verifier owner)");
  console.log("3. Set Binding Validity Period (PrivacyManager owner)");
  console.log("4. View Nullifier Records");
  console.log("5. Set a Wallet's Privacy Preferences (the wallet signs)");
  console.log("0. Back to Main Menu");

  const choice = await mod.promptUser("Select option (0-5): ");
  const ask = mod.promptUser;
  try {
    switch (choice) {
      case "1":
        return await settings.viewSettings(mod.state);
      case "2":
        return await settings.setCacheExpiry(mod.state, ask);
      case "3":
        return await settings.setValidity(mod.state, ask);
      case "4":
        return await settings.showNullifiers(mod.state);
      case "5":
        return await settings.setPreferences(mod.state, ask);
      case "0":
        return;
      default:
        displayError("Invalid choice");
    }
  } catch (error) {
    displayError(`Privacy settings failed: ${error.message}`);
  }
}

/** Option 48: verifier counters and wiring, read from chain */
async function showStatistics(mod) {
  displaySection("ZK STATISTICS & ANALYTICS DASHBOARD", "📊");
  try {
    await showVerifierStats(mod.state);
  } catch (error) {
    displayError(`Failed to fetch ZK statistics: ${error.message}`);
  }
}

/** Option 49: eight privacy integration checks read from chain */
async function testIntegration(mod) {
  displaySection("TEST COMPLETE PRIVACY INTEGRATION", "🧪");
  try {
    return await runIntegrationChecks(mod.state);
  } catch (error) {
    displayError(`Privacy integration test failed: ${error.message}`);
  }
}

/** Option 50: wire VSC's ComplianceRules to PrivacyManager; report it */
async function integrateWithToken(mod) {
  displaySection("INTEGRATE PRIVACY WITH VANGUARD STABLECOIN", "🔗");
  try {
    return await showTokenIntegration(
      mod.state,
      new ContractDeployer(mod.state, mod.logger),
    );
  } catch (error) {
    displayError(`Privacy integration failed: ${error.message}`);
  }
}

module.exports = {
  realGenerator,
  deployPrivacySystem,
  viewZKModeStatus,
  submitPrivateProofs,
  verifyWhitelistMembership,
  attestationView,
  verifyJurisdiction,
  verifyAccreditation,
  privacyPreservingValidation,
  managePrivacySettings,
  showStatistics,
  testIntegration,
  integrateWithToken,
};
