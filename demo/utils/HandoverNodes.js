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
 * day-2 audit trusts an acknowledged node whoever registered it), and
 * warns below ConsensusOracle.MIN_NODES; it prints each node's weight
 * share and fails when one node alone reaches the bar (Task 5.1, A1F-4:
 * the engine then opens no query). Each list oracle bound to VSC
 * or VGT must carry the compiled WhitelistOracle or BlacklistOracle
 * code, not be paused, require at least two consensus oracles and keep a
 * sane maxVerdictAge; its manager link is HandoverDerive.js.
 */

const { ethers } = require("hardhat");
const { addrOf, same, fail } = require("./HandoverChecks");
const { scanLogs } = require("./HandoverScans");
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

/**
 * { nodes: [{ addr, name, registeredBy, block }], designated: [addr],
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
  for (const addr of live) {
    const ev = regs.filter((e) => same(e.args[0], addr)).at(-1);
    const tx = ev && (await ethers.provider.getTransaction(ev.transactionHash));
    nodes.push({
      addr,
      name: ev ? ev.args[1] : "?",
      registeredBy: tx ? tx.from : null,
      block: ev ? ev.blockNumber : null,
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
  out.push({
    label: `no OracleManager node alone reaches the ${f.threshold}% bar; weight shares: ${list(w.shares) || (w.alone === null ? "unreadable" : "none")}`,
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

/** The list-oracle checks: [{ label, ok, fix }] plus the pins. */
async function listOracleChecks(o) {
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
  for (const c of await nodeChecks(o)) if (!c.ok) fail(c.fix);
  for (const c of await listOracleChecks(o)) if (!c.ok) fail(c.fix);
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
  // Task 5.6b: in the day-2 audit an acknowledged node is the operator's
  // word, whoever sent its registration (executeProposal is permissionless).
  const ack = o.audit
    ? await Promise.all((o.oracleNodes || []).map(addrOf))
    : [];
  for (const n of f.nodes) {
    if (ack.some((a) => same(a, n.addr))) continue;
    if (n.registeredBy && same(n.registeredBy, dAddr)) {
      const w = `OracleManager node ${n.addr} (${n.name}) was registered by the deployer at block ${n.block}: it votes with a key the deployer chose; rotate deployer-era nodes by an OracleParameters vote (D50)`;
      warnings.push(w);
      residual.push(w);
    }
  }
  if (f.nodes.length < f.minNodes) {
    warnings.push(
      `OracleManager has ${f.nodes.length} registered node(s), below ConsensusOracle.MIN_NODES (${f.minNodes}): no query can open until governance registers more by vote`,
    );
  }
  const lines = (await nodeChecks(o, f)).map((c) => [c.label, c.ok]);
  for (const c of await listOracleChecks(o)) lines.push([c.label, c.ok]);
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
  nodeFacts,
  nodeChecks,
  listOracleChecks,
  preflightNodes,
  nodeSteps,
  nodeLines,
  nodeStrays,
};
