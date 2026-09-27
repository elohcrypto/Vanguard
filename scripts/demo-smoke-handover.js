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

  // Seven proposals at most (five acceptances, two registry calls): give the
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
    identityRegistry: c("identityRegistry"),
    complianceRules: c("complianceRules"),
    oracleManager,
    investorTypeRegistry: c("investorTypeRegistry"),
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
  if (result.ok) {
    console.log(
      `✅ Handover ceremony: ${result.checks.length} checks pass, the deployer holds no power.`,
    );
  }
}

module.exports = { runHandoverSmoke };
