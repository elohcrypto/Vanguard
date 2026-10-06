/**
 * @fileoverview Key removal with the holder's consent (plan v2 Task 4.5):
 * option 5 -> 1 (prompted) and option 5a (no prompts).
 *
 * OnchainID.removeKeyWithProof is sent by a MANAGEMENT key and carries a
 * signature by the key's own address over the digest getRemoveKeyMessage
 * returns. That digest is already EIP-191 prefixed, so the holder signs
 * the inner keccak256 with signMessage (which adds the prefix) and the
 * result recovers against the digest. removeKey is the management action
 * without consent (KeyManager rotations, non-ECDSA keys).
 */

const { ethers } = require("hardhat");
const {
  displaySection,
  displaySuccess,
  displayError,
} = require("./DisplayHelpers");
const { DEMO_WALLET, keyOf, who, demoIdentity } = require("./KeyLifecycleFlow");

const ACTION = 2;
const ECDSA = 1;
const PURPOSES = { 1: "MANAGEMENT", 2: "ACTION", 3: "CLAIM", 4: "ENCRYPTION" };

/**
 * The inner message removeKeyWithProof prefixes and recovers from. The
 * key's removal nonce is read from chain: a signature is good for one
 * removal of the key.
 */
async function innerMessage(identity, key, purpose) {
  const { chainId } = await ethers.provider.getNetwork();
  const nonce = await identity.removalNonces(key);
  return ethers.solidityPackedKeccak256(
    ["string", "address", "bytes32", "uint256", "uint256", "uint256"],
    [
      "Remove key from OnchainID",
      await identity.getAddress(),
      key,
      purpose,
      nonce,
      chainId,
    ],
  );
}

/**
 * `signer` consents to removing `key` (purpose `purpose`) from `identity`.
 * Checks the message against the chain's getRemoveKeyMessage before
 * signing and the signature against that digest after. Returns the
 * signature and the digest.
 */
async function signRemoval(identity, signer, key, purpose) {
  const inner = await innerMessage(identity, key, purpose);
  const digest = await identity.getRemoveKeyMessage(key, purpose);
  if (ethers.hashMessage(ethers.getBytes(inner)) !== digest) {
    throw new Error("message differs from getRemoveKeyMessage");
  }
  const signature = await signer.signMessage(ethers.getBytes(inner));
  const recovered = ethers.recoverAddress(digest, signature);
  if (recovered.toLowerCase() !== (await signer.getAddress()).toLowerCase()) {
    throw new Error(`signature recovers ${recovered}, not the signer`);
  }
  return { signature, digest };
}

/** The key as the chain holds it: { active, purpose, revokedAt }. */
async function readKey(identity, key, purpose) {
  const info = await identity.getKey(key);
  return {
    active: await identity.keyHasPurpose(key, purpose),
    purpose: Number(info.purpose),
    revokedAt: Number(info.revokedAt),
  };
}

/**
 * `manager` (a MANAGEMENT key of `identity`) sends removeKeyWithProof with
 * `signature`; prints the method and reads the key back from chain.
 */
async function removeWithProof(identity, manager, key, purpose, signature) {
  console.log("   Method: removeKeyWithProof (holder's signature)");
  await (
    await identity.connect(manager).removeKeyWithProof(key, purpose, signature)
  ).wait();
  const after = await readKey(identity, key, purpose);
  console.log(
    `   Read back: keyHasPurpose(${PURPOSES[purpose]}) = ${after.active}, ` +
      `getKey revokedAt = ${after.revokedAt}`,
  );
  return after;
}

/** removeKey (no consent): the only path for a key nobody can sign for. */
async function removeWithoutProof(identity, manager, key, purpose) {
  console.log("   Method: removeKey (management action, no signature)");
  await (await identity.connect(manager).removeKey(key, purpose)).wait();
  const after = await readKey(identity, key, purpose);
  console.log(
    `   Read back: keyHasPurpose(${PURPOSES[purpose]}) = ${after.active}, ` +
      `getKey revokedAt = ${after.revokedAt}`,
  );
  return after;
}

/**
 * Option 5a, no prompts: on wallet 1's identity add an ACTION key for a
 * throwaway wallet, show a stranger's signature refused, remove the key
 * with the throwaway wallet's signature and read the result back.
 */
async function runRemovalDemo(state) {
  displaySection("KEY REMOVAL WITH THE HOLDER'S SIGNATURE (5a)", "🗑️");
  if (!state.getContract("onchainIDFactory")) {
    displayError("Deploy first (option 1)");
    return null;
  }
  const owner = state.signers[DEMO_WALLET];
  const identity = await demoIdentity(state, owner);
  const idAddr = await identity.getAddress();
  const holder = ethers.Wallet.createRandom();
  const stranger = ethers.Wallet.createRandom();
  const key = keyOf(holder.address);
  console.log(`   Identity: ${idAddr}`);
  console.log(`   Sent by:  ${who(state, owner.address)} (MANAGEMENT key)`);
  console.log(`   Holder:   throwaway wallet ${holder.address}`);

  await (await identity.addKey(key, ACTION, ECDSA)).wait();
  const before = await readKey(identity, key, ACTION);
  console.log(`   Added ACTION key ${key}: active = ${before.active}`);

  const wrong = await signRemoval(identity, stranger, key, ACTION);
  let wrongRefused = false;
  try {
    await identity.removeKeyWithProof.staticCall(key, ACTION, wrong.signature);
  } catch (e) {
    wrongRefused = /does not prove ownership/.test(e.message);
  }
  console.log(
    `   A stranger's signature: ${wrongRefused ? "refused" : "ACCEPTED"} ` +
      "(OnchainID: Signature does not prove ownership of key)",
  );

  const { signature, digest } = await signRemoval(
    identity,
    holder,
    key,
    ACTION,
  );
  console.log(`   Holder signed getRemoveKeyMessage digest ${digest}`);
  const after = await removeWithProof(identity, owner, key, ACTION, signature);
  const removed = before.active && !after.active && after.revokedAt > 0;
  if (removed && wrongRefused) displaySuccess("Key removed with its proof");
  else displayError("Removal did not read back as expected");
  return { identity: idAddr, key, removed, wrongRefused, ...after };
}

module.exports = {
  innerMessage,
  signRemoval,
  readKey,
  removeWithProof,
  removeWithoutProof,
  runRemovalDemo,
};
