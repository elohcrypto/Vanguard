/**
 * Option 58 (plan v2 Task 4.10, D37 = a): no-prompt on-chain proofs that
 * the investor-type cooldown and the required whitelist tier are transfer
 * rules. Every verdict is a chain read or a transaction receipt.
 *
 * Cooldown, on VSC itself: a verified, non-exempt wallet sends; an
 * immediate second send is refused with "Transfer cooldown" (canTransfer
 * false, the revert reason read by eth_call); on a dev node the clock
 * jumps past the sender's cooldown and the send passes. A real network
 * prints the time to come back instead.
 *
 * Tier, on a probe token: no deploy path binds a whitelist oracle to VSC,
 * so VSC reads no entry and the tier rule does not apply to it (R-410-5).
 * The probe is a fresh Token on the demo's IdentityRegistry with its own
 * ComplianceRules (OracleOnly), WhitelistOracle and InvestorTypeRegistry,
 * all owned by the runner: the sender is Accredited (tier 3+), listed at
 * tier 2 it is refused, re-listed at tier 3 it sends.
 */
const { ethers } = require("hardhat");
const { canJumpTime, advancePast } = require("./ChainTime");
const { cooldownWaitLine } = require("./InvestorTypeRules");

const AMOUNT = ethers.parseEther("1");
const iso = (s) => new Date(Number(s) * 1000).toISOString();

/** The revert reason a send would hit now, or null if it would pass. */
async function reasonOf(token, from, to, amount) {
  try {
    await token.connect(from).transfer.staticCall(to, amount);
    return null;
  } catch (e) {
    const m = /reason string '([^']*)'/.exec(e.message);
    return (
      e.reason || (m && m[1]) || e.shortMessage || e.message.split("\n")[0]
    );
  }
}

/** Two verified, unfrozen, non-exempt demo wallets with VSC to send. */
async function pickPair(state, token, registry, log) {
  const idReg = state.getContract("identityRegistry");
  const rules = state.getContract("complianceRules");
  const tAddr = await token.getAddress();
  const ok = [];
  for (const s of state.signers.slice(1, 10)) {
    if (!(await idReg.isVerified(s.address))) continue;
    if (await token.isFrozen(s.address)) continue;
    if (await registry.investorLimitExempt(s.address)) continue;
    if (await rules["isTrustedContract(address,address)"](tAddr, s.address))
      continue;
    ok.push(s);
    if (ok.length === 2) break;
  }
  if (ok.length < 2) {
    log("   Needs two verified demo wallets (options 3/24 onboard them)");
    return null;
  }
  const [sender, recipient] = ok;
  if ((await token.getFreeBalance(sender.address)) < 3n * AMOUNT) {
    const treasury = state.signers[0];
    if (
      await token.canTransfer(treasury.address, sender.address, 3n * AMOUNT)
    ) {
      await (
        await token.connect(treasury).transfer(sender.address, 3n * AMOUNT)
      ).wait();
    } else if (await token.isAgent(treasury.address)) {
      await (
        await token.connect(treasury).mint(sender.address, 3n * AMOUNT)
      ).wait();
    } else {
      log(
        `   ${sender.address} holds under 3 VSC and the treasury cannot fund it`,
      );
      return null;
    }
    log(`   funded ${sender.address} with 3 VSC from the treasury`);
  }
  return { sender, recipient };
}

/**
 * The cooldown proof on VSC.
 * @returns {Promise<object|null>} {sender, recipient, refused, passed} or null
 */
