/**
 * @fileoverview Privacy option 42 sub-options 1-6: submit the proofs
 * @module PrivacyProofFlow
 * @description Whitelist membership, blacklist non-membership and the three
 * attestation proofs (jurisdiction, accreditation, compliance), one by
 * one or all together.
 * Moved out of demo/modules/PrivacyModule.js (plan v2 Task 4.8). Each
 * function takes the module instance `mod` first (its state, promptUser,
 * logger and sibling methods) and runs the option's code unchanged.
 */

"use strict";

const { displaySuccess, displayError } = require("./DisplayHelpers");
const {
  demoIdentity,
  demoWhitelist,
  proveForDemoUser,
  publishAndBind,
} = require("./WhitelistBinderFlow");
const { runLiveWhitelistFlow } = require("./WhitelistLiveFlow");
const { runBlacklistProofFlow } = require("./BlacklistProofFlow");
const { runAttestationFlow } = require("./AttestationFlow");
const { runAllProofs } = require("./PrivacyBatchFlow");

// ==================== HELPER METHODS ====================
async function submitWhitelistMembershipProof(mod) {
  console.log("\n📋 SUBMIT WHITELIST MEMBERSHIP PROOF");
  console.log("-".repeat(40));
  console.log(
    "🎯 Anonymous compliance verification with a real PLONK proof, bound to the wallet on VSC",
  );

  const privacyManager = mod.state.getContract("privacyManager");
  if (!privacyManager) {
    displayError("No PrivacyManager: run option 1 (or 41) first");
    return;
  }

  try {
    await mod.realGenerator();
    console.log("\n🔐 Generating a real whitelist proof (PLONK)...");

    let proof; // PLONK: 24 words
    let publicSignals; // [nullifier, merkleRoot, walletBinding]
    let finalNullifierHash;
    let generationTime = 0;

    // The wallet that proves and submits; the binding names it.
    let proofUser = mod.state.signers[0];

    // Ask user for security mode
    console.log("\n🛡️  SECURITY MODE OPTIONS:");
    console.log("1. Demo mode (simplified - lists demo wallets 0-2)");
    console.log("2. Custom input mode (choose the listed wallets)");
    console.log(
      "3. Secure mode (prover wallet 1; its identity and KYC/AML read from chain)",
    );
    const securityChoice = await mod.promptUser("Select option (1-3): ");

    // D30 onboarding: every listed user hands the operator the commitment
    // Poseidon(identity, secret) of its own identity (its OnchainID
    // address) and its own secret (DemoState.zkSecrets); nobody else
    // learns the secret. The root and the proof come from the same
    // library functions as scripts/zk/build-whitelist-root.js and
    // scripts/zk/prove-whitelist.js.
    const signers = mod.state.signers;
    // Blank input keeps the default list ([]); an empty, non-numeric or
    // unknown entry refuses the whole list (null), never wallet 0.
    const pickWallets = async (question) => {
      const input = (await mod.promptUser(question)).trim();
      if (!input) return [];
      const parts = input.split(",").map((x) => x.trim());
      const bad = parts.find((x) => !/^\d+$/.test(x) || !signers[Number(x)]);
      if (bad !== undefined) {
        console.log(
          `❌ "${bad}" is not a wallet index (0-${signers.length - 1}); proof generation cancelled.`,
        );
        return null;
      }
      return [...new Set(parts.map(Number))].map((i) => signers[i]);
    };
    let listed = signers.slice(0, 3);

    if (securityChoice === "3") {
      // Secure mode: the checks below are chain reads, printed as read.
      console.log("\n🛡️  SECURE MODE: identity and KYC/AML read from chain");
      console.log("=".repeat(60));
      proofUser = signers[1] || signers[0];
      console.log(`   📍 Prover: ${proofUser.address} (wallet 1)`);
      const { identity, onchainID } = await demoIdentity(
        mod.state,
        proofUser.address,
      );
      console.log(
        onchainID
          ? `   ✅ 1. IdentityRegistry.identity: OnchainID ${onchainID}`
          : "   ⚠️  1. IdentityRegistry.identity: none; the wallet address is a simulated identity",
      );
      console.log(`      🔢 Identity (field element): ${identity}`);
      const idReg = mod.state.getContract("identityRegistry");
      const verified = idReg
        ? await idReg.isVerified(proofUser.address)
        : false;
      console.log(
        `   ${verified ? "✅" : "⚠️ "} 2. IdentityRegistry.isVerified: ${verified}${verified ? "" : " (VSC refuses this wallet whatever its binding)"}`,
      );
      console.log(
        "   ℹ️  3. Nullifier: PrivacyManager.nullifierWallet records it at submission (printed below)",
      );

      // Setup whitelist
      console.log("\n📋 Setting up whitelist...");
      const whitelistChoice = await mod.promptUser(
        "Use default whitelist? (yes/no): ",
      );
      if (whitelistChoice.toLowerCase() !== "yes" && whitelistChoice.trim()) {
        const picked = await pickWallets(
          "Enter the listed wallet indices (comma-separated, e.g., 0,1,2): ",
        );
        if (picked === null) return;
        if (picked.length) listed = picked;
      }
      if (!listed.includes(proofUser)) {
        console.log(`   ⚠️  Adding your identity to whitelist...`);
        listed.push(proofUser);
      }

      console.log(
        onchainID && verified
          ? "\n✅ Identity and KYC/AML hold on chain for the prover"
          : "\n⚠️  Not every check holds: the proof still binds, VSC refuses an unverified wallet",
      );
    } else if (securityChoice === "2") {
      // Custom input mode
      console.log("\n📋 CUSTOM INPUT MODE");
      console.log(
        "Choose which demo wallets the operator lists; each one is onboarded with its own identity and secret.",
      );
      console.log(
        "Note: the prover is the first listed wallet that is KYC/AML verified.\n",
      );
      const custom = await pickWallets(
        "Enter the listed wallet indices (comma-separated, e.g., 0,1,2): ",
      );
      if (custom === null) return;
      if (custom.length) listed = custom;
    } else {
      console.log("\n📊 Using demo values: wallets 0-2 are listed");
    }

    if (securityChoice !== "3") {
      // VSC refuses an unverified wallet whatever its binding, so the
      // prover (the live flow's sender) is the first verified listed one.
      const idReg = mod.state.getContract("identityRegistry");
      let pick = null;
      for (const w of listed) {
        if (idReg && (await idReg.isVerified(w.address))) {
          pick = w;
          break;
        }
      }
      proofUser = pick || listed[0];
      console.log(
        pick
          ? `   👤 Prover: ${pick.address}, the first listed wallet that is KYC/AML verified`
          : `   ⚠️  No listed wallet is KYC/AML verified: ${proofUser.address} proves and binds, but VSC refuses it until it is onboarded (options 23/24, or 3, 6 and 7), or use security mode 3`,
      );
    }

    const { users, rootFile } = await demoWhitelist(mod.state, listed);
    console.log("\n📊 PROOF PARAMETERS:");
    console.log(`   👤 Prover wallet: ${proofUser.address}`);
    for (const u of users) {
      console.log(
        `   📋 ${u.wallet}: identity ${u.onchainID || `${u.wallet} (simulated)`}`,
      );
    }
    console.log(
      `   🔏 Whitelist tree: ${rootFile.count} commitments Poseidon(identity, secret), root ${rootFile.root.slice(0, 18)}…`,
    );

    const startTime = Date.now();
    // Refuses before proving when the user's commitment is not listed.
    const calldata = await proveForDemoUser(mod.state, proofUser, rootFile);
    generationTime = Date.now() - startTime;

    proof = calldata.proof;
    publicSignals = calldata.signals;
    finalNullifierHash = publicSignals[0];
    console.log(
      `✅ Real proof generated in ${generationTime}ms (${(generationTime / 1000).toFixed(2)}s)`,
    );

    mod.state.proofGenerationTimes.set("Whitelist Membership", generationTime);

    // Submit: the root is published on PrivacyManager and the wallet binds
    // itself (Task 3.3); only that binding counts as whitelist status.
    console.log("\n🔍 Submitting whitelist membership proof...");
    console.log(`   🔢 Nullifier Hash: ${finalNullifierHash}`);
    const receipt = await publishAndBind({
      state: mod.state,
      privacyManager,
      user: proofUser,
      proof,
      signals: publicSignals,
    });
    mod.state.gasTracker.set("Whitelist Proof", receipt.gasUsed);
    mod.state.whitelistRootFile = rootFile;
    displaySuccess("WHITELIST MEMBERSHIP PROOF BOUND TO THE WALLET!");

    // Task 3.6: the same binding on the live token, steps (a) to (e).
    return await runLiveWhitelistFlow({
      state: mod.state,
      sender: proofUser,
      listed,
      rootFile,
    });
  } catch (error) {
    displayError(`Whitelist proof submission failed: ${error.message}`);
  }
}

