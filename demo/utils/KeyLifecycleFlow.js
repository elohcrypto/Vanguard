/**
 * @fileoverview The identity key lifecycle through KeyManager (plan v2 Task
 * 4.2): demo options 12, 12a, 12b and option 5's recovery and replacement.
 *
 * KeyManager holds no owner and no allowlist. An identity opts in with
 * OnchainID.authorizeManager(KeyManager) (owner only); after that a
 * MANAGEMENT key of the identity rotates keys behind a timelock (24h, or the
 * identity's own custom timelock). Recovery (Task 4.11, KeyRecoveryDrill.js)
 * evicts every other MANAGEMENT key 48h after the agents' approval and
 * moves the ownership 7 days after it. deauthorizeManager pauses KeyManager
 * for the identity (refused while a recovery is approved); it does not
 * cancel: cancelKeyRotation / cancelKeyRecovery stop an item, and an item
 * not executed within 7 days (EXECUTION_WINDOW) after its executionTime
 * expires. Before re-authorizing, the flow lists what is still pending
 * (option 5 and 12b ask first).
 *
 * Resuming works within one demo session (the keys live in memory): a
 * pending rotation or recovery candidate is not re-initiated. On a dev node
 * the flow jumps past each timelock with evm_increaseTime; elsewhere it
 * prints when the step becomes executable and the option to come back to.
 * The prompted option 5 and 12b paths are in KeyLifecycleOptions.js.
 */

const { ethers } = require("hardhat");
// Called through the module so a test can stand in for a public network.
const ChainTime = require("./ChainTime");
const {
  displaySection,
  displaySuccess,
  displayError,
} = require("./DisplayHelpers");

const MANAGEMENT = 1;
const ECDSA = 1;
/**
 * Option 12's defaults: wallet 1's identity; recovery agents 7 and 8, the
 * investors Bob and Carol, which hold no issuer, ops or guardian role
 * (docs/TESTNET_DEMO.md "Roles are wallet indices").
 */
const DEMO_WALLET = 1;
const AGENT_WALLETS = [7, 8];
/** The drill's recovered wallet: investor Alice, not an agent. */
const RECOVERED_WALLET = 6;
const ROLES = [
  "deployer",
  "fee wallet, compliance officer",
  "KYC issuer",
  "AML issuer",
  "risk oracle",
  "fraud oracle",
  "investor Alice",
  "investor Bob",
  "investor Carol",
  "issuer admin",
  "ops",
  "guardian",
];
const PURPOSES = { 1: "MANAGEMENT", 2: "ACTION", 3: "CLAIM", 4: "ENCRYPTION" };

const same = (a, b) => a.toLowerCase() === b.toLowerCase();
const keyOf = (addr) => ethers.solidityPackedKeccak256(["address"], [addr]);
/** A key nobody holds yet: the hash of a fresh random address. */
const freshKey = () => keyOf(ethers.Wallet.createRandom().address);
const short = (k) => `${k.slice(0, 10)}…${k.slice(-6)}`;
const signerFor = (state, addr) =>
  state.signers.find((s) => same(s.address, addr));
const at = (unix) => new Date(Number(unix) * 1000).toISOString();
/** "wallet N (role) 0x..", the way every print names a wallet. */
function who(state, addr) {
  const i = state.signers.findIndex((s) => same(s.address, addr));
  return i < 0 ? addr : `wallet ${i} (${ROLES[i] ?? "user"}) ${addr}`;
}

/**
 * The OnchainID owned by `wallet`: from demo state, the IdentityRegistry
 * or the factory, else created through the factory (as option 3 does).
 * Returns the contract connected to `wallet`.
 */
async function demoIdentity(state, wallet) {
  let addr = [...state.identities.values()].find((i) =>
    same(i.owner, wallet.address),
  )?.address;
  const registry = state.getContract("identityRegistry");
  if (!addr && registry) {
    const a = await registry.identity(wallet.address);
    if (a !== ethers.ZeroAddress) addr = a;
  }
  const factory = state.getContract("onchainIDFactory");
  if (!addr) {
    const a = await factory.getIdentityByOwner(wallet.address);
    if (a !== ethers.ZeroAddress) addr = a;
  }
  if (!addr) {
    const fee = await factory.deploymentFee();
    const salt = ethers.randomBytes(32);
    await (
      await factory
        .connect(wallet)
        .deployOnchainID(wallet.address, salt, { value: fee })
    ).wait();
    addr = await factory.getIdentityByOwner(wallet.address);
    console.log(`   🆔 Created OnchainID ${addr} for wallet ${wallet.address}`);
  }
  if (!state.identities.has(addr)) {
    state.identities.set(addr, {
      address: addr,
      owner: wallet.address,
      signer: wallet,
      createdAt: new Date().toISOString(),
    });
  }
  return (await ethers.getContractAt("OnchainID", addr)).connect(wallet);
}

