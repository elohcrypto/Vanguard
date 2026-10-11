/**
 * @fileoverview Handover ceremony, plan v2 Task 4.13 (A1 H1, B G-1/G-5):
 * every live role holder, from the event scans, against the exact set
 * the handed-over system allows.
 *
 * Agents: {ops} on VSC, {ops, governance} on VGT (governance burns the
 * fee deposits), {ops, VSC, VGT} on the IdentityRegistry (the tokens
 * call moveIdentity on recovery, W-1). InvestorTypeRegistry officers:
 * ops plus officer contracts (checked in HandoverTrust.js). Authorized
 * tokens: VSC only. Issuer keys (direct reads, R-413-7): every trusted
 * issuer ends owned by issuerAdmin with issuerAdmin's the only live
 * MANAGEMENT/CLAIM_SIGNER key (the deployer's allowed until step 1), and
 * no key of ops, the guardian, governance, a registry agent or an oracle
 * node anywhere (D25 b extended). A stray is refused, never removed
 * silently (R-413-4): the refusal names the owner call, and demo option
 * 83c offers to send it. R-413-6: every scan keeps its raw hits and a
 * line fails when the scan did not find the holders granted by event
 * (governance on VGT, VSC and VGT on the registry, ops after step 1), so
 * an empty scan is never read as "no strays". Exemptions are residue
 * warnings.
 */

const { ethers } = require("hardhat");
const { addrOf, same, keyOf, fail } = require("./HandoverChecks");
const { uniq, scanLogs } = require("./HandoverScans");
const { registryGovernors } = require("./HandoverPowers");

const MANAGEMENT_KEY = 1;
const CLAIM_SIGNER_KEY = 3;
const PURPOSE = { 1: "MANAGEMENT", 3: "CLAIM_SIGNER" };
const NONE = { live: [], hits: [] };

/**
 * { live, hits }: the raw event hits (so a line can prove the scan ran)
 * plus `extra` candidates read directly, filtered by `isLive`.
 */
async function scannedSet(c, filter, o, extra, isLive, proven = [], what = "") {
  const hits = uniq((await scanLogs(c, filter, o)).map((ev) => ev.args[0]));
  const live = [];
  for (const a of uniq([...hits, ...extra])) if (await isLive(a)) live.push(a);
  // R-413-6 (M-3): a `proven` candidate that is live was granted by event
  // (never by a constructor), so it must appear in the scan.
  const missed = live.filter(
    (a) => proven.some((p) => same(p, a)) && !hits.some((h) => same(h, a)),
  );
  if (missed.length) {
    fail(
      `${what} event scan found none of the holders it must see (${missed.join(", ")}; scan hits ${hits.length}, live ${live.length}): fromBlock, logChunk or the RPC is wrong; nothing can be concluded from it`,
    );
  }
  return { live, hits };
}

/**
 * Live agents of `c`: AgentAdded events plus `extra`, filtered by isAgent;
 * `proven` are the extras granted by event (not the constructor's).
 */
const liveAgents = (c, o, extra = [], proven = [], what = "AgentAdded") =>
  scannedSet(
    c,
    c.filters.AgentAdded(),
    o,
    extra,
    (a) => c.isAgent(a),
    proven,
    what,
  );

/** Live compliance officers (the constructor's deployer emits no event). */
const liveOfficers = (reg, o, extra = [], proven = []) =>
  scannedSet(
    reg,
    reg.filters.ComplianceOfficerUpdated(),
    o,
    extra,
    (a) => reg.isComplianceOfficer(a),
    proven,
    "InvestorTypeRegistry ComplianceOfficerUpdated",
  );

/** Live authorized tokens: every authorization emits, so extras are proven. */
const liveAuthorized = (reg, o, extra = []) =>
  scannedSet(
    reg,
    reg.filters.TokenAuthorized(),
    o,
    extra,
    (a) => reg.isTokenAuthorized(a),
    extra,
    "InvestorTypeRegistry TokenAuthorized",
  );

/** Live investorLimitExempt accounts: every exemption emits, extras proven. */
const liveExempt = (reg, o, extra = []) =>
  scannedSet(
    reg,
    reg.filters.InvestorLimitExemptionUpdated(),
    o,
    extra,
    (a) => reg.investorLimitExempt(a),
    extra,
    "InvestorTypeRegistry InvestorLimitExemptionUpdated",
  );