/**
 * Option 42 -> 2 (Task 3.7): prove the bound wallet's holder owns a
 * commitment in the current whitelist root whose identity is not on the
 * BlacklistOracle's list, verify it through the wrapper, then show a
 * listed identity cannot prove. A non-gating demonstration (D2).
 */
async function submitBlacklistNonMembershipProof(mod) {
  console.log("\n🚫 SUBMIT BLACKLIST NON-MEMBERSHIP PROOF");
  console.log("-".repeat(40));
  console.log(`🎯 Privacy-preserving blacklist check using real ZK proofs`);

  const zkVerifierIntegrated = mod.state.getContract("zkVerifierIntegrated");
  if (!zkVerifierIntegrated) {
    displayError("No ZK verifier: run option 1 (or 41)");
    return;
  }

  try {
    const generator = await mod.realGenerator();
    return await runBlacklistProofFlow({ state: mod.state, generator });
  } catch (error) {
    displayError(`Blacklist proof submission failed: ${error.message}`);
  }
}

/**
 * The wallet that signs-then-proves in 42 -> 3/4/5: a typed index, else
 * the first KYC/AML verified wallet after the deployer, else wallet 1.
 * Returns null on a bad index.
 */
async function pickAttestationUser(mod) {
  const signers = mod.state.signers;
  const idReg = mod.state.getContract("identityRegistry");
  let fallback = signers[1] || signers[0];
  for (const s of signers.slice(1)) {
    if (idReg && (await idReg.isVerified(s.address))) {
      fallback = s;
      break;
    }
  }
  const input = (
    await mod.promptUser(
      `Wallet index that proves (default ${signers.indexOf(fallback)}): `,
    )
  ).trim();
  if (!input) return fallback;
  if (!/^\d+$/.test(input) || !signers[Number(input)]) {
    displayError(`"${input}" is not a wallet index (0-${signers.length - 1})`);
    return null;
  }
  return signers[Number(input)];
}