/**
 * Rotations and recovery candidates of the identity still executable (not
 * done, not cancelled, inside the window), from KeyManager's events.
 */
async function pendingItems(km, idAddr) {
  const now = BigInt((await ethers.provider.getBlock("latest")).timestamp);
  const live = async (t) => now <= t + (await km.EXECUTION_WINDOW());
  const out = [];
  const seen = new Set();
  for (const ev of await km.queryFilter(
    km.filters.KeyRotationInitiated(idAddr),
  )) {
    const [, o, n, p] = ev.args;
    const rid = ethers.solidityPackedKeccak256(
      ["address", "bytes32", "bytes32", "uint256"],
      [idAddr, o, n, p],
    );
    const r = await km.getKeyRotation(idAddr, rid);
    if (seen.has(rid) || r.initiatedAt === 0n || r.completed) continue;
    seen.add(rid);
    if (await live(r.executionTime))
      out.push(
        `rotation ${short(o)} -> ${short(n)}, executable ${at(r.executionTime)}`,
      );
  }
  for (const ev of await km.queryFilter(
    km.filters.KeyRecoveryInitiated(idAddr),
  )) {
    const key = ev.args[1];
    const c = await km.getRecoveryCandidate(idAddr, key);
    if (seen.has(key) || c.initiatedAt === 0n) continue;
    seen.add(key);
    if (await live(c.executionTime))
      out.push(
        `recovery candidate ${short(key)} (${c.approvalCount} approvals), executable ${at(c.executionTime)}`,
      );
  }
  return out;
}

/**
 * authorizeManager / deauthorizeManager by the identity owner. Before
 * re-authorizing it lists what is still pending (withdrawal paused it);
 * with `confirm` (a prompt) it asks first and returns false on "no".
 */
async function setAuthorized(identity, owner, km, on, confirm) {
  const kmAddr = await km.getAddress();
  if ((await identity.authorizedManagers(kmAddr)) === on) return on;
  if (on) {
    const pending = await pendingItems(km, await identity.getAddress());
    if (pending.length) {
      console.log("   ⚠️  Re-authorizing re-arms these paused items (anyone");
      console.log("      can execute them inside their 7-day window); cancel");
      console.log("      them first (cancelKeyRotation / cancelKeyRecovery):");
      for (const p of pending) console.log(`      - ${p}`);
      if (confirm) {
        const a = await confirm("Re-authorize KeyManager anyway? (yes/no): ");
        if (a.trim().toLowerCase() !== "yes") {
          console.log("   KeyManager stays withdrawn.");
          return false;
        }
      }
    }
  }
  const id = identity.connect(owner);
  await (
    await (on ? id.authorizeManager(kmAddr) : id.deauthorizeManager(kmAddr))
  ).wait();
  console.log(
    `   ${on ? "✅ authorizeManager" : "🚫 deauthorizeManager"}(KeyManager ${kmAddr}) sent by owner ${owner.address}`,
  );
  return on;
}

/**
 * Ensure block.timestamp >= `executionTime`. Dev node: jump. Elsewhere:
 * print when it opens and return false (the caller comes back later).
 */
async function passTimelock(executionTime, label, comeBack) {
  const now = (await ethers.provider.getBlock("latest")).timestamp;
  const due = Number(executionTime);
  if (now >= due) return true;
  if (await ChainTime.canJumpTime()) {
    await ethers.provider.send("evm_increaseTime", [due - now + 1]);
    await ethers.provider.send("evm_mine", []);
    console.log(`   ⏩ ${label}: jumped ${due - now + 1}s (dev node)`);
    return true;
  }
  console.log(`   ⏳ ${label}: executable from ${at(due)} (chain time),`);
  console.log("      for 7 days; after that it expires and starts over.");
  console.log(
    `      Come back then: ${comeBack} resumes from this step (same session).`,
  );
  return false;
}

