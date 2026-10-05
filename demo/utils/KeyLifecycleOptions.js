/**
 * @fileoverview The prompted KeyManager paths (plan v2 Task 4.2): option
 * 5 -> 2 (recovery), 5 -> 3 (replace a MANAGEMENT key) and 12b (rotation
 * timelock). The shared steps live in KeyLifecycleFlow.js.
 */

const { ethers } = require("hardhat");
const {
  displaySection,
  displaySuccess,
  displayError,
} = require("./DisplayHelpers");
const {
  AGENT_WALLETS,
  MANAGEMENT,
  same,
  keyOf,
  who,
  signerFor,
  demoIdentity,
  setAuthorized,
  rotateKey,
  recoverKey,
  reviewKeys,
  lifecycleContext,
} = require("./KeyLifecycleFlow");

/** A wallet index or a passphrase -> key hash (option 5's input narrative). */
async function askKey(state, prompt, question) {
  const answer = (await prompt(question)).trim();
  if (/^\d+$/.test(answer) && state.signers[Number(answer)]) {
    const a = state.signers[Number(answer)].address;
    return { key: keyOf(a), info: who(state, a), label: false };
  }
  if (!answer) return null;
  console.log("   ℹ️  A passphrase key is a label (keccak256 of the text):");
  console.log("      nobody can sign with it, so it restores no access.");
  return {
    key: ethers.id(answer),
    info: `passphrase (${answer.length} chars)`,
    label: true,
  };
}

/** The identity record's owner signer and OnchainID, or null. */
async function ownerAndIdentity(state, record) {
  const km = state.getContract("keyManager");
  const owner = signerFor(state, record.owner);
  if (!owner) displayError(`Owner ${record.owner} is not a demo signer`);
  if (!km || !owner) return null;
  const id = await ethers.getContractAt("OnchainID", record.address);
  return { km, owner, identity: id.connect(owner) };
}

/**
 * Option 5 -> 2: recovery agents add a new MANAGEMENT key to `record`
 * through KeyManager's 48h timelock. The setup is the holder's: the owner
 * authorizes KeyManager and names the agents while it still holds its key,
 * which the demo does here as a separate, labelled step.
 */
async function recoverInteractive(state, record, prompt) {
  const ctx = await ownerAndIdentity(state, record);
  if (!ctx) return null;
  const { km, owner, identity } = ctx;
  const agents = [...AGENT_WALLETS, 6]
    .map((i) => state.signers[i])
    .filter((s) => !same(s.address, owner.address))
    .slice(0, 2);
  console.log("\n🚨 RECOVERY THROUGH KEYMANAGER");
  console.log(
    "   Step A, the holder, beforehand: while it still holds its key,",
  );
  console.log("   the owner authorizes KeyManager and names recovery agents.");
  console.log("   A holder who already lost every key cannot do this step;");
  console.log("   set recovery up at onboarding.");
  console.log(`   Owner: ${who(state, owner.address)}`);
  for (const a of agents) console.log(`   Agent: ${who(state, a.address)}`);
  console.log("   Step B, later: the agents (2-of-2) add a new MANAGEMENT key");
  console.log("   after 48h unless the owner or a MANAGEMENT key cancels it.");
  console.log("   Recovery never restores owner().");
  const k = await askKey(
    state,
    prompt,
    "New key (wallet index or passphrase): ",
  );
  if (!k) return displayError("No key given");
  if (!(await setAuthorized(identity, owner, km, true, prompt))) return null;
  const r = await recoverKey(
    state,
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
  const ctx = await ownerAndIdentity(state, record);
  if (!ctx) return null;
  const { km, owner, identity } = ctx;
  const keys = await identity.getKeysByPurpose(MANAGEMENT);
  console.log("\n🔄 REPLACE A MANAGEMENT KEY THROUGH KEYMANAGER");
  console.log(`   Sent by the owner, ${who(state, owner.address)}`);
  keys.forEach((k, i) => console.log(`   ${i}: ${k}`));
  const oldKey =
    keys[Number(await prompt(`Key to replace (0-${keys.length - 1}): `))];
  if (!oldKey) return displayError("Invalid key selection");
  if (oldKey === keyOf(owner.address)) {
    console.log("   ⚠️  This is the owner's own key. OnchainID still accepts");
    console.log(
      "      owner() as a manager, but KeyManager accepts MANAGEMENT",
    );
    console.log(
      "      keys only: options 12, 12b and 5 -> 2/3 will refuse this",
    );
    console.log("      owner until it holds a MANAGEMENT key again.");
  }
  const k = await askKey(
    state,
    prompt,
    "New key (wallet index or passphrase): ",
  );
  if (!k) return displayError("No key given");
  if (!(await setAuthorized(identity, owner, km, true, prompt))) return null;
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
  if (!(await setAuthorized(identity, owner, km, true, prompt))) return null;
  const idAddr = await identity.getAddress();
  await (
    await km.connect(owner).setCustomTimelock(idAddr, hours * 3600)
  ).wait();
  displaySuccess(`Rotations of ${idAddr} now wait ${hours}h`);
  return hours * 3600;
}

module.exports = {
  recoverInteractive,
  replaceInteractive,
  setTimelockInteractive,
};
