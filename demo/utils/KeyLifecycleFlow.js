/**
 * @fileoverview The identity key lifecycle through KeyManager (plan v2 Task
 * 4.2): demo options 12, 12a, 12b and option 5's recovery and replacement.
 *
 * KeyManager holds no owner and no allowlist. An identity opts in with
 * OnchainID.authorizeManager(KeyManager) (owner only); after that a
 * MANAGEMENT key of the identity rotates keys behind a timelock (24h, or the
 * identity's own custom timelock) and recovery agents add a new MANAGEMENT
 * key behind a 48h timelock. deauthorizeManager withdraws the opt-in.
 *
 * Every step is resumable from the chain: a pending rotation or recovery
 * candidate is not re-initiated. On a dev node the flow jumps past each
 * timelock with evm_increaseTime; elsewhere it prints when the step becomes
 * executable and the option to come back to.
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
/** Option 12's defaults: the demo identity of wallet 1, agents 2 and 3. */
const DEMO_WALLET = 1;
const AGENT_WALLETS = [2, 3];
const PURPOSES = { 1: "MANAGEMENT", 2: "ACTION", 3: "CLAIM", 4: "ENCRYPTION" };

const same = (a, b) => a.toLowerCase() === b.toLowerCase();
const keyOf = (addr) => ethers.solidityPackedKeccak256(["address"], [addr]);
/** A key nobody holds yet: the hash of a fresh random address. */
const freshKey = () => keyOf(ethers.Wallet.createRandom().address);
const short = (k) => `${k.slice(0, 10)}…${k.slice(-6)}`;
const signerFor = (state, addr) =>
  state.signers.find((s) => same(s.address, addr));
const at = (unix) => new Date(Number(unix) * 1000).toISOString();

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

