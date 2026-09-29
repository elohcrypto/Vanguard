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
      if (!/GovernanceToken: trusted contract/.test(e.message)) {
        failures.push(
          `D23: ops ${name}(governance) wrong revert: ${e.message.split("\n")[0]}`,
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
    const name =
      e.revert?.name ??
      (e.data ? vgt.interface.parseError(e.data)?.name : undefined);
    if (name !== "ExpectedPause") {
      failures.push(
        `D24: ops cannot unpause VGT: ${e.message.split("\n")[0]}`,
      );
    }
  }
  try {
    await opsVgt.pause.staticCall();
    failures.push("D24: ops can pause VGT");
  } catch (e) {
    // Hardhat may not put the reason in e.message; decode Error(string).
    const why = e.data?.startsWith("0x08c379a0")
      ? ethers.AbiCoder.defaultAbiCoder().decode(
          ["string"],
          ethers.dataSlice(e.data, 4),
        )[0]
      : e.message;
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
