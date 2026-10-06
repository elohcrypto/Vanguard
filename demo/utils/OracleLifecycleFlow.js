/**
 * @fileoverview Oracle lifecycle and the one consensus path (plan v2 Task
 * 4.4, D11 = a). OracleManager is the gate: queries open there, nodes answer
 * there (submitResponse, the one vote entry) and the Whitelist/Blacklist
 * oracles read the verdict there. ConsensusOracle is its engine: it
 * snapshots every registered node (active or paused) when a query opens and
 * resolves a side at consensusThreshold percent of that snapshot (66: two
 * of three nodes), so pausing nodes never lowers the bar.
 * The operator (ops, wallet 10) pauses, unpauses and emergency-designates
 * nodes; removal and parameters are the manager owner's (the deployer,
 * governance after the handover). Options 33a, 34a, 35a, 37 and 40 and
 * scripts/demo-smoke-oracles.js share these steps; every line printed is
 * read back from chain.
 */

const { ethers } = require("hardhat");
const { governOracleManager } = require("./GovernedCalls");

/** KYC, AML and Compliance nodes (option 31 registers them). */
const NODE_WALLETS = [1, 2, 3];
const OPS_WALLET = 10;
const THRESHOLD = 66;
const QUERY = { WHITELIST: 1, BLACKLIST: 2, IDENTITY: 3, COMPLIANCE: 4 };
const SEVERITY = ["LOW", "MEDIUM", "HIGH", "CRITICAL"];

const same = (a, b) => a.toLowerCase() === b.toLowerCase();
const short = (a) => `${a.slice(0, 8)}…${a.slice(-4)}`;
const reason = (e) => (e.shortMessage || e.message || String(e)).split("\n")[0];

function opsSigner(state) {
  return state.signers[OPS_WALLET];
}

function nodeSigners(state) {
  return NODE_WALLETS.map((i) => state.signers[i]);
}

/** A fresh address no demo wallet uses: rounds never touch real holders. */
function throwawaySubject() {
  return ethers.Wallet.createRandom().address;
}

/** { om, engine, wl, bl }, or null after printing what is missing. */
function oracleContracts(state, log = console.log) {
  const om = state.getContract("oracleManager");
  const engine = state.getContract("consensusOracle");
  if (!om || !engine) {
    log("❌ Deploy the Oracle Management System first (option 31)");
    return null;
  }
  return {
    om,
    engine,
    wl: state.getContract("whitelistOracle"),
    bl: state.getContract("blacklistOracle"),
  };
}

/** The engine's queryId from a submitQuery receipt. */
function queryIdOf(engine, receipt) {
  for (const l of receipt.logs) {
    const ev = (() => {
      try {
        return engine.interface.parseLog(l);
      } catch {
        return null;
      }
    })();
    if (ev && ev.name === "ConsensusQueryCreated") return ev.args.queryId;
  }
  throw new Error("submitQuery emitted no ConsensusQueryCreated");
}

/** Raise a query through the manager (an active node or the owner). */
async function raiseQuery(state, raiser, subject, type, data = "0x") {
  const { om, engine } = oracleContracts(state);
  const rc = await (
    await om.connect(raiser).submitQuery(subject, type, data)
  ).wait();
  return queryIdOf(engine, rc);
}

/** Engine tally plus the manager's stamped resolution. */
async function tally(state, q) {
  const { om, engine } = oracleContracts(state);
  const r = await engine.getConsensusResult(q);
  const [hasResult, result, resolvedAt] = await om.getQueryResolution(q);
  const [subject, type] = await om.getQueryBinding(q);
  return {
    q,
    subject,
    type: Number(type),
    yes: r.positiveVotes,
    no: r.negativeVotes,
    snapshot: r.snapshotWeight,
    expiresAt: Number(r.expiresAt),
    expired: r.expired,
    voters: await engine.getQueryVoters(q),
    hasResult,
    result,
    resolvedAt: Number(resolvedAt),
  };
}

