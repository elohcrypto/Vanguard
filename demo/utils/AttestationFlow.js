/**
 * @fileoverview Demo attestation flows on PrivacyManager (plan v2 Task
 * 3.7b, D31 a): option 42 -> 3 / 4 / 5 and the status views 44 / 45 / 46.
 * A trusted issuer signs the investor's attribute message with an EdDSA
 * Baby Jubjub key (scripts/zk/attest.js); the investor proves the signature
 * and the policy and binds the record with submitAttestationProof
 * (scripts/zk/prove-attestation.js): the same library functions the CLIs
 * and the tests use. Kept out of PrivacyModule.js, which is far over the
 * 500-line rule already.
 *
 * The demo issuer key lives in DemoState.attestorKey: 32 random bytes made
 * once per session and never printed; only its public key (Ax, Ay) is.
 */

const crypto = require("crypto");
const {
  CIRCUITS,
  attestorPublicKey,
  attestorId,
  signAttestation,
} = require("../../scripts/zk/attest");
const {
  proveAttestation,
  submitAttestationProof,
} = require("../../scripts/zk/prove-attestation");
const { demoIdentity } = require("./WhitelistBinderFlow");

/** Demo policies set at deploy (owner; type 11 votes after the handover). */
const DEFAULT_MINIMUM_ACCREDITATION = 100000n;
const DEFAULT_COMPLIANCE = [70n, 25n, 25n, 25n, 25n]; // minimum, wK, wA, wJ, wAcc

const NAMES = {
  jurisdiction: "Jurisdiction eligibility",
  accreditation: "Accreditation status",
  compliance: "Compliance aggregation",
};
const VALIDATOR = {
  jurisdiction: "validatePrivateJurisdiction",
  accreditation: "validatePrivateAccreditation",
  compliance: "validatePrivateCompliance",
};

/** The session's demo issuer key (never printed). */
function demoAttestorKey(state) {
  state.attestorKey ??= "0x" + crypto.randomBytes(32).toString("hex");
  return state.attestorKey;
}

const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();

/**
 * A policy as printed: the allowed mask with its source and ISO codes, or
 * the numbers. The jurisdiction set is ComplianceRules' rule for VSC (Task
 * 3.8): PrivacyManager keeps only the code-to-bit assignment.
 */
async function describePolicy(pm, circuit) {
  const p = (await pm.currentPolicy(CIRCUITS[circuit].id)).map(BigInt);
  if (circuit === "jurisdiction") {
    const rules = await pm.complianceRules();
    if (same(rules, "0x" + "0".repeat(40))) {
      return "allowed mask 0: no source yet (option 21 points it at ComplianceRules' rule for VSC)";
    }
    const [codes, bits] = await pm.getActiveJurisdictions();
    const named = codes.map((c, i) => `${c}=${bits[i]}`).join(", ");
    return `allowed mask ${p[0]} from ComplianceRules ${rules} rule for VSC ${await pm.policyToken()} (ISO code=bit: ${named || "none allowed"})`;
  }
  if (circuit === "accreditation") return `minimum accreditation ${p[0]}`;
  return `minimum ${p[0]}, weights kyc ${p[1]} / aml ${p[2]} / jurisdiction ${p[3]} / accreditation ${p[4]}`;
}

/**
 * Trust the demo issuer key for the three circuits and set the default
 * policies the owner has not set yet, printing them. Called where the
 * privacy pair is deployed (option 1, or option 41 standalone).
 * @param {Object} p
 * @param {Object} p.state - DemoState
 * @param {Object} p.privacyManager - owned by the caller's signer
 * @param {Function} [p.log]
 */
