/**
 * @fileoverview Handover ceremony, plan v2 Task 4.13 (A1 M3, B G-6/G-7,
 * D50): the OracleManager's nodes and the list oracles.
 *
 * Consensus power stays with whoever holds the node keys, so every
 * registered node must be acknowledged in the config's `oracleNodes`
 * (empty on a first handover: production nodes are registered by vote
 * after it); the deployer is never a node; an emergency designation (a
 * node that may emergencyBlacklist anyone at once) must sit on an
 * acknowledged node, and step 5 clears every designation the deployer
 * era left while the deployer still owns the manager. The ceremony
 * prints each node's provenance (who sent its OracleRegistered) as a
 * residual warning when that was the deployer (D50: rotate by vote; the
 * day-2 audit skips only a node a governance execution registered,
 * R-56c-1). Completion and the audit fail a set of 1 to MIN_NODES - 1
 * nodes (Task 5.17, deep review M-4: no query opens, so the lists freeze;
 * 0 nodes, before production nodes are voted in, stays a warning), print
 * each node's weight share (n/a below MIN_NODES) and fail when one node
 * alone reaches the bar (Task 5.1, A1F-4: the engine then opens no
 * query). No node may be the deployer, or hold another role key (deep
 * review M-5, D25 b: a node is a key of its own; HandoverNodeKeys.js). Each
 * list oracle's minimumConsensusOracles must be reachable by the fewest
 * registered nodes that reach the bar (deep review contracts L-2). Each list oracle bound to VSC
 * or VGT must carry the compiled WhitelistOracle or BlacklistOracle
 * code, not be paused, require at least two consensus oracles and keep a
 * sane maxVerdictAge; its manager link is HandoverDerive.js.
 */

const { ethers } = require("hardhat");
const { addrOf, same, fail } = require("./HandoverChecks");
const { scanLogs } = require("./HandoverScans");
const { roleOf } = require("./HandoverNodeKeys");
const {
  pinChecks,
  codeHashLabel,
  codeHashRefusal,
} = require("./HandoverCodeHash");

const LIST_ABI = [
  "function paused() view returns (bool)",
  "function active() view returns (bool)",
  "function maxVerdictAge() view returns (uint256)",
  "function minimumConsensusOracles() view returns (uint8)",
  "function oracleName() view returns (string)",
];
const MIN_CONSENSUS = 2;
const ZERO = ethers.ZeroAddress;
const list = (xs) => xs.join(", ");

const EXECUTED = ethers.id("ProposalExecuted(uint256)");

/**
 * R-56c-1: the registering transaction was sent to governance and its
 * receipt carries governance's ProposalExecuted (a vote's execution,
 * whoever sent it), not a call the deployer made itself.
 */
async function viaGovernance(tx, gov) {
  if (!tx.to || !same(tx.to, gov)) return false;
  const rc = await ethers.provider.getTransactionReceipt(tx.hash);
  return rc.logs.some((l) => same(l.address, gov) && l.topics[0] === EXECUTED);
}

/**
 * { nodes: [{ addr, name, registeredBy, block, byGovernance }],
 * designated: [addr],
 * minNodes }: the live node list and each node's designation are direct
 * reads; the OracleRegistered scan adds provenance only.
 */
