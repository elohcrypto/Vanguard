/**
 * Handover ceremony section of scripts/demo-smoke.js (plan v2 Task 2C.1).
 *
 * Runs the same ceremony as demo options 83c/83d and scripts/handover.ts
 * (demo/utils/Handover.js) against the smoke's deployment, then asserts the
 * deployer holds no power. Kept separate so demo-smoke.js stays readable; it
 * is invoked by the same command line:
 *   npx hardhat run scripts/demo-smoke.js --network localhost
 *
 * Must run LAST: after it the deployer is no longer an agent, so the smoke's
 * earlier onboarding (registerIdentity by the deployer) would fail.
 */

const { ethers } = require("hardhat");
const {
  ACCEPTANCE_PLAN,
  handoverDeployerPowers,
  acceptAllByVote,
  assertHandoverComplete,
} = require("../demo/utils/Handover");

/** Wallet roles from docs/TESTNET_DEMO.md. */
const OPS = 10;
const GUARDIAN = 11;
const PROPOSER = 1;
// Verified VGT holders the smoke already onboarded (0-3 and 6-8). Five
// votes clear every quorum in the plan (TokenParameters is 30%).
const VOTERS = [2, 3, 6, 7, 8];

// ethers v6 error shapes differ by provider: the in-process network puts
// the revert hex in e.data, a JSON-RPC node wraps it as { data, message }.
// parseError decodes both custom errors and Error(string).
function revertOf(e, iface) {
  const data = [e.data, e.data?.data, e.error?.data, e.info?.error?.data].find(
    (d) => typeof d === "string" && d.length >= 10,
  );
  let p = null;
  try {
    p = data ? iface.parseError(data) : null;
  } catch {}
  return {
    name: e.revert?.name ?? p?.name,
    reason:
      e.revert?.args?.[0] ??
      e.reason ??
      (p?.name === "Error" ? p.args[0] : undefined),
    message: e.message ?? "",
  };
}