function tallyLine(t) {
  const state = t.hasResult
    ? `resolved ${t.result ? "YES" : "NO"}`
    : t.expired
      ? "expired, no verdict"
      : "open";
  return `yes ${t.yes} / no ${t.no} of snapshot ${t.snapshot} (${t.voters.length} vote(s)): ${state}`;
}

/** Nodes answer in order until the manager stamps a verdict. */
async function answerUntilResolved(state, q, votes, log = console.log) {
  const { om } = oracleContracts(state);
  for (const [node, vote] of votes) {
    if ((await om.getQueryResolution(q))[0]) break;
    await (await om.connect(node).submitResponse(q, vote)).wait();
    log(`   🗳️  ${short(node.address)} answered ${vote ? "YES" : "NO"}`);
  }
  return tally(state, q);
}

/** A node's attestation signature for (subject, queryId, result, chainId). */
async function attestationSig(node, subject, q, result) {
  const { chainId } = await ethers.provider.getNetwork();
  return node.signMessage(
    ethers.getBytes(
      ethers.solidityPackedKeccak256(
        ["address", "bytes32", "bool", "uint256"],
        [subject, q, result, chainId],
      ),
    ),
  );
}

/** One node applies the resolved verdict to the Whitelist/Blacklist oracle. */
async function applyVerdict(oracle, node, subject, q, result) {
  const sig = await attestationSig(node, subject, q, result);
  return (
    await oracle.connect(node).provideAttestation(subject, q, result, sig, "0x")
  ).wait();
}

/**
 * Raise a query by node 1 and let nodes 1 and 2 answer YES: the engine
 * resolves at two of three. Returns the tally.
 */
async function consensusRound(state, type, subject, data, log = console.log) {
  const [n1, n2] = nodeSigners(state);
  const { engine } = oracleContracts(state);
  const q = await raiseQuery(state, n1, subject, type, data);
  log(`   📝 Query ${q}`);
  log(
    `      raised by node ${short(n1.address)} for ${subject}; threshold ${await engine.consensusThreshold()}% of the registered weight`,
  );
  const t = await answerUntilResolved(
    state,
    q,
    [
      [n1, true],
      [n2, true],
    ],
    log,
  );
  log(`   ⚖️  ${tallyLine(t)}`);
  return t;
}

/** Option 33a: a whitelist verdict by consensus, applied by node 1. */
async function runWhitelistRound(state, log = console.log) {
  const c = oracleContracts(state, log);
  if (!c) return null;
  log("\n📋 WHITELIST BY CONSENSUS (OPTION 33a)");
  const subject = throwawaySubject();
  const t = await consensusRound(state, QUERY.WHITELIST, subject, "0x", log);
  if (!t.hasResult) return (log("❌ The query did not resolve"), null);
  await applyVerdict(c.wl, nodeSigners(state)[0], subject, t.q, true);
  const listed = await c.wl.isWhitelisted(subject);
  const info = await c.wl.getWhitelistInfo(subject);
  log(
    listed
      ? `   ✅ ${subject} whitelisted by the verdict: tier ${info.tier}, "${info.reason}"`
      : `❌ ${subject} is not whitelisted after the verdict`,
  );
  return { ...t, listed };
}

/** Option 34a: a HIGH blacklist verdict by consensus, applied by node 1. */
async function runBlacklistRound(state, log = console.log) {
  const c = oracleContracts(state, log);
  if (!c) return null;
  log("\n🚫 BLACKLIST BY CONSENSUS (OPTION 34a)");
  const subject = throwawaySubject();
  const data = ethers.AbiCoder.defaultAbiCoder().encode(["uint8"], [2]);
  log("   Severity HIGH is fixed when the query is raised (R-2F3-2)");
  const t = await consensusRound(state, QUERY.BLACKLIST, subject, data, log);
  if (!t.hasResult) return (log("❌ The query did not resolve"), null);
  await applyVerdict(c.bl, nodeSigners(state)[0], subject, t.q, true);
  const e = await c.bl.getBlacklistInfo(subject);
  const listed = await c.bl.isBlacklisted(subject);
  const days = Number(e.expiryTime - e.timestamp) / 86400;
  log(
    listed
      ? `   ✅ ${subject} blacklisted by the verdict: ${SEVERITY[Number(e.severity)]}, ${days} days`
      : `❌ ${subject} is not blacklisted after the verdict`,
  );
  return { ...t, listed, severity: Number(e.severity) };
}

