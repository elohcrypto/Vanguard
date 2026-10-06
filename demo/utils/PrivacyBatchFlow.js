/**
 * @fileoverview Option 42 -> 6, all five private proofs for one wallet
 * (plan v2 Task 4.7, phase-3 review B-M3). It used to print "Generated"
 * five times from a timer. It now runs the real flows the single options
 * run, with their defaults, for one wallet:
 *   whitelist (42 -> 1's proof and binding, without the transfer steps),
 *   blacklist non-membership (42 -> 2, non-gating: D2),
 *   jurisdiction, accreditation and compliance attestations (42 -> 3/4/5),
 * then reads PrivacyManager.validateAllPrivateCompliance(wallet). The
 * verdict is that read.
 */

const { displaySuccess, displayError } = require("./DisplayHelpers");
const {
  demoWhitelist,
  proveForDemoUser,
  publishAndBind,
} = require("./WhitelistBinderFlow");
const { runBlacklistProofFlow } = require("./BlacklistProofFlow");
const { runAttestationFlow } = require("./AttestationFlow");

const DEFAULT_CODE = 840n; // 42 -> 3's default (US)
const DEFAULT_AMOUNT = 250000n; // 42 -> 4's default (Accredited)
const DEFAULT_SCORES = ["95", "90", "100", "85"]; // 42 -> 5's default

/** One step: true / false / null (skipped), printed with its reason. */
async function step(results, name, log, fn) {
  log(`\n━━ ${name} ━━`);
  try {
    const r = await fn();
    results[name] = r;
  } catch (e) {
    log(`   ❌ ${name} refused: ${e.message.split("\n")[0]}`);
    results[name] = false;
  }
}

/**
 * @returns {Promise<{steps: Object, chain: boolean[]}|null>} the step
 *   outcomes and validateAllPrivateCompliance(user)
 */
async function runAllProofs({ state, generator, user, log = console.log }) {
  const pm = state.getContract("privacyManager");
  if (!pm) {
    displayError("No PrivacyManager: run option 1 (or 41)");
    return null;
  }
  log(`👤 Wallet for all five proofs: ${user.address}`);
  const results = {};

  await step(results, "whitelist", log, async () => {
    // 42 -> 1's demo list (wallets 0-2) plus the wallet itself.
    const listed = [...new Set([...state.signers.slice(0, 3), user])];
    const { rootFile } = await demoWhitelist(state, listed);
    const t0 = Date.now();
    const calldata = await proveForDemoUser(state, user, rootFile);
    state.proofGenerationTimes.set("Whitelist Membership", Date.now() - t0);
    const rx = await publishAndBind({
      state,
      privacyManager: pm,
      user,
      proof: calldata.proof,
      signals: calldata.signals,
    });
    state.gasTracker.set("Whitelist Proof", rx.gasUsed);
    state.whitelistRootFile = rootFile;
    return pm.hasValidWhitelistProof(user.address);
  });

  await step(results, "blacklist", log, async () => {
    const r = await runBlacklistProofFlow({ state, generator, log });
    return r ? r.verified : null;
  });

  await step(results, "jurisdiction", log, async () => {
    const [codes] = await pm.getActiveJurisdictions();
    if (codes.length === 0) {
      log(
        "   ⏭️  no allowed jurisdiction code on PrivacyManager: run option 21",
      );
      return null;
    }
    const code = codes.includes(DEFAULT_CODE) ? DEFAULT_CODE : codes[0];
    const mask = await pm.jurisdictionBit(code);
    log(`   🌍 attested code ${code} (bit ${mask})`);
    const { valid } = await runAttestationFlow({
      state,
      generator,
      circuit: "jurisdiction",
      user,
      attributes: { mask },
      log,
    });
    return valid;
  });

  await step(results, "accreditation", log, async () => {
    const minimum = await pm.minimumAccreditation();
    const amount = minimum > DEFAULT_AMOUNT ? minimum : DEFAULT_AMOUNT;
    log(`   💰 attested amount ${amount} (minimum ${minimum})`);
    const { valid } = await runAttestationFlow({
      state,
      generator,
      circuit: "accreditation",
      user,
      attributes: { amount },
      log,
    });
    return valid;
  });

  await step(results, "compliance", log, async () => {
    const { valid } = await runAttestationFlow({
      state,
      generator,
      circuit: "compliance",
      user,
      attributes: { scores: DEFAULT_SCORES },
      log,
    });
    return valid;
  });

  const chain = await pm.validateAllPrivateCompliance(user.address);
  const [w, j, a, c] = chain;
  log("\n📊 BATCH RESULT (read from chain):");
  for (const [k, v] of Object.entries(results)) {
    log(
      `   ${v === true ? "✅" : v === false ? "❌" : "⏭️ "} ${k}${k === "blacklist" ? " (verified by the wrapper; nothing gates on it, D2)" : ""}`,
    );
  }
  log(
    `   validateAllPrivateCompliance(${user.address}): whitelist ${w}, jurisdiction ${j}, accreditation ${a}, compliance ${c}`,
  );
  if (w && j && a && c) {
    displaySuccess("ALL FOUR GATING PRIVATE CHECKS HOLD FOR THE WALLET");
  } else {
    displayError("NOT EVERY PRIVATE CHECK HOLDS FOR THE WALLET (see above)");
  }
  return { steps: results, chain: [w, j, a, c] };
}

module.exports = { runAllProofs };
