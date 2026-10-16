/**
 * @fileoverview Oracle option 38a (plan v2 Task 4.16, D47 a): bind the
 * whitelist oracle to VSC so the investor-type tier rule (Task 4.10) and
 * the consensus tier (4.12) act on the real token.
 *
 *   1. Fill: every current VSC holder (Transfer scan, trusted contracts
 *      left out) is listed on the whitelist oracle at the tier its
 *      investor type requires, by the oracle's owner or list manager
 *      (the deployer before the handover, ops after it; never wallet 0
 *      after it, and a multisig ops lists by its own batch).
 *   2. Preflight (HandoverHolders.js, the ceremony's rule): in OracleOnly
 *      an unlisted holder refuses the bind, in Either it warns.
 *   3. Bind: ComplianceRules.setWhitelistOracle(VSC, oracle) directly
 *      while the deployer owns ComplianceRules; a ComplianceRules (type 1)
 *      proposal once governance does, voted and executed here on request
 *      (the demo's one vote path, HandoverVotes), else with 77/78.
 *
 * Every verdict is a chain read or a receipt (R-48-6). The proposal
 * wizard (option 76, type 1, action 3) builds the same call after the
 * same preflight (bindProposal).
 */

const { ethers } = require("hardhat");
const { displaySection, displayError } = require("./DisplayHelpers");
const { MODE } = require("./HandoverChecks");
const { holderStanding, preflightHolders } = require("./HandoverHolders");
const {
  proposeCall,
  castAcceptanceVotes,
  settleProposal,
} = require("./HandoverVotes");
const { pickVoters } = require("./VoterPicker");
const { postCeremonyOf } = require("./PostCeremony");

const same = (a, b) => a.toLowerCase() === b.toLowerCase();

/** The ceremony-shaped view of the demo state the holder scan reads. */
function ceremonyView(state) {
  return {
    token: state.getContract("digitalToken"),
    complianceRules: state.getContract("complianceRules"),
    fromBlock:
      state.deployStartBlock ??
      state.identityRegistryDeployBlock ??
      state.complianceRulesDeployBlock ??
      0,
  };
}

/**
 * The demo signer allowed to list on `oracle`: its owner or list manager,
 * never wallet 0 after the ceremony (R-56-5; Task 5.14).
 */
async function listSigner(state, oracle) {
  const owner = await oracle.owner();
  const manager = await oracle.listManager();
  const d = (await postCeremonyOf(state)) ? state.signers[0] : null;
  return (
    state.signers.find(
      (s) =>
        !(d && same(s.address, d.address)) &&
        (same(s.address, owner) || same(s.address, manager)),
    ) || null
  );
}

/** Why no loaded wallet may list on `oracle` (Task 5.14). */
async function noSignerReason(state, oracle) {
  const owner = await oracle.owner();
  if ((await ethers.provider.getCode(owner)) !== "0x") {
    return `the oracle's owner ${owner} is a contract (a multisig ops): listing is ops's batch or manual step; nothing sent`;
  }
  if (same(owner, state.signers[0].address)) {
    return `the deployer ${owner} still owns the oracle and sends nothing after the ceremony (R-56-5): the ceremony hands it to ops`;
  }
  return "no loaded wallet owns or manages the oracle";
}

/**
 * List every holder the oracle does not carry at its required tier.
 * Returns { listed, skipped } counts; prints one line per receipt.
 */
async function fillOracle(state, oracle, log = console.log) {
  const o = ceremonyView(state);
  const s = await holderStanding(o, oracle);
  const signer = await listSigner(state, oracle);
  const why = signer ? null : await noSignerReason(state, oracle);
  let listed = 0;
  for (const h of s.holders) {
    if (h.ok) continue;
    if (!signer) {
      log(`   ⛔ ${h.address} not listed: ${why}`);
      continue;
    }
    const tier = Math.max(1, h.required);
    const rc = await (
      await oracle
        .connect(signer)
        .addToWhitelist(h.address, tier, 0, "option 38a: current VSC holder")
    ).wait();
    log(
      `   ✅ ${h.address} listed at tier ${tier} (needs ${h.required}; tx ${rc.hash.slice(0, 12)}...)`,
    );
    listed++;
  }
  return { listed, skipped: s.holders.length - listed };
}

/**
 * The holder preflight for a bind of `oracle` to VSC, as the ceremony
 * applies it: { refused } with the reason, or { warnings } (Either).
 */
async function bindPreflight(state, oracle) {
  const o = ceremonyView(state);
  const vsc = await o.token.getAddress();
  const warnings = [];
  const mode = MODE[Number(await o.complianceRules.whitelistMode(vsc))];
  if (mode === "ZkOnly") return { warnings, mode };
  const probe = {
    ...o,
    complianceRules: {
      whitelistOracle: async () => oracle.target,
      whitelistMode: (t) => o.complianceRules.whitelistMode(t),
      "isTrustedContract(address,address)": (t, a) =>
        o.complianceRules["isTrustedContract(address,address)"](t, a),
    },
  };
  try {
    await preflightHolders(probe, (w) => warnings.push(w));
  } catch (e) {
    if (!/^Handover: /.test(e.message)) throw e;
    return { refused: e.message.slice(10), warnings, mode };
  }
  return { warnings, mode };
}

/** The VSC holders the demo's whitelist oracle lists now (chain). */
async function listedHolders(state) {
  const oracle = state.getContract("whitelistOracle");
  if (!oracle || !state.getContract("digitalToken")) return [];
  const s = await holderStanding(ceremonyView(state), oracle);
  return s.holders.filter((h) => h.listed).map((h) => h.address);
}