async function nodeFacts(o) {
  const om = o.oracleManager;
  const live = await om.getRegisteredOracles();
  const regs = await scanLogs(om, om.filters.OracleRegistered(), o);
  // R-413-6 (M-3): every live node was registered by event.
  const missed = live.filter((a) => !regs.some((e) => same(e.args[0], a)));
  if (missed.length) {
    fail(
      `OracleManager OracleRegistered event scan found none of the holders it must see (${missed.join(", ")}): fromBlock, logChunk or the RPC is wrong; nothing can be concluded from it`,
    );
  }
  const nodes = [];
  const gov = o.governance ? await addrOf(o.governance) : null;
  for (const addr of live) {
    const ev = regs.filter((e) => same(e.args[0], addr)).at(-1);
    const tx = ev && (await ethers.provider.getTransaction(ev.transactionHash));
    nodes.push({
      addr,
      name: ev ? ev.args[1] : "?",
      registeredBy: tx ? tx.from : null,
      block: ev ? ev.blockNumber : null,
      byGovernance: Boolean(gov && tx && (await viaGovernance(tx, gov))),
    });
  }
  // R-413-6: a designation can only sit on a registered node
  // (onlyRegistered), so every node is read directly; no scan to miss.
  const designated = [];
  for (const a of live) if (await om.isEmergencyOracle(a)) designated.push(a);
  const engine = await ethers.getContractAt(
    [
      "function MIN_NODES() view returns (uint256)",
      "function weightOf(address) view returns (uint256)",
      "function consensusThreshold() view returns (uint256)",
    ],
    await om.consensusEngine(),
  );
  const minNodes = Number(await engine.MIN_NODES().catch(() => 2));
  // Task 5.1 review I5: an unreadable weight or bar is null, and fails
  // the weight-share row rather than reading as 0.
  for (const n of nodes)
    n.weight = await engine.weightOf(n.addr).catch(() => null);
  const threshold = await engine.consensusThreshold().catch(() => null);
  return { nodes, designated, minNodes, threshold };
}

/**
 * Task 5.1 (A1F-4): each node's share of the registered weight, and
 * whether the heaviest alone reaches the bar (the engine then refuses
 * every query: SingleNodeQuorum).
 */
function weightShares(f) {
  const unreadable = f.nodes
    .filter((n) => n.weight === null)
    .map((n) => n.addr);
  if (unreadable.length || f.threshold === null)
    return { shares: [], heavy: { weight: null }, alone: null, unreadable };
  const total = f.nodes.reduce((t, n) => t + n.weight, 0n);
  const pct = (w) => (total ? Number((w * 1000n) / total) / 10 : 0);
  const heavy = f.nodes.reduce((m, n) => (n.weight > m.weight ? n : m), {
    weight: 0n,
  });
  return {
    shares: f.nodes.map((n) => `${n.addr} ${n.weight} (${pct(n.weight)}%)`),
    heavy,
    // Below MIN_NODES no query opens anyway; nodeLines warns about that.
    alone:
      f.nodes.length >= f.minNodes &&
      total > 0n &&
      heavy.weight * 100n >= total * f.threshold,
    unreadable,
  };
}

/** [{ label, ok, fix, strays }] for the nodes and designations. */
async function nodeChecks(o, f = null) {
  f = f || (await nodeFacts(o));
  const dAddr = await addrOf(o.deployer);
  const ack = await Promise.all((o.oracleNodes || []).map(addrOf));
  const live = f.nodes.map((n) => n.addr);
  const stray = live.filter((a) => !ack.some((b) => same(a, b)));
  const out = [];
  out.push({
    label: `the deployer ${dAddr} is not an OracleManager node`,
    ok: !live.some((a) => same(a, dAddr)),
    fix: `the deployer ${dAddr} is a registered OracleManager node: it would keep voting verdicts after the handover; the manager owner must removeOracle(deployer, ...) first`,
    strays: [],
  });
  const roles = [];
  for (const a of live) {
    const r = await roleOf(o, a);
    if (r) roles.push(`${a} (${r})`);
  }
  out.push({
    label:
      "no OracleManager node is ops, the guardian, the issuer admin, the proposer, a voter, a claim signer, the manager operator, a registry/VGT/VSC agent or a ClaimIssuer key",
    ok: roles.length === 0,
    fix: `OracleManager node(s) ${list(roles)} hold a role key: a node is a key of its own (D25 b), or one key both runs the system and votes its verdicts; the manager owner must removeOracle(node, ...) and register a node key of its own first`,
    strays: [],
  });
  out.push({
    label: `every registered OracleManager node is acknowledged in oracleNodes (${live.length} registered, ${ack.length} acknowledged)`,
    ok: stray.length === 0,
    fix: `OracleManager node(s) ${list(stray)} are registered but not acknowledged in the config's "oracleNodes": a node votes every whitelist and blacklist verdict; list each one the deployment stands behind, or have the manager owner removeOracle(node, ...) first`,
    strays: stray.map((a) => ({
      what: `OracleManager node ${a}`,
      on: o.oracleManager,
      fn: "removeOracle",
      args: [a, "handover: not acknowledged"],
    })),
  });
  const w = weightShares(f);
  const few = f.nodes.length > 0 && f.nodes.length < f.minNodes;
  out.push({
    label: `no OracleManager node alone reaches the ${f.threshold}% bar; weight shares: ${few ? "n/a (below MIN_NODES)" : list(w.shares) || (w.alone === null ? "unreadable" : "none")}`,
    // Below MIN_NODES the share is n/a: completion and the audit fail
    // that on their own MIN_NODES line (nodeLines).
    ok: w.alone === false,
    fix:
      w.alone === null
        ? `the ConsensusOracle engine did not answer weightOf (${list(w.unreadable) || "no node"}) or consensusThreshold (${f.threshold ?? "unreadable"}): no node's weight share can be checked; bind a working engine first`
        : `OracleManager node ${w.heavy.addr} holds ${w.heavy.weight} of the registered weight, at or above the ${f.threshold}% bar alone: the engine opens no query (SingleNodeQuorum); the manager owner must setOracleWeight(...) so no node reaches the bar alone first`,
    strays: [],
  });
  const unack = f.designated.filter((a) => !ack.some((b) => same(a, b)));
  out.push({
    label: `every emergency designation sits on an acknowledged node (${f.designated.length} designated)`,
    ok: unack.length === 0,
    fix: `emergency designation on node(s) ${list(unack)}, which oracleNodes does not acknowledge: a designated node blacklists anyone at once (emergencyBlacklist); ops (the operator) or the manager owner must setEmergencyOracle(node, false) first`,
    strays: unack.map((a) => ({
      what: `OracleManager emergency designation of ${a}`,
      on: o.oracleManager,
      fn: "setEmergencyOracle",
      args: [a, false],
    })),
  });
  return out;
}

