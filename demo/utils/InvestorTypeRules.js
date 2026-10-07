/**
 * Investor-type transfer rules on VSC (plan v2 Task 4.10, D37 = a), read
 * from the chain for options 16/20c (cooldowns), 17/20d (tiers) and the
 * wiring every path that points a token at an InvestorTypeRegistry runs.
 *
 * Cooldown: Token._checkTransfer refuses a non-trusted sender inside its
 * type's transferCooldownMinutes ("Transfer cooldown"); the registry keeps
 * one lastTransferAt per sender, written only by a token it authorized
 * (authorizeToken). A token whose registry has not authorized it refuses
 * every mint and transfer ("Token not authorized by investor registry").
 * Tier: ComplianceRules requires a party's whitelist oracle entry tier to
 * reach its type's requiredWhitelistTier wherever the party passes by that
 * entry (OracleOnly, or Either with a live entry); in ZkOnly, or for a
 * proof-bound party with no entry, it does not apply (a proof binding
 * carries no tier). Exempt wallets (D22) skip both.
 */
const { ethers } = require("hardhat");
const { canJumpTime, advancePast } = require("./ChainTime");

const TYPE_NAMES = ["Normal", "Retail", "Accredited", "Institutional"];
const MODE_NAMES = ["OracleOnly", "ZkOnly", "Either"];
const NOT_AUTHORIZED = "Token not authorized by investor registry";

const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
const iso = (s) => new Date(Number(s) * 1000).toISOString();

/**
 * Point `token` at `registry`, authorized first. A registry that has not
 * authorized the token makes it refuse every mint and transfer, so when
 * the runner cannot authorize (it does not own the registry, e.g. after
 * the handover) the token is NOT pointed at it; the owner and the vote
 * that must authorize it are printed instead (review L4).
 * @returns {Promise<boolean>} whether the token now enforces an
 *   authorizing registry
 */
async function wireInvestorRegistry(token, registry, log = console.log) {
  const t = await token.getAddress();
  const r = await registry.getAddress();
  if (!(await registry.isTokenAuthorized(t))) {
    const owner = await registry.owner();
    const me = await registry.runner.getAddress();
    if (!same(owner, me)) {
      log(
        `   ⚠️  InvestorTypeRegistry NOT wired into ${t}: its owner ${owner} must first call authorizeToken(${t}, true) (an InvestorTypeConfig vote, option 76 type 0, after the handover); wiring it before would make the token refuse every mint and transfer ("${NOT_AUTHORIZED}")`,
      );
      return false;
    }
    await (await registry.authorizeToken(t, true)).wait();
    log(
      `   ✅ registry.isTokenAuthorized(token) = ${await registry.isTokenAuthorized(t)}: the token writes each sender's cooldown clock (Task 4.10)`,
    );
  } else {
    log(`   ✅ InvestorTypeRegistry already authorizes the token ${t}`);
  }
  if (!same(await token.investorTypeRegistry(), r)) {
    await (await token.setInvestorTypeRegistry(r)).wait();
  }
  return same(await token.investorTypeRegistry(), r);
}

/** VSC, its registry and ComplianceRules from state, or null after a hint. */
async function rulesContext(state, log = console.log) {
  const token = state.getContract("digitalToken");
  const registry = state.getContract("investorTypeRegistry");
  if (!token || !registry) {
    log("   VSC (option 21) and the InvestorTypeRegistry (option 51) first");
    return null;
  }
  const tAddr = await token.getAddress();
  const wired = same(
    await token.investorTypeRegistry(),
    await registry.getAddress(),
  );
  const authorized = await registry.isTokenAuthorized(tAddr);
  const rules = state.getContract("complianceRules");
  return { token, tAddr, registry, rules, wired, authorized };
}

/** Options 16 and 20c: the cooldowns Token enforces, and each wallet's clock. */
async function printCooldowns(state, log = console.log) {
  const ctx = await rulesContext(state, log);
  if (!ctx) return;
  const { registry, wired, authorized } = ctx;
  const how = wired
    ? 'enforced by Token: "Transfer cooldown"'
    : "not wired to VSC";
  log(`\n📊 COOLDOWN PER TYPE (${how}):`);
  for (let t = 0; t < TYPE_NAMES.length; t++) {
    const c = await registry.getInvestorTypeConfig(t);
    log(
      `   ${t} ${TYPE_NAMES[t].padEnd(13)} ${Number(c.transferCooldownMinutes)} minutes`,
    );
  }
  log(
    `   VSC authorized by the registry: ${authorized}${authorized ? "" : ` (VSC refuses every mint and transfer: "${NOT_AUTHORIZED}")`}`,
  );
  const now = (await ethers.provider.getBlock("latest")).timestamp;
  log(`\n👤 Demo wallets (chain time ${iso(now)}):`);
  for (const s of state.signers.slice(1, 5)) {
    const type = Number(await registry.getInvestorType(s.address));
    const exempt = await registry.investorLimitExempt(s.address);
    const last = await registry.lastTransferAt(s.address);
    const minutes = Number(await registry.getTransferCooldown(s.address));
    const free = await registry.canTransferNow(s.address);
    const when =
      last === 0n
        ? "never sent through an authorized token"
        : `last sent ${iso(last)}`;
    const verdict = exempt
      ? "exempt, no cooldown"
      : free
        ? "may send now"
        : `in cooldown until ${iso(last + BigInt(minutes * 60))}`;
    log(`   ${s.address} (${TYPE_NAMES[type]}): ${when}; ${verdict}`);
  }
  log(
    "\n💡 Sending by transfer/transferFrom starts the clock; receiving, mint, burn and recovery start none; exempt wallets and trusted contracts (escrow, custody) have none",
  );
  log("💡 Option 58 proves it on chain: send, refused, time travel, send");
}