/** Live MANAGEMENT and CLAIM_SIGNER keys of an issuer: [{ hash, purpose }]. */
async function liveIssuerKeys(issuer) {
  const out = [];
  for (const purpose of [MANAGEMENT_KEY, CLAIM_SIGNER_KEY]) {
    for (const hash of await issuer.getKeysByPurpose(purpose)) {
      const k = await issuer.issuerKeys(hash);
      if (k.key !== ethers.ZeroHash && !k.revoked)
        out.push({ hash, purpose: Number(k.purpose) });
    }
  }
  return out;
}

/**
 * Every live role set, read once: { vscAgents, vgtAgents, regAgents,
 * officers, authorized } as { live, hits }; governors, exempt, nodes as
 * lists; issuers: [{ issuer, label, owner, keys }]. `o` from
 * withDerivedContracts.
 */
async function roleFacts(o) {
  const [dAddr, ops, govAddr] = await Promise.all(
    [o.deployer, o.ops, o.governance].map(addrOf),
  );
  const [vsc, vgt] = await Promise.all(
    [o.token, o.governanceToken].map(addrOf),
  );
  const reg = o.investorTypeRegistry;
  const fee = await Promise.all((o.feeWallets || []).map(addrOf));
  const facts = {
    dAddr,
    ops,
    govAddr,
    vsc,
    vgt,
    vscAgents: await liveAgents(
      o.token,
      o,
      [dAddr, ops],
      [ops],
      "Token AgentAdded",
    ),
    vgtAgents: await liveAgents(
      o.governanceToken,
      o,
      [dAddr, ops, govAddr],
      [ops, govAddr],
      "GovernanceToken AgentAdded",
    ),
    regAgents: await liveAgents(
      o.identityRegistry,
      o,
      [dAddr, ops, vsc, vgt],
      [ops, vsc, vgt],
      "IdentityRegistry AgentAdded",
    ),
    officers: reg ? await liveOfficers(reg, o, [dAddr, ops], [ops]) : NONE,
    governors: reg ? await registryGovernors(o, reg) : [],
    authorized: reg ? await liveAuthorized(reg, o, [vsc, vgt]) : NONE,
    exempt: reg ? (await liveExempt(reg, o, [dAddr, ops, ...fee])).live : [],
    nodes: await o.oracleManager.getRegisteredOracles(),
    issuers: [],
  };
  for (const issuer of o.issuers || []) {
    facts.issuers.push({
      issuer,
      label: `${(await issuer.issuerName().catch(() => "")) || "ClaimIssuer"} (${await addrOf(issuer)})`,
      owner: await issuer.owner(),
      keys: await liveIssuerKeys(issuer),
    });
  }
  return facts;
}

const list = (xs) => xs.join(", ");
const isCode = async (a) => (await ethers.provider.getCode(a)) !== "0x";
const unseen = (hits, mustSee) =>
  mustSee.filter((a) => !hits.some((b) => same(a, b)));
const scanFix = (label, missed) =>
  `${label} event scan found none of the holders it must see (${list(missed)}): fromBlock, logChunk or the RPC is wrong; nothing can be concluded from it`;

/**
 * The role findings for `phase` ("preflight": before step 1, the deployer
 * may still hold what step 5 removes; "completion": the exact sets).
 * Returns [{ label, ok, fix, strays: [{ what, on, fn, args }] }].
 */
