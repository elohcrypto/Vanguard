/**
 * Oracle section of scripts/demo-smoke.js (plan v2 Task 4.4, D11 = a).
 *
 * Runs demo options 33a, 34a and 35a (demo/utils/OracleLifecycleFlow.js)
 * against the smoke's oracle system and asserts from chain, not from the
 * printed lines: the engine is bound both ways and is the compiled
 * ConsensusOracle; the threshold is 66%; a whitelist and a blacklist
 * query resolve two of three through the engine (ConsensusReached) and
 * the verdicts apply; ops (the operator) pauses a node whose answer is
 * then refused and whose weight a later snapshot excludes, unpauses it,
 * and the manager's emergency designation gates emergencyBlacklist; an
 * expired query closes without a verdict. Failures are pushed, never
 * thrown.
 */

const { ethers, network } = require("hardhat");
const Flow = require("../demo/utils/OracleLifecycleFlow");
const { codeHash, expectedHash } = require("../demo/utils/HandoverCodeHash");

const same = (a, b) => a.toLowerCase() === b.toLowerCase();

/** Run `fn` with console.log captured; [result, lines]. */
async function quietly(fn) {
  const lines = [];
  const real = console.log;
  console.log = (...a) => lines.push(a.join(" "));
  try {
    return [await fn((...a) => lines.push(a.join(" "))), lines];
  } finally {
    console.log = real;
  }
}

async function runOracleSmoke(state, failures) {
  const facts = [];
  const check = (label, ok) => facts.push([label, Boolean(ok)]);
  const c = Flow.oracleContracts(state, () => {});
  if (!c) return failures.push("4.4: no oracleManager / consensusOracle");
  const { om, engine, wl, bl } = c;
  const [omAddr, engAddr] = [await om.getAddress(), await engine.getAddress()];
  const reached = async (q) =>
    (await engine.queryFilter(engine.filters.ConsensusReached(q))).at(-1);

  check("manager binds the engine", same(await om.consensusEngine(), engAddr));
  check(
    "engine serves this manager",
    same(await engine.oracleManager(), omAddr),
  );
  check(
    "engine code is the compiled ConsensusOracle",
    (await codeHash(engAddr)) === (await expectedHash("ConsensusOracle")),
  );
  check(
    `threshold is ${Flow.THRESHOLD}% of the active weight`,
    Number(await om.getConsensusThreshold()) === Flow.THRESHOLD,
  );

  try {
    const [w, wLines] = await quietly((log) =>
      Flow.runWhitelistRound(state, log),
    );
    const ev = w && (await reached(w.q));
    check(
      `33a: whitelist query resolved 2 of 3 (ConsensusReached 200/300) [${wLines.at(-1)}]`,
      ev &&
        ev.args.result &&
        ev.args.yesWeight === 200n &&
        ev.args.snapshotWeight === 300n,
    );
    check(
      "33a: the verdict whitelisted the subject",
      w && (await wl.isWhitelisted(w.subject)),
    );

    const [b] = await quietly((log) => Flow.runBlacklistRound(state, log));
    const bev = b && (await reached(b.q));
    check(
      "34a: blacklist query resolved YES through the engine",
      bev && bev.args.result,
    );
    const e = b && (await bl.getBlacklistInfo(b.subject));
    check(
      "34a: the verdict listed the subject HIGH (the raised severity)",
      e && e.isBlacklistedStatus && Number(e.severity) === 2,
    );

    const [l, lLines] = await quietly((log) => Flow.runLifecycle(state, log));
    const [n1, n2, n3] = Flow.nodeSigners(state);
    check(`35a: finished [${lLines.at(-1)}]`, l && l.done);
    check(
      "35a: the operator is ops",
      same(await om.operator(), Flow.opsSigner(state).address),
    );
    check("35a: the paused node's answer was refused", l && l.pausedRefusal);
    const lt = l && l.tally;
    check(
      "35a: a snapshot after the pause excludes the paused node (200)",
      lt && lt.snapshot === 200n,
    );
    const lev = lt && (await reached(lt.q));
    check(
      "35a: the query resolved from the two active nodes",
      lev &&
        lev.args.yesWeight === 200n &&
        !lt.voters.some((v) => same(v, n3.address)),
    );
    check("35a: unpause restored node 3", await om.isActiveOracle(n3.address));
    check(
      "35a: the designated node listed (emergencyBlacklist)",
      l && l.emergencyListed,
    );
    check("35a: a cleared designation is refused", l && l.emergencyRefusal);
    check(
      "35a: node 2 is designated again",
      await om.isEmergencyOracle(n2.address),
    );
    check(
      "35a: the throwaway node was removed",
      l && (l.removal.gone || l.removal.skipped),
    );

    // Expiry closes a query without a verdict (dev node: jump past it).
    const q = await Flow.raiseQuery(
      state,
      n1,
      Flow.throwawaySubject(),
      Flow.QUERY.COMPLIANCE,
    );
    const expiry = Number(await engine.queryExpiryTime());
    await network.provider.send("evm_increaseTime", [expiry + 1]);
    await network.provider.send("evm_mine");
    let late = null;
    try {
      await (await om.connect(n2).submitResponse(q, true)).wait();
    } catch (err) {
      late = err.message;
    }
    const t = await Flow.tally(state, q);
    check(
      "an expired query refuses answers and has no verdict",
      late && /QueryExpired/.test(late) && t.expired && !t.hasResult,
    );
  } catch (err) {
    failures.push(`4.4: oracle flow threw: ${err.message.split("\n")[0]}`);
  }

  for (const [label, ok] of facts)
    if (!ok) failures.push(`4.4: ${label} failed`);
  if (facts.every(([, ok]) => ok)) {
    console.log(
      `✅ Oracles: ${facts.length} chain checks pass (one engine under the gate, ops lifecycle).`,
    );
  }
}

module.exports = { runOracleSmoke };