/** True once `executionTime` + EXECUTION_WINDOW has passed. */
async function expired(km, executionTime) {
  const now = BigInt((await ethers.provider.getBlock("latest")).timestamp);
  return now > executionTime + (await km.EXECUTION_WINDOW());
}

/**
 * Rotate `oldKey` -> `newKey` (`purpose`) through KeyManager, sent by
 * `manager` (a MANAGEMENT key of the identity). A pending rotation is not
 * re-initiated. Returns { executed, executionTime }.
 */
async function rotateKey(km, identity, manager, oldKey, newKey, purpose, back) {
  const idAddr = await identity.getAddress();
  const rotationId = ethers.solidityPackedKeccak256(
    ["address", "bytes32", "bytes32", "uint256"],
    [idAddr, oldKey, newKey, purpose],
  );
  let r = await km.getKeyRotation(idAddr, rotationId);
  if (r.completed) return { executed: true, executionTime: r.executionTime };
  if (r.initiatedAt === 0n || (await expired(km, r.executionTime))) {
    await (
      await km
        .connect(manager)
        .initiateKeyRotation(idAddr, oldKey, newKey, purpose)
    ).wait();
    r = await km.getKeyRotation(idAddr, rotationId);
    const hours = Number(r.executionTime - r.initiatedAt) / 3600;
    console.log(
      `   🔄 initiateKeyRotation: ${short(oldKey)} -> ${short(newKey)} (${PURPOSES[purpose] ?? purpose}), timelock ${hours}h`,
    );
  } else {
    console.log(`   🔄 Rotation already pending since ${at(r.initiatedAt)}`);
  }
  if (!(await passTimelock(r.executionTime, "rotation timelock", back))) {
    return { executed: false, executionTime: r.executionTime };
  }
  await (
    await km
      .connect(manager)
      .executeKeyRotation(idAddr, oldKey, newKey, purpose)
  ).wait();
  console.log("   ✅ executeKeyRotation: new key added, old key revoked");
  return { executed: true, executionTime: r.executionTime };
}

/** Print the identity's live keys by purpose and its KeyManager opt-in. */
async function reviewKeys(identity, km, marks = {}) {
  const idAddr = await identity.getAddress();
  console.log(`\n🔍 Keys of OnchainID ${idAddr}`);
  for (const p of [1, 2, 3, 4]) {
    const keys = await identity.getKeysByPurpose(p);
    if (keys.length === 0) continue;
    console.log(`   ${PURPOSES[p]}:`);
    for (const k of keys)
      console.log(`     ${k}${marks[k] ? `  ${marks[k]}` : ""}`);
  }
  for (const [k, label] of Object.entries(marks)) {
    const info = await identity.getKey(k);
    if (info.revokedAt > 0n) console.log(`   revoked: ${k}  ${label}`);
  }
  const authorized = await identity.authorizedManagers(await km.getAddress());
  console.log(`   KeyManager authorized: ${authorized ? "yes" : "no"}`);
  return authorized;
}

/** Option 12's (and the smoke's) prerequisites, or null with a hint. */
function lifecycleContext(state) {
  const km = state.getContract("keyManager");
  if (!km || !state.getContract("onchainIDFactory")) {
    displayError("Deploy contracts first (option 1 deploys KeyManager)");
    return null;
  }
  return { km, owner: state.signers[DEMO_WALLET] };
}

/**
 * Option 12, no prompts: authorize KeyManager on wallet 1's demo identity,
 * add a fresh MANAGEMENT key through batchAddKeys, rotate it to another
 * fresh key, then run the recovery drill (KeyRecoveryDrill.js) on a drill
 * identity owned by wallet 1: a planted rogue MANAGEMENT key is evicted
 * 48h after agents 7 and 8 approve, and wallet 6 becomes the owner 7 days
 * after it. Review the keys, then revoke the rotated-in key (nobody holds
 * it; wallet 1 keeps its own). Re-running after a real-network pause
 * resumes the same keys in the same session. Returns what happened.
 */