/** Print each holder's standing from chain after the bind. */
async function printStanding(state, log = console.log) {
  const o = ceremonyView(state);
  const vsc = await o.token.getAddress();
  const s = await holderStanding(o);
  if (!s) return log("   ℹ️  no whitelist oracle bound to VSC");
  log(`\n👤 VSC holders on ${s.oracle} (${s.mode}), from chain:`);
  for (const h of s.holders) {
    const allows = await o.complianceRules.whitelistTierAllows(vsc, h.address);
    log(
      `   ${h.address}: ${h.listed ? `tier ${h.tier}` : "unlisted"}, needs ${h.required}${h.exempt ? " (exempt)" : ""}: whitelistTierAllows ${allows ? "✅ true" : "⛔ false"}`,
    );
  }
}

/** Option 38a. */
async function bindWhitelistToToken(mod) {
  displaySection("BIND THE WHITELIST ORACLE TO VSC (D47)", "🔗");
  const { state } = mod;
  const token = state.getContract("digitalToken");
  const rules = state.getContract("complianceRules");
  const oracle = state.getContract("whitelistOracle");
  if (!token || !rules) {
    return console.log("ℹ️  Deploy VSC and ComplianceRules first (option 21)");
  }
  if (!oracle) {
    return console.log("ℹ️  Deploy the oracle system first (option 31)");
  }
  try {
    const vsc = await token.getAddress();
    const bound = await rules.whitelistOracle(vsc);
    const mode = MODE[Number(await rules.whitelistMode(vsc))];
    console.log(`   VSC whitelist mode ${mode}, oracle bound: ${bound}`);
    if (same(bound, oracle.target)) {
      console.log("   ℹ️  this oracle is already bound to VSC");
      return printStanding(state);
    }
    console.log("\n📝 Step 1: list every current VSC holder at its tier");
    const { listed, skipped } = await fillOracle(state, oracle);
    console.log(`   ${listed} listed, ${skipped} already at their tier`);

    console.log("\n📝 Step 2: the ceremony's holder preflight");
    const pre = await bindPreflight(state, oracle);
    for (const w of pre.warnings) console.log(`   ⚠️  ${w}`);
    if (pre.refused) {
      console.log(`   ⛔ Bind refused: ${pre.refused}`);
      return;
    }
    console.log("   ✅ no holder would be frozen by the bind");

    console.log("\n📝 Step 3: ComplianceRules.setWhitelistOracle(VSC, oracle)");
    const callData = rules.interface.encodeFunctionData("setWhitelistOracle", [
      vsc,
      oracle.target,
    ]);
    const owner = await rules.owner();
    const deployer = state.signers[0];
    if (same(owner, deployer.address)) {
      const rc = await (
        await rules.connect(deployer).setWhitelistOracle(vsc, oracle.target)
      ).wait();
      console.log(`   ✅ bound by the deployer (owner), tx ${rc.hash}`);
    } else {
      const gov = state.getContract("vanguardGovernance");
      if (!gov || !same(owner, await gov.getAddress())) {
        return console.log(
          `   ⛔ ComplianceRules is owned by ${owner}, neither the deployer nor governance`,
        );
      }
      const pick = await pickVoters(state, 1, "ComplianceRules");
      if (!pick) return;
      const id = await proposeCall(
        gov,
        pick.proposer,
        1,
        rules,
        callData,
        "Bind the whitelist oracle to VSC",
        "demo: option 38a",
      );
      console.log(
        `   🗳️  Proposal #${id} (ComplianceRules) by ${pick.proposer.address}`,
      );
      const now = await mod.promptUser(
        "Vote and execute now with the demo voters? (y/n): ",
      );
      if (now.trim().toLowerCase() !== "y") {
        return console.log("   💡 Vote with option 77, execute with 78");
      }
      await castAcceptanceVotes(gov, id, pick.voters);
      // R-56-5: executed by the proposer, never the default wallet 0.
      await settleProposal(
        gov.connect(pick.proposer),
        id,
        "bind the whitelist oracle",
      );
      console.log(`   ✅ proposal #${id} executed`);
    }
    const after = await rules.whitelistOracle(vsc);
    console.log(
      `   ${same(after, oracle.target) ? "✅" : "❌"} rules.whitelistOracle(VSC) = ${after}`,
    );
    await printStanding(state);
    console.log("\n💡 Options 17 and 20d show each holder's tier verdict");
  } catch (error) {
    if (/^Handover: /.test(error.message)) {
      console.log(`   ⛔ Refused: ${error.message.slice(10)}`);
    } else displayError(`Bind failed: ${error.message}`);
  }
}

/**
 * The proposal wizard's action (option 76, type 1): the same preflight,
 * then { title, description, callData }, or null after the refusal.
 */
async function bindProposal(mod) {
  const { state } = mod;
  const oracle = state.getContract("whitelistOracle");
  if (!oracle) {
    displayError("Deploy the oracle system first (option 31)");
    return null;
  }
  const vsc = await state.getContract("digitalToken").getAddress();
  const pre = await bindPreflight(state, oracle);
  for (const w of pre.warnings) console.log(`   ⚠️  ${w}`);
  if (pre.refused) {
    console.log(`   ⛔ ${pre.refused}`);
    return null;
  }
  return {
    title: "Bind the whitelist oracle to VSC",
    description: `setWhitelistOracle(${vsc}, ${oracle.target}): the investor-type tier rule acts on VSC (D47)`,
    callData: state
      .getContract("complianceRules")
      .interface.encodeFunctionData("setWhitelistOracle", [vsc, oracle.target]),
  };
}

module.exports = {
  bindWhitelistToToken,
  bindProposal,
  fillOracle,
  bindPreflight,
  printStanding,
  listSigner,
  noSignerReason,
  listedHolders,
};