/**
 * The operator is ops. Set directly while the deployer owns the manager,
 * as an OracleParameters proposal once governance does.
 */
async function ensureOperator(state, log = console.log) {
  const { om } = oracleContracts(state);
  const ops = opsSigner(state).address;
  if (same(await om.operator(), ops)) return { ok: true };
  const r = await governOracleManager(state, "setOperator", [ops], log);
  if (r.direct) {
    log(`   ✅ OracleManager operator: ops ${ops}`);
    return { ok: true };
  }
  return { ok: false, ...r };
}

/** Run `fn`; the revert reason, or null when it did not revert. */
async function refusal(fn) {
  try {
    await (await fn()).wait();
    return null;
  } catch (e) {
    return reason(e);
  }
}

/**
 * Why `node` cannot take part in 35a (paused then unpaused by ops), or null:
 * a node the owner paused or one at the reputation floor stays paused.
 */
async function lifecycleBlock(om, node, label) {
  if (await om.pausedByOwner(node)) {
    return `${label} was paused by the owner; only the owner unpauses it`;
  }
  const rep = await om.getOracleReputation(node);
  if (rep <= (await om.MIN_REPUTATION())) {
    return `${label} is at the reputation floor (${rep}); ops cannot unpause it`;
  }
  return null;
}

/**
 * Option 35a: the node lifecycle, no prompts. Ops pauses node 3, whose
 * answer is refused while nodes 1 and 2 still resolve (node 3 stays in the
 * snapshot's denominator); ops pauses node 2 too and node 1 alone cannot
 * resolve (pausing never lowers the bar); ops unpauses both, designates
 * node 2 for emergency listings, uses and clears it; the owner registers
 * and removes a fourth, throwaway node (skipped once governance owns the
 * manager). Refuses to start when ops could not undo its pauses; a failed
 * run still unpauses what it paused.
 */