/**
 * Task 5.17 (deep review contracts L-2): the fewest of `weights` (bigint,
 * the registered nodes') whose sum reaches `threshold`% of their total,
 * the votes a query can resolve with; null with no node or no weight.
 */
function fewestToReach(weights, threshold) {
  const total = weights.reduce((t, w) => t + w, 0n);
  if (!weights.length || total === 0n || threshold === null) return null;
  const desc = [...weights].sort((a, b) => (b > a ? 1 : b < a ? -1 : 0));
  let sum = 0n;
  for (const [i, w] of desc.entries()) {
    sum += w;
    if (sum * 100n >= total * BigInt(threshold)) return i + 1;
  }
  return desc.length;
}

/**
 * L-2: a list oracle's floor above `fewest` freezes every verdict: support
 * is fixed when the query resolves, and it resolves as soon as `fewest`
 * nodes reach the bar (TooFewVoters forever). The row, or null when
 * `fewest` is (below MIN_NODES nothing opens: that line covers it).
 */
function floorRow(label, min, fewest, threshold) {
  if (fewest === null || min === null) return null;
  return {
    label: `${label} minimumConsensusOracles (${min}) <= ${fewest}, the fewest registered nodes that reach the ${threshold}% bar`,
    ok: Number(min) <= fewest,
    fix: `${label} minimumConsensusOracles is ${min} but ${fewest} registered node(s) reach the ${threshold}% bar: a query resolves at ${fewest} vote(s) and takes no more, so every verdict fails TooFewVoters; ${
      fewest >= MIN_CONSENSUS
        ? `its owner must setMinimumConsensusOracles(${fewest}) (or the node weights change) first`
        : `no floor fits (it is at least ${MIN_CONSENSUS}): the node weights must change so no single node reaches the bar`
    }`,
  };
}

