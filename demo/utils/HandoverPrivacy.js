/**
 * @fileoverview Handover ceremony, plan v2 Task 3.3 (R-3R-3, R-3R-4): the
 * privacy contracts. PrivacyManager (type 11, PrivacyParameters) and
 * ZKVerifierIntegrated (type 12, VerifierParameters) are ACCEPTANCE_PLAN
 * entries with a bind setter, so HandoverPowers derives them from the bound
 * targets, refuses a bound-but-omitted one and binds both at step 3. This
 * file adds what is specific to them: the verifier PrivacyManager uses must
 * be the one the config names, a testingMode verifier is refused, both
 * contracts and the wrapper's five verifiers must carry the compiled code
 * (HandoverCodeHash.js), ops becomes the list operator, and the completion
 * lines. Task 3.4 adds the PrivacyManager ComplianceRules wires: it joins
 * the ceremony even before governance is bound to it. Task 3.8: its
 * jurisdiction policy must read the ceremony's ComplianceRules rule for VSC.
 */

const { ethers } = require("hardhat");
const { addrOf, same, fail } = require("./HandoverChecks");
const { scanLogs } = require("./HandoverScans");
const {
  codeHashChecks,
  codeHashLabel,
  codeHashRefusal,
  buildIdentity,
  buildIdentityLabel,
} = require("./HandoverCodeHash");

const check = (cond, msg) => cond || fail(msg);
const ZERO = ethers.ZeroAddress;
const MODE = ["OracleOnly", "ZkOnly", "Either"];
const ATTESTATION_CIRCUITS = [
  ["jurisdiction", ethers.id("JURISDICTION_PROOF")],
  ["accreditation", ethers.id("ACCREDITATION_PROOF")],
  ["compliance", ethers.id("COMPLIANCE_AGGREGATION")],
];

/**
 * Task 3.4 (R-3R-15): the PrivacyManager ComplianceRules wires for VSC and
 * VGT, read from chain. With the one governance is bound to (type 11,
 * `bound`), every non-zero one must be the same address: that one is the
 * ceremony's PrivacyManager, so a wired but unbound one is nominated,
 * bound and accepted like a bound one. `conflict` names two that differ.
 */
async function wiredPrivacy(o, bound) {
  const rules = o.complianceRules;
  const seen = bound
    ? [[`governance is bound to PrivacyManager ${bound}`, bound]]
    : [];
  const wired = [];
  for (const [label, c] of [
    ["VSC", o.token],
    ["VGT", o.governanceToken],
  ]) {
    const t = await addrOf(c);
    // Review 3.4 LOW-3: a ComplianceRules from before 3.4 has no getter;
    // only that revert is named, anything else (RPC) is rethrown.
    const pm = await rules.privacyManager(t).catch(async (e) => {
      if (e.code !== "CALL_EXCEPTION" && !/revert/i.test(e.message)) throw e;
      fail(
        `ComplianceRules ${await addrOf(rules)} has no privacyManager(token) (predates Task 3.4): redeploy it before the ceremony`,
      );
    });
    wired.push({ label, pm, mode: MODE[Number(await rules.whitelistMode(t))] });
    if (!same(pm, ZERO))
      seen.push([
        `ComplianceRules wires PrivacyManager ${pm} for ${label}`,
        pm,
      ]);
  }
  const [first] = seen;
  const other = first && seen.find(([, a]) => !same(a, first[1]));
  return {
    wired,
    privacyManager: first ? first[1] : null,
    wiredBy: first && !bound ? first[0] : null,
    conflict: other
      ? `${first[0]}, but ${other[0]}: one PrivacyManager per deployment; rewire ComplianceRules (setPrivacyManager) before the ceremony`
      : null,
  };
}

/**
 * Read-only, before the first transaction. PrivacyManager's zkVerifier() is
 * the verifier that decides what a whitelist proof is worth: the config must
 * name it (else the deployer keeps updateVerifier), and no named verifier
 * may be a testingMode one (it accepts any proof with non-zero signals).
 */
