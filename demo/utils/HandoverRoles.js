/**
 * @fileoverview Handover ceremony, plan v2 Task 4.13 (A1 H1, B G-1/G-5):
 * every live role holder, from the event scans, against the exact set
 * the handed-over system allows.
 *
 * Agents: {ops} on VSC, {ops, governance} on VGT (governance burns the
 * fee deposits), {ops, VSC, VGT} on the IdentityRegistry (the tokens
 * call moveIdentity on recovery, W-1). InvestorTypeRegistry officers:
 * ops plus officer contracts (checked in HandoverTrust.js). Authorized
 * tokens: VSC only. Issuer keys: on an issuer the deployer hands over,
 * only the deployer's (until step 1) and issuerAdmin's; on any trusted
 * issuer no key of the deployer, ops, the guardian, governance, a
 * registry agent or an oracle node (D25 b extended). Before step 1 the
 * deployer may still hold what step 5 removes; a stray is refused, never
 * removed silently (R-413-4): the refusal names the owner call, and demo
 * option 83c offers to send it. Exemptions are residue warnings.
 */

const { ethers } = require("hardhat");
const { addrOf, same, keyOf, fail } = require("./HandoverChecks");
const { uniq, scanLogs } = require("./HandoverScans");
const { registryGovernors } = require("./HandoverPowers");

const MANAGEMENT_KEY = 1;
const CLAIM_SIGNER_KEY = 3;
const PURPOSE = { 1: "MANAGEMENT", 3: "CLAIM_SIGNER" };

/** Live agents of `c`: AgentAdded events plus `extra`, filtered by isAgent. */
async function liveAgents(c, o, extra = []) {
  const seen = uniq([
    ...(await scanLogs(c, c.filters.AgentAdded(), o)).map((ev) => ev.args[0]),
    ...extra,
  ]);
  const live = [];
  for (const a of seen) if (await c.isAgent(a)) live.push(a);
  return live;
}

/** Live compliance officers (the constructor's deployer emits no event). */
async function liveOfficers(reg, o, extra = []) {
  const evs = await scanLogs(reg, reg.filters.ComplianceOfficerUpdated(), o);
  const seen = uniq([...evs.map((ev) => ev.args[0]), ...extra]);
  const live = [];
  for (const a of seen) if (await reg.isComplianceOfficer(a)) live.push(a);
  return live;
}

/** Live authorized tokens of the registry (TokenAuthorized events). */
async function liveAuthorized(reg, o) {
  const evs = await scanLogs(reg, reg.filters.TokenAuthorized(), o);
  const live = [];
  for (const a of uniq(evs.map((ev) => ev.args[0])))
    if (await reg.isTokenAuthorized(a)) live.push(a);
  return live;
}

/** Live investorLimitExempt accounts (InvestorLimitExemptionUpdated). */
async function liveExempt(reg, o) {
  const f = reg.filters.InvestorLimitExemptionUpdated();
  const evs = await scanLogs(reg, f, o);
  const live = [];
  for (const a of uniq(evs.map((ev) => ev.args[0])))
    if (await reg.investorLimitExempt(a)) live.push(a);
  return live;
}

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
 * officers, governors, authorized, exempt, nodes, issuers: [{ issuer,
 * label, owner, handed, keys }] }. `o` from withDerivedContracts.
 */
async function roleFacts(o) {
  const [dAddr, ops, govAddr] = await Promise.all(
    [o.deployer, o.ops, o.governance].map(addrOf),
  );
  const [vsc, vgt] = await Promise.all(
    [o.token, o.governanceToken].map(addrOf),
  );
  const reg = o.investorTypeRegistry;
  const facts = {
    dAddr,
    ops,
    govAddr,
    vsc,
    vgt,
    vscAgents: await liveAgents(o.token, o, [dAddr, ops]),
    vgtAgents: await liveAgents(o.governanceToken, o, [dAddr, ops, govAddr]),
    regAgents: await liveAgents(o.identityRegistry, o, [dAddr, ops, vsc, vgt]),
    officers: reg ? await liveOfficers(reg, o, [dAddr, ops]) : [],
    governors: reg ? await registryGovernors(o, reg) : [],
    authorized: reg ? await liveAuthorized(reg, o) : [],
    exempt: reg ? await liveExempt(reg, o) : [],
    nodes: await o.oracleManager.getRegisteredOracles(),
    issuers: [],
  };
  const issuerAdmin = o.issuerAdmin ? await addrOf(o.issuerAdmin) : null;
  for (const issuer of o.issuers || []) {
    const owner = await issuer.owner();
    const keys = await liveIssuerKeys(issuer);
    const dKey = keyOf(dAddr);
    facts.issuers.push({
      issuer,
      label: `${(await issuer.issuerName().catch(() => "")) || "ClaimIssuer"} (${await addrOf(issuer)})`,
      owner,
      handed:
        same(owner, dAddr) ||
        keys.some((k) => k.hash === dKey) ||
        (issuerAdmin !== null && same(owner, issuerAdmin)),
      keys,
    });
  }
  return facts;
}

