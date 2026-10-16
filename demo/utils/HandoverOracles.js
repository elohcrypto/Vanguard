/**
 * @fileoverview Handover ceremony, plan v2 Task 4.4: OracleManager's
 * consensus engine and operator.
 *
 * The engine (ConsensusOracle) has no owner since 4.4: every write comes
 * from the manager it was built for, so nothing is handed over. What the
 * ceremony proves instead: the manager binds an engine, that engine's
 * runtime code is the compiled ConsensusOracle (HandoverCodeHash.js) and it
 * serves this manager. The operator (pause, unpause, emergency
 * designation) goes to ops: the deployer step sets it while the deployer
 * still owns the manager; once governance owns it, an operator other than
 * ops is refused (only an OracleParameters vote can change it). Review
 * L-4: the engine parameters the deployer could have set are checked too,
 * so a deployer-era threshold or node weight cannot pass as "no power":
 * the threshold must be 66% and every registered node at the default
 * weight.
 *
 * Task 5.14: the list oracles the deployer holds, bound or not
 * (deployerListOracles): the ceremony hands each to ops and completion
 * refuses one the deployer still owns.
 */

const { ethers } = require("hardhat");
const { addrOf, same, fail } = require("./HandoverChecks");
const {
  codeHash,
  expectedHash,
  maskedCodeHash,
} = require("./HandoverCodeHash");
const { uniq, scanLogs } = require("./HandoverScans");

const ENGINE_ABI = ["function oracleManager() view returns (address)"];
const THRESHOLD = 66n; // the demo and deploy default: two of three

/** { threshold, expiry, heavy } read from a code-matched engine. */
async function engineParams(o, engineAddr) {
  const e = await ethers.getContractAt("ConsensusOracle", engineAddr);
  const def = await e.DEFAULT_ORACLE_WEIGHT();
  const heavy = [];
  for (const n of await o.oracleManager.getRegisteredOracles()) {
    const w = await e.weightOf(n);
    if (w !== def) heavy.push(`${n} (${w})`);
  }
  return {
    threshold: await e.consensusThreshold(),
    expiry: await e.queryExpiryTime(),
    heavy,
  };
}

/** { om, engine, hasCode, actual, expected, bound, operator, owner } */
async function oracleFacts(o) {
  const om = await addrOf(o.oracleManager);
  const engine = await o.oracleManager.consensusEngine();
  const hasCode =
    !same(engine, ethers.ZeroAddress) &&
    (await ethers.provider.getCode(engine)) !== "0x";
  const actual = hasCode ? await codeHash(engine) : null;
  const expected = await expectedHash("ConsensusOracle");
  const served = hasCode
    ? await (
        await ethers.getContractAt(ENGINE_ABI, engine)
      )
        .oracleManager()
        .catch(() => null)
    : null;
  return {
    om,
    engine,
    hasCode,
    actual,
    expected,
    bound: Boolean(served) && same(served, om),
    operator: await o.oracleManager.operator(),
    owner: await o.oracleManager.owner(),
  };
}