async function roleChecks(o, phase, f = null) {
  f = f || (await roleFacts(o));
  const pre = phase === "preflight";
  const { dAddr, ops, govAddr, vsc, vgt } = f;
  const out = [];
  const exact = (label, set, allowed, required, mustSee, on, who) => {
    const strays = set.live.filter((a) => !allowed.some((b) => same(a, b)));
    // Step 1 grants ops: before it, ops is allowed but not yet required;
    // after it the scan must have seen ops's AgentAdded as well.
    const must = pre ? required.filter((a) => !same(a, ops)) : required;
    const missing = must.filter((a) => !set.live.some((b) => same(a, b)));
    // Only a holder that IS live proves the scan: its grant event exists.
    const must2 = (pre ? mustSee : [...mustSee, ops]).filter((a) =>
      set.live.some((b) => same(a, b)),
    );
    const missed = unseen(set.hits, must2);
    out.push({
      label: `${label} agents are exactly {${list(required)}}${pre ? " plus the deployer" : ""} (AgentAdded scan)`,
      ok: strays.length === 0 && missing.length === 0 && missed.length === 0,
      fix: missed.length
        ? scanFix(`${label} AgentAdded`, missed)
        : strays.length
          ? `${label} agent(s) ${list(strays)} besides ${who}: after the handover they could mint, freeze or move holders; the ${label} owner must removeAgent(...) each of them first`
          : `${label} is missing agent(s) ${list(missing)}: the ${label} owner must addAgent(...) them first`,
      strays: strays.map((a) => ({
        what: `${label} agent ${a}`,
        on,
        fn: "removeAgent",
        args: [a],
      })),
    });
  };
  // VSC: the constructor grants the deployer without an event; ops is
  // granted by event at step 1, so completion sees it.
  exact(
    "Token",
    f.vscAgents,
    [dAddr, ops],
    [ops],
    [],
    o.token,
    "the deployer and ops",
  );
  exact(
    "GovernanceToken",
    f.vgtAgents,
    [dAddr, ops, govAddr],
    [ops, govAddr],
    [govAddr],
    o.governanceToken,
    "the deployer, ops and governance",
  );
  exact(
    "IdentityRegistry",
    f.regAgents,
    [dAddr, ops, vsc, vgt],
    [ops, vsc, vgt],
    [vsc, vgt],
    o.identityRegistry,
    "the deployer, ops, VSC and VGT (recovery)",
  );
  const reg = o.investorTypeRegistry;
  if (reg) {
    const eoas = [];
    for (const a of f.officers.live) if (!(await isCode(a))) eoas.push(a);
    const allowed = pre ? [dAddr, ops] : [ops];
    const strays = eoas.filter((a) => !allowed.some((b) => same(a, b)));
    // The constructor's deployer emits no event; ops is set by event at
    // step 1, so completion proves this scan by seeing ops.
    const opsLive = f.officers.live.some((a) => same(a, ops));
    const missed = pre || !opsLive ? [] : unseen(f.officers.hits, [ops]);
    out.push({
      label: `InvestorTypeRegistry compliance officers are ops and officer contracts only${pre ? " (plus the deployer)" : ""} (ComplianceOfficerUpdated scan)`,
      ok: strays.length === 0 && missed.length === 0,
      fix: missed.length
        ? scanFix("InvestorTypeRegistry ComplianceOfficerUpdated", missed)
        : `InvestorTypeRegistry compliance officer wallet(s) ${list(strays)} besides ${pre ? "the deployer and ops" : "ops"}: a wallet officer assigns investor types (caps, cooldowns) after the handover; the registry owner must setComplianceOfficer(<wallet>, false) first`,
      strays: strays.map((a) => ({
        what: `InvestorTypeRegistry compliance officer ${a}`,
        on: reg,
        fn: "setComplianceOfficer",
        args: [a, false],
      })),
    });
    // VSC is read directly; when it is authorized the scan must have
    // seen its TokenAuthorized event.
    const others = f.authorized.live.filter((a) => !same(a, vsc));
    const vscAuth = f.authorized.live.some((a) => same(a, vsc));
    const missedAuth = vscAuth ? unseen(f.authorized.hits, [vsc]) : [];
    out.push({
      label:
        "InvestorTypeRegistry authorizes no token but VSC (TokenAuthorized scan)",
      ok: others.length === 0 && missedAuth.length === 0,
      fix: missedAuth.length
        ? scanFix("InvestorTypeRegistry TokenAuthorized", missedAuth)
        : `InvestorTypeRegistry authorizes ${list(others)} besides VSC: an authorized token writes every holder's cooldown clock; the registry owner must authorizeToken(<token>, false) first`,
      strays: others.map((a) => ({
        what: `InvestorTypeRegistry authorized token ${a}`,
        on: reg,
        fn: "authorizeToken",
        args: [a, false],
      })),
    });
  }
  out.push(...(await issuerKeyChecks(o, f, pre)));
  return out;
}

/**
 * Issuer key findings, two lines per trusted issuer, from direct reads
 * (getKeysByPurpose; no scan). R-413-7: every trusted issuer, whoever
 * owns it, must end owned by issuerAdmin with issuerAdmin's the only key;
 * one the ceremony cannot bring there (owned by a third party) fails
 * rather than being skipped, since that is exactly the issuer a deployer
 * would leave outside its own handover.
 */