async function runHandoverSmoke(state, failures) {
  const s = state.signers;
  const c = (k) => state.getContract(k);
  const governance = c("vanguardGovernance");
  const oracleManager = c("oracleManager");

  // R6: option 74 binds OracleParameters to the deployed OracleManager.
  const boundOracle = await governance.boundTarget(2);
  const omAddr = await oracleManager.getAddress();
  if (boundOracle.toLowerCase() !== omAddr.toLowerCase()) {
    failures.push(
      `governance.boundTarget(OracleParameters) = ${boundOracle}, expected OracleManager ${omAddr}`,
    );
    return;
  }

  // Eight proposals at most (seven acceptances, or six when 83b already gave
  // governance the registry plus two registry calls): give the
  // proposer and every voter enough VGT for all of them.
  const vgt = c("governanceToken");
  const perRound =
    (await governance.proposalCreationCost()) + (await governance.votingCost());
  for (const i of [PROPOSER, ...VOTERS]) {
    if (!(await c("identityRegistry").isVerified(s[i].address))) {
      failures.push(`handover smoke: wallet ${i} is not a verified voter`);
      return;
    }
    const want = perRound * 8n;
    const have = await vgt.balanceOf(s[i].address);
    if (have < want) {
      await (
        await vgt.distributeGovernanceTokens([s[i].address], [want - have])
      ).wait();
    }
  }

  const args = {
    fromBlock: state.complianceRulesDeployBlock,
    deployer: s[0],
    ops: s[OPS],
    guardian: s[GUARDIAN],
    governance,
    token: c("digitalToken"),
    governanceToken: vgt,
    identityRegistry: c("identityRegistry"),
    complianceRules: c("complianceRules"),
    oracleManager,
    investorTypeRegistry: c("investorTypeRegistry"),
    // The smoke does not deploy DynamicListManager (option 84); optional in the plan.
    dynamicListManager: undefined,
    oracles: ["whitelistOracle", "blacklistOracle", "consensusOracle"].map(c),
    issuers: [c("kycIssuer"), c("amlIssuer")],
  };

  const lines = [];
  const log = (m) => lines.push(m);
  try {
    const report = await handoverDeployerPowers({ ...args, log });
    const contracts = {};
    for (const e of ACCEPTANCE_PLAN) {
      contracts[e.key] = e.key === "governance" ? governance : args[e.key];
    }
    await acceptAllByVote({
      governance,
      contracts,
      proposer: s[PROPOSER],
      voters: VOTERS.map((i) => s[i]),
      registryProposals: report.registryProposals,
      log,
    });
  } catch (e) {
    failures.push(
      `handover ceremony threw: ${e.message.split("\n")[0]} | last steps: ${lines.slice(-3).join(" | ")}`,
    );
    return;
  }

  const result = await assertHandoverComplete(args);
  for (const f of result.failures) failures.push(`handover: ${f}`);

  // D23: ops is a VGT agent now, but cannot freeze or burn governance's
  // fees (no vote could undo it). staticCall: nothing changes on chain.
  const opsVgt = vgt.connect(s[OPS]);
  const govAddr = await governance.getAddress();
  const iface = vgt.interface;
  const levers = [
    [
      "setAddressFrozen",
      () => opsVgt.setAddressFrozen.staticCall(govAddr, true),
    ],
    ["burn", () => opsVgt["burn(address,uint256)"].staticCall(govAddr, 1n)],
  ];
  for (const [name, call] of levers) {
    try {
      await call();
      failures.push(`D23: ops ${name}(governance) on VGT succeeded`);
    } catch (e) {
      const r = revertOf(e, iface);
      const trusted = /GovernanceToken: trusted contract/;
      if (!trusted.test(r.reason ?? "") && !trusted.test(r.message)) {
        failures.push(
          `D23: ops ${name}(governance) wrong revert: ${r.message.split("\n")[0]}`,
        );
      }
    }
  }
  // No recovery out of or into governance: out of it via the VGT hook,
  // into it via the base Token check (review M1); the hook runs first.
  const voter = s[VOTERS[0]].address;
  const voterId = await c("identityRegistry").identity(voter);
  const hook = /GovernanceToken: trusted contract/;
  const either =
    /GovernanceToken: trusted contract|Token: recovery into trusted contract/;
  const recoveries = [
    [
      "recoveryAddress(governance, fresh)",
      hook,
      () =>
        opsVgt.recoveryAddress.staticCall(
          govAddr,
          ethers.Wallet.createRandom().address,
          ethers.ZeroAddress,
        ),
    ],
    [
      "recoveryAddress(voter, governance)",
      either,
      () => opsVgt.recoveryAddress.staticCall(voter, govAddr, voterId),
    ],
  ];
  for (const [name, refused, call] of recoveries) {
    try {
      await call();
      failures.push(`D23: ops ${name} on VGT succeeded`);
    } catch (e) {
      const r = revertOf(e, iface);
      if (!refused.test(r.reason ?? "") && !refused.test(r.message)) {
        failures.push(
          `D23: ops ${name} wrong revert: ${r.message.split("\n")[0]}`,
        );
      }
    }
  }
  try {
    await opsVgt.setAddressFrozen.staticCall(s[VOTERS[0]].address, true);
  } catch (e) {
    failures.push(
      `D23: ops can no longer freeze a voter on VGT: ${e.message.split("\n")[0]}`,
    );
  }

  // D24: ops may release a VGT pause but never impose one. VGT is not
  // paused, so unpause must pass the access check and hit ExpectedPause.
  try {
    await opsVgt.unpause.staticCall();
    failures.push("D24: ops unpause on an unpaused VGT succeeded");
  } catch (e) {
    const r = revertOf(e, iface);
    if (r.name !== "ExpectedPause" && !/ExpectedPause/.test(r.message)) {
      failures.push(`D24: ops cannot unpause VGT: ${r.message.split("\n")[0]}`);
    }
  }
  try {
    await opsVgt.pause.staticCall();
    failures.push("D24: ops can pause VGT");
  } catch (e) {
    const r = revertOf(e, iface);
    const why = r.reason ?? r.message;
    if (!/Token: caller is not owner or guardian/.test(why)) {
      failures.push(`D24: ops pause wrong revert: ${why.split("\n")[0]}`);
    }
  }

  if (result.ok) {
    console.log(
      `✅ Handover ceremony: ${result.checks.length} checks pass, the deployer holds no power.`,
    );
  }
}

module.exports = { runHandoverSmoke };