async function runKeyLifecycle(state) {
  displaySection("KEY LIFECYCLE THROUGH KEYMANAGER (OPTION 12)", "🔐");
  const ctx = lifecycleContext(state);
  if (!ctx) return null;
  const { km, owner } = ctx;
  const identity = await demoIdentity(state, owner);
  const idAddr = await identity.getAddress();
  console.log(`   Identity: ${idAddr}, owner ${who(state, owner.address)}`);
  let run = state.keyLifecycle;
  if (!run || run.done || !same(run.identity, idAddr)) {
    run = { identity: idAddr, oldKey: freshKey(), newKey: freshKey() };
    run.drill = {};
    state.keyLifecycle = run;
  }
  await setAuthorized(identity, owner, km, true);

  const back = "option 12";
  const rotated = await identity.getKey(run.oldKey);
  if (rotated.key === ethers.ZeroHash) {
    await (
      await km
        .connect(owner)
        .batchAddKeys(idAddr, [run.oldKey], [MANAGEMENT], [ECDSA])
    ).wait();
    console.log(`   ➕ batchAddKeys: MANAGEMENT key ${short(run.oldKey)}`);
  }
  const rotation = await rotateKey(
    km,
    identity,
    owner,
    run.oldKey,
    run.newKey,
    MANAGEMENT,
    back,
  );
  if (!rotation.executed) return { ...run, rotation, done: false };

  const authorized = await reviewKeys(identity, km, {
    [run.oldKey]: "(rotated out)",
    [run.newKey]: "(rotated in)",
  });
  if (await identity.keyHasPurpose(run.newKey, MANAGEMENT)) {
    // N4: leave no live key nobody holds.
    await (
      await km
        .connect(owner)
        .batchRemoveKeys(idAddr, [run.newKey], [MANAGEMENT])
    ).wait();
    console.log("   🧹 batchRemoveKeys: revoked the rotated-in key option 12");
    console.log("      created (random, nobody holds it); wallet 1 keeps its");
    console.log("      own MANAGEMENT key.");
  }

  console.log("\n🛡️  Recovery drill: eviction and owner transfer (Task 4.11)");
  const { runRecoveryDrill } = require("./KeyRecoveryDrill");
  const recovery = await runRecoveryDrill(state, {
    km,
    owner,
    recovered: state.signers[RECOVERED_WALLET],
    agents: AGENT_WALLETS.map((i) => state.signers[i]),
    back,
    run: run.drill,
  });
  if (!recovery.done) return { ...run, rotation, recovery, done: false };
  run.done = true;
  displaySuccess(
    "Key rotated; recovery evicted the rogue key and moved the owner",
  );
  return {
    ...run,
    keyManager: await km.getAddress(),
    authorized,
    rotation,
    recovery,
  };
}

/**
 * Option 12a, no prompts: toggle KeyManager's authorization on wallet 1's
 * demo identity and show the gate (a rotation through KeyManager is
 * refused while it is withdrawn).
 */
async function toggleAuthorization(state) {
  displaySection("KEYMANAGER AUTHORIZATION (OPTION 12a)", "🔐");
  const ctx = lifecycleContext(state);
  if (!ctx) return null;
  const { km, owner } = ctx;
  const identity = await demoIdentity(state, owner);
  const kmAddr = await km.getAddress();
  const on = !(await identity.authorizedManagers(kmAddr));
  await setAuthorized(identity, owner, km, on);
  const probe = [await identity.getAddress(), keyOf(owner.address)];
  try {
    await km
      .connect(owner)
      .initiateKeyRotation.staticCall(...probe, freshKey(), MANAGEMENT);
    console.log("   ✅ KeyManager accepts a rotation for this identity");
  } catch (e) {
    const why = e.reason ?? e.shortMessage ?? e.message;
    console.log(`   🚫 KeyManager refuses a rotation: ${why.split("\n")[0]}`);
  }
  console.log(
    on
      ? "   Option 12 runs the lifecycle; 12a again withdraws the authorization."
      : "   Option 12a again (or option 12) re-authorizes it.",
  );
  return identity.authorizedManagers(kmAddr);
}

module.exports = {
  DEMO_WALLET,
  AGENT_WALLETS,
  RECOVERED_WALLET,
  MANAGEMENT,
  same,
  keyOf,
  who,
  signerFor,
  demoIdentity,
  pendingItems,
  setAuthorized,
  rotateKey,
  passTimelock,
  reviewKeys,
  lifecycleContext,
  runKeyLifecycle,
  toggleAuthorization,
};
