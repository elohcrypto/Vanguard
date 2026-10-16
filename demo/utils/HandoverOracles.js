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

const { ethers, artifacts } = require("hardhat");
const { addrOf, same, fail } = require("./HandoverChecks");
const {
  codeHash,
  expectedHash,
  immutableRanges,
} = require("./HandoverCodeHash");
const { uniq } = require("./HandoverScans");

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
  "function listManager() view returns (address)",
];

const compiled = new Map();
/** True when `code` is the compiled WhitelistOracle or BlacklistOracle. */
async function isListOracleCode(code) {
  const b = ethers.getBytes(code);
  for (const n of ["WhitelistOracle", "BlacklistOracle"]) {
    if (!compiled.has(n)) {
      const art = await artifacts.readArtifact(n);
      compiled.set(n, {
        size: ethers.dataLength(art.deployedBytecode),
        hash: await expectedHash(n),
        ranges: await immutableRanges(n),
      });
    }
    const k = compiled.get(n);
    if (b.length !== k.size) continue;
    const m = Uint8Array.from(b);
    for (const r of k.ranges) m.fill(0, r.start, r.start + r.length);
    if (ethers.keccak256(m) === k.hash) return true;
  }
  return false;
}

/**
 * Review M-1: best effort. Every event naming the deployer as new owner
 * or nominee, any contract (eth_getLogs with no address), chunked; a
 * range the provider refuses even at one block, for any reason, is
 * skipped and recorded in `capped` (a flood must not stop the ceremony).
 */
async function scanNamingDeployer(o, dAddr) {
  const filter = {
    topics: [[MOVED, STARTED], null, ethers.zeroPadValue(dAddr, 32)],
  };
  const latest = Number.isInteger(o.toBlock)
    ? o.toBlock
    : await ethers.provider.getBlockNumber();
  const max = o.logChunk || 5000;
  const [logs, capped] = [[], []];
  for (let b = o.fromBlock || 0, chunk = max; b <= latest;) {
    const to = Math.min(b + chunk - 1, latest);
    try {
      logs.push(
        ...(await ethers.provider.getLogs({
          ...filter,
          fromBlock: b,
          toBlock: to,
        })),
      );
      [b, chunk] = [to + 1, Math.min(max, chunk * 2)];
    } catch (e) {
      // Review LOW-2: any refusal at one block is a skipped block.
      if (chunk > 1) chunk = Math.max(1, Math.floor(chunk / 2));
      else capped.push(b++);
    }
  }
  return { logs, capped };
}

/**
 * Task 5.14: the list oracles serving the plan's OracleManager that name
 * the deployer, from address-bound reads (review M-1). Authoritative
 * candidates: every address the deployer CREATEd since fromBlock (its
 * nonce there to its nonce now; a contract a deployer-made factory
 * created is reached only when named or bound), and the named and bound
 * oracles. ListOracleBase is OZ
 * Ownable2Step: the deployer becomes owner only by its own CREATE or its
 * own acceptOwnership, which a named or bound oracle shows directly.
 * Best effort: the emitters of OwnershipTransferred/Started naming the
 * deployer (scanNamingDeployer). Review H-1: a candidate is called only
 * when its runtime code is the compiled oracle's. Returns { held,
 * pendingOwn, nominated, managed, managedOther, capped }: `held` the
 * deployer owns it or is pending by its own nomination (`pendingOwn`:
 * { oracle, owner }, the owner, who alone nominates, is a contract the
 * deployer created); `nominated` pending by a stranger
 * ({ oracle, by }, no power until it accepts, never after the ceremony,
 * R-56-5); `managed` (L-2) a deployer-created, named or bound oracle the
 * deployer does not own whose listManager is the deployer ({ oracle,
 * owner }); `managedOther` the same found only by the scan (a stranger
 * can name the deployer on its own oracle: a warning). R-413-6: a named
 * or bound oracle naming the deployer must be in an uncapped scan.
 */
