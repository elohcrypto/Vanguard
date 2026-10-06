/**
 * @fileoverview Option 47's sub-options on chain (plan v2 Task 4.7). They
 * used to print fixed text ("Proof Caching: Enabled (24 hours)", "feature
 * available in production"). Each now reads, and where the caller may,
 * sets, the real setting:
 *   1 view: PrivacyManager and ZKVerifierIntegrated settings;
 *   2 proof cache: ZKVerifierIntegrated.setProofCacheExpiry (owner);
 *   3 proof validity: PrivacyManager.setProofValidityPeriod (owner);
 *   4 nullifiers: the bindings and the nullifier -> wallet maps;
 *   5 privacy preferences: a wallet's own setUserPrivacySettings.
 * Owner calls are sent only while the deployer owns the contract; after the
 * handover the option names the vote that sets it.
 */

const { displaySuccess, displayError } = require("./DisplayHelpers");
const { boundWallets } = require("./PrivacyChainViews");

const same = (a, b) => a.toLowerCase() === b.toLowerCase();
const FLAGS = [
  "enablePrivateWhitelist",
  "enablePrivateJurisdiction",
  "enablePrivateAccreditation",
  "enablePrivateCompliance",
];
const CIRCUITS = [
  ["jurisdiction", "JURISDICTION_PROOF_CIRCUIT"],
  ["accreditation", "ACCREDITATION_PROOF_CIRCUIT"],
  ["compliance", "COMPLIANCE_AGGREGATION_CIRCUIT"],
];

function contracts(state) {
  const zk = state.getContract("zkVerifierIntegrated");
  const pm = state.getContract("privacyManager");
  if (!zk || !pm) {
    displayError("No ZK verifier / PrivacyManager: run option 1 (or 41)");
    return null;
  }
  return { zk, pm };
}

/** 47 -> 1 */
async function viewSettings(state, log = console.log) {
  const c = contracts(state);
  if (!c) return;
  const { zk, pm } = c;
  log("\n📋 PRIVACY SETTINGS (read from chain):");
  log(`   ZK proofs: real (testingMode ${await zk.testingMode()})`);
  log(
    `   Proof cache: ${await zk.proofCacheExpiry()} s (ZKVerifierIntegrated; no off switch, 1 hour to 7 days)`,
  );
  log(
    `   Binding validity: ${await pm.proofValidityPeriod()} s (PrivacyManager.proofValidityPeriod)`,
  );
  log(
    "   Nullifiers: always tracked (nullifierWallet, attestationNullifierWallet); no setting",
  );
  const d = await pm.defaultPrivacySettings();
  log(
    `   Default preferences: ${FLAGS.map((f) => `${f.slice(13)} ${d[f]}`).join(", ")}`,
  );
  for (const [i, s] of state.signers.entries()) {
    const u = await pm.userPrivacySettings(s.address);
    if (u.proofValidityPeriod === 0n) continue; // never set: defaults apply
    log(
      `   wallet ${i}: ${FLAGS.map((f) => `${f.slice(13)} ${u[f]}`).join(", ")}`,
    );
  }
}

/** Send an owner setter as the deployer, or say who sets it. */
async function ownerSet(state, target, label, voteType, send, log) {
  const owner = await target.owner();
  if (!same(owner, state.signers[0].address)) {
    log(
      `   ℹ️  ${label} is owned by ${owner} (governance after the handover): a ${voteType} vote sets it (option 76)`,
    );
    return false;
  }
  await (await send(target.connect(state.signers[0]))).wait();
  return true;
}

/** 47 -> 2 */
async function setCacheExpiry(state, promptUser, log = console.log) {
  const c = contracts(state);
  if (!c) return;
  log(`\n⏱️  Proof cache expiry now: ${await c.zk.proofCacheExpiry()} s`);
  const h = (
    await promptUser("New expiry in hours, 1-168 (Enter keeps): ")
  ).trim();
  if (!h) return log("   unchanged");
  if (!/^\d+$/.test(h) || +h < 1 || +h > 168)
    return displayError(`${h} is not 1-168 hours`);
  const done = await ownerSet(
    state,
    c.zk,
    "ZKVerifierIntegrated",
    "VerifierParameters (type 12)",
    (zk) => zk.setProofCacheExpiry(BigInt(h) * 3600n),
    log,
  );
  if (done)
    displaySuccess(`PROOF CACHE EXPIRY ${await c.zk.proofCacheExpiry()} s`);
}