async function proveCooldown(state, log = console.log) {
  const token = state.getContract("digitalToken");
  const registry = state.getContract("investorTypeRegistry");
  if (!token || !registry) {
    log("   VSC (option 21) and the InvestorTypeRegistry (option 51) first");
    return null;
  }
  const tAddr = await token.getAddress();
  if (
    (await token.investorTypeRegistry()).toLowerCase() !==
    (await registry.getAddress()).toLowerCase()
  ) {
    log("   VSC does not enforce this registry: run option 51");
    return null;
  }
  if (!(await registry.isTokenAuthorized(tAddr))) {
    log(
      '   VSC is not authorized by its registry: every send is refused ("Token not authorized by investor registry"); option 51 authorizes it',
    );
    return null;
  }
  const pair = await pickPair(state, token, registry, log);
  if (!pair) return null;
  const { sender, recipient } = pair;
  const minutes = Number(await registry.getTransferCooldown(sender.address));
  log(`\n🔄 COOLDOWN on VSC: ${sender.address} -> ${recipient.address}, 1 VSC`);
  log(`   sender's type cooldown (chain): ${minutes} minutes`);

  if (!(await registry.canTransferNow(sender.address))) {
    const last = await registry.lastTransferAt(sender.address);
    if (!(await canJumpTime())) {
      log(`   ${await cooldownWaitLine(last + BigInt(minutes * 60))}`);
      log("   the cooldown proof is skipped until then (the tier proof runs)");
      return null;
    }
    await advancePast(last + BigInt(minutes * 60) - 1n, "earlier cooldown", {
      margin: 1,
    });
  }
  const why = await reasonOf(token, sender, recipient.address, AMOUNT);
  if (why) {
    log(`   the first send would be refused for another reason: "${why}"`);
    return null;
  }
  const r1 = await (
    await token.connect(sender).transfer(recipient.address, AMOUNT)
  ).wait();
  const last = await registry.lastTransferAt(sender.address);
  log(`   1. sent (tx ${r1.hash}); lastTransferAt = ${iso(last)}`);

  const can = await token.canTransfer(
    sender.address,
    recipient.address,
    AMOUNT,
  );
  const refused = await reasonOf(token, sender, recipient.address, AMOUNT);
  log(`   2. canTransfer now: ${can}; a second send reverts: "${refused}"`);
  if (can || refused !== "Transfer cooldown")
    return { sender, recipient, refused, passed: false };

  const end = last + BigInt(minutes * 60);
  if (!(await canJumpTime())) {
    log(`   3. no evm_increaseTime here: ${await cooldownWaitLine(end)}`);
    log("      the send after the cooldown is skipped; run 58 again then");
    return { sender, recipient, refused, passed: null };
  }
  await advancePast(end - 1n, `${minutes}-minute cooldown`, { margin: 1 });
  const r2 = await (
    await token.connect(sender).transfer(recipient.address, AMOUNT)
  ).wait();
  log(
    `   3. after the cooldown the send passes (tx ${r2.hash}, status ${r2.status})`,
  );
  return { sender, recipient, refused, passed: r2.status === 1 };
}

/**
 * The tier proof on a probe token (see the file comment).
 * @returns {Promise<object|null>} {probe, oracle, types, sender, recipient, refused, passed}
 */