async function setupDemoAttestations({
  state,
  privacyManager: pm,
  log = console.log,
}) {
  const { Ax, Ay } = await attestorPublicKey(demoAttestorKey(state));
  const id = attestorId(Ax, Ay);
  log(
    "   🖋️  Demo attestation issuer (KYC issuer's EdDSA key; private key never shown):",
  );
  log(`      Ax ${Ax}`);
  log(`      Ay ${Ay}`);
  for (const circuit of Object.keys(CIRCUITS)) {
    const cid = CIRCUITS[circuit].id;
    if (!(await pm.trustedAttestor(cid, id))) {
      await (await pm.setTrustedAttestor(cid, Ax, Ay, true)).wait();
    }
  }
  if ((await pm.minimumAccreditation()) === 0n) {
    await (
      await pm.setMinimumAccreditation(DEFAULT_MINIMUM_ACCREDITATION)
    ).wait();
  }
  const c = await pm.compliancePolicy();
  if (c.wK + c.wA + c.wJ + c.wAcc === 0n) {
    await (await pm.setCompliancePolicy(...DEFAULT_COMPLIANCE)).wait();
  }
  for (const circuit of Object.keys(CIRCUITS)) {
    const n = await pm.trustedAttestorCount(CIRCUITS[circuit].id);
    log(
      `   ✅ ${NAMES[circuit]}: ${n} trusted issuer key(s); ${await describePolicy(pm, circuit)}`,
    );
  }
  return { Ax, Ay, attestor: id };
}

/**
 * Task 3.8: point PrivacyManager's jurisdiction policy at ComplianceRules'
 * rule for VSC and give a bit to every code of the rule's allow list that
 * the rule admits, in list order; prints the source and the bits. Bits are
 * append-only, so a rerun registers only new codes. Without ownership it
 * prints the PrivacyParameters vote instead.
 * @returns {Promise<number|null>} codes registered, or null when unwired
 */
async function wireJurisdictionSource({
  privacyManager: pm,
  complianceRules: rules,
  token,
  log = console.log,
}) {
  const rulesAddr = await rules.getAddress();
  const vsc = await token.getAddress();
  const owner = await pm.owner();
  const isOwner = same(owner, await pm.runner.getAddress());
  // Review 3.8 L2: PrivacyManager derives ComplianceRules from VSC
  // (compliance()), so only the token is set and a Token vote is followed.
  if (!same(await pm.policyToken(), vsc)) {
    if (!isOwner) {
      log(
        `   ⚠️  PrivacyManager's jurisdiction policy token is not VSC ${vsc}: the owner (${owner}) sets it by a PrivacyParameters vote (setPolicyToken)`,
      );
      return null;
    }
    await (await pm.setPolicyToken(vsc)).wait();
  }
  if (!same(await pm.complianceRules(), rulesAddr)) {
    log(
      `   ⚠️  VSC's compliance is ${await pm.complianceRules()}, not ComplianceRules ${rulesAddr}`,
    );
  }
  const [, allowed] = await rules.getJurisdictionRule(vsc);
  for (const code of allowed) {
    if ((await pm.jurisdictionBit(code)) !== 0n) continue;
    if (!(await rules.validateJurisdiction(vsc, code))[0]) continue;
    if (!isOwner) {
      log(
        `   ⚠️  ${code} has no jurisdiction bit: registerJurisdictionCode(${code}) by a PrivacyParameters vote`,
      );
      continue;
    }
    await (await pm.registerJurisdictionCode(code)).wait();
  }
  const [codes] = await pm.getAllJurisdictions();
  log(
    `   ✅ Private jurisdiction proofs use ${await describePolicy(pm, "jurisdiction")}`,
  );
  log(`   ✅ Jurisdiction bits registered: ${codes.length}`);
  if (allowed.length === 0) {
    log(
      "   ℹ️  VSC's rule has no allow list (every code not blocked passes): give the codes issuers attest a bit with registerJurisdictionCode",
    );
  }
  return codes.length;
}

/**
 * Sign-then-prove for `user` and bind the record on PrivacyManager.
 * @param {Object} p
 * @param {Object} p.state - DemoState (attestor key, identity registry)
 * @param {Object} p.generator - the shared RealProofGenerator
 * @param {string} p.circuit - jurisdiction | accreditation | compliance
 * @param {Object} p.user - the wallet (signer) that proves and submits
 * @param {Object} p.attributes - { mask } | { amount } | { scores }
 * @param {Function} [p.log]
 * @returns {Promise<{record: Object, valid: boolean, gasUsed: bigint|null}>}
 */
