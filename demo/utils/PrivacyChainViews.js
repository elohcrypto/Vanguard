/**
 * @fileoverview Options 48, 49 and 50 read from chain (plan v2 Task 4.7,
 * phase-3 review B-M3). They used to print "Operational", "PASSED" and
 * "Ready for production use" from a timer; every verdict now comes from a
 * PrivacyManager, ZKVerifierIntegrated or ComplianceRules view.
 */

const { ethers } = require("hardhat");
const { displaySuccess, displayError } = require("./DisplayHelpers");

const MODES = ["OracleOnly", "ZkOnly", "Either"];
/** ZKVerifierIntegrated keys its counters by these names. */
const PROOF_TYPES = [
  "whitelist",
  "blacklist",
  "jurisdiction",
  "accreditation",
  "compliance",
];
const same = (a, b) => a.toLowerCase() === b.toLowerCase();
const hasCode = async (a) =>
  a !== ethers.ZeroAddress && (await ethers.provider.getCode(a)) !== "0x";

/** The pair, or null after the message. */
function pair(state) {
  const zk = state.getContract("zkVerifierIntegrated");
  const pm = state.getContract("privacyManager");
  if (!zk || !pm) {
    displayError("No ZK verifier / PrivacyManager: run option 1 (or 41)");
    return null;
  }
  return { zk, pm };
}

/** The five verifier addresses the wrapper routes to. */
async function verifierAddresses(zk) {
  const v = await zk.getVerifierAddresses();
  return {
    whitelist: v.whitelist,
    blacklist: await zk.blacklistVerifier(),
    jurisdiction: v.jurisdiction,
    accreditation: v.accreditation,
    compliance: v.compliance,
  };
}

/** Option 48: counters and wiring of the verifier wrapper. */
async function showVerifierStats(state, log = console.log) {
  const p = pair(state);
  if (!p) return null;
  const { zk, pm } = p;
  log(`\n🌍 ZKVerifierIntegrated ${await zk.getAddress()}`);
  log(`   testingMode: ${await zk.testingMode()} (immutable)`);
  log(`   proof cache expiry: ${await zk.proofCacheExpiry()} s`);
  log(
    "\n📈 VERIFICATIONS ON CHAIN (getVerificationStats; cache hits not counted):",
  );
  const stats = {};
  for (const t of PROOF_TYPES) {
    const [total, valid, rate] = await zk.getVerificationStats(t);
    stats[t] = { total, valid };
    log(
      `   • ${t}: ${total} verified, ${valid} valid${total > 0n ? ` (${Number(rate) / 100}%)` : ""}`,
    );
  }
  log("\n🔗 WIRING:");
  for (const [t, a] of Object.entries(await verifierAddresses(zk))) {
    log(`   ${(await hasCode(a)) ? "✅" : "❌"} ${t} verifier ${a}`);
  }
  const pmZk = await pm.zkVerifier();
  log(
    `   ${same(pmZk, await zk.getAddress()) ? "✅" : "❌"} PrivacyManager ${await pm.getAddress()} verifies through ${pmZk}`,
  );
  log(
    `   📜 whitelist root version ${await pm.whitelistVersion()}, proofs bound for ${await pm.proofValidityPeriod()} s`,
  );
  if (state.proofGenerationTimes.size > 0) {
    log("\n⏱️  PROOF GENERATION TIMES (this session, off chain):");
    for (const [k, ms] of state.proofGenerationTimes) log(`   • ${k}: ${ms}ms`);
  }
  if (state.gasTracker.size > 0) {
    log("\n💰 GAS OF THIS SESSION'S PROOF SUBMISSIONS (receipts):");
    for (const [k, gas] of state.gasTracker)
      log(`   • ${k}: ${gas.toLocaleString()} gas`);
  }
  return stats;
}

/** Wallets with a whitelist binding: { signer, binding }. */
async function boundWallets(state, pm) {
  const out = [];
  for (const s of state.signers) {
    const b = await pm.whitelistBindings(s.address);
    if (b.version !== 0n) out.push({ signer: s, binding: b });
  }
  return out;
}

/**
 * Option 49: eight integration checks, each true, false or not run (with
 * the option that sets it up). Returns the list.
 */
