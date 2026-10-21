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
const { addrOf, same, fail, MODE } = require("./HandoverChecks");
const { scanLogs, uniq } = require("./HandoverScans");
const {
  codeHashChecks,
  codeHashLabel,
  codeHashRefusal,
  buildIdentity,
  buildIdentityLabel,
} = require("./HandoverCodeHash");

const check = (cond, msg) => cond || fail(msg);
const ZERO = ethers.ZeroAddress;
const ATTESTATION_CIRCUITS = [
  ["jurisdiction", ethers.id("JURISDICTION_PROOF")],
  ["accreditation", ethers.id("ACCREDITATION_PROOF")],
  ["compliance", ethers.id("COMPLIANCE_AGGREGATION")],
];
const ALL_KINDS = ["whitelist", ...ATTESTATION_CIRCUITS.map(([n]) => n)];
// updateVerifier's tag -> the PrivacyManager records that verifier decides.
const KINDS = {
  whitelist: ["whitelist"],
  blacklist: [],
  jurisdiction: ["jurisdiction"],
  accreditation: ["accreditation"],
  compliance: ["compliance"],
};

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
async function preflightPrivacy(o, log = () => {}) {
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
  // Review D2-2: the lines completion and the audit print, refused here
  // too (round 2): before the ceremony the deployer republishes or
  // re-trusts in one transaction; after it each is a governance vote.
  if (!pm) return;
  const [ops, gov] = await Promise.all([o.ops, o.governance].map(addrOf));
  const swaps = await swapLines(o, pm, [await pm.zkVerifier()], ops, gov);
  for (const [label, ok] of swaps) log(`   ${ok ? "✅" : "❌"} ${label}`);
  const open = swaps.filter(([, ok]) => !ok).map(([label]) => label);
  check(!open.length, open.join("; "));
}

/**
 * Task 3.8: the jurisdiction set of the private proofs is the rule VSC's
 * ComplianceRules (VSC.compliance(), derived on chain, review L2) holds for
 * VSC, so PrivacyManager's policy token must be VSC; another token would
 * let a contract governance does not hold decide which countries the
 * private path admits.
 */