async function runAttestationFlow({
  state,
  generator,
  circuit,
  user,
  attributes,
  log = console.log,
}) {
  const pm = state.getContract("privacyManager");
  if (!pm) throw new Error("no PrivacyManager: run option 1 (or 41)");
  const { identity, onchainID } = await demoIdentity(state, user.address);
  log(`\n👤 Investor wallet: ${user.address}`);
  log(
    `   🪪 Identity: ${onchainID ? `OnchainID ${onchainID}` : `${user.address} (simulated: no OnchainID)`}`,
  );
  log(`   📜 Policy on PrivacyManager: ${await describePolicy(pm, circuit)}`);

  // 1. The issuer signs (off chain); the attestation goes to the investor.
  // Task 3.8 M1: signed for this chain and this PrivacyManager only.
  const { chainId } = await pm.runner.provider.getNetwork();
  const attestation = await signAttestation({
    key: demoAttestorKey(state),
    circuit,
    chainId,
    privacyManager: pm.target,
    identity,
    ...attributes,
  });
  log(
    `   🖋️  Issuer signed the ${circuit} attestation (salt and signature stay with the investor)`,
  );

  // 2. The investor proves (refuses an untrusted issuer or a stale policy).
  const t0 = Date.now();
  const calldata = await proveAttestation({
    attestation,
    wallet: user.address,
    privacyManager: pm.target,
    runner: user,
    generator,
  });
  const ms = Date.now() - t0;
  state.proofGenerationTimes?.set(NAMES[circuit], ms);
  log(`   🔐 PLONK proof generated and checked locally in ${ms}ms`);

  // 3. The investor binds it; PrivacyManager checks issuer, policy, wallet,
  //    nullifier and the proof.
  const r = await submitAttestationProof({
    calldata,
    privacyManager: pm.target,
    signer: user,
  });
  const rx = await user.provider.getTransactionReceipt(r.txHash);
  if (rx) state.gasTracker?.set(`${NAMES[circuit]} Proof`, rx.gasUsed);
  const valid = await pm
    .connect(user)
    [VALIDATOR[circuit]].staticCall(user.address);
  log(`\n🔗 submitAttestationProof from ${user.address} (tx ${r.txHash})`);
  if (rx) log(`   💰 Gas Used: ${rx.gasUsed.toLocaleString()}`);
  log(`   🧾 policyHash ${r.policyHash}`);
  log(`   🔢 nullifier  ${r.nullifier}`);
  log(`   ⏳ expires    ${r.expiresAt}`);
  log(
    `   ${valid ? "✅" : "❌"} ${VALIDATOR[circuit]}(${user.address}): ${valid}`,
  );
  return { record: r, valid, gasUsed: rx ? rx.gasUsed : null };
}

/**
 * Status of one circuit for every demo wallet that has a record, read from
 * PrivacyManager (options 44, 45, 46).
 * @returns {Promise<{wallet: string, valid: boolean}[]>}
 */
async function attestationStatus({ state, circuit, log = console.log }) {
  const pm = state.getContract("privacyManager");
  if (!pm) throw new Error("no PrivacyManager: run option 1 (or 41)");
  const cid = CIRCUITS[circuit].id;
  const current = await pm.currentPolicyHash(cid);
  log(`📜 ${NAMES[circuit]} policy: ${await describePolicy(pm, circuit)}`);
  const out = [];
  for (const [i, s] of state.signers.entries()) {
    const rec = await pm.attestationRecords(s.address, cid);
    if (rec.expiresAt === 0n) continue;
    const info = await pm.getUserProofInfo(s.address, cid);
    const valid = await pm[VALIDATOR[circuit]].staticCall(s.address);
    const why = info.isValid
      ? valid
        ? "valid"
        : "valid record, but the user opted out (privacy settings)"
      : info.isExpired
        ? "expired"
        : rec.policyHash !== current
          ? "lapsed: the policy changed since"
          : "lapsed: the issuer key is no longer trusted";
    log(`   ${valid ? "✅" : "❌"} wallet ${i} ${s.address}: ${why}`);
    log(
      `      🔢 nullifier ${rec.nullifier}, expires ${new Date(Number(rec.expiresAt) * 1000).toISOString()}`,
    );
    out.push({ wallet: s.address, valid });
  }
  if (out.length === 0) log(`   (no wallet has a ${circuit} record)`);
  return out;
}

module.exports = {
  DEFAULT_MINIMUM_ACCREDITATION,
  DEFAULT_COMPLIANCE,
  demoAttestorKey,
  setupDemoAttestations,
  wireJurisdictionSource,
  runAttestationFlow,
  attestationStatus,
};