async function preflightPrivacy(o) {
  const pm = o.privacyManager;
  const zk = o.zkVerifier;
  if (pm) {
    await preflightJurisdictionSource(o);
    const used = await pm.zkVerifier();
    if (!(zk && same(await addrOf(zk), used))) {
      fail(
        `PrivacyManager ${await addrOf(pm)} uses ZKVerifierIntegrated ${used}, which the config does not name: set "zkVerifier" to it`,
      );
    }
  }
  if (zk && (await zk.testingMode())) {
    fail(
      `ZKVerifierIntegrated ${await addrOf(zk)} is in testingMode (accepts any proof with non-zero signals): redeploy it with testingMode=false before the handover`,
    );
  }
  // Review 3.3 MEDIUM-1/2: the flags above are self-reported.
  for (const c of await codeHashChecks(pm, [zk])) {
    if (!c.ok) fail(codeHashRefusal(c));
  }
}

/**
 * Task 3.8: the jurisdiction set of the private proofs is ComplianceRules'
 * rule for VSC, so PrivacyManager must read the ceremony's ComplianceRules
 * with VSC as the policy token; another one would let a contract governance
 * does not hold decide which countries the private path admits.
 */
async function preflightJurisdictionSource(o) {
  const pm = o.privacyManager;
  const pmAddr = await addrOf(pm);
  const src = await pm.complianceRules().catch(async (e) => {
    if (e.code !== "CALL_EXCEPTION" && !/revert/i.test(e.message)) throw e;
    fail(
      `PrivacyManager ${pmAddr} has no complianceRules() (predates Task 3.8): redeploy it before the ceremony`,
    );
  });
  const rules = await addrOf(o.complianceRules);
  if (!same(src, rules)) {
    fail(
      `PrivacyManager ${pmAddr} reads its jurisdiction policy from ComplianceRules ${src}, not the ceremony's ${rules}: setJurisdictionSource before the ceremony`,
    );
  }
  const vsc = await addrOf(o.token);
  const policyToken = await pm.policyToken();
  if (!same(policyToken, vsc)) {
    fail(
      `PrivacyManager ${pmAddr} takes its jurisdiction policy from token ${policyToken}, not VSC ${vsc}: setJurisdictionSource before the ceremony`,
    );
  }
}

/**
 * Step 5 on PrivacyManager, while the deployer still owns it: ops publishes
 * whitelist roots from now on (governance can too, by a PrivacyParameters
 * vote). Once governance owns it, only a vote can, so this only says so and
 * the completion line checks it.
 */
async function privacySteps({ o, d, dAddr, ok, log }) {
  const pm = o.privacyManager;
  if (!pm) return;
  const ops = await addrOf(o.ops);
  if (!same(await pm.listOperator(), ops)) {
    // Review 3.3 LOW-4: governance already owns it (a rerun, or handed early).
    if (!same(await pm.owner(), dAddr)) {
      log(
        "   ⚠️  PrivacyManager: governance must set listOperator to ops by a PrivacyParameters vote",
      );
      return;
    }
    await (await pm.connect(d).setListOperator(ops)).wait();
    check(
      same(await pm.listOperator(), ops),
      "PrivacyManager listOperator is not ops",
    );
  }
  ok(`PrivacyManager listOperator: ops ${ops}`);
}

/**
 * Completion lines: [label, pass] for both privacy contracts, including the
 * code-hash pins and the trusted attestor count per attestation circuit.
 * Pushes to `warnings` (review 3.3 LOW-3) when the current whitelist root
 * was published by the deployer: bindings made under it stay live until ops
 * rotates the root; and when a circuit trusts no attestor (Task 3.7b).
 */