/** Read-only, before the first transaction. */
async function preflightOracles(o) {
  const f = await oracleFacts(o);
  const [dAddr, ops] = [await addrOf(o.deployer), await addrOf(o.ops)];
  if (same(f.engine, ethers.ZeroAddress)) {
    fail(
      `OracleManager ${f.om} has no consensus engine: its owner must setConsensusEngine(a ConsensusOracle deployed for it) before the handover`,
    );
  }
  if (!f.hasCode)
    fail(`OracleManager consensus engine ${f.engine} has no code`);
  if (f.actual !== f.expected) {
    fail(
      `OracleManager consensus engine ${f.engine} runtime code hash ${f.actual} is not the compiled ConsensusOracle (${f.expected}): redeploy it from this build and bind it`,
    );
  }
  if (!f.bound) {
    fail(
      `consensus engine ${f.engine} does not serve OracleManager ${f.om}: deploy a ConsensusOracle for this manager and bind it`,
    );
  }
  const p = await engineParams(o, f.engine);
  if (p.threshold !== THRESHOLD) {
    fail(
      `consensus engine ${f.engine} threshold is ${p.threshold}%, not ${THRESHOLD}%: its owner must setConsensusThreshold(${THRESHOLD}) before the handover`,
    );
  }
  if (p.heavy.length) {
    fail(
      `consensus engine ${f.engine} weights nodes off the default: ${p.heavy.join(", ")}; reset them (setOracleWeight to the default) before the handover`,
    );
  }
  if (same(f.operator, ops) || same(f.owner, dAddr)) return;
  fail(
    same(f.operator, dAddr)
      ? `OracleManager operator is the deployer ${dAddr} and the deployer no longer owns the manager: governance must setOperator(ops) by an OracleParameters vote`
      : `OracleManager operator is ${f.operator}, not ops ${ops}, and the deployer no longer owns the manager: governance must setOperator(ops) by an OracleParameters vote`,
  );
}

/** Deployer step: ops becomes the operator (the deployer owns the manager). */
async function oracleSteps(ctx) {
  const { o, d, ok } = ctx;
  const ops = await addrOf(o.ops);
  if (same(await o.oracleManager.operator(), ops)) {
    ok(`OracleManager operator: already ops ${ops}`);
    return;
  }
  await (await o.oracleManager.connect(d).setOperator(ops)).wait();
  if (!same(await o.oracleManager.operator(), ops)) {
    throw new Error("Handover: OracleManager operator did not move to ops");
  }
  ok(`OracleManager operator: ops ${ops}`);
}

/** Completion lines: [label, pass][]. */
async function oracleLines(o, dAddr, ops) {
  const f = await oracleFacts(o);
  const pinned = f.hasCode && f.actual === f.expected && f.bound;
  const p = pinned ? await engineParams(o, f.engine) : null;
  return [
    [
      `OracleManager ${f.om} consensus engine ${f.engine} is the compiled ConsensusOracle and serves this manager`,
      pinned,
    ],
    [
      `consensus threshold is ${THRESHOLD}% of the registered weight (expiry ${p ? p.expiry : "?"}s)`,
      Boolean(p) && p.threshold === THRESHOLD,
    ],
    [
      p && p.heavy.length
        ? `nodes off the default engine weight: ${p.heavy.join(", ")}`
        : "every registered node carries the default engine weight",
      Boolean(p) && p.heavy.length === 0,
    ],
    [
      `OracleManager operator (pause, unpause, emergency designation) is ops ${ops}, not the deployer`,
      same(f.operator, ops) && !same(f.operator, dAddr),
    ],
    [
      "the deployer is not an OracleManager node",
      !(await o.oracleManager.isRegisteredOracle(dAddr)),
    ],
  ];
}

const [MOVED, STARTED] = [
  "OwnershipTransferred(address,address)",
  "OwnershipTransferStarted(address,address)",
].map((e) => ethers.id(e));
const LIST_ORACLE_ABI = [
  "function oracleManager() view returns (address)",
  "function owner() view returns (address)",
  "function pendingOwner() view returns (address)",
];
// eth_getLogs over every contract, in scanLogs's chunks.
const ANY_CONTRACT = {
  queryFilter: (filter, fromBlock, toBlock) =>
    ethers.provider.getLogs({ ...filter, fromBlock, toBlock }),
};
const noAnswer = (e) =>
  e.code === "CALL_EXCEPTION" ||
  e.code === "BAD_DATA" ||
  /revert/i.test(e.message);

/** True when `a` runs the compiled WhitelistOracle or BlacklistOracle. */
async function isListOracle(a) {
  for (const n of ["WhitelistOracle", "BlacklistOracle"]) {
    if ((await maskedCodeHash(a, n)) === (await expectedHash(n))) return true;
  }
  return false;
}