async function runLifecycle(state, log = console.log) {
  const c = oracleContracts(state, log);
  if (!c) return null;
  const { om, bl } = c;
  const ops = opsSigner(state);
  const [n1, n2, n3] = nodeSigners(state);
  const out = { done: false };
  log("\n🔁 ORACLE LIFECYCLE (OPTION 35a)");
  for (const [n, label] of [
    [n2, "node 2"],
    [n3, "node 3"],
  ]) {
    const why = await lifecycleBlock(om, n.address, label);
    if (why) return (log(`❌ 35a not started: ${why}`), out);
  }
  const op = await ensureOperator(state, log);
  if (!op.ok) {
    log(
      op.proposalId
        ? `   ℹ️  Proposal #${op.proposalId} sets the operator; vote it (77/78), then rerun 35a`
        : `❌ Operator not set: ${op.refused}`,
    );
    return out;
  }

  const paused = [];
  const pause = async (n, label) => {
    if (!(await om.isActiveOracle(n.address))) {
      await (await om.connect(ops).unpauseOracle(n.address)).wait();
    }
    await (await om.connect(ops).pauseOracle(n.address)).wait();
    paused.push(n);
    log(`   ⏸️  ops paused ${label} ${n.address}`);
  };
  try {
    await pause(n3, "node 3");
    const q = await raiseQuery(state, n1, throwawaySubject(), QUERY.COMPLIANCE);
    out.pausedRefusal = await refusal(() =>
      om.connect(n3).submitResponse(q, false),
    );
    log(
      out.pausedRefusal
        ? `   🚫 node 3's answer refused: ${out.pausedRefusal}`
        : "❌ node 3's answer was accepted while paused",
    );
    out.tally = await answerUntilResolved(
      state,
      q,
      [
        [n1, true],
        [n2, true],
      ],
      log,
    );
    log(
      `   ⚖️  ${tallyLine(out.tally)} (paused node 3 still in the denominator)`,
    );

    await pause(n2, "node 2");
    const q2 = await raiseQuery(
      state,
      n1,
      throwawaySubject(),
      QUERY.COMPLIANCE,
    );
    out.aloneTally = await answerUntilResolved(state, q2, [[n1, true]], log);
    log(
      `   ⚖️  ${tallyLine(out.aloneTally)}: node 1 alone cannot resolve, pausing never lowers the bar`,
    );

    for (const [n, label] of [
      [n2, "node 2"],
      [n3, "node 3"],
    ]) {
      await (await om.connect(ops).unpauseOracle(n.address)).wait();
      paused.splice(paused.indexOf(n), 1);
      log(
        `   ▶️  ops unpaused ${label}: active = ${await om.isActiveOracle(n.address)}`,
      );
    }
    out.unpaused = await om.isActiveOracle(n3.address);
  } finally {
    // A failure between pause and unpause must not leave a node paused.
    for (const n of paused) {
      if (!(await om.isActiveOracle(n.address))) {
        await (await om.connect(ops).unpauseOracle(n.address)).wait();
        log(`   ▶️  restored ${n.address} after a failed step`);
      }
    }
  }

  await (await om.connect(ops).setEmergencyOracle(n2.address, true)).wait();
  const target = throwawaySubject();
  await (
    await bl.connect(n2).emergencyBlacklist(target, 3, "35a emergency drill")
  ).wait();
  out.emergencyListed = await bl.isBlacklisted(target);
  log(
    `   🚨 ops designated node 2; it listed ${target} CRITICAL for 7 days: ${out.emergencyListed}`,
  );
  await (await om.connect(ops).setEmergencyOracle(n2.address, false)).wait();
  out.emergencyRefusal = await refusal(() =>
    bl.connect(n2).emergencyBlacklist(throwawaySubject(), 3, "after clear"),
  );
  log(
    `   🔒 designation cleared; a second listing is refused: ${out.emergencyRefusal}`,
  );
  // Option 32 designates node 2 for option 35's prompted listing.
  await (await om.connect(ops).setEmergencyOracle(n2.address, true)).wait();

  out.removal = await removeThrowawayNode(state, log);
  out.done = true;
  return out;
}

/** Register then remove a fourth node; owner only, so deployer-owned only. */
async function removeThrowawayNode(state, log) {
  const { om } = oracleContracts(state);
  const d = state.signers[0];
  if (!same(await om.owner(), d.address)) {
    log(
      "   ℹ️  Register and remove are the owner's (governance): option 76 -> type 2 -> removeOracle",
    );
    return { skipped: true };
  }
  const node = throwawaySubject();
  await (await om.connect(d).registerOracle(node, "DRILL", "35a", 500)).wait();
  await (await om.connect(d).removeOracle(node, "35a drill")).wait();
  const gone = !(await om.isRegisteredOracle(node));
  log(`   🗑️  owner registered and removed node ${node}: removed = ${gone}`);
  return { node, gone };
}

module.exports = {
  NODE_WALLETS,
  OPS_WALLET,
  THRESHOLD,
  QUERY,
  SEVERITY,
  opsSigner,
  nodeSigners,
  throwawaySubject,
  oracleContracts,
  raiseQuery,
  tally,
  tallyLine,
  answerUntilResolved,
  applyVerdict,
  consensusRound,
  ensureOperator,
  runWhitelistRound,
  runBlacklistRound,
  runLifecycle,
};
