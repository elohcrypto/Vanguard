/**
 * Key lifecycle section of scripts/demo-smoke.js (plan v2 Task 4.2).
 *
 * Runs demo option 12 (demo/utils/KeyLifecycleFlow.js) against the smoke's
 * deployment: the KeyManager option 1 deployed is authorized on wallet 1's
 * identity, one rotation and one recovery run through their timelocks on
 * the dev node, and the key set is read back from chain. Records the
 * identity in state.keyLifecycle for the handover ceremony's check.
 */

const { ethers } = require("hardhat");
const {
  DEMO_WALLET,
  AGENT_WALLETS,
  keyOf,
  runKeyLifecycle,
} = require("../demo/utils/KeyLifecycleFlow");

const MANAGEMENT = 1;

async function runKeySmoke(state, failures) {
  const km = state.getContract("keyManager");
  if (!km) {
    failures.push("4.2: option 1 did not register keyManager");
    return;
  }
  const kmAddr = await km.getAddress();
  // No owner and no allowlist: the old getters are gone from the bytecode.
  for (const sig of ["owner()", "authorizedManagers(address)"]) {
    const data = ethers.id(sig).slice(0, 10).padEnd(74, "0");
    try {
      await ethers.provider.call({ to: kmAddr, data });
      failures.push(`4.2: KeyManager still answers ${sig}`);
    } catch {
      /* expected: no such function */
    }
  }

  const lines = [];
  const real = console.log;
  console.log = (...a) => lines.push(a.join(" "));
  let r;
  try {
    r = await runKeyLifecycle(state);
  } catch (e) {
    failures.push(`4.2: option 12 threw: ${e.message.split("\n")[0]}`);
    return;
  } finally {
    console.log = real;
  }
  if (!r || !r.done) {
    failures.push(
      `4.2: option 12 did not finish: ${lines.slice(-3).join(" | ")}`,
    );
    return;
  }

  const wallet = state.signers[DEMO_WALLET].address;
  const registryId = await state
    .getContract("identityRegistry")
    .identity(wallet);
  if (registryId !== ethers.ZeroAddress && registryId !== r.identity) {
    failures.push(
      `4.2: option 12 used ${r.identity}, not wallet 1's ${registryId}`,
    );
  }
  const id = await ethers.getContractAt("OnchainID", r.identity);
  const has = (k) => id.keyHasPurpose(k, MANAGEMENT);
  const facts = [
    [
      "KeyManager is authorized on the demo identity",
      await id.authorizedManagers(kmAddr),
    ],
    ["the rotated-out key is gone", !(await has(r.oldKey))],
    [
      "the rotated-out key is revoked",
      (await id.getKey(r.oldKey)).revokedAt > 0n,
    ],
    ["the rotated-in key is MANAGEMENT", await has(r.newKey)],
    ["the recovery key is MANAGEMENT", await has(r.recoveryKey)],
    ["wallet 1 keeps its MANAGEMENT key", await has(keyOf(wallet))],
  ];
  const rec = await km.getKeyRecovery(r.identity);
  const agents = AGENT_WALLETS.map((i) => state.signers[i].address);
  facts.push([
    "recovery completed with agents 2 and 3",
    rec.completed && rec.recoveryAgents.join() === agents.join(),
  ]);
  // Both timelocks really ran: the chain moved past their execution times.
  const now = (await ethers.provider.getBlock("latest")).timestamp;
  const rotation = await km.getKeyRotation(
    r.identity,
    ethers.solidityPackedKeccak256(
      ["address", "bytes32", "bytes32", "uint256"],
      [r.identity, r.oldKey, r.newKey, MANAGEMENT],
    ),
  );
  facts.push([
    "the rotation waited its 24h timelock",
    rotation.completed &&
      rotation.executionTime - rotation.initiatedAt === 86400n &&
      now >= Number(rotation.executionTime),
  ]);
  const cand = await km.getRecoveryCandidate(r.identity, r.recoveryKey);
  facts.push([
    "the recovery epoch closed (candidate cleared)",
    cand.initiatedAt === 0n,
  ]);
  for (const [label, ok] of facts)
    if (!ok) failures.push(`4.2: ${label} failed`);
  if (facts.every(([, ok]) => ok)) {
    console.log(
      `✅ Key lifecycle: ${facts.length} chain checks pass (rotation and recovery through KeyManager).`,
    );
  }
}

module.exports = { runKeySmoke };
