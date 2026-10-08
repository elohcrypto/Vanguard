/**
 * Key lifecycle section of scripts/demo-smoke.js (plan v2 Task 4.2).
 *
 * Runs demo option 12 (demo/utils/KeyLifecycleFlow.js) against the smoke's
 * deployment: the KeyManager option 1 deployed is authorized on wallet 1's
 * identity, one rotation runs through its timelock on the dev node, and
 * option 12's recovery drill (Task 4.11) evicts a planted rogue MANAGEMENT
 * key 48h after the agents' approval and moves the drill identity's
 * ownership to wallet 6 7 days after it; the key sets, owners, event
 * timestamps and refusals are read back from chain. Records the identity
 * in state.keyLifecycle for the handover ceremony's check.
 * Then option 5a (demo/utils/KeyRemovalFlow.js, Task 4.5): a key removed
 * with its holder's signature is gone, a stranger's signature is refused,
 * and a removed key is not removed again. First, options 6/7 revoke and
 * update (Task 4.8 b, demo/utils/OnchainIDClaimChain.js) through the
 * module API: a revoked-then-refreshed wallet reads isVerified false and,
 * re-attested by "update -> ISSUED", true again (chain reads).
 */

const { ethers } = require("hardhat");
const {
  DEMO_WALLET,
  AGENT_WALLETS,
  RECOVERED_WALLET,
  keyOf,
  runKeyLifecycle,
} = require("../demo/utils/KeyLifecycleFlow");
const {
  innerMessage,
  runRemovalDemo,
} = require("../demo/utils/KeyRemovalFlow");
const { refusal } = require("../demo/utils/KeyRecoveryDrill");
const OnchainIDModule = require("../demo/modules/OnchainIDModule");
const { EnhancedLogger } = require("../demo/logging");
const { KYC_TOPIC, cacheVerification } = require("../demo/utils/Kyc");

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

/** Options 6 -> 5 and 6 -> 3 -> 1 on wallet 6 (verified in the smoke's step 6). */
async function claimRevocationSmoke(state, failures) {
  const wallet = state.signers[6].address;
  const registry = state.getContract("identityRegistry");
  const kyc = state.getContract("kycIssuer");
  const address = await registry.identity(wallet);
  if (address === ethers.ZeroAddress || !(await registry.isVerified(wallet))) {
    failures.push("4.8b: wallet 6 is not a verified identity to revoke");
    return;
  }
  // Cache wallet 6's verification first (4.9), so a stale cache would keep
  // isVerified true unless the option refreshes after revoking.
  await cacheVerification(state, wallet, () => {});
  if ((await registry.verifiedUntil(address))[1] === 0n) {
    failures.push("4.8b: wallet 6's verification did not cache");
    return;
  }
  const identity = { address, owner: wallet };
  // The record option 6 -> 1 writes; the smoke attested wallet 6 directly.
  state.claims.set(`${address}_KYC`, { type: "KYC", countryCode: 840 });
  const oid = new OnchainIDModule(state, new EnhancedLogger(), async () => "1");
  const real = console.log;
  const facts = async () => [
    await kyc.hasValidClaim(address, KYC_TOPIC),
    await registry.isVerified(wallet),
  ];
  let revoked, reissued;
  console.log = () => {};
  try {
    await oid.revokeKYCClaimForIdentity(identity);
    revoked = await facts();
    await oid.updateKYCStatusForIdentity(identity); // prompt answers "1"
    reissued = await facts();
  } catch (e) {
    failures.push(`4.8b: claim options threw: ${e.message.split("\n")[0]}`);
    return;
  } finally {
    console.log = real;
  }
  const ok =
    revoked.join() === "false,false" &&
    state.claims.get(`${address}_KYC`).status === "ISSUED" &&
    reissued.join() === "true,true";
  if (!ok) {
    failures.push(
      `4.8b: revoke -> (hasValidClaim, isVerified) ${revoked}, re-issue -> ${reissued}`,
    );
    return;
  }
  console.log(
    "✅ Claim options 6/7: revoked + refreshed reads isVerified false, re-attested true (chain).",
  );
}

async function runKeySmoke(state, failures) {
  await claimRevocationSmoke(state, failures); // 4.8 (b)
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
  // Task 4.11: the drill identity, read from chain.
  const d = r.recovery;
  const drill = await ethers.getContractAt("OnchainID", d.identity);
  const rescued = state.signers[RECOVERED_WALLET].address;
  const rogueKey = keyOf(d.rogue);
  const recApproved = await one(km.filters.KeyRecoveryApproved(d.identity));
  const recDone = await one(km.filters.KeyRecoveryCompleted(d.identity));
  const evicted = await km.queryFilter(
    km.filters.KeyRecoveryKeyEvicted(d.identity, rogueKey),
  );
  const proposed = await one(
    km.filters.RecoveryOwnerTransferProposed(d.identity, rescued),
  );
  const rec = await km.getKeyRecovery(d.identity);
  const mgmt = await drill.getKeysByPurpose(MANAGEMENT);
  const rogueCancel = await refusal(
    km,
    "cancelKeyRecovery",
    [d.identity, keyOf(rescued)],
    d.rogue,
  );
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
      "the rotation waited its 24h timelock",
      rotInit && rotDone && (await ts(rotDone)) - (await ts(rotInit)) >= 86400,
    ],
    [
      "recovery executed 48h after the approval (KeyRecoveryApproved -> Completed)",
      recApproved &&
        recDone &&
        (await ts(recDone)) - (await ts(recApproved)) >= 172800,
    ],
    [
      "recovery ran with agents 7 and 8 (no issuer role)",
      rec.completed && rec.recoveryAgents.join() === agents.join(),
    ],
    [
      "the rogue MANAGEMENT key was evicted (KeyRecoveryKeyEvicted, keyHasPurpose false)",
      evicted.length === 1 &&
        !(await drill.keyHasPurpose(rogueKey, MANAGEMENT)),
    ],
    [
      "wallet 6's key is the drill identity's only MANAGEMENT key",
      mgmt.length === 1 && mgmt[0] === keyOf(rescued),
    ],
    [
      "the owner transfer waited 7 days after the approval",
      recApproved &&
        proposed &&
        (await ts(proposed)) - (await ts(recApproved)) >= 604800,
    ],
    [
      "wallet 6 accepted: owner() is wallet 6",
      (await drill.owner()) === rescued,
    ],
    [
      "the rogue key's cancel was refused (and the old owner's accept)",
      Boolean(rogueCancel) && d.refused && d.oldOwnerRefused,
    ],
    [
      "option 12 revoked the rotated-in key it created",
      await wasMgmtNowRevoked(r.newKey),
    ],
    ["wallet 1 keeps its MANAGEMENT key", await has(keyOf(wallet))],
    ...(await removalFacts(state, failures)),
  ];
  for (const [label, ok] of facts)
    if (!ok) failures.push(`4.2/4.5: ${label} failed`);
  if (facts.every(([, ok]) => ok)) {
    console.log(
      `✅ Key lifecycle: ${facts.length} chain checks pass (rotation, recovery eviction at 48h and owner transfer at 7 days through KeyManager, removal with proof).`,
    );
  }
}

module.exports = { runKeySmoke };
