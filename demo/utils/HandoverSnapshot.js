/**
 * @fileoverview Handover ceremony, plan v2 Task 4.13: the preflight
 * snapshot. handoverDeployerPowers records every derived address and
 * live set it found before step 1; the completion check re-derives and
 * compares: no contract may differ and nothing may appear that the
 * ceremony itself did not grant (ops as agent and officer, issuerAdmin's
 * key, governance as rule administrator). A deployer that prepares the
 * chain between the preflight and step 4 (it still owns everything until
 * the votes) is therefore caught even where the exact-set lines would
 * tolerate the newcomer.
 */

const { addrOf, same } = require("./HandoverChecks");

/**
 * M-1: the snapshots this process took, by governance address. A caller
 * that spread its arguments (the tests' `{ ...args }`) still gets its own
 * preflight back; another process (HANDOVER_PHASE=accept, a demo
 * restart) has nothing here and must pass the persisted snapshot.
 */
const preflightSnapshots = new Map();
const { roleFacts } = require("./HandoverRoles");
const { trustFacts } = require("./HandoverTrust");
const { nodeFacts } = require("./HandoverNodes");

/** Every derived address and live set, as plain strings. */
async function snapshotFacts(o) {
  const r = await roleFacts(o);
  const t = await trustFacts(o);
  const n = await nodeFacts(o);
  const derived = {};
  for (const key of Object.keys(o.derivedFrom || {})) {
    if (o[key]) derived[key] = await addrOf(o[key]);
  }
  const issuerKeys = {};
  for (const i of r.issuers) {
    issuerKeys[await addrOf(i.issuer)] = i.keys.map((k) => k.hash);
  }
  return {
    derived,
    sets: {
      "Token agents": r.vscAgents.live,
      "GovernanceToken agents": r.vgtAgents.live,
      "IdentityRegistry agents": r.regAgents.live,
      "InvestorTypeRegistry officers": r.officers.live,
      "InvestorTypeRegistry governors": r.governors,
      "InvestorTypeRegistry authorized tokens": r.authorized.live,
      "investorLimitExempt accounts": r.exempt,
      "OracleManager nodes": n.nodes.map((x) => x.addr),
      "emergency designations": n.designated,
      "trusted contracts": t.trusted.map((x) => `${x.account} on ${x.token}`),
      registrars: t.registrars.map((x) => `${x.registrar} on ${x.token}`),
    },
    issuerKeys,
    proposalCount: Number(await o.governance.proposalCount()),
  };
}

/**
 * Completion lines against `snap` (from handoverDeployerPowers): the
 * derived addresses are unchanged and no set grew beyond what the
 * ceremony grants. [label, pass][].
 */
async function snapshotLines(o, snap) {
  if (!snap) return [];
  const now = await snapshotFacts(o);
  const ops = await addrOf(o.ops);
  const admin = o.issuerAdmin ? await addrOf(o.issuerAdmin) : null;
  const keyOf = require("./HandoverChecks").keyOf;
  const lines = [];
  const moved = Object.keys(now.derived).filter(
    (k) => snap.derived[k] && !same(snap.derived[k], now.derived[k]),
  );
  lines.push([
    moved.length
      ? `derived contract(s) changed since the preflight: ${moved.map((k) => `${k} ${snap.derived[k]} -> ${now.derived[k]}`).join(", ")}`
      : `every derived contract is the one the preflight found (${Object.keys(now.derived).length})`,
    moved.length === 0,
  ]);
  const vsc = await addrOf(o.token);
  const grants = {
    "InvestorTypeRegistry authorized tokens": [vsc],
    "Token agents": [ops],
    "GovernanceToken agents": [ops],
    "IdentityRegistry agents": [ops],
    "InvestorTypeRegistry officers": [ops],
  };
  const grew = [];
  for (const [name, set] of Object.entries(now.sets)) {
    const before = snap.sets[name] || [];
    const allowed = grants[name] || [];
    for (const x of set) {
      if (before.some((b) => same(b, x))) continue;
      if (allowed.some((a) => same(a, x))) continue;
      grew.push(`${x} in ${name}`);
    }
  }
  for (const [issuer, keys] of Object.entries(now.issuerKeys)) {
    const before = snap.issuerKeys[issuer] || [];
    for (const k of keys) {
      if (before.includes(k) || (admin && k === keyOf(admin))) continue;
      grew.push(`key ${k} on issuer ${issuer}`);
    }
  }
  lines.push([
    grew.length
      ? `appeared after the preflight, not granted by the ceremony: ${grew.join(", ")}`
      : "nothing appeared after the preflight that the ceremony did not grant",
    grew.length === 0,
  ]);
  return lines;
}

module.exports = { preflightSnapshots, snapshotFacts, snapshotLines };
