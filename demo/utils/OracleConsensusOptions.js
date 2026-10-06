/**
 * @fileoverview Option 37's prompted sub-options (plan v2 Task 4.4) on the
 * real path: a node raises the query in OracleManager, nodes answer with
 * OracleManager.submitResponse, and the tally is read from the
 * ConsensusOracle engine. The shared steps live in OracleLifecycleFlow.js.
 */

const { ethers } = require("hardhat");
const { displayError, displaySuccess } = require("./DisplayHelpers");
const {
  QUERY,
  nodeSigners,
  oracleContracts,
  raiseQuery,
  tally,
  tallyLine,
} = require("./OracleLifecycleFlow");

const TYPE_NAMES = ["", "Whitelist", "Blacklist", "Identity", "Compliance"];

function printNodes(state) {
  nodeSigners(state).forEach((n, i) =>
    console.log(`   ${i}: node ${n.address} (wallet ${i + 1})`),
  );
}

/** A queryId typed by the user, or null after explaining the format. */
async function askQueryId(prompt) {
  const q = (await prompt("Enter query ID (0x + 64 hex): ")).trim();
  if (!ethers.isHexString(q, 32)) {
    displayError(
      `Not a query ID: "${q}" (the 66-character hash option 37 -> 1 printed)`,
    );
    return null;
  }
  return q;
}

/** 37 -> 1: a node raises a query for an identity owner. */
async function createQueryInteractive(state, prompt) {
  if (!oracleContracts(state)) return null;
  const ids = Array.from(state.identities?.values?.() ?? []);
  if (ids.length === 0) {
    return displayError("No identities available: create one first (option 3)");
  }
  ids.forEach((id, i) => console.log(`   ${i}: ${id.owner}`));
  const subject = ids[Number(await prompt(`Subject (0-${ids.length - 1}): `))];
  if (!subject) return displayError("Invalid subject");
  console.log(
    "   Types: 1 Whitelist, 2 Blacklist (MEDIUM), 3 Identity, 4 Compliance",
  );
  const type = Number(await prompt("Query type (1-4): "));
  if (!(type >= QUERY.WHITELIST && type <= QUERY.COMPLIANCE)) {
    return displayError("Query type must be 1-4");
  }
  printNodes(state);
  const raiser = nodeSigners(state)[Number(await prompt("Raised by (0-2): "))];
  if (!raiser) return displayError("Invalid node");
  const q = await raiseQuery(state, raiser, subject.owner, type);
  const t = await tally(state, q);
  displaySuccess("QUERY RAISED IN ORACLEMANAGER");
  console.log(`🆔 Query ID: ${q}`);
  console.log(`   👤 Subject: ${subject.owner} (${TYPE_NAMES[type]})`);
  console.log(
    `   ⚖️  Snapshot weight ${t.snapshot}; expires at ${t.expiresAt}`,
  );
  console.log("💡 Nodes answer with option 37 -> 2 (copy the ID above)");
  return q;
}

/** 37 -> 2: a node answers through OracleManager.submitResponse. */
async function voteInteractive(state, prompt) {
  const c = oracleContracts(state);
  if (!c) return null;
  const q = await askQueryId(prompt);
  if (!q) return null;
  printNodes(state);
  const node = nodeSigners(state)[Number(await prompt("Node (0-2): "))];
  if (!node) return displayError("Invalid node");
  const vote = (await prompt("Answer (1=YES, 0=NO): ")).trim() === "1";
  try {
    await (await c.om.connect(node).submitResponse(q, vote)).wait();
  } catch (e) {
    return displayError(
      `Answer refused: ${(e.shortMessage || e.message).split("\n")[0]}`,
    );
  }
  const t = await tally(state, q);
  displaySuccess(`${node.address} answered ${vote ? "YES" : "NO"}`);
  console.log(`   ⚖️  ${tallyLine(t)}`);
  return t;
}

/** 37 -> 3: the engine's tally and the manager's verdict. */
async function resultInteractive(state, prompt) {
  if (!oracleContracts(state)) return null;
  const q = await askQueryId(prompt);
  if (!q) return null;
  const t = await tally(state, q);
  if (t.type === 0) return displayError(`No query ${q} in OracleManager`);
  console.log(`\n📊 QUERY ${q}`);
  console.log(`   👤 Subject: ${t.subject} (${TYPE_NAMES[t.type]})`);
  console.log(`   ⚖️  ${tallyLine(t)}`);
  console.log(`   🗳️  Voters: ${t.voters.join(", ") || "none"}`);
  if (t.hasResult) console.log(`   ⏱️  Resolved at ${t.resolvedAt}`);
  return t;
}

/** 37 -> 4: every query the engine opened, newest first (max 10). */
async function listQueries(state) {
  const c = oracleContracts(state);
  if (!c) return [];
  const events = await c.engine.queryFilter(
    c.engine.filters.ConsensusQueryCreated(),
  );
  console.log(`\n📋 ${events.length} query(ies) opened by the engine`);
  const out = [];
  for (const ev of events.slice(-10).reverse()) {
    const t = await tally(state, ev.args.queryId);
    console.log(`   ${t.q} ${TYPE_NAMES[t.type]}: ${tallyLine(t)}`);
    out.push(t);
  }
  return out;
}

module.exports = {
  createQueryInteractive,
  voteInteractive,
  resultInteractive,
  listQueries,
};