/**
 * Shared tail of 42 -> 3/4/5 (Task 3.7b): the demo issuer signs, the user
 * proves through scripts/zk/prove-attestation.js and binds the record on
 * PrivacyManager; success is printed only when the validator reads true.
 */
async function attest(mod, circuit, user, attributes, label) {
  const generator = await mod.realGenerator();
  try {
    const { valid } = await runAttestationFlow({
      state: mod.state,
      generator,
      circuit,
      user,
      attributes,
    });
    if (valid) displaySuccess(`${label} ATTESTATION BOUND AND VALID`);
    else
      displayError(
        `${label} attestation bound but the validator reads false (privacy settings opt-out?)`,
      );
    return valid;
  } catch (error) {
    displayError(`${label} attestation refused: ${error.message}`);
    return false;
  }
}

/**
 * Option 42 -> 3: an issuer attests the user's jurisdiction as its
 * country's PrivacyManager bit; the proof shows the bit is in the allowed
 * mask (the codes ComplianceRules allows for VSC) without revealing it.
 */
async function submitJurisdictionEligibilityProof(mod) {
  console.log("\n🌍 SUBMIT JURISDICTION ELIGIBILITY PROOF");
  console.log("-".repeat(40));
  const pm = mod.state.getContract("privacyManager");
  if (!pm) {
    displayError("No PrivacyManager: run option 1 (or 41)");
    return;
  }
  const [codes, bits] = await pm.getActiveJurisdictions();
  console.log(
    "🎯 Attested jurisdiction, proved against ComplianceRules' rule for VSC (ISO 3166-1 numeric code, PrivacyManager bit):",
  );
  if (codes.length === 0) {
    console.log(
      "   none allowed yet: option 21 points PrivacyManager at VSC's rule and registers its codes",
    );
  }
  codes.forEach((c, i) => console.log(`   ${c} (bit ${bits[i]}, allowed)`));
  const user = await mod.pickAttestationUser();
  if (!user) return;
  const input =
    (
      await mod.promptUser("Your country, ISO numeric (default 840 = US): ")
    ).trim() || "840";
  if (!/^[0-9]{1,3}$/.test(input)) {
    displayError(`${input} is not an ISO 3166-1 numeric code`);
    return;
  }
  const code = BigInt(input);
  const mask = await pm.jurisdictionBit(code);
  if (mask === 0n) {
    displayError(
      `${code} has no jurisdiction bit on PrivacyManager (owner: registerJurisdictionCode, a PrivacyParameters vote after the handover)`,
    );
    return;
  }
  console.log(`   🌍 Attested: ${code} (bit ${mask}), private in the proof`);
  return mod.attest("jurisdiction", user, { mask }, "JURISDICTION");
}

