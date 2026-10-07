/**
 * Smoke leg on the REAL demo VSC, plan v2 Task 4.10 (D37 = a): the
 * investor-type cooldown and whitelist tier are transfer rules. Runs after
 * the custody leg (demo-smoke-escrow.js chains it), before the handover.
 *
 * 1. VSC enforces the InvestorTypeRegistry and the registry authorizes VSC.
 * 2. Option 58 runs through the module API (it prompts for nothing) and
 *    must report both proofs.
 * 3. Independently of the option's prints, from chain: the wallet 58 just
 *    used is inside its cooldown (canTransfer false, the send reverts
 *    "Transfer cooldown"), and after the cooldown it sends.
 * 4. On 58's probe token: an entry below the sender's required tier is
 *    refused (canTransfer false, whitelistTierAllows false, "Compliance
 *    check failed"); at the tier it passes. On VSC, with no whitelist
 *    oracle bound, the tier rule does not apply (whitelistTierAllows true).
 */
const { ethers } = require("hardhat");
const InvestorTypeModule = require("../demo/modules/InvestorTypeModule");
const ComplianceModule = require("../demo/modules/ComplianceModule");
const { EnhancedLogger } = require("../demo/logging");
const { reasonOf, AMOUNT } = require("../demo/utils/InvestorTypeProof");

const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
const jump = async (seconds) => {
  await ethers.provider.send("evm_increaseTime", [seconds]);
  await ethers.provider.send("evm_mine", []);
};

async function runInvestorSmoke(state, failures) {
  const token = state.getContract("digitalToken");
  const registry = state.getContract("investorTypeRegistry");
  const rules = state.getContract("complianceRules");

  // 1. The hook is wired.
  if (!same(await token.investorTypeRegistry(), registry.target))
    failures.push("VSC does not enforce the demo InvestorTypeRegistry");
  if (!(await registry.isTokenAuthorized(token.target)))
    failures.push("VSC is not authorized by its InvestorTypeRegistry (4.10)");

  // 2. Option 58, output captured.
  const mod = new InvestorTypeModule(
    state,
    new EnhancedLogger(),
    async () => "",
  );
  const lines = [];
  const real = console.log;
  console.log = (...a) => lines.push(a.join(" "));
  let res;
  try {
    res = await mod.testTransferCooldowns();
  } finally {
    console.log = real;
  }
  for (const l of lines) console.log(l);
  const failed = failures.length;
  const out = lines.join(" | ").slice(0, 400);
  if (!res?.cooldown)
    failures.push(`option 58 did not prove the cooldown: ${out}`);
  if (!res?.tier) failures.push(`option 58 did not prove the tier: ${out}`);
  if (lines.some((l) => /^❌/.test(l)))
    failures.push(
      "option 58 printed a line starting with ❌ (strict drives fail)",
    );
  if (!res?.c || !res?.t) return;

  // 3. The cooldown, from chain.
  const { sender, recipient } = res.c;
  const can = () =>
    token.canTransfer(sender.address, recipient.address, AMOUNT);
  if (await can())
    failures.push("cooldown: canTransfer is true right after the sender sent");
  const why = await reasonOf(token, sender, recipient.address, AMOUNT);
  if (why !== "Transfer cooldown")
    failures.push(
      `cooldown: a send inside it reverts "${why}", expected "Transfer cooldown"`,
    );
  const minutes = Number(await registry.getTransferCooldown(sender.address));
  const last = await registry.lastTransferAt(sender.address);
  const now = BigInt((await ethers.provider.getBlock("latest")).timestamp);
  await jump(Number(last + BigInt(minutes * 60) - now));
  if (!(await can()))
    failures.push(
      `cooldown: still refused ${minutes} minutes after the last send`,
    );
  const received = await registry.lastTransferAt(recipient.address);
  const r = await (
    await token.connect(sender).transfer(recipient.address, AMOUNT)
  ).wait();
  const at = (await ethers.provider.getBlock(r.blockNumber)).timestamp;
  if (
    r.status !== 1 ||
    (await registry.lastTransferAt(sender.address)) !== BigInt(at)
  )
    failures.push(
      "cooldown: the send after it did not land or did not restart the clock",
    );
  if ((await registry.lastTransferAt(recipient.address)) !== received)
    failures.push("cooldown: receiving wrote the recipient's clock");

  // 4. The tier, from chain, on 58's probe token.
  const { probe, oracle, types, rules: probeRules } = res.t;
  const need = Number(await types.getRequiredWhitelistTier(sender.address));
  const probeCan = () =>
    probe.canTransfer(sender.address, recipient.address, AMOUNT);
  await (
    await oracle.addToWhitelist(sender.address, need - 1, 0, "smoke")
  ).wait();
  if (await probeCan())
    failures.push(
      `tier: a tier-${need - 1} entry passes a type needing ${need}`,
    );
  if (await probeRules.whitelistTierAllows(probe.target, sender.address))
    failures.push("tier: whitelistTierAllows is true for a tier-short entry");
  const tierWhy = await reasonOf(probe, sender, recipient.address, AMOUNT);
  if (tierWhy !== "Compliance check failed")
    failures.push(`tier: a tier-short send reverts "${tierWhy}"`);
  await (await oracle.addToWhitelist(sender.address, need, 0, "smoke")).wait();
  if (!(await probeCan()))
    failures.push(`tier: refused at the required tier ${need}`);
  if (!(await rules.whitelistTierAllows(token.target, sender.address)))
    failures.push(
      "tier: VSC has no whitelist oracle, yet the tier rule refuses",
    );

  // 5. Options 16 and 17 say "enforced" and read the chain.
  const cm = new ComplianceModule(state, new EnhancedLogger(), async () => "");
  const views = [];
  console.log = (...a) => views.push(a.join(" "));
  try {
    await cm.showTransferCooldowns();
    await cm.showWhitelistTiers();
  } finally {
    console.log = real;
  }
  const text = views.join("\n");
  console.log(text);
  for (const want of ["enforced by Token", "enforced by ComplianceRules"])
    if (!text.includes(want)) failures.push(`options 16/17: no "${want}" line`);
  if (/not enforced|^❌/m.test(text))
    failures.push("options 16/17 print 'not enforced' or an error line");

  // Leave no wallet inside a cooldown for the legs after this one.
  await jump(minutes * 60);
  if (failures.length === failed)
    console.log(
      "✅ investor smoke: VSC authorized; cooldown refused then allowed; tier-short refused, at tier allowed (Task 4.10)",
    );
}

module.exports = { runInvestorSmoke };
