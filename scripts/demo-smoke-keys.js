/**
 * Key lifecycle section of scripts/demo-smoke.js (plan v2 Task 4.2).
 *
 * Runs demo option 12 (demo/utils/KeyLifecycleFlow.js) against the smoke's
 * deployment: the KeyManager option 1 deployed is authorized on wallet 1's
 * identity, one rotation and one recovery run through their timelocks on
 * the dev node, and the key set is read back from chain. Records the
 * identity in state.keyLifecycle for the handover ceremony's check.
 * Then option 5a (demo/utils/KeyRemovalFlow.js, Task 4.5): a key removed
 * with its holder's signature is gone, a stranger's signature is refused,
 * and a removed key is not removed again.
 */

const { ethers } = require("hardhat");
const {
  DEMO_WALLET,
  AGENT_WALLETS,
  keyOf,
  runKeyLifecycle,
} = require("../demo/utils/KeyLifecycleFlow");
const {
  innerMessage,
  runRemovalDemo,
} = require("../demo/utils/KeyRemovalFlow");

const MANAGEMENT = 1;
const ACTION = 2;

/** Option 5a, then its facts read from chain (not from the flow's return). */
async function removalFacts(state, failures) {
  const real = console.log;
  console.log = () => {};
  let r;
  try {
    r = await runRemovalDemo(state);
  } catch (e) {
    failures.push(`4.5: option 5a threw: ${e.message.split("\n")[0]}`);
    return [];
  } finally {
    console.log = real;
  }
  if (!r) return [["option 5a ran", false]];
  const owner = state.signers[DEMO_WALLET];
  const id = (await ethers.getContractAt("OnchainID", r.identity)).connect(
    owner,
  );
  const removed = await id.queryFilter(id.filters.KeyRemoved(r.key, ACTION));
  // The revert reason of a static removeKeyWithProof, or "" if accepted.
  const reason = async (key, signer) => {
    const sig = await signer.signMessage(
      ethers.getBytes(await innerMessage(id, key, ACTION)),
    );
    try {
      await id.removeKeyWithProof.staticCall(key, ACTION, sig);
      return "";
    } catch (e) {
      return e.message;
    }
  };
  // A stranger against a live key: a fresh one, removed again after.
  const live = ethers.Wallet.createRandom();
  const liveKey = keyOf(live.address);
  await (await id.addKey(liveKey, ACTION, 1)).wait();
  const stranger = await reason(liveKey, ethers.Wallet.createRandom());
  await (await id.removeKey(liveKey, ACTION)).wait();
  const info = await id.getKey(r.key);
  return [
    [
      "5a: the key removed with proof is gone (keyHasPurpose false, revokedAt set)",
      !(await id.keyHasPurpose(r.key, ACTION)) && info.revokedAt > 0n,
    ],
    ["5a: KeyRemoved was emitted for it", removed.length === 1],
    [
      "5a: a stranger's signature is refused",
      /does not prove ownership/.test(stranger),
    ],
    [
      "5a: the removed key is not removed again",
      /Key already revoked/.test(await reason(r.key, live)),
    ],
  ];
}

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
  // Was MANAGEMENT, now revoked: option 12 cleans up the keys it made (N4).
  const wasMgmtNowRevoked = async (k) => {
    const info = await id.getKey(k);
    return info.purpose === 1n && info.revokedAt > 0n;
  };
  const ts = async (ev) => (await ev.getBlock()).timestamp;
  const one = async (f) => (await km.queryFilter(f)).at(-1);
  const rotDone = await one(
    km.filters.KeyRotationCompleted(r.identity, r.oldKey, r.newKey),
  );
  const rotInit = await one(
    km.filters.KeyRotationInitiated(r.identity, r.oldKey, r.newKey),
  );
  const recInit = await one(
    km.filters.KeyRecoveryInitiated(r.identity, r.recoveryKey),
  );
  const recDone = await one(
    km.filters.KeyRecoveryCompleted(r.identity, r.recoveryKey),
  );
  const rec = await km.getKeyRecovery(r.identity);
  const agents = AGENT_WALLETS.map((i) => state.signers[i].address);
  const facts = [
    [
      "KeyManager is authorized on the demo identity",
      await id.authorizedManagers(kmAddr),
    ],
    ["the rotated-out key is gone", await wasMgmtNowRevoked(r.oldKey)],
    [
      "the rotation added the rotated-in key (KeyRotationCompleted)",
      Boolean(rotDone),
    ],
    [
      "the recovery added the recovery key (KeyRecoveryCompleted)",
      Boolean(recDone),
    ],
    [
      "the rotation waited its 24h timelock",
      rotInit && rotDone && (await ts(rotDone)) - (await ts(rotInit)) >= 86400,
    ],
    [
      "the recovery waited its 48h timelock",
      recInit && recDone && (await ts(recDone)) - (await ts(recInit)) >= 172800,
    ],
    [
      "recovery completed with agents 7 and 8 (no issuer role)",
      rec.completed && rec.recoveryAgents.join() === agents.join(),
    ],
    [
      "option 12 revoked the rotated-in and recovered keys it created",
      (await wasMgmtNowRevoked(r.newKey)) &&
        (await wasMgmtNowRevoked(r.recoveryKey)),
    ],
    ["wallet 1 keeps its MANAGEMENT key", await has(keyOf(wallet))],
    ...(await removalFacts(state, failures)),
  ];
  for (const [label, ok] of facts)
    if (!ok) failures.push(`4.2/4.5: ${label} failed`);
  if (facts.every(([, ok]) => ok)) {
    console.log(
      `✅ Key lifecycle: ${facts.length} chain checks pass (rotation and recovery through KeyManager, removal with proof).`,
    );
  }
}

module.exports = { runKeySmoke };
