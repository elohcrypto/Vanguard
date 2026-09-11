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

module.exports = { advancePast, canJumpTime, chainNow };