/** Options 17 and 20d: the tier rule ComplianceRules applies, per wallet. */
async function printTiers(state, log = console.log) {
  const ctx = await rulesContext(state, log);
  if (!ctx) return;
  const { registry, rules, tAddr, wired } = ctx;
  if (!rules) return log("   ComplianceRules not deployed (option 13)");
  const mode = MODE_NAMES[Number(await rules.whitelistMode(tAddr))];
  const wl = await rules.whitelistOracle(tAddr);
  const bound = wl !== ethers.ZeroAddress;
  const how = !wired
    ? "not wired to VSC"
    : mode === "ZkOnly"
      ? "enforced where an oracle entry is read; not applicable to VSC in ZkOnly"
      : bound
        ? "enforced by ComplianceRules on VSC"
        : "enforced where a whitelist oracle is bound; not applicable to VSC today";
  log(`\n📊 REQUIRED TIER PER TYPE (${how}):`);
  for (let t = 0; t < TYPE_NAMES.length; t++) {
    const c = await registry.getInvestorTypeConfig(t);
    log(
      `   ${t} ${TYPE_NAMES[t].padEnd(13)} tier ${Number(c.requiredWhitelistTier)}+`,
    );
  }
  log(
    `\n⚖️  VSC whitelist mode ${mode}, whitelist oracle ${bound ? wl : "none"}`,
  );
  if (mode === "ZkOnly") {
    log("   Not applicable in ZkOnly: a proof binding carries no tier");
  } else if (!bound) {
    log(
      "   No whitelist oracle is bound to VSC, so no entry is read and the tier rule does not apply to VSC today (option 58 proves it on a probe token)",
    );
  }
  const oracle = bound
    ? await ethers.getContractAt("WhitelistOracle", wl)
    : null;
  log("\n👤 Demo wallets:");
  for (const s of state.signers.slice(1, 5)) {
    const type = Number(await registry.getInvestorType(s.address));
    const need = Number(await registry.getRequiredWhitelistTier(s.address));
    let entry = "no oracle";
    if (oracle) {
      const info = await oracle.getWhitelistInfo(s.address);
      entry = info[0] ? `entry tier ${Number(info[3])}` : "no live entry";
    }
    const ok = await rules.whitelistTierAllows(tAddr, s.address);
    log(
      `   ${s.address}: ${TYPE_NAMES[type]}, needs tier ${need}+, ${entry}: ${ok ? "tier rule passes or does not apply" : 'refused ("Compliance check failed", tier short)'}`,
    );
  }
}

/**
 * The line a network without evm_increaseTime prints instead of waiting:
 * minutes left until `end` (unix seconds) on the chain clock.
 */
async function cooldownWaitLine(end) {
  const now = (await ethers.provider.getBlock("latest")).timestamp;
  const left = Math.max(0, Math.ceil((Number(end) - now) / 60));
  return `⏰ cooldown: ${left} minutes left, re-run after ${iso(end)}`;
}

/**
 * Let `wallet` send again on VSC: on a dev node jump past its type's
 * cooldown (Task 4.10); elsewhere say until when. True when it may send.
 */
async function waitOutCooldown(state, wallet, log = console.log) {
  const token = state.getContract("digitalToken");
  const reg = state.getContract("investorTypeRegistry");
  if (!token || !reg) return true;
  if (!same(await token.investorTypeRegistry(), await reg.getAddress()))
    return true;
  if (await reg.canTransferNow(wallet.address)) return true;
  const minutes = Number(await reg.getTransferCooldown(wallet.address));
  const end = (await reg.lastTransferAt(wallet.address)) + BigInt(minutes * 60);
  if (!(await canJumpTime())) {
    log(`   ${await cooldownWaitLine(end)} (${wallet.address})`);
    return false;
  }
  await advancePast(end - 1n, `${minutes}-minute transfer cooldown`, {
    margin: 1,
  });
  return true;
}

module.exports = {
  cooldownWaitLine,
  waitOutCooldown,
  TYPE_NAMES,
  MODE_NAMES,
  NOT_AUTHORIZED,
  wireInvestorRegistry,
  printCooldowns,
  printTiers,
};