async function issuerKeyChecks(o, f, pre) {
  const { dAddr, ops, govAddr } = f;
  const guardian = await addrOf(o.guardian);
  const issuerAdmin = o.issuerAdmin ? await addrOf(o.issuerAdmin) : null;
  const out = [];
  const agents = f.regAgents.live.filter(
    (a) => ![f.vsc, f.vgt, ops, dAddr].some((b) => same(a, b)),
  );
  const roles = [
    ...(pre ? [] : [[dAddr, "the deployer"]]),
    [ops, "ops"],
    [guardian, "the guardian"],
    [govAddr, "governance"],
    ...agents.map((a) => [a, `registry agent ${a}`]),
    ...f.nodes.map((n) => [n, `oracle node ${n}`]),
  ];
  for (const i of f.issuers) {
    const held = [];
    for (const k of i.keys) {
      const r = roles.find(([a]) => keyOf(a) === k.hash);
      if (r) held.push(`${r[1]} (${PURPOSE[k.purpose]})`);
    }
    out.push({
      label: `${i.label}: no key of the deployer, ops, the guardian, governance, a registry agent or an oracle node (D25 b)`,
      ok: held.length === 0,
      fix: `${i.label} carries a live key of ${list(held)}: one key would both run the system and attest identities (D25 b); its owner must revokeIssuerKey first`,
      strays: [],
    });
    const mine = same(i.owner, dAddr);
    const adminOwned = issuerAdmin !== null && same(i.owner, issuerAdmin);
    const okOwner = adminOwned || (pre && mine);
    const known = [issuerAdmin && keyOf(issuerAdmin), pre && keyOf(dAddr)];
    const unknown = i.keys.filter((k) => !known.includes(k.hash));
    out.push({
      label: `${i.label}: owned by ${pre ? "the deployer or " : ""}issuerAdmin and every live key is ${pre ? "the deployer's or " : ""}issuerAdmin's`,
      ok: okOwner && unknown.length === 0,
      fix: !okOwner
        ? `${i.label} is owned by ${i.owner}, neither the deployer nor issuerAdmin: the ceremony cannot bring it under issuerAdmin; its owner must transferOwnership(issuerAdmin) (issuerAdmin accepts) and revoke its own keys first, or the IdentityRegistry owner must removeTrustedIssuer(it)`
        : `${i.label} carries live ${unknown.map((k) => `${PURPOSE[k.purpose]} key ${k.hash}`).join(", ")} that is neither the deployer's nor issuerAdmin's: it keeps attesting after the handover; ${mine ? "the deployer (a MANAGEMENT key)" : "issuerAdmin"} must revokeIssuerKey(<hash>) first`,
      strays: mine
        ? unknown.map((k) => ({
            what: `${i.label} ${PURPOSE[k.purpose]} key ${k.hash}`,
            on: i.issuer,
            fn: "revokeIssuerKey",
            args: [k.hash],
          }))
        : [],
    });
  }
  return out;
}

/** Read-only, before the first transaction: refuse the first stray. */
async function preflightRoles(o) {
  for (const c of await roleChecks(o, "preflight")) if (!c.ok) fail(c.fix);
}

/** Completion lines: [label, pass][]; exemptions go to `warnings`. */
async function roleLines(o, warnings = []) {
  const f = await roleFacts(o);
  for (const a of f.exempt) {
    // The deployer's exemption is read directly, not from the scan, by
    // HandoverCompletion.residueWarnings ("deployer still holds ... VSC
    // (investorLimitExempt: true ...)"), which covers the same power.
    if (same(a, f.dAddr)) continue;
    warnings.push(
      `${a} is investorLimitExempt (set before the handover): it bypasses every investor-type cap; only an InvestorTypeConfig vote can remove it`,
    );
  }
  return (await roleChecks(o, "completion", f)).map((c) => [c.label, c.ok]);
}

/** The strays a deployer-owner call removes: [{ what, on, fn, args }]. */
async function roleStrays(o) {
  const out = [];
  for (const c of await roleChecks(o, "preflight")) out.push(...c.strays);
  return out;
}

module.exports = {
  scannedSet,
  liveAgents,
  liveOfficers,
  liveAuthorized,
  liveExempt,
  liveIssuerKeys,
  roleFacts,
  roleChecks,
  preflightRoles,
  roleLines,
  roleStrays,
};
