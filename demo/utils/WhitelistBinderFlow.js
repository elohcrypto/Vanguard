/**
 * @fileoverview Demo whitelist flow on PrivacyManager (plan v2 Tasks 3.3,
 * 3.5): each user commits Poseidon(identity, secret), the root and the proof
 * come from the same library functions as the scripts/zk CLIs, the list
 * operator publishes the root, the user binds its wallet with
 * submitWhitelistProof, and hasValidWhitelistProof is the status a
 * compliance gate reads. Kept out of PrivacyModule.js, which is far over
 * the 500-line rule already.
 */

const { ethers } = require("hardhat");
const {
  buildWhitelistRoot,
  computeCommitment,
} = require("../../scripts/zk/build-whitelist-root");
const { proveWhitelist } = require("../../scripts/zk/prove-whitelist");

const OPS_INDEX = 10; // docs/TESTNET_DEMO.md wallet roles
const same = (a, b) => a.toLowerCase() === b.toLowerCase();

/**
 * A demo user's whitelist identity: its OnchainID address as a field
 * element (D30, no modulo). A wallet with no OnchainID registered stands in
 * with its own address (simulated onboarding).
 * @returns {Promise<{identity: bigint, onchainID: string|null}>}
 */
async function demoIdentity(state, address) {
  const registry = state.getContract("identityRegistry");
  const onchainID = registry
    ? await registry.identity(address)
    : ethers.ZeroAddress;
  if (same(onchainID, ethers.ZeroAddress)) {
    return { identity: BigInt(address), onchainID: null };
  }
  return { identity: BigInt(onchainID), onchainID };
}

/** The user's own whitelist secret, created once (DemoState.zkSecrets). */
function demoSecret(state, address) {
  if (!state.zkSecrets.has(address)) {
    // 31 random bytes: always below the field order.
    state.zkSecrets.set(
      address,
      BigInt(ethers.hexlify(ethers.randomBytes(31))),
    );
  }
  return state.zkSecrets.get(address);
}

/**
 * Onboard the listed wallets the way an operator would: each user hands in
 * Poseidon(its identity, its own secret); the root is built over those
 * commitments by scripts/zk/build-whitelist-root.js. A second wallet of an
 * identity already listed is skipped (one commitment per identity, D29).
 * @returns {Promise<{users: Object[], rootFile: Object}>}
 */
async function demoWhitelist(state, signers) {
  const users = [];
  for (const s of signers) {
    const { identity, onchainID } = await demoIdentity(state, s.address);
    const twin = users.find((u) => u.identity === identity);
    if (twin) {
      console.log(
        `   ⚠️  ${s.address} shares identity with ${twin.wallet}: one commitment per identity (D29), skipped`,
      );
      continue;
    }
    const secret = demoSecret(state, s.address);
    users.push({
      wallet: s.address,
      identity,
      onchainID,
      commitment: await computeCommitment(identity, secret),
    });
  }
  const rootFile = await buildWhitelistRoot(
    users.map((u) => ({ identity: u.identity, commitment: u.commitment })),
  );
  return { users, rootFile };
}

/**
 * Prove for `user` under `rootFile` with that user's own identity and
 * secret, bound to that user's wallet (scripts/zk/prove-whitelist.js).
 */
async function proveForDemoUser(state, user, rootFile) {
  const { identity } = await demoIdentity(state, user.address);
  return proveWhitelist({
    rootFile,
    identity,
    secret: demoSecret(state, user.address),
    wallet: user.address,
    generator: state.realProofGenerator,
  });
}

/** The signer allowed to publish: listOperator if loaded, else the owner. */
function publisherFor(state, owner, operator) {
  for (const who of [operator, owner]) {
    if (same(who, ethers.ZeroAddress)) continue;
    const s = state.signers.find((x) => same(x.address, who));
    if (s) return s;
  }
  return null;
}

/**
 * Publish `signals[1]` as the whitelist root (if it is not the current one)
 * and bind `user` with the proof. Returns the receipt of the binding.
 */
async function publishAndBind({ state, privacyManager, user, proof, signals }) {
  const pm = privacyManager;
  const root = ethers.toBeHex(BigInt(signals[1]), 32);
  const owner = await pm.owner();
  const operator = await pm.listOperator();
  const deployer = state.signers[0];
  const governed = !same(owner, deployer.address);

  console.log("\n📜 PrivacyManager whitelist root registry:");
  console.log(`   Owner:         ${owner}${governed ? " (governance)" : ""}`);
  console.log(`   List operator: ${operator}`);
  if (governed) {
    // After the handover the deployer holds no root power (R-3R-4).
    try {
      await pm.connect(deployer).publishWhitelistRoot.staticCall(root);
      console.log(
        "   ❌ the deployer can still publish a root: handover incomplete",
      );
    } catch (e) {
      const why = /NotListOperator/.test(e.message)
        ? "NotListOperator"
        : e.message.split("\n")[0];
      console.log(
        `   ✅ deployer root publish refused after the handover (${why}); ops (wallet ${OPS_INDEX}) publishes`,
      );
    }
  }
  if ((await pm.whitelistRoot()) !== root) {
    const publisher = publisherFor(state, owner, operator);
    if (!publisher) {
      throw new Error(
        `no loaded wallet may publish the root (owner ${owner}, listOperator ${operator}); after the handover a PrivacyParameters vote (type 11) can`,
      );
    }
    const rx = await (
      await pm.connect(publisher).publishWhitelistRoot(root)
    ).wait();
    console.log(
      `   ✅ root ${root.slice(0, 18)}… published by ${publisher.address} (version ${await pm.whitelistVersion()}, gas ${rx.gasUsed})`,
    );
  } else {
    console.log(`   ✅ root ${root.slice(0, 18)}… is already the current one`);
  }

  // The binding must name the submitting wallet; a copied proof is refused.
  const receipt = await (
    await pm.connect(user).submitWhitelistProof(proof, signals)
  ).wait();
  const b = await pm.whitelistBindings(user.address);
  const valid = await pm.hasValidWhitelistProof(user.address);
  console.log(`\n🔗 submitWhitelistProof from ${user.address}`);
  console.log(`   💰 Gas Used: ${receipt.gasUsed.toLocaleString()}`);
  console.log(`   🔢 Nullifier bound: ${b.nullifier}`);
  console.log(
    `   ⏳ Valid until: ${new Date(Number(b.expiresAt) * 1000).toISOString()} (root version ${b.version})`,
  );
  console.log(`   ✅ hasValidWhitelistProof: ${valid}`);
  return receipt;
}

module.exports = {
  demoIdentity,
  demoSecret,
  demoWhitelist,
  proveForDemoUser,
  publishAndBind,
};