const list = (xs) => xs.join(", ");
const isCode = async (a) => (await ethers.provider.getCode(a)) !== "0x";

/**
 * The role findings for `phase` ("preflight": before step 1, the deployer
 * may still hold what step 5 removes; "completion": the exact sets).
 * Returns [{ label, ok, fix, strays: [{ what, fn, args, on }] }].
 */
async function roleChecks(o, phase, f = null) {
  f = f || (await roleFacts(o));
  const pre = phase === "preflight";
  const { dAddr, ops, govAddr, vsc, vgt } = f;
  const out = [];
  const exact = (label, live, allowed, required, on, who) => {
    const strays = live.filter((a) => !allowed.some((b) => same(a, b)));
    // Step 1 grants ops: before it, ops is allowed but not yet required.
    const must = pre ? required.filter((a) => !same(a, ops)) : required;
    const missing = must.filter((a) => !live.some((b) => same(a, b)));
    const ok = strays.length === 0 && missing.length === 0;
    out.push({
      label: `${label} agents are exactly {${list(required)}}${pre ? " plus the deployer" : ""}`,
      ok,
      fix: strays.length
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
  exact(
    "Token",
    f.vscAgents,
    [dAddr, ops],
    [ops],
    o.token,
    "the deployer and ops",
  );
  exact(
    "GovernanceToken",
    f.vgtAgents,
    [dAddr, ops, govAddr],
    [ops, govAddr],
    o.governanceToken,
    "the deployer, ops and governance",
  );
  exact(
    "IdentityRegistry",
    f.regAgents,
    [dAddr, ops, vsc, vgt],
    [ops, vsc, vgt],
    o.identityRegistry,
    "the deployer, ops, VSC and VGT (recovery)",
  );
  const reg = o.investorTypeRegistry;
  if (reg) {
    const eoas = [];
    for (const a of f.officers) if (!(await isCode(a))) eoas.push(a);
    const allowed = pre ? [dAddr, ops] : [ops];
    const strays = eoas.filter((a) => !allowed.some((b) => same(a, b)));
    out.push({
      label: `InvestorTypeRegistry compliance officers are ops and officer contracts only${pre ? " (plus the deployer)" : ""}`,
      ok: strays.length === 0,
      fix: `InvestorTypeRegistry compliance officer wallet(s) ${list(strays)} besides ${pre ? "the deployer and ops" : "ops"}: a wallet officer assigns investor types (caps, cooldowns) after the handover; the registry owner must setComplianceOfficer(<wallet>, false) first`,
      strays: strays.map((a) => ({
        what: `InvestorTypeRegistry compliance officer ${a}`,
        on: reg,
        fn: "setComplianceOfficer",
        args: [a, false],
      })),
    });
    const others = f.authorized.filter((a) => !same(a, vsc));
    out.push({
      label: "InvestorTypeRegistry authorizes no token but VSC",
      ok: others.length === 0,
      fix: `InvestorTypeRegistry authorizes ${list(others)} besides VSC: an authorized token writes every holder's cooldown clock; the registry owner must authorizeToken(<token>, false) first`,
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

/** Issuer key findings (D25 b extended): one per issuer. */
async function issuerKeyChecks(o, f, pre) {
  const { dAddr, ops, govAddr } = f;
  const guardian = await addrOf(o.guardian);
  const issuerAdmin = o.issuerAdmin ? await addrOf(o.issuerAdmin) : null;
  const out = [];
  const regAgents = f.regAgents.filter(
    (a) => !same(a, f.vsc) && !same(a, f.vgt),
  );
  const roles = [
    ...(pre ? [] : [[dAddr, "the deployer"]]),
    [ops, "ops"],
    [guardian, "the guardian"],
    [govAddr, "governance"],
    ...regAgents
      .filter((a) => !same(a, ops) && !same(a, dAddr))
      .map((a) => [a, `registry agent ${a}`]),
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
    if (!i.handed) continue;
    const known = [keyOf(dAddr), issuerAdmin && keyOf(issuerAdmin)].filter(
      Boolean,
    );
    const unknown = i.keys.filter(
      (k) => !known.includes(k.hash) || (!pre && k.hash === keyOf(dAddr)),
    );
    out.push({
      label: `${i.label}: every live key is ${pre ? "the deployer's or " : ""}issuerAdmin's`,
      ok: unknown.length === 0,
      fix: `${i.label} carries live ${unknown.map((k) => `${PURPOSE[k.purpose]} key ${k.hash}`).join(", ")} that is neither the deployer's nor issuerAdmin's: it keeps attesting after the handover; the deployer (a MANAGEMENT key) must revokeIssuerKey(<hash>) first`,
      strays: unknown.map((k) => ({
        what: `${i.label} ${PURPOSE[k.purpose]} key ${k.hash}`,
        on: i.issuer,
        fn: "revokeIssuerKey",
        args: [k.hash],
      })),
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
    if (same(a, f.dAddr)) continue; // the treasury artifact has its own line
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