/**
 * Option 42 -> 4: an issuer attests the user's accreditation amount; the
 * proof shows it meets PrivacyManager's minimum without revealing it.
 */
async function submitAccreditationStatusProof(mod) {
  console.log("\n💰 SUBMIT ACCREDITATION STATUS PROOF");
  console.log("-".repeat(40));
  const pm = mod.state.getContract("privacyManager");
  if (!pm) {
    displayError("No PrivacyManager: run option 1 (or 41)");
    return;
  }
  const minimum = await pm.minimumAccreditation();
  console.log(
    `🎯 PrivacyManager's minimum accreditation: ${minimum.toLocaleString()} (owner policy; a type 11 vote after the handover)`,
  );
  const levels = [
    { level: 50000n, name: "Retail ($50K)" },
    { level: 250000n, name: "Accredited ($250K)" },
    { level: 1000000n, name: "Accredited Investor ($1M)" },
    { level: 25000000n, name: "Institutional ($25M)" },
  ];
  levels.forEach((l, i) => console.log(`   ${i + 1}. ${l.name}`));
  const user = await mod.pickAttestationUser();
  if (!user) return;
  const pick =
    levels[
      parseInt(await mod.promptUser("Attested amount (1-4, default 2): ")) - 1
    ] || levels[1];
  console.log(
    `   💰 Attested: ${pick.name}, private in the proof${pick.level < minimum ? " (below the minimum: the prover refuses)" : ""}`,
  );
  return mod.attest(
    "accreditation",
    user,
    { amount: pick.level },
    "ACCREDITATION",
  );
}

/**
 * Option 42 -> 5: an issuer attests four compliance scores in one
 * attestation; the proof shows the weighted sum meets PrivacyManager's
 * minimum without revealing the scores or the aggregate.
 */
async function submitComplianceAggregationProof(mod) {
  console.log("\n📊 SUBMIT COMPLIANCE AGGREGATION PROOF");
  console.log("-".repeat(40));
  const pm = mod.state.getContract("privacyManager");
  if (!pm) {
    displayError("No PrivacyManager: run option 1 (or 41)");
    return;
  }
  const p = await pm.compliancePolicy();
  console.log(
    `🎯 Policy: weighted sum >= ${p.minimum} x 100, weights kyc ${p.wK} / aml ${p.wA} / jurisdiction ${p.wJ} / accreditation ${p.wAcc}`,
  );
  const user = await mod.pickAttestationUser();
  if (!user) return;
  const input = (
    await mod.promptUser(
      "Attested scores kyc,aml,jurisdiction,accreditation (default 95,90,100,85): ",
    )
  ).trim();
  const scores = (input || "95,90,100,85").split(",").map((x) => x.trim());
  console.log(`   📋 Attested scores: PRIVATE in the proof`);
  return mod.attest("compliance", user, { scores }, "COMPLIANCE");
}

/** Option 42 -> 6: all five real proofs for one wallet (PrivacyBatchFlow.js) */
async function submitAllPrivateProofs(mod) {
  console.log("\n🎯 SUBMIT ALL PRIVATE PROOFS (BATCH)");
  console.log("=".repeat(50));
  console.log(
    "🔐 The five real flows of 42 -> 1 to 5, with their defaults, for one wallet",
  );
  const user = await mod.pickAttestationUser();
  if (!user) return;
  try {
    const generator = await mod.realGenerator();
    return await runAllProofs({ state: mod.state, generator, user });
  } catch (error) {
    displayError(`Batch proof submission failed: ${error.message}`);
  }
}

module.exports = {
  submitWhitelistMembershipProof,
  submitBlacklistNonMembershipProof,
  pickAttestationUser,
  attest,
  submitJurisdictionEligibilityProof,
  submitAccreditationStatusProof,
  submitComplianceAggregationProof,
  submitAllPrivateProofs,
};