async function privacyLines(o, dAddr, ops, govAddr, warnings = []) {
  const lines = [];
  const pm = o.privacyManager;
  const pmAddr = pm ? await addrOf(pm) : o.derived?.factories?.privacyManager;
  let used = null;
  if (pmAddr) {
    const c = await ethers.getContractAt("PrivacyManager", pmAddr);
    lines.push([
      "PrivacyManager listOperator is ops",
      same(await c.listOperator(), ops),
    ]);
    lines.push([
      "PrivacyManager pendingOwner is not the deployer",
      !same(await c.pendingOwner(), dAddr),
    ]);
    // Task 3.8: the one jurisdiction source.
    const rules = await addrOf(o.complianceRules);
    lines.push([
      `PrivacyManager jurisdiction source: ComplianceRules ${rules}`,
      same(await c.complianceRules(), rules),
    ]);
    const vsc = await addrOf(o.token);
    lines.push([
      `PrivacyManager jurisdiction policy token: VSC ${vsc}`,
      same(await c.policyToken(), vsc),
    ]);
    const [codes] = await c.getAllJurisdictions();
    lines.push([
      `PrivacyManager jurisdiction bits registered: ${codes.length}`,
      true,
    ]);
    // Task 3.7b: who may vouch for the attestation proofs. Informational;
    // none trusted refuses every proof of that circuit until a vote trusts
    // an issuer key (setTrustedAttestor).
    for (const [name, id] of ATTESTATION_CIRCUITS) {
      const n = await c.trustedAttestorCount(id);
      lines.push([`PrivacyManager trusted attestors for ${name}: ${n}`, true]);
      if (n === 0n) {
        warnings.push(
          `PrivacyManager trusts no attestor for ${name}: its proofs are refused until a PrivacyParameters vote calls setTrustedAttestor`,
        );
      }
    }
    // Review 3.7b L2, like the deployer-root warning: a key the deployer
    // trusted lets it keep vouching for attestations after the handover.
    const trustLogs = await scanLogs(c, c.filters.TrustedAttestorSet(), o);
    const lastTrust = new Map();
    for (const e of trustLogs) {
      lastTrust.set(`${e.args.circuitId}:${e.args.attestor}`, e);
    }
    for (const e of lastTrust.values()) {
      const name = ATTESTATION_CIRCUITS.find(
        ([, id]) => id === e.args.circuitId,
      );
      if (
        e.args.trusted &&
        same(e.args.by, dAddr) &&
        (await c.trustedAttestor(e.args.circuitId, e.args.attestor))
      ) {
        warnings.push(
          `PrivacyManager issuer key (Ax ${e.args.ax}) for ${name ? name[0] : e.args.circuitId} was trusted by the deployer: re-approve it by a PrivacyParameters vote or untrust it`,
        );
      }
    }
    used = await c.zkVerifier();
    const v = await ethers.getContractAt("ZKVerifierIntegrated", used);
    lines.push([
      `PrivacyManager's verifier ${used} owned by governance`,
      same(await v.owner(), govAddr),
    ]);
    // Review 3.3 follow-up LOW-B: the deployer may have published through a
    // second key it controls, so anything but ops or governance warns.
    const roots = await scanLogs(c, c.filters.WhitelistRootPublished(), o);
    const last = roots[roots.length - 1];
    const pub = last && last.args.publisher;
    if (last && !same(pub, ops) && !same(pub, govAddr)) {
      const who = same(pub, dAddr)
        ? "the deployer"
        : `${pub}, not ops or governance`;
      warnings.push(
        `PrivacyManager whitelist root ${last.args.root} (version ${last.args.version}) was published by ${who}: republish as ops so deployer-era bindings lapse`,
      );
    }
  }
  // Task 3.4: what ComplianceRules wires agrees with the ceremony's one.
  const derivedPm = o.derived?.factories?.privacyManager;
  for (const w of o.derived?.privacy?.wired || []) {
    const none = same(w.pm, ZERO);
    lines.push([
      `ComplianceRules privacyManager for ${w.label}: ${none ? "none" : w.pm} (mode ${w.mode})`,
      none || Boolean(derivedPm && same(w.pm, derivedPm)),
    ]);
  }
  const zk = o.zkVerifier;
  const zkAddr = zk ? await addrOf(zk) : o.derived?.factories?.zkVerifier;
  const pins = await codeHashChecks(pmAddr, [used, zkAddr]);
  for (const c of pins) {
    lines.push([codeHashLabel(c), c.ok]);
  }
  if (pins.length) lines.push([buildIdentityLabel(buildIdentity()), true]);
  if (zkAddr) {
    const v = await ethers.getContractAt("ZKVerifierIntegrated", zkAddr);
    lines.push([
      "ZKVerifierIntegrated pendingOwner is not the deployer",
      !same(await v.pendingOwner(), dAddr),
    ]);
    lines.push([
      "ZKVerifierIntegrated is not in testingMode",
      !(await v.testingMode()),
    ]);
  }
  return lines;
}

module.exports = { wiredPrivacy, preflightPrivacy, privacySteps, privacyLines };