async function deployerListOracles(o, mustSee = []) {
  const out = { held: [], pendingOwn: [], nominated: [], managed: [] };
  Object.assign(out, { managedOther: [], capped: [] });
  if (!o.oracleManager) return out;
  const [dAddr, om] = await Promise.all(
    [o.deployer, o.oracleManager].map(addrOf),
  );
  // Before fromBlock the manager had no code, so no oracle of it was
  // created (checkFromBlock proves the manager's deploy is in range).
  const from = Number(o.fromBlock || 0);
  const first =
    from > 0 ? await ethers.provider.getTransactionCount(dAddr, from - 1) : 0;
  const nonce = await ethers.provider.getTransactionCount(dAddr);
  const created = [];
  for (let n = first; n < nonce; n++)
    created.push(ethers.getCreateAddress({ from: dAddr, nonce: n }));
  const authoritative = uniq([...created, ...mustSee]);
  const { logs, capped } = await scanNamingDeployer(o, dAddr);
  out.capped = capped;
  const emitters = uniq(logs.map((l) => l.address));
  const read = async (a) => {
    const code = await ethers.provider.getCode(a);
    if (code === "0x" || !(await isListOracleCode(code))) return null;
    const c = await ethers.getContractAt(LIST_ORACLE_ABI, a);
    if (!same(await c.oracleManager(), om)) return null;
    return { c, owner: await c.owner(), pending: await c.pendingOwner() };
  };
  const missed = [];
  for (const a of uniq(mustSee)) {
    const r = await read(a);
    const names = r && (same(r.owner, dAddr) || same(r.pending, dAddr));
    if (names && !capped.length && !emitters.some((e) => same(e, a)))
      missed.push(a);
  }
  if (missed.length) {
    fail(
      `OwnershipTransferred/OwnershipTransferStarted event scan found none of the holders it must see (${missed.join(", ")} name the deployer): fromBlock, logChunk or the RPC is wrong; nothing can be concluded from it`,
    );
  }
  for (const a of uniq([...authoritative, ...emitters])) {
    const r = await read(a);
    if (!r) continue;
    const mine = authoritative.some((x) => same(x, a));
    if (same(r.owner, dAddr)) {
      out.held.push(a);
      continue;
    }
    if (same(await r.c.listManager(), dAddr))
      out[mine ? "managed" : "managedOther"].push({
        oracle: a,
        owner: r.owner,
      });
    if (!same(r.pending, dAddr)) continue;
    // Review M-2: OZ Ownable2Step sets _pendingOwner only in the owner's
    // transferOwnership and clears it on every owner change (ListOracleBase
    // overrides neither), so the current owner made this nomination.
    const own = created.some((x) => same(x, r.owner));
    const by = r.owner;
    if (own) {
      out.held.push(a);
      out.pendingOwn.push({ oracle: a, owner: r.owner });
    } else out.nominated.push({ oracle: a, by });
  }
  return out;
}

const cappedLine = (c) =>
  `scan for other list oracles naming the deployer was capped at block ${c[0]}${c.length > 1 ? ` and ${c.length - 1} more` : ""}: not checked`;
const nominatedLine = ({ oracle, by }) =>
  `list oracle ${oracle} names the deployer as pending owner, nominated by ${by}, not the deployer: no power until it accepts, and the deployer sends nothing after the ceremony (R-56-5); its owner can cancel with transferOwnership(${ethers.ZeroAddress})`;
const otherLine = ({ oracle, owner }) =>
  `list oracle ${oracle} (owner ${owner}, not created, named or bound) makes the deployer its listManager: it writes a list no token reads; its owner can setListManager(...)`;

/**
 * Preflight, from withDerivedPowers' derivation `d` and the config's
 * `oracles`: refuses an own pending nomination (I-3) and a kept
 * listManager (L-2); logs the rest.
 */
async function preflightListOracles(d, oracles, log) {
  const l = d.listOracles;
  const named = await Promise.all(oracles.map(addrOf));
  for (const { oracle, owner } of l.pendingOwn) {
    fail(
      `list oracle ${oracle} names the deployer as pending owner, nominated by its owner ${owner} (created by the deployer): before the handover the deployer accepts it (acceptOwnership; the ceremony then hands it to ops) or ${owner} cancels it (transferOwnership(${ethers.ZeroAddress}))`,
    );
  }
  for (const { oracle, owner } of l.managed) {
    // A named one: HandoverChecks.preflight refuses it in its own words.
    if (named.some((x) => same(x, oracle))) continue;
    fail(
      `list oracle ${oracle} keeps the deployer as listManager (owner ${owner}): it would keep writing that list; its owner must setListManager(...) away from the deployer first`,
    );
  }
  for (const n of l.nominated)
    log(`   ⚠️  ${nominatedLine(n)}: not handed over`);
  for (const m of l.managedOther) log(`   ⚠️  ${otherLine(m)}`);
  if (l.capped.length) log(`   ⚠️  ${cappedLine(l.capped)}`);
}

/** Task 5.14 completion lines from o.derived; the rest warn. */
async function heldOracleLines(o, warnings) {
  const om = o.oracleManager ? await addrOf(o.oracleManager) : "(none)";
  const { held, nominated, managed, managedOther, capped } =
    o.derived.listOracles;
  for (const n of nominated) warnings.push(nominatedLine(n));
  for (const m of managedOther) warnings.push(otherLine(m));
  if (capped.length) warnings.push(cappedLine(capped));
  const kept = managed.map((m) => m.oracle);
  return [
    [
      held.length
        ? `the deployer still owns (or has pending by its own nomination) list oracle(s) ${held.join(", ")} serving OracleManager ${om}`
        : `the deployer owns no list oracle serving OracleManager ${om} (owner, or pending by its own nomination)`,
      held.length === 0,
    ],
    [
      kept.length
        ? `list oracle(s) ${kept.join(", ")} serving OracleManager ${om} keep the deployer as listManager`
        : `no list oracle the deployer created, or named or bound, keeps the deployer as listManager`,
      kept.length === 0,
    ],
  ];
}

module.exports = {
  oracleFacts,
  preflightOracles,
  oracleSteps,
  oracleLines,
  deployerListOracles,
  preflightListOracles,
  heldOracleLines,
};