/** The list-oracle checks: [{ label, ok, fix }] plus the pins. */
async function listOracleChecks(o, f = null) {
  f = f || (await nodeFacts(o));
  // Below MIN_NODES no query opens: that line covers it (slice C ruling).
  const unread =
    f.nodes.length < f.minNodes || f.nodes.some((n) => n.weight === null);
  const fewest = unread
    ? null
    : fewestToReach(
        f.nodes.map((n) => n.weight),
        f.threshold,
      );
  const out = [];
  for (const oracle of o.oracles || []) {
    const a = await addrOf(oracle);
    const c = await ethers.getContractAt(LIST_ABI, a);
    const name = await c.oracleName().catch(() => "");
    const label = `list oracle ${a}${name ? ` (${name})` : ""}`;
    let kind = null;
    for (const n of ["WhitelistOracle", "BlacklistOracle"]) {
      const [pin] = await pinChecks([{ label: n, addr: a, name: n }]);
      if (pin.ok) kind = n;
      if (!kind && n === "BlacklistOracle") {
        out.push({
          label: codeHashLabel({
            ...pin,
            name: "WhitelistOracle or BlacklistOracle",
          }),
          ok: false,
          fix: codeHashRefusal({
            ...pin,
            name: "WhitelistOracle or BlacklistOracle",
          }),
        });
      }
    }
    if (kind) {
      out.push({
        label: `${label} code matches the compiled ${kind}`,
        ok: true,
      });
    }
    const paused = await c.paused().catch(() => null);
    const active = await c.active().catch(() => null);
    out.push({
      label: `${label} is not paused and is active`,
      ok: paused === false && active === true,
      fix: `${label} is ${paused ? "paused" : "inactive"}: a paused list freezes every verdict it holds (isBlacklisted keeps answering) and refuses updates; its owner must unpause() first`,
    });
    const min = await c.minimumConsensusOracles().catch(() => null);
    out.push({
      label: `${label} minimumConsensusOracles >= ${MIN_CONSENSUS} (${min})`,
      ok: min !== null && Number(min) >= MIN_CONSENSUS,
      fix: `${label} minimumConsensusOracles is ${min}: below ${MIN_CONSENSUS} one attestation would be a verdict; its owner must setMinimumConsensusOracles(${MIN_CONSENSUS}) first`,
    });
    const floor = floorRow(label, min, fewest, f.threshold);
    if (floor) out.push(floor);
    const age = await c.maxVerdictAge().catch(() => null);
    const sane = age !== null && age >= 3600n && age <= 30n * 86400n;
    out.push({
      label: `${label} maxVerdictAge is between 1 hour and 30 days (${age}s)`,
      ok: sane,
      fix: `${label} maxVerdictAge ${age}s is outside [1 hour, 30 days]; its owner must setMaxVerdictAge(...) first`,
    });
  }
  return out;
}

/**
 * Task 4.17 (review B PB5): the oracles the DynamicListManager writes.
 * Each must be the oracle of its kind ComplianceRules binds to VSC, or,
 * when none of that kind is bound, an oracle the ceremony hands to ops
 * (listed in `oracles` before step 2, owned by ops after it). Otherwise a
 * list vote lands on an oracle no token reads, or one the deployer keeps.
 */
async function listTargetChecks(o, pre) {
  const dlm = o.dynamicListManager;
  if (!dlm) return [];
  const vsc = await addrOf(o.token);
  const ops = await addrOf(o.ops);
  const handed = await Promise.all((o.oracles || []).map(addrOf));
  const out = [];
  for (const [kind, getter] of [
    ["whitelist", "whitelistOracle"],
    ["blacklist", "blacklistOracle"],
  ]) {
    const target = await dlm[getter]();
    if (same(target, ZERO)) continue;
    const bound = await o.complianceRules[getter](vsc);
    const owner = await (
      await ethers.getContractAt(
        ["function owner() view returns (address)"],
        target,
      )
    )
      .owner()
      .catch(() => ZERO);
    const ok = !same(bound, ZERO)
      ? same(bound, target)
      : pre
        ? handed.some((h) => same(h, target))
        : same(owner, ops);
    out.push({
      label: `DynamicListManager ${kind} oracle ${target} is the one ComplianceRules binds to VSC, or (none bound) one handed to ops`,
      ok,
      fix: `DynamicListManager writes ${kind} oracle ${target}, but ComplianceRules binds ${same(bound, ZERO) ? "none to VSC and the ceremony does not hand it to ops (owner " + owner + ")" : bound + " to VSC"}: list votes would land where no token reads, or on an oracle the deployer keeps; its owner must setOracles(...) to the bound oracles first`,
    });
  }
  return out;
}