async function preflightJurisdictionSource(o) {
  const pm = o.privacyManager;
  const pmAddr = await addrOf(pm);
  const policyToken = await pm.policyToken().catch(async (e) => {
    if (e.code !== "CALL_EXCEPTION" && !/revert/i.test(e.message)) throw e;
    fail(
      `PrivacyManager ${pmAddr} has no policyToken() (predates Task 3.8): redeploy it before the ceremony`,
    );
  });
  const vsc = await addrOf(o.token);
  if (!same(policyToken, vsc)) {
    fail(
      `PrivacyManager ${pmAddr} takes its jurisdiction policy from token ${policyToken}, not VSC ${vsc}: setPolicyToken before the ceremony`,
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
 * The issuer keys PrivacyManager still trusts by the deployer's own call:
 * the last TrustedAttestorSet per (circuit, key) set it trusted with `by`
 * the deployer. [{ circuitId, name, ax, ay }]. A governance vote that sets
 * the same key trusted again (setTrustedAttestor(..., true): no state or
 * epoch change) makes governance the last setter (Q20 = B, Task 5.15:
 * scripts/production/postCeremonyVotes.ts).
 */
async function deployerTrustedAttestors(o, dAddr, c = o.privacyManager) {
  const logs = await scanLogs(c, c.filters.TrustedAttestorSet(), o);
  const last = new Map();
  for (const e of logs) last.set(`${e.args.circuitId}:${e.args.attestor}`, e);
  const out = [];
  for (const e of last.values()) {
    const named = ATTESTATION_CIRCUITS.find(
      ([, id]) => id === e.args.circuitId,
    );
    if (
      e.args.trusted &&
      same(e.args.by, dAddr) &&
      (await c.trustedAttestor(e.args.circuitId, e.args.attestor))
    ) {
      out.push({
        circuitId: e.args.circuitId,
        name: named ? named[0] : e.args.circuitId,
        ax: e.args.ax,
        ay: e.args.ay,
      });
    }
  }
  return out;
}

/**
 * Review D2-2: every verifier swap since fromBlock, oldest first: a
 * ZKVerifierIntegrated VerifierUpdated on each wrapper in `zks` (its
 * constructor emits none) and a PrivacyManager ZKVerifierUpdated after the
 * constructor's. [{ block, what, kinds, bindings }]: `kinds` the records
 * the swapped verifier decides (a blacklist proof binds nothing),
 * `bindings` the PrivacyManager bindings made from it to the next swap.
 * Also `bound`: the binding events, whitelist then attestation.
 */
async function verifierSwaps(o, pm, zks) {
  const swaps = [];
  for (const a of zks) {
    const zk = await ethers.getContractAt("ZKVerifierIntegrated", a);
    for (const ev of await scanLogs(zk, zk.filters.VerifierUpdated(), o)) {
      const tag = Object.keys(KINDS).find(
        (t) => ethers.id(t) === ev.args[0].hash,
      );
      swaps.push({
        block: ev.blockNumber,
        what: `ZKVerifierIntegrated ${a} ${tag || "unknown"} verifier set to ${ev.args[1]}`,
        kinds: tag ? KINDS[tag] : ALL_KINDS,
      });
    }
  }
  for (const ev of await scanLogs(pm, pm.filters.ZKVerifierUpdated(), o)) {
    if (same(ev.args[0], ZERO)) continue;
    swaps.push({
      block: ev.blockNumber,
      what: `PrivacyManager verifier ${ev.args[0]} replaced by ${ev.args[1]}`,
      kinds: ALL_KINDS,
    });
  }
  swaps.sort((x, y) => x.block - y.block);
  const bound = {
    whitelist: await scanLogs(pm, pm.filters.WhitelistProofBound(), o),
    attestation: await scanLogs(pm, pm.filters.AttestationProofBound(), o),
  };
  const at = [...bound.whitelist, ...bound.attestation].map(
    (e) => e.blockNumber,
  );
  swaps.forEach((s, i) => {
    const end = i + 1 < swaps.length ? swaps[i + 1].block : Infinity;
    s.bindings = at.filter((b) => b >= s.block && b < end).length;
  });
  return { swaps, bound };
}

/**
 * D2-2: true when every attestation record of circuit `id` made up to block
 * `b` has lapsed: the policy epoch, or the epoch of every attestor the
 * circuit trusts now, moved after `b`.
 */
async function lapsedSince(pm, id, b, o) {
  const then = { blockTag: b };
  if ((await pm.policyEpoch(id)) > (await pm.policyEpoch(id, then)))
    return true;
  const sets = await scanLogs(pm, pm.filters.TrustedAttestorSet(id), o);
  for (const k of new Set(sets.map((e) => e.args.attestor))) {
    if (!(await pm.trustedAttestor(id, k))) continue;
    const now = await pm.attestorEpoch(id, k);
    if (now <= (await pm.attestorEpoch(id, k, then))) return false;
  }
  return true;
}

/**
 * Review D2-2, completion and the audit: [label, pass] for the swaps, one
 * line each, and a failing line per record kind a swap left able to count:
 * whitelist bindings until ops (or governance) republishes the root after
 * the last whitelist verifier swap; a circuit's attestation records until
 * its policy epoch, or the epoch of every attestor it trusts, moved after
 * the last swap of its verifier. Then the wrapper's validProofs beside the
 * bindings, for the operator to account for.
 */
async function swapLines(o, pm, zks, ops, govAddr) {
  const { swaps, bound } = await verifierSwaps(o, pm, zks);
  const last = (k) =>
    Math.max(
      -1,
      ...swaps.filter((s) => s.kinds.includes(k)).map((s) => s.block),
    );
  const open = [];
  const lw = last("whitelist");
  if (lw >= 0) {
    const v = await pm.whitelistVersion();
    const pubs = await scanLogs(pm, pm.filters.WhitelistRootPublished(), o);
    const cur = pubs.find((e) => e.args.version === v);
    const fresh =
      v === 0n ||
      (cur &&
        cur.blockNumber > lw &&
        [ops, govAddr].some((a) => same(a, cur.args.publisher)));
    if (!fresh)
      open.push([
        "whitelist",
        `whitelist bindings made up to block ${lw} (the last whitelist verifier swap) still count: ops must republish the whitelist root (publishWhitelistRoot) after it`,
      ]);
  }
  for (const [name, id] of ATTESTATION_CIRCUITS) {
    const b = last(name);
    if (b < 0) continue;
    if (!(await lapsedSince(pm, id, b, o)))
      open.push([
        name,
        `${name} records made up to block ${b} (the last ${name} verifier swap) still count: a PrivacyParameters vote must untrust then re-trust each trusted ${name} attestor key, or change the ${name} policy, after it`,
      ]);
  }
  const stuck = new Set(open.map(([k]) => k));
  const zk = await ethers.getContractAt("ZKVerifierIntegrated", zks[0]);
  const proofs = [];
  const binds = [`whitelist ${bound.whitelist.length}`];
  for (const k of ALL_KINDS) proofs.push(`${k} ${await zk.validProofs(k)}`);
  for (const [name, id] of ATTESTATION_CIRCUITS)
    binds.push(
      `${name} ${bound.attestation.filter((e) => e.args.circuitId === id).length}`,
    );
  return [
    [
      `verifier swaps since fromBlock ${Number(o.fromBlock || 0)}: ${swaps.length}`,
      open.length === 0,
    ],
    ...swaps.map((s) => [
      `verifier swap at block ${s.block}: ${s.what} (${s.bindings} PrivacyManager binding(s) made under it)`,
      !s.kinds.some((k) => stuck.has(k)),
    ]),
    ...open.map(([, label]) => [label, false]),
    [
      `ZKVerifierIntegrated ${zks[0]} validProofs ${proofs.join(", ")}; PrivacyManager bindings ${binds.join(", ")}`,
      true,
    ],
  ];
}

/**
 * Completion lines: [label, pass] for both privacy contracts, including the
 * code-hash pins and the trusted attestor count per attestation circuit.
 * Pushes to `warnings` (review 3.3 LOW-3) when the current whitelist root
 * was published by the deployer: bindings made under it stay live until ops
 * rotates the root; and when a circuit trusts no attestor (Task 3.7b).
 * The deployer-era issuer-key and root warnings also go to `residual`
 * (review B-L3): the deployer, or a key it chose, still vouches.
 */
async function privacyLines(
  o,
  dAddr,
  ops,
  govAddr,
  warnings = [],
  residual = [],
) {
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
    const vsc = await addrOf(o.token);
    lines.push([
      `PrivacyManager jurisdiction policy token: VSC ${vsc}`,
      same(await c.policyToken(), vsc),
    ]);
    lines.push([
      `PrivacyManager jurisdiction source (VSC.compliance()): ComplianceRules ${rules}`,
      same(await c.complianceRules(), rules),
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
    for (const k of await deployerTrustedAttestors(o, dAddr, c)) {
      const w = `PrivacyManager issuer key (Ax ${k.ax}) for ${k.name} was trusted by the deployer: re-approve it by a PrivacyParameters vote or untrust it`;
      warnings.push(w);
      residual.push(w);
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
      const w = `PrivacyManager whitelist root ${last.args.root} (version ${last.args.version}) was published by ${who}: republish as ops so deployer-era bindings lapse`;
      warnings.push(w);
      residual.push(w);
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
  // Review D2-2: read through pinned code only.
  if (pmAddr && pins.every((c) => c.ok)) {
    const pm = await ethers.getContractAt("PrivacyManager", pmAddr);
    lines.push(...(await swapLines(o, pm, uniq([used, zkAddr]), ops, govAddr)));
  }
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

module.exports = {
  wiredPrivacy,
  preflightPrivacy,
  privacySteps,
  privacyLines,
  deployerTrustedAttestors,
};
