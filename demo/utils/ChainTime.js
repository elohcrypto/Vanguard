/**
 * Advance past an on-chain deadline on ANY network.
 *
 * Hardhat and Anvil expose evm_increaseTime, so the demo used to jump the
 * clock. A public testnet has no such RPC: the only way past a deadline is
 * to wait for it. This helper does the jump where it can and the wait where
 * it must, so one code path serves both. The deadline is read from the
 * chain, never computed from a constant, so it is right whatever timeScale
 * the governance contract was deployed with.
 */
const { ethers } = require("hardhat");

let _canJump = null;

async function canJumpTime() {
  if (_canJump !== null) return _canJump;
  try {
    // Zero-second jump: harmless on a dev node, method-not-found elsewhere.
    await ethers.provider.send("evm_increaseTime", [0]);
    _canJump = true;
  } catch {
    _canJump = false;
  }
  return _canJump;
}

async function chainNow() {
  return (await ethers.provider.getBlock("latest")).timestamp;
}

/**
 * Ensure block.timestamp > deadline (unix seconds).
 * @param {bigint|number} deadline
 * @param {string} label - what we are waiting for, for the log line
 * @param {object} opts  - { pollMs: 15000, margin: 60 }
 */
async function advancePast(deadline, label, opts = {}) {
  const margin = opts.margin ?? 60;
  const target = Number(deadline) + margin;
  const now = await chainNow();
  if (now > Number(deadline)) {
    console.log(`   ⏱️  ${label}: already passed`);
    return;
  }
  if (await canJumpTime()) {
    await ethers.provider.send("evm_increaseTime", [target - now]);
    await ethers.provider.send("evm_mine", []);
    console.log(`   ⏩ ${label}: jumped ${target - now}s (dev node)`);
    return;
  }
  const pollMs = opts.pollMs ?? 15000;
  console.log(
    `   ⏳ ${label}: waiting ${target - now}s of real time (no evm_increaseTime on this network)`,
  );
  // Public chains only tick with new blocks; poll rather than sleep once.
  while ((await chainNow()) <= Number(deadline)) {
    const left = Number(deadline) - (await chainNow());
    process.stdout.write(`      ${Math.max(left, 0)}s remaining\r`);
    await new Promise((r) => setTimeout(r, pollMs));
  }
  process.stdout.write("\n");
  console.log(`   ✅ ${label}: passed`);
}

// ---- Voter maturity (plan 2F.1, D25) ----
// Governance admits a proposer or voter only if its identity was registered
// at least governance.minVoterAge() before the proposal (7 days divided by
// TIME_SCALE), and counts only such identities toward quorum.

const VOTER_AGE_REMEDY =
  "register voters at least 7 days (divided by TIME_SCALE) before the ceremony; on a dev node jump time";

const walletOf = (w) => (typeof w === "string" ? w : w.address);

/** minVoterAge, refusing 0 (the bounded setter cannot reach it; keep it explicit). */
async function minVoterAgeOf(governance) {
  const age = await governance.minVoterAge();
  if (age === 0n)
    throw new Error(
      "Handover: governance.minVoterAge() is 0; fresh identities could vote",
    );
  return age;
}

/**
 * Why `wallet` cannot propose or vote on a proposal created now because its
 * identity is too young, or null when it is old enough.
 */
async function voterAgeRefusal(governance, identityRegistry, wallet) {
  const age = await minVoterAgeOf(governance);
  const id = await identityRegistry.identity(walletOf(wallet));
  const at = await identityRegistry.identityRegisteredAt(id);
  if (at !== 0n && at + age <= BigInt(await chainNow())) return null;
  return `has an identity younger than minVoterAge (${age}s); governance refuses it ("Identity too new to vote"): ${VOTER_AGE_REMEDY}`;
}

/** Quorum denominator for a proposal created now: identities old enough to vote. */
async function eligibleVotersNow(governance, identityRegistry) {
  const cutoff = BigInt(await chainNow()) - (await minVoterAgeOf(governance));
  return identityRegistry.registeredIdentityCountAt(cutoff > 0n ? cutoff : 0n);
}

/**
 * Advance past the maturity of every wallet's identity, so they may propose
 * and vote. Jumps on a dev node; on a real network prints the wait and polls.
 */
async function advancePastVoterAge(governance, identityRegistry, wallets) {
  const age = await minVoterAgeOf(governance);
  let latest = 0n;
  for (const w of wallets) {
    const id = await identityRegistry.identity(walletOf(w));
    const at = await identityRegistry.identityRegisteredAt(id);
    if (at > latest) latest = at;
  }
  if (latest === 0n) return;
  await advancePast(latest + age, `voter identities ${age}s old (minVoterAge)`);
}

module.exports = {
  advancePast,
  canJumpTime,
  chainNow,
  advancePastVoterAge,
  eligibleVotersNow,
  voterAgeRefusal,
};