/** Read-only, before the first transaction. */
async function preflightNodes(o) {
  const f = await nodeFacts(o);
  for (const c of await nodeChecks(o, f)) if (!c.ok) fail(c.fix);
  for (const c of await listOracleChecks(o, f)) if (!c.ok) fail(c.fix);
  for (const c of await listTargetChecks(o, true)) if (!c.ok) fail(c.fix);
}

/**
 * Step 5: clear every deployer-era emergency designation while the
 * deployer still owns the manager (or is its operator); otherwise say
 * who must (ops, the operator after step 2).
 */
async function nodeSteps({ o, d, dAddr, ok, log }) {
  const om = o.oracleManager;
  const { designated } = await nodeFacts(o);
  if (!designated.length) return ok("no emergency designation to clear");
  const may = same(await om.owner(), dAddr) || same(await om.operator(), dAddr);
  for (const a of designated) {
    if (!may) {
      log(
        `   ⚠️  emergency designation of ${a}: ops (the operator) must setEmergencyOracle(${a}, false)`,
      );
      continue;
    }
    await (await om.connect(d).setEmergencyOracle(a, false)).wait();
    if (await om.isEmergencyOracle(a)) {
      fail(`emergency designation of ${a} did not clear`);
    }
    ok(`emergency designation of node ${a} cleared (deployer era)`);
  }
}

/**
 * Completion lines plus the node warnings: provenance (residual when the
 * deployer registered the node, D50) and the MIN_NODES floor.
 */
async function nodeLines(o, dAddr, warnings = [], residual = []) {
  const f = await nodeFacts(o);
  // Task 5.6b: the day-2 audit skips a node a governance execution
  // registered (executeProposal is permissionless, so the deployer may
  // have sent it); a node the deployer registered itself keeps D50's
  // warning there too (R-56c-1), acknowledged or not.
  for (const n of f.nodes) {
    if (o.audit && n.byGovernance) continue;
    if (n.registeredBy && same(n.registeredBy, dAddr)) {
      const w = `OracleManager node ${n.addr} (${n.name}) was registered by the deployer at block ${n.block}: it votes with a key the deployer chose; rotate deployer-era nodes by an OracleParameters vote (D50)`;
      warnings.push(w);
      residual.push(w);
    }
  }
  // Slice C review L-2, owner ruling (b): an escrow fee wallet receives
  // fees and runs nothing, so it is no role key (D25 b); a node that is
  // one is a residual warning, not a failure.
  const fee = await Promise.all((o.feeWallets || []).map(addrOf));
  for (const n of f.nodes)
    if (fee.some((a) => same(a, n.addr))) {
      const w = `node ${n.addr} is also an escrow fee wallet (uncapped holder that votes verdicts): use a separate key in production`;
      warnings.push(w);
      residual.push(w);
    }
  // M-4: a partial set (a removal too many) freezes every list: no query
  // opens. None at all is the first handover's state, before production
  // nodes are voted in (D50): a warning.
  if (f.nodes.length === 0) {
    warnings.push(
      `OracleManager has 0 registered nodes, below ConsensusOracle.MIN_NODES (${f.minNodes}): no query can open until governance registers nodes by vote`,
    );
  }
  const lines = [];
  if (f.nodes.length > 0)
    lines.push([
      `OracleManager has ${f.nodes.length} registered node(s), at least ConsensusOracle.MIN_NODES (${f.minNodes})`,
      f.nodes.length >= f.minNodes,
    ]);
  for (const c of await nodeChecks(o, f)) lines.push([c.label, c.ok]);
  for (const c of await listOracleChecks(o, f)) lines.push([c.label, c.ok]);
  for (const c of await listTargetChecks(o, false)) lines.push([c.label, c.ok]);
  return lines;
}

/** The strays a manager owner call removes. */
async function nodeStrays(o) {
  const out = [];
  for (const c of await nodeChecks(o)) out.push(...c.strays);
  return out;
}

module.exports = {
  fewestToReach,
  floorRow,
  roleOf,
  nodeFacts,
  nodeChecks,
  listOracleChecks,
  preflightNodes,
  nodeSteps,
  nodeLines,
  nodeStrays,
};