/**
 * Task 5.14: { held, nominated } for the list oracles serving the plan's
 * OracleManager that name the deployer. ListOracleBase is OZ
 * Ownable2Step: every owner change (the constructor's included) emits
 * OwnershipTransferred(_, newOwner), every nomination
 * OwnershipTransferStarted(_, pending); both index the new address. Its
 * constructor requires the manager's code, so the event lies after the
 * manager's deploy, which checkFromBlock proves is inside the scan.
 * Candidates are the emitters of either event naming the deployer
 * (eth_getLogs with no address); one counts only with the compiled
 * oracle code and the plan's manager, so a stranger's look-alike is
 * ignored. `held`: the deployer owns it, or is its pending owner by a
 * nomination it sent. `nominated`: pending by someone else's nomination
 * ({ oracle, by }); the deployer holds nothing until it accepts, which
 * it never does after the ceremony (R-56-5). R-413-6: every oracle in
 * `mustSee` that names the deployer must be among the emitters.
 */
async function deployerListOracles(o, mustSee = []) {
  const out = { held: [], nominated: [] };
  if (!o.oracleManager) return out;
  const [dAddr, om] = await Promise.all(
    [o.deployer, o.oracleManager].map(addrOf),
  );
  const filter = {
    topics: [[MOVED, STARTED], null, ethers.zeroPadValue(dAddr, 32)],
  };
  const logs = await scanLogs(ANY_CONTRACT, filter, o);
  const emitters = uniq(logs.map((l) => l.address));
  const names = async (c) =>
    same(await c.owner(), dAddr) || same(await c.pendingOwner(), dAddr);
  const missed = [];
  for (const a of uniq(mustSee)) {
    const c = await ethers.getContractAt(LIST_ORACLE_ABI, a);
    if (!emitters.some((e) => same(e, a)) && (await names(c))) missed.push(a);
  }
  if (missed.length) {
    fail(
      `OwnershipTransferred/OwnershipTransferStarted event scan found none of the holders it must see (${missed.join(", ")} name the deployer): fromBlock, logChunk or the RPC is wrong; nothing can be concluded from it`,
    );
  }
  for (const a of emitters) {
    const c = await ethers.getContractAt(LIST_ORACLE_ABI, a);
    const served = await c.oracleManager().catch((e) => {
      if (noAnswer(e)) return null;
      throw e;
    });
    if (!served || !same(served, om) || !(await isListOracle(a))) continue;
    if (same(await c.owner(), dAddr)) {
      out.held.push(a);
      continue;
    }
    if (!same(await c.pendingOwner(), dAddr)) continue;
    const ev = logs
      .filter((l) => same(l.address, a) && l.topics[0] === STARTED)
      .at(-1);
    const tx = ev && (await ethers.provider.getTransaction(ev.transactionHash));
    // A nomination the scan cannot attribute counts as the deployer's.
    if (!tx || same(tx.from, dAddr)) out.held.push(a);
    else out.nominated.push({ oracle: a, by: tx.from });
  }
  return out;
}

/** Task 5.14 completion lines from o.derived; stranger nominations warn. */
async function heldOracleLines(o, warnings) {
  const om = o.oracleManager ? await addrOf(o.oracleManager) : "(none)";
  const { heldOracles: held, nominatedOracles: nominated } = o.derived;
  for (const { oracle, by } of nominated) {
    warnings.push(
      `list oracle ${oracle} names the deployer as pending owner, nominated by ${by}, not the deployer: no power until it accepts, and the deployer sends nothing after the ceremony (R-56-5); its owner can cancel with transferOwnership(${ethers.ZeroAddress})`,
    );
  }
  return [
    [
      held.length
        ? `the deployer still owns (or has pending by its own nomination) list oracle(s) ${held.join(", ")} serving OracleManager ${om}`
        : `the deployer owns no list oracle serving OracleManager ${om} (owner, or pending by its own nomination)`,
      held.length === 0,
    ],
  ];
}

module.exports = {
  oracleFacts,
  preflightOracles,
  oracleSteps,
  oracleLines,
  deployerListOracles,
  heldOracleLines,
};