async function proveTier(state, pair, log = console.log) {
  const idReg = state.getContract("identityRegistry");
  const om = state.getContract("oracleManager");
  if (idReg && !pair) {
    const v = [];
    for (const s of state.signers.slice(1, 10))
      if (v.length < 2 && (await idReg.isVerified(s.address))) v.push(s);
    if (v.length === 2) pair = { sender: v[0], recipient: v[1] };
  }
  if (!idReg || !om || !pair) {
    log(
      "   Needs the identity registry, the oracle system (31) and two verified wallets",
    );
    return null;
  }
  const { sender, recipient } = pair;
  const runner = state.signers[0];
  const deploy = async (name, ...a) => {
    const c = await (
      await ethers.getContractFactory(name, runner)
    ).deploy(...a);
    await c.waitForDeployment();
    return c;
  };
  const rules = await deploy("ComplianceRules", runner.address, [], []);
  const probe = await deploy(
    "Token",
    "VSC tier probe",
    "VSCT",
    idReg.target,
    rules.target,
  );
  const oracle = await deploy(
    "WhitelistOracle",
    om.target,
    "Tier probe",
    "Task 4.10",
  );
  const types = await deploy("InvestorTypeRegistry");
  await (
    await rules.setTokenIdentityRegistry(probe.target, idReg.target)
  ).wait();
  await (await rules.setWhitelistOracle(probe.target, oracle.target)).wait();
  await (await probe.setInvestorTypeRegistry(types.target)).wait();
  await (await types.authorizeToken(probe.target, true)).wait();
  await (await types.assignInvestorType(sender.address, 2)).wait(); // Accredited
  const need = Number(await types.getRequiredWhitelistTier(sender.address));
  await (
    await oracle.addToWhitelist(sender.address, need, 0, "tier probe")
  ).wait();
  await (
    await oracle.addToWhitelist(recipient.address, 5, 0, "tier probe")
  ).wait();
  await (await probe.mint(sender.address, 2n * AMOUNT)).wait();
  log(
    `\n📊 TIER on probe token ${probe.target} (OracleOnly, oracle ${oracle.target})`,
  );
  log(`   ${sender.address} is Accredited: required tier ${need}+ (chain)`);

  await (
    await oracle.addToWhitelist(sender.address, need - 1, 0, "tier probe")
  ).wait();
  const short = Number((await oracle.getWhitelistInfo(sender.address))[3]);
  const can = await probe.canTransfer(
    sender.address,
    recipient.address,
    AMOUNT,
  );
  const tierOk = await rules.whitelistTierAllows(probe.target, sender.address);
  const refused = await reasonOf(probe, sender, recipient.address, AMOUNT);
  log(
    `   1. entry tier ${short}: canTransfer ${can}, whitelistTierAllows ${tierOk}, a send reverts: "${refused}"`,
  );

  await (
    await oracle.addToWhitelist(sender.address, need, 0, "tier probe")
  ).wait();
  const r = await (
    await probe.connect(sender).transfer(recipient.address, AMOUNT)
  ).wait();
  const tierNow = await rules.whitelistTierAllows(probe.target, sender.address);
  log(
    `   2. re-listed at tier ${need}: whitelistTierAllows ${tierNow}, the send passes (tx ${r.hash}, status ${r.status})`,
  );
  const passed =
    !can && !tierOk && refused === "Compliance check failed" && r.status === 1;
  return { probe, oracle, types, rules, sender, recipient, refused, passed };
}

/**
 * Option 58: both proofs, no prompts. Returns {cooldown, tier} (true when
 * proven on chain this run) with the raw results for the smoke.
 */
async function runOption58(state, log = console.log) {
  log("\n⏰ OPTION 58: COOLDOWN AND TIER ARE TRANSFER RULES (Task 4.10)");
  log("=".repeat(60));
  let c = null;
  let t = null;
  try {
    c = await proveCooldown(state, log);
  } catch (e) {
    log(`   cooldown proof stopped: ${e.message.split("\n")[0]}`);
  }
  try {
    t = await proveTier(
      state,
      c && { sender: c.sender, recipient: c.recipient },
      log,
    );
  } catch (e) {
    log(`   tier proof stopped: ${e.message.split("\n")[0]}`);
  }
  const cooldown = c?.passed === true;
  const tier = t?.passed === true;
  log("\n📋 Result (chain reads and receipts):");
  log(
    `   ${cooldown ? "✅" : "⚠️ "} cooldown: ${cooldown ? 'a send inside the cooldown is refused ("Transfer cooldown"), after it passes' : "not proven this run (see above)"}`,
  );
  log(
    `   ${tier ? "✅" : "⚠️ "} tier: ${tier ? 'a tier-short entry is refused ("Compliance check failed"), re-listed it passes' : "not proven this run (see above)"}`,
  );
  return { cooldown, tier, c, t };
}

module.exports = { proveCooldown, proveTier, runOption58, reasonOf, AMOUNT };