/** authorizeManager / deauthorizeManager by the identity owner. */
async function setAuthorized(identity, owner, km, on) {
  const kmAddr = await km.getAddress();
  if ((await identity.authorizedManagers(kmAddr)) === on) return on;
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
  console.log(`   ⏳ ${label}: executable from ${at(due)} (chain time).`);
  console.log(`      Come back then: ${comeBack} resumes from this step.`);
  return false;
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
  if (r.initiatedAt === 0n) {
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

/**
 * Recover the identity onto `key` (added as MANAGEMENT): `manager` sets up
 * `agents` (threshold `threshold`), agents[0] opens the candidate, the
 * first `threshold` agents approve, then it executes after 48h. A pending
 * candidate for `key` is resumed, not re-opened.
 */
async function recoverKey(km, identity, manager, agents, threshold, key, back) {
  const idAddr = await identity.getAddress();
  if (await identity.keyHasPurpose(key, MANAGEMENT)) {
    return { executed: true };
  }
  let c = await km.getRecoveryCandidate(idAddr, key);
  if (c.initiatedAt === 0n) {
    const list = agents.map((a) => a.address);
    await (
      await km.connect(manager).setupKeyRecovery(idAddr, list, threshold)
    ).wait();
    console.log(
      `   🛡️  setupKeyRecovery: ${threshold}-of-${list.length} agents ${list.join(", ")}`,
    );
    await (await km.connect(agents[0]).initiateKeyRecovery(idAddr, key)).wait();
    c = await km.getRecoveryCandidate(idAddr, key);
    console.log(
      `   🚨 initiateKeyRecovery by agent ${agents[0].address}: new key ${short(key)}`,
    );
  } else {
    console.log(`   🚨 Recovery already pending since ${at(c.initiatedAt)}`);
  }
  for (const agent of agents.slice(0, threshold)) {
    if (await km.hasApprovedRecovery(idAddr, key, agent.address)) continue;
    await (await km.connect(agent).approveKeyRecovery(idAddr, key)).wait();
    console.log(`   👍 approveKeyRecovery by agent ${agent.address}`);
  }
  if (!(await passTimelock(c.executionTime, "recovery timelock", back))) {
    return { executed: false, executionTime: c.executionTime };
  }
  await (await km.connect(agents[0]).executeKeyRecovery(idAddr, key)).wait();
  console.log("   ✅ executeKeyRecovery: recovery key added as MANAGEMENT");
  return { executed: true, executionTime: c.executionTime };
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
 * fresh key, recover onto a third fresh key with agents 2 and 3 (2-of-2),
 * then review the keys. Re-running after a real-network pause resumes the
 * same keys. Returns what happened, read from the chain.
 */
async function runKeyLifecycle(state) {
  displaySection("KEY LIFECYCLE THROUGH KEYMANAGER (OPTION 12)", "🔐");
  const ctx = lifecycleContext(state);
  if (!ctx) return null;
  const { km, owner } = ctx;
  const identity = await demoIdentity(state, owner);
  const idAddr = await identity.getAddress();
  console.log(`   Identity: ${idAddr} (owner wallet ${DEMO_WALLET})`);
  let run = state.keyLifecycle;
  if (!run || run.done || !same(run.identity, idAddr)) {
    run = { identity: idAddr, oldKey: freshKey(), newKey: freshKey() };
    run.recoveryKey = freshKey();
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

  const agents = AGENT_WALLETS.map((i) => state.signers[i]);
  const recovery = await recoverKey(
    km,
    identity,
    owner,
    agents,
    agents.length,
    run.recoveryKey,
    back,
  );
  if (!recovery.executed) return { ...run, rotation, recovery, done: false };

  const authorized = await reviewKeys(identity, km, {
    [run.oldKey]: "(rotated out)",
    [run.newKey]: "(rotated in)",
    [run.recoveryKey]: "(recovered)",
  });
  run.done = true;
  displaySuccess("Key rotated and identity recovered through KeyManager");
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

/** "wallet index" or a passphrase -> key hash (option 5's input narrative). */
async function askKey(state, prompt, question) {
  const answer = (await prompt(question)).trim();
  if (/^\d+$/.test(answer) && state.signers[Number(answer)]) {
    const a = state.signers[Number(answer)].address;
    return { key: keyOf(a), info: `wallet ${answer} (${a})` };
  }
  if (!answer) return null;
  return {
    key: ethers.id(answer),
    info: `passphrase (${answer.length} chars)`,
  };
}

/** The owner's signer for an option 5 identity record, or null. */
function ownerOf(state, record) {
  const owner = signerFor(state, record.owner);
  if (!owner) displayError(`Owner ${record.owner} is not a demo signer`);
  return owner;
}

/**
 * Option 5 -> 2: recovery agents restore access to `record` (a demo
 * identity) on a new MANAGEMENT key, through KeyManager's 48h timelock.
 */
async function recoverInteractive(state, record, prompt) {
  const km = state.getContract("keyManager");
  const owner = ownerOf(state, record);
  if (!km || !owner) return null;
  const identity = (
    await ethers.getContractAt("OnchainID", record.address)
  ).connect(owner);
  const agents = state.signers
    .slice(2, 6)
    .filter((s) => !same(s.address, owner.address))
    .slice(0, 2);
  console.log("\n🚨 RECOVERY THROUGH KEYMANAGER");
  console.log("   The holder lost a key; two recovery agents restore access.");
  console.log(`   Agents: ${agents.map((a) => a.address).join(", ")} (2-of-2)`);
  const k = await askKey(
    state,
    prompt,
    "New key (wallet index or passphrase): ",
  );
  if (!k) return displayError("No key given");
  await setAuthorized(identity, owner, km, true);
  const r = await recoverKey(
    km,
    identity,
    owner,
    agents,
    2,
    k.key,
    "option 5 -> 2",
  );
  if (r.executed) displaySuccess(`Recovered onto ${k.info}`);
  await reviewKeys(identity, km, { [k.key]: "(recovered)" });
  return r;
}

/**
 * Option 5 -> 3: replace a MANAGEMENT key of `record` through KeyManager's
 * rotation timelock, sent by the owner.
 */
async function replaceInteractive(state, record, prompt) {
  const km = state.getContract("keyManager");
  const owner = ownerOf(state, record);
  if (!km || !owner) return null;
  const identity = (
    await ethers.getContractAt("OnchainID", record.address)
  ).connect(owner);
  const keys = await identity.getKeysByPurpose(MANAGEMENT);
  console.log("\n🔄 REPLACE A MANAGEMENT KEY THROUGH KEYMANAGER");
  keys.forEach((k, i) => console.log(`   ${i}: ${k}`));
  const oldKey =
    keys[Number(await prompt(`Key to replace (0-${keys.length - 1}): `))];
  if (!oldKey) return displayError("Invalid key selection");
  if (oldKey === keyOf(owner.address)) {
    console.log(
      "   ⚠️  This is the owner's own key; the owner keeps owner() rights.",
    );
  }
  const k = await askKey(
    state,
    prompt,
    "New key (wallet index or passphrase): ",
  );
  if (!k) return displayError("No key given");
  await setAuthorized(identity, owner, km, true);
  const r = await rotateKey(
    km,
    identity,
    owner,
    oldKey,
    k.key,
    MANAGEMENT,
    "option 5 -> 3",
  );
  if (r.executed) displaySuccess(`Management key replaced by ${k.info}`);
  await reviewKeys(identity, km, { [oldKey]: "(replaced)", [k.key]: "(new)" });
  return r;
}

/** Option 12b: set wallet 1's identity rotation timelock (1h..168h). */
async function setTimelockInteractive(state, prompt) {
  displaySection("ROTATION TIMELOCK (OPTION 12b)", "⏱️");
  const ctx = lifecycleContext(state);
  if (!ctx) return null;
  const { km, owner } = ctx;
  const identity = await demoIdentity(state, owner);
  const hours = Number(await prompt("Rotation timelock in hours (1-168): "));
  if (!Number.isInteger(hours) || hours < 1 || hours > 168) {
    return displayError("Timelock must be 1-168 whole hours");
  }
  await setAuthorized(identity, owner, km, true);
  const idAddr = await identity.getAddress();
  await (
    await km.connect(owner).setCustomTimelock(idAddr, hours * 3600)
  ).wait();
  displaySuccess(`Rotations of ${idAddr} now wait ${hours}h`);
  return hours * 3600;
}

module.exports = {
  DEMO_WALLET,
  AGENT_WALLETS,
  keyOf,
  demoIdentity,
  runKeyLifecycle,
  toggleAuthorization,
  recoverInteractive,
  replaceInteractive,
  setTimelockInteractive,
};