/** 47 -> 3 */
async function setValidity(state, promptUser, log = console.log) {
  const c = contracts(state);
  if (!c) return;
  log(`\n⏳ Binding validity now: ${await c.pm.proofValidityPeriod()} s`);
  const d = (
    await promptUser("New validity in days, 1-365 (Enter keeps): ")
  ).trim();
  if (!d) return log("   unchanged");
  if (!/^\d+$/.test(d) || +d < 1 || +d > 365)
    return displayError(`${d} is not 1-365 days`);
  const done = await ownerSet(
    state,
    c.pm,
    "PrivacyManager",
    "PrivacyParameters (type 11)",
    (pm) => pm.setProofValidityPeriod(BigInt(d) * 86400n),
    log,
  );
  if (done)
    displaySuccess(
      `BINDING VALIDITY ${await c.pm.proofValidityPeriod()} s (new bindings)`,
    );
}

/** 47 -> 4: every nullifier the demo wallets hold, checked both ways. */
async function showNullifiers(state, log = console.log) {
  const c = contracts(state);
  if (!c) return;
  const { zk, pm } = c;
  log("\n🔢 NULLIFIERS (PrivacyManager; tracked always, no setting):");
  let n = 0;
  for (const { signer, binding } of await boundWallets(state, pm)) {
    n++;
    const w = await pm.nullifierWallet(binding.version, binding.nullifier);
    log(
      `   ${same(w, signer.address) ? "✅" : "❌"} whitelist ${signer.address}: nullifier ${binding.nullifier} (root version ${binding.version}) -> ${w}`,
    );
  }
  for (const [name, getter] of CIRCUITS) {
    const cid = await zk[getter]();
    for (const s of state.signers) {
      const r = await pm.attestationRecords(s.address, cid);
      if (r.expiresAt === 0n) continue;
      n++;
      const w = await pm.attestationNullifierWallet(r.policyHash, r.nullifier);
      log(
        `   ${same(w, s.address) ? "✅" : "❌"} ${name} ${s.address}: nullifier ${r.nullifier} -> ${w}`,
      );
    }
  }
  if (!n) log("   (none yet: option 42 binds proofs)");
}

/** 47 -> 5: a wallet sets its own preference flags (its own key signs). */
async function setPreferences(state, promptUser, log = console.log) {
  const c = contracts(state);
  if (!c) return;
  const i = (await promptUser("Wallet index (default 1): ")).trim() || "1";
  const user = /^\d+$/.test(i) ? state.signers[Number(i)] : null;
  if (!user) return displayError(`"${i}" is not a wallet index`);
  const cur = await c.pm.getUserPrivacySettings(user.address);
  const next = {};
  for (const f of FLAGS) {
    const a = (
      await promptUser(`${f.slice(13)} (now ${cur[f]}; y/n, Enter keeps): `)
    )
      .trim()
      .toLowerCase();
    next[f] = a === "" ? cur[f] : a === "y" || a === "yes";
  }
  // The struct's period is kept for the ABI only (validity is the owner's
  // proofValidityPeriod); the setter wants 1 hour to 30 days.
  next.proofValidityPeriod = await c.pm.DEFAULT_PROOF_VALIDITY();
  await (await c.pm.connect(user).setUserPrivacySettings(next)).wait();
  const back = await c.pm.getUserPrivacySettings(user.address);
  log(
    `   wallet ${i}: ${FLAGS.map((f) => `${f.slice(13)} ${back[f]}`).join(", ")} (read back)`,
  );
  const [w, j, a, cc] = await c.pm.validateAllPrivateCompliance(user.address);
  log(
    `   validateAllPrivateCompliance: whitelist ${w}, jurisdiction ${j}, accreditation ${a}, compliance ${cc}`,
  );
  displaySuccess("PREFERENCES SET BY THE WALLET ITSELF");
}

module.exports = {
  viewSettings,
  setCacheExpiry,
  setValidity,
  showNullifiers,
  setPreferences,
};
