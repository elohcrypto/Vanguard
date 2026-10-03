/**
 * @fileoverview The ZK allow list on the live token (plan v2 Task 3.6).
 * Option 42 -> 1 and scripts/demo-smoke-privacy.js run the same steps on
 * VSC after a wallet bound itself on PrivacyManager:
 *   (a) VSC to whitelist mode Either (no whitelist oracle bound: an allow
 *       list of PrivacyManager bindings)
 *   (b) the bound wallet transfers VSC to another bound, verified wallet
 *   (c) a verified wallet without a binding is refused
 *   (d) the operator rotates the root without the sender: refused again
 *   (e) the sender re-onboards (new secret), both re-prove: succeeds
 * Every root and proof step uses the scripts/zk library (Task 3.5).
 */

const { ethers } = require("hardhat");
const { publishRoot } = require("../../scripts/zk/build-whitelist-root");
const { submitWhitelistProof } = require("../../scripts/zk/prove-whitelist");
const {
  demoWhitelist,
  proveForDemoUser,
  publisherFor,
} = require("./WhitelistBinderFlow");

const EITHER = 2;
const MODES = ["OracleOnly", "ZkOnly", "Either"];
const same = (a, b) => a.toLowerCase() === b.toLowerCase();
// scripts/zk/prove-whitelist.js refuses a commitment outside the root so.
const NOT_IN_ROOT = /is not in the root file/;
const fmt = (x) => ethers.formatEther(x);

/** Publish `rootFile` as the list operator, or the owner while none is set. */
async function publish(state, pm, rootFile, log) {
  const signer = publisherFor(state, await pm.owner(), await pm.listOperator());
  if (!signer) {
    throw new Error(
      "no loaded wallet may publish the root; after the handover ops or a PrivacyParameters vote (type 11) does",
    );
  }
  const r = await publishRoot({
    root: rootFile.root,
    privacyManager: await pm.getAddress(),
    signer,
  });
  log(
    `   📜 root ${rootFile.root.slice(0, 18)}… (${rootFile.count} commitments) published by ${signer.address}, version ${r.version}`,
  );
}

/** Prove `user` under `rootFile` and bind its wallet (library submit). */
async function proveAndBind(state, pm, user, rootFile, log) {
  const calldata = await proveForDemoUser(state, user, rootFile);
  const b = await submitWhitelistProof({
    calldata,
    privacyManager: await pm.getAddress(),
    signer: user,
  });
  log(`   🔗 ${user.address} bound (root version ${b.version})`);
}

/** Token.canTransfer, then the real transfer when it allows it. */
async function tryTransfer(token, from, to, amount, log) {
  const ok = await token.canTransfer(from.address, to.address, amount);
  log(`   🔍 canTransfer(${from.address} -> ${to.address}): ${ok}`);
  if (!ok) return false;
  const before = await token.balanceOf(to.address);
  await (await token.connect(from).transfer(to.address, amount)).wait();
  const after = await token.balanceOf(to.address);
  log(`   ✅ transferred ${fmt(amount)} VSC: ${fmt(before)} -> ${fmt(after)}`);
  return after - before === amount;
}

/** canTransfer must read false; the transfer is shown refused, not sent. */
async function showRefused(token, from, to, amount, log) {
  const ok = await token.canTransfer(from.address, to.address, amount);
  let why = "not refused";
  try {
    await token.connect(from).transfer.staticCall(to.address, amount);
  } catch (e) {
    why = (e.reason || e.shortMessage || e.message).split("\n")[0];
  }
  log(`   🔍 canTransfer(${from.address} -> ${to.address}): ${ok}`);
  log(`   🚫 transfer (staticCall only): ${why}`);
  return !ok;
}

