/**
 * @fileoverview Blacklist non-membership proof on the live lists (plan v2
 * Task 3.7, option 42 -> 2). The statement: the wallet's holder owns a
 * commitment in the current whitelist root whose identity is not in the
 * sanctions tree. The sanctions tree is built from the wallets the
 * BlacklistOracle lists, resolved to their OnchainID through the
 * IdentityRegistry (identity = BigInt(OnchainID address), as for the
 * whitelist). Nothing on chain gates on this proof (D2). Kept out of
 * PrivacyModule.js, which is far over the 500-line rule already.
 */

const { ethers } = require("hardhat");
const { computeCommitment } = require("../../scripts/zk/build-whitelist-root");
const { demoIdentity } = require("./WhitelistBinderFlow");

const same = (a, b) => a.toLowerCase() === b.toLowerCase();

/**
 * Wallets the BlacklistOracle lists now: every subject of its listing
 * events, kept when isBlacklisted still says so (removals and expiries drop).
 */
async function listedWallets(oracle) {
  const subjects = new Set();
  for (const name of ["BlacklistUpdated", "EmergencyBlacklistAdded"]) {
    for (const ev of await oracle.queryFilter(oracle.filters[name]())) {
      subjects.add(ethers.getAddress(ev.args.subject));
    }
  }
  const listed = [];
  for (const s of subjects) {
    if (await oracle.isBlacklisted(s)) listed.push(s);
  }
  return listed;
}

/** The BlacklistOracle gating VSC, else the one option 1 deployed. */
async function sanctionsOracle(state) {
  const rules = state.getContract("complianceRules");
  const token = state.getContract("digitalToken");
  if (rules && token) {
    const bound = await rules.blacklistOracle(await token.getAddress());
    if (bound !== ethers.ZeroAddress) {
      return ethers.getContractAt("BlacklistOracle", bound);
    }
  }
  return state.getContract("blacklistOracle") || null;
}

/** A signer with a live binding whose commitment is in `rootFile`. */
async function boundMember(state, pm, rootFile) {
  const leaves = new Set(rootFile.leaves.map((l) => BigInt(l)));
  for (const s of state.signers) {
    if (!state.zkSecrets.has(s.address)) continue;
    if (!(await pm.hasValidWhitelistProof(s.address))) continue;
    const { identity, onchainID } = await demoIdentity(state, s.address);
    const c = await computeCommitment(identity, state.zkSecrets.get(s.address));
    if (leaves.has(BigInt(c))) return { signer: s, identity, onchainID };
  }
  return null;
}

/**
 * Prove and verify for a bound demo user; then show a listed identity
 * cannot prove. Returns null when a precondition is missing.
 */
