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
 * ops is refused (only an OracleParameters vote can change it).
 */

const { ethers } = require("hardhat");
const { addrOf, same, fail } = require("./HandoverChecks");
const { codeHash, expectedHash } = require("./HandoverCodeHash");

const ENGINE_ABI = ["function oracleManager() view returns (address)"];

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
  return [
    [
      `OracleManager ${f.om} consensus engine ${f.engine} is the compiled ConsensusOracle and serves this manager`,
      f.hasCode && f.actual === f.expected && f.bound,
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

module.exports = { oracleFacts, preflightOracles, oracleSteps, oracleLines };