/**
 * Run steps (a) to (e) on VSC. `sender` is bound under `rootFile`, which
 * lists `listed` (sender included). Returns what each step observed; the
 * smoke also reads the chain itself.
 * @param {Object} p
 * @param {Object} p.state - DemoState
 * @param {Object} p.sender - signer bound under rootFile
 * @param {Object[]} p.listed - signers onboarded in rootFile
 * @param {Object} p.rootFile - buildWhitelistRoot output, the current root
 * @param {Object} [p.outsider] - verified signer with no binding
 * @param {bigint} [p.amount] - VSC moved per transfer
 * @param {Function} [p.onRotated] - awaited right after step (d), so a
 *   caller (the smoke) can read the chain in that state
 * @returns {Promise<Object|null>} null when a precondition is missing
 */
async function runLiveWhitelistFlow({
  state,
  sender,
  listed,
  rootFile,
  outsider,
  amount = ethers.parseEther("10"),
  log = console.log,
  onRotated,
}) {
  const token = state.getContract("digitalToken");
  const rules = state.getContract("complianceRules");
  const pm = state.getContract("privacyManager");
  const idReg = state.getContract("identityRegistry");
  const deployer = state.signers[0];
  log("\n🪙 THE ZK ALLOW LIST ON VSC (live token)");
  if (!token || !rules || !idReg) {
    log("   ℹ️  VSC is not deployed: run option 21, then 42 -> 1 again");
    return null;
  }
  const vsc = await token.getAddress();
  const pmAddr = await pm.getAddress();
  if (!same(await rules.privacyManager(vsc), pmAddr)) {
    if (!same(await rules.owner(), deployer.address)) {
      log(
        `   ⚠️  ComplianceRules does not read ${pmAddr} for VSC; a ComplianceRules vote (type 1) calls setPrivacyManager`,
      );
      return null;
    }
    await (await rules.setPrivacyManager(vsc, pmAddr)).wait();
    log(`   ✅ ComplianceRules.privacyManager(VSC) set to ${pmAddr}`);
  }
  const verified = async (s) => idReg.isVerified(s.address);
  const bound = async (s) => pm.hasValidWhitelistProof(s.address);
  if (!(await verified(sender))) {
    log(
      `   ℹ️  ${sender.address} is not KYC/AML verified: onboard it (options 23/24, 3, 4) to use it on VSC`,
    );
    return null;
  }
  let recipient = null;
  for (const s of listed) {
    if (!same(s.address, sender.address) && (await verified(s))) {
      recipient = s;
      break;
    }
  }
  if (!recipient) {
    log(
      "   ℹ️  No other verified wallet is listed: list one (security mode 2 or 3) to show a transfer",
    );
    return null;
  }
  if (!outsider) {
    for (const s of state.signers) {
      if (listed.some((l) => same(l.address, s.address))) continue;
      if ((await verified(s)) && !(await bound(s))) {
        outsider = s;
        break;
      }
    }
  }
  const out = {};

  // (a) Either: with no whitelist oracle, only live bindings pass.
  log("\n(a) VSC whitelist mode");
  let mode = Number(await rules.whitelistMode(vsc));
  if (mode !== EITHER) {
    if (!same(await rules.owner(), deployer.address)) {
      log(
        `   ⚠️  mode ${MODES[mode]}; after the handover a ComplianceRules vote (type 1) calls setWhitelistMode(VSC, 2)`,
      );
      return null;
    }
    await (await rules.setWhitelistMode(vsc, EITHER)).wait();
    mode = Number(await rules.whitelistMode(vsc));
  }
  out.mode = MODES[mode];
  const oracleBound = (await rules.whitelistOracle(vsc)) !== ethers.ZeroAddress;
  log(`   ✅ VSC whitelist mode: ${out.mode}`);
  log(
    oracleBound
      ? "   ℹ️  a whitelist oracle is bound: oracle-listed wallets pass too"
      : "   ℹ️  no whitelist oracle bound: this is an allow list of PrivacyManager bindings; every VSC holder without a live binding is refused (mint recipient, transfers), burns stay open",
  );

  // (b) Both parties need a binding: the recipient proves under the root.
  log("\n(b) bound wallet -> another verified wallet");
  if (!(await bound(recipient))) {
    await proveAndBind(state, pm, recipient, rootFile, log);
  }
  // Two transfers (b, e); the refusals in (c) and (d) must not be a
  // balance shortfall, and the sender keeps one amount after (e).
  const have = await token.balanceOf(sender.address);
  if (have < 3n * amount) {
    if (!(await token.isAgent(deployer.address))) {
      log(`   ℹ️  ${sender.address} holds too little VSC: fund it (option 25)`);
      return null;
    }
    // The mint recipient faces the same gate: the sender is bound.
    await (await token.mint(sender.address, 3n * amount - have)).wait();
    log(
      `   🏭 minted ${fmt(3n * amount - have)} VSC to ${sender.address} (bound)`,
    );
  }
  out.transferred = await tryTransfer(token, sender, recipient, amount, log);

  // (c) A verified wallet without a binding.
  log("\n(c) a verified wallet without a binding");
  if (outsider) {
    out.outsiderRefused = await showRefused(
      token,
      sender,
      outsider,
      amount,
      log,
    );
  } else {
    log("   ℹ️  every other verified wallet is listed: nothing to show");
  }

  // (d) Root rotation without the sender's commitment. The kept recipient
  //     re-onboards with a fresh commitment, so the rotated root is new on
  //     every run (an old root is never republished), and re-binds under
  //     it: the sender is then the only party without a binding.
  log("\n(d) ops/owner rotates the root without the sender");
  const rest = listed.filter((s) => !same(s.address, sender.address));
  state.zkSecrets.delete(recipient.address);
  const { rootFile: root2 } = await demoWhitelist(state, rest);
  log(
    `   ♻️  ${recipient.address} re-onboards with a fresh commitment; ${sender.address} is left out`,
  );
  await publish(state, pm, root2, log);
  await proveAndBind(state, pm, recipient, root2, log);
  log(`   🔍 hasValidWhitelistProof(sender): ${await bound(sender)}`);
  log(`   🔍 hasValidWhitelistProof(recipient): ${await bound(recipient)}`);
  out.rotatedRefused = await showRefused(token, sender, recipient, amount, log);
  // Removal is proven only by the library's not-in-the-root refusal.
  out.senderRemoved = false;
  try {
    await proveForDemoUser(state, sender, root2);
    log("   ❌ the removed wallet could still prove");
  } catch (e) {
    out.senderRemoved = NOT_IN_ROOT.test(e.message);
    log(
      out.senderRemoved
        ? "   🚫 the sender cannot re-prove: its commitment is not in the root"
        : `   ❌ the re-prove failed for another reason: ${e.message.split("\n")[0]}`,
    );
  }
  out.afterRotation = {
    sender: await bound(sender),
    recipient: await bound(recipient),
  };
  if (onRotated) await onRotated({ sender, recipient });

  // (e) Re-onboarding is a new commitment (a fresh secret), so the new
  //     root differs from every old one; both wallets re-prove and re-bind.
  log("\n(e) re-onboard the sender, re-prove, re-bind");
  state.zkSecrets.delete(sender.address);
  const { rootFile: root3 } = await demoWhitelist(state, listed);
  await publish(state, pm, root3, log);
  for (const s of [sender, recipient]) {
    await proveAndBind(state, pm, s, root3, log);
  }
  out.reproved = await tryTransfer(token, sender, recipient, amount, log);
  log(
    out.transferred && out.rotatedRefused && out.senderRemoved && out.reproved
      ? "\n✅ ZK allow list on VSC: bound -> transfer, sender removed -> refused, re-proved -> transfer"
      : "\n⚠️  ZK allow list on VSC: a step did not behave as expected (see above)",
  );
  return { ...out, recipient: recipient.address, outsider: outsider?.address };
}

module.exports = { runLiveWhitelistFlow };