async function runBlacklistProofFlow({ state, generator, log = console.log }) {
  const zk = state.getContract("zkVerifierIntegrated");
  const pm = state.getContract("privacyManager");
  log(
    "ℹ️  Nothing on chain gates on this proof (D2): VSC's blacklist gate reads the BlacklistOracle directly, and PrivacyManager refuses this circuit.",
  );
  if (!zk || !pm) {
    log("❌ No ZK verifier / PrivacyManager: run option 1 (or 41)");
    return null;
  }

  // Precondition: a live whitelist binding under the current root.
  const rootFile = state.whitelistRootFile;
  const root = BigInt(await pm.whitelistRoot());
  const member =
    rootFile && BigInt(rootFile.root) === root
      ? await boundMember(state, pm, rootFile)
      : null;
  if (!member) {
    log(
      "ℹ️  No wallet holds a live whitelist binding under the current root: run option 42 -> 1 first (the proof shows the holder of a whitelisted commitment is not sanctioned).",
    );
    return null;
  }
  const user = member.signer;
  log(`\n👤 Prover: ${user.address} (live whitelist binding)`);
  log(
    member.onchainID
      ? `   🔢 Identity: OnchainID as a field element (${member.identity})`
      : `   🔢 Identity: the wallet address (simulated, no OnchainID) (${member.identity})`,
  );
  log(
    `   🌳 Whitelist root: ${rootFile.root.slice(0, 18)}… (${rootFile.count} commitments)`,
  );

  // The sanctions tree from the live BlacklistOracle.
  const oracle = await sanctionsOracle(state);
  if (!oracle) {
    log(
      "❌ No BlacklistOracle: run option 31 (oracle system); option 34 lists wallets",
    );
    return null;
  }
  const wallets = await listedWallets(oracle);
  log(
    `\n🚫 BlacklistOracle ${await oracle.getAddress()}: ${wallets.length} listed wallet(s)`,
  );
  // Keyed by the whitelist's own resolver (demoIdentity): the OnchainID,
  // else the wallet address (simulated onboarding). A listed wallet is
  // never skipped, or it would be whitelisted under an identity the
  // sanctions tree does not hold and could prove "not sanctioned".
  const sanctioned = new Map(); // identity -> first listed wallet
  for (const w of wallets) {
    const { identity: id, onchainID } = await demoIdentity(state, w);
    if (!sanctioned.has(id)) sanctioned.set(id, w);
    log(
      onchainID
        ? `   • ${w} -> OnchainID ${onchainID}`
        : `   • ${w} -> its own address (simulated identity, no OnchainID)`,
    );
  }
  const identities = [...sanctioned.keys()];
  if (!identities.length)
    log(
      "   ℹ️  Sanctions tree is empty (root 0): the proof still binds the list version",
    );

  let verified = false;
  const commitments = rootFile.leaves.map((l) => BigInt(l));
  const secret = state.zkSecrets.get(user.address);
  if (sanctioned.has(member.identity)) {
    log(
      `\n🚫 ${user.address}'s identity is on the sanctions list: it cannot prove non-membership`,
    );
  } else {
    log("\n🔐 Generating a real ZK proof (PLONK)...");
    const t0 = Date.now();
    const r = await generator.generateBlacklistProof({
      identity: member.identity,
      secret,
      commitments,
      blacklistIdentities: identities,
      walletBinding: user.address,
    });
    const ms = Date.now() - t0;
    state.proofGenerationTimes.set("Blacklist Non-Membership", ms);
    log(`✅ Real proof generated in ${ms}ms (${(ms / 1000).toFixed(2)}s)`);

    const [nullifier, wlRoot, blRoot, binding] = r.publicSignals;
    log("\n🔍 Public signals:");
    log(`   🔢 nullifier = Poseidon(secret, blacklistRoot): ${nullifier}`);
    log(`   🌳 whitelistRoot: ${wlRoot}`);
    log(`   🚫 blacklistRoot: ${blRoot}`);
    log(`   👛 walletBinding: ${ethers.toBeHex(BigInt(binding), 20)}`);

    const verifier = zk.connect(user);
    const ok = await verifier.verifyBlacklistNonMembership.staticCall(
      r.proof,
      r.publicSignals,
    );
    log(`\n🔍 verifyBlacklistNonMembership (staticCall): ${ok}`);
    if (!ok) {
      log("❌ The verifier refused the proof: nothing sent");
      return { verified };
    }
    const receipt = await (
      await verifier.verifyBlacklistNonMembership(r.proof, r.publicSignals)
    ).wait();
    state.gasTracker.set("Blacklist Proof", receipt.gasUsed);
    verified = true;
    log("✅ BLACKLIST NON-MEMBERSHIP PROOF VERIFIED!");
    log(`   🔗 Transaction: ${receipt.hash}`);
    log(`   🧱 Block: ${receipt.blockNumber}`);
    log(`   💰 Gas Used: ${receipt.gasUsed.toLocaleString()}`);
    log(
      "   🔐 The verifier learns neither the identity nor the commitment: only that the holder of a whitelisted commitment is not sanctioned",
    );
  }

  // A listed identity cannot prove: a sanctioned whitelist member if there
  // is one, else the prover itself as if it were listed.
  log("\n🧪 A listed identity cannot prove:");
  let who = null;
  for (const s of state.signers) {
    if (!state.zkSecrets.has(s.address)) continue;
    const { identity } = await demoIdentity(state, s.address);
    const c = await computeCommitment(identity, state.zkSecrets.get(s.address));
    if (sanctioned.has(identity) && commitments.includes(BigInt(c))) {
      who = {
        identity,
        secret: state.zkSecrets.get(s.address),
        wallet: s.address,
      };
      break;
    }
  }
  const list = who ? identities : [...identities, member.identity];
  if (!who) {
    who = { identity: member.identity, secret, wallet: user.address };
    log(
      `   ℹ️  No whitelisted wallet is listed: adding ${user.address}'s identity to a copy of the list`,
    );
  }
  try {
    await generator.generateBlacklistProof({
      identity: who.identity,
      secret: who.secret,
      commitments,
      blacklistIdentities: list,
      walletBinding: who.wallet,
    });
    log("   ❌ a listed identity produced a proof");
    return { verified, listedRefused: false };
  } catch (e) {
    log(`   🚫 ${who.wallet}: ${e.message.split("\n")[0]}`);
    return {
      verified,
      listedRefused: /is on the sanctions list/.test(e.message),
    };
  }
}

module.exports = { runBlacklistProofFlow, listedWallets };