async function runIntegrationChecks(state, log = console.log) {
  const p = pair(state);
  if (!p) return null;
  const { zk, pm } = p;
  const zkAddr = await zk.getAddress();
  const pmAddr = await pm.getAddress();
  const checks = [];
  const add = (name, ok, detail) => checks.push({ name, ok, detail });

  add(
    "ZK verifier deployed, real verification",
    (await hasCode(zkAddr)) && !(await zk.testingMode()),
    `code at ${zkAddr}, testingMode ${await zk.testingMode()}`,
  );
  const v = await verifierAddresses(zk);
  const missing = [];
  for (const [t, a] of Object.entries(v))
    if (!(await hasCode(a))) missing.push(t);
  add(
    "Five circuit verifiers wired",
    missing.length === 0,
    missing.length ? `no code for ${missing.join(", ")}` : "all five have code",
  );
  const pmZk = await pm.zkVerifier();
  add(
    "PrivacyManager uses this verifier",
    same(pmZk, zkAddr),
    `zkVerifier() = ${pmZk}`,
  );

  const rules = state.getContract("complianceRules");
  const vsc = state.getContract("digitalToken");
  if (rules && vsc) {
    const vscAddr = await vsc.getAddress();
    const wired = await rules.privacyManager(vscAddr);
    const mode = MODES[Number(await rules.whitelistMode(vscAddr))];
    add(
      "VSC's ComplianceRules reads this PrivacyManager",
      same(wired, pmAddr),
      `privacyManager(VSC) = ${wired}, whitelist mode ${mode}`,
    );
  } else
    add(
      "VSC's ComplianceRules reads this PrivacyManager",
      null,
      "needs VSC (option 21)",
    );

  const bound = await boundWallets(state, pm);
  const live = [];
  for (const { signer } of bound)
    if (await pm.hasValidWhitelistProof(signer.address))
      live.push(signer.address);
  add(
    "A whitelist binding is valid",
    live.length ? true : null,
    live.length
      ? `${live.length} wallet(s), e.g. ${live[0]}`
      : "no binding: option 42 -> 1 or 42 -> 6",
  );

  const valid = { j: 0, a: 0, c: 0 };
  for (const s of state.signers) {
    const [, j, a, c] = await pm.validateAllPrivateCompliance(s.address);
    valid.j += j ? 1 : 0;
    valid.a += a ? 1 : 0;
    valid.c += c ? 1 : 0;
  }
  const att = valid.j && valid.a && valid.c;
  add(
    "Attestation records valid (jurisdiction, accreditation, compliance)",
    att ? true : null,
    `${valid.j} / ${valid.a} / ${valid.c} wallet(s)${att ? "" : ": option 42 -> 3, 4, 5 or 42 -> 6"}`,
  );

  const expiry = await zk.proofCacheExpiry();
  add(
    "Proof cache bounded",
    expiry >= 3600n && expiry <= 7n * 86400n,
    `proofCacheExpiry ${expiry} s (setter range 1 hour to 7 days)`,
  );

  if (bound.length === 0)
    add("Nullifiers map back to their wallets", null, "no binding yet");
  else {
    let ok = true;
    for (const { signer, binding } of bound) {
      const w = await pm.nullifierWallet(binding.version, binding.nullifier);
      if (!same(w, signer.address)) ok = false;
    }
    add(
      "Nullifiers map back to their wallets",
      ok,
      `nullifierWallet(version, nullifier) for ${bound.length} binding(s)`,
    );
  }

  log("");
  checks.forEach((c, i) =>
    log(
      `${i + 1}/${checks.length} ${c.ok === true ? "✅" : c.ok === false ? "❌" : "⏭️ "} ${c.name}: ${c.detail}`,
    ),
  );
  const held = checks.filter((c) => c.ok === true).length;
  const failed = checks.filter((c) => c.ok === false).length;
  const notRun = checks.length - held - failed;
  log(`\n📊 ${held} hold, ${failed} fail, ${notRun} not run (read from chain)`);
  if (held === checks.length)
    displaySuccess("ALL EIGHT PRIVACY CHECKS HOLD ON CHAIN");
  else if (failed) displayError(`${failed} PRIVACY CHECK(S) FAIL ON CHAIN`);
  else log("   💡 Run the options named above, then 49 again");
  return checks;
}

/**
 * Option 50: wire VSC's ComplianceRules to the PrivacyManager where the
 * deployer may (deployer.wirePrivacyManager), then report what VSC's
 * transfers read, per verified demo wallet.
 */
async function showTokenIntegration(state, deployer, log = console.log) {
  const p = pair(state);
  if (!p) return null;
  const rules = state.getContract("complianceRules");
  const vsc = state.getContract("digitalToken");
  if (!rules || !vsc) {
    displayError("Please deploy Vanguard StableCoin first (option 21)");
    return null;
  }
  const { pm } = p;
  const vscAddr = await vsc.getAddress();
  log(`🪙 VSC ${vscAddr}, ComplianceRules ${await rules.getAddress()}`);
  await deployer.wirePrivacyManager();
  const wired = same(
    await rules.privacyManager(vscAddr),
    await pm.getAddress(),
  );
  const mode = Number(await rules.whitelistMode(vscAddr));
  const oracle = await rules.whitelistOracle(vscAddr);
  log(`   policyToken on PrivacyManager: ${await pm.policyToken()}`);
  log(
    `   whitelist mode ${MODES[mode]}, whitelist oracle ${oracle === ethers.ZeroAddress ? "none" : oracle}`,
  );
  log(
    mode === 0
      ? "   ℹ️  OracleOnly: VSC transfers do not read ZK bindings (42 -> 1 switches VSC to Either)"
      : `   ℹ️  ${MODES[mode]}: VSC transfers read hasValidWhitelistProof${mode === 2 ? " or the whitelist oracle" : ""}`,
  );
  const idReg = state.getContract("identityRegistry");
  log("\n👥 Verified demo wallets:");
  let shown = 0;
  for (const [i, s] of state.signers.entries()) {
    if (!idReg || !(await idReg.isVerified(s.address))) continue;
    shown++;
    log(
      `   wallet ${i} ${s.address}: hasValidWhitelistProof ${await pm.hasValidWhitelistProof(s.address)}`,
    );
  }
  if (!shown) log("   (none: options 23/24, or 3, 6 and 7)");
  if (wired)
    displaySuccess(
      `VSC'S COMPLIANCERULES READS THIS PRIVACYMANAGER (MODE ${MODES[mode]})`,
    );
  else displayError("VSC's ComplianceRules does not read this PrivacyManager");
  return { wired, mode: MODES[mode] };
}

module.exports = {
  showVerifierStats,
  runIntegrationChecks,
  showTokenIntegration,
  boundWallets,
};
