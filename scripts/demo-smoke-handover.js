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
const { advancePastVoterAge } = require("../demo/utils/ChainTime");

/** Wallet roles from docs/TESTNET_DEMO.md. */
const OPS = 10;
const GUARDIAN = 11;
// Takes any claim issuer the deployer holds; never ops (2F.5, D25 b).
const ISSUER_ADMIN = 9;
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

  // Twelve proposals at most (eleven acceptances incl. both factories and
  // both privacy contracts, or ten when 83b already gave governance the
  // registry plus two registry calls): give the proposer and every voter
  // enough VGT for all of them.
  const vgt = c("governanceToken");
  const perRound =
    (await governance.proposalCreationCost()) + (await governance.votingCost());
  for (const i of [PROPOSER, ...VOTERS]) {
    if (!(await c("identityRegistry").isVerified(s[i].address))) {
      failures.push(`handover smoke: wallet ${i} is not a verified voter`);
      return;
    }
    const want = perRound * 12n;
    const have = await vgt.balanceOf(s[i].address);
    if (have < want) {
      await (
        await vgt.distributeGovernanceTokens([s[i].address], [want - have])
      ).wait();
    }
  }

  // D25: voters are registered minVoterAge before the ceremony's proposals.
  await advancePastVoterAge(
    governance,
    c("identityRegistry"),
    [PROPOSER, ...VOTERS].map((i) => s[i]),
  );

  // 3.3 (R-3R-4): the privacy contracts join the ceremony. Option 1
  // deployed them and option 21 wired them for VSC (3.6), so the ceremony
  // derives the PrivacyManager from ComplianceRules (R-3R-15).
  const privacyManager = c("privacyManager");
  const zkVerifier = c("zkVerifierIntegrated");
  if (!privacyManager || !zkVerifier) {
    failures.push("handover smoke: no privacy pair in state (option 1)");
    return;
  }
  // Before the ceremony the deployer (owner) publishes the root, so the
  // version moves past every deployer-era binding.
  const root = ethers.toBeHex(ethers.toBigInt(ethers.randomBytes(31)), 32);
  await (await privacyManager.publishWhitelistRoot(root)).wait();

  // Log scans start at the IdentityRegistry deploy (review M-3).
  let fromBlock = state.identityRegistryDeployBlock;
  if (fromBlock === undefined) {
    fromBlock = state.complianceRulesDeployBlock;
    console.log(
      `   ⚠️  IdentityRegistry deploy block not recorded: scanning from the ComplianceRules deploy (block ${fromBlock})`,
    );
  }
  const args = {
    fromBlock,
    deployer: s[0],
    ops: s[OPS],
    guardian: s[GUARDIAN],
    issuerAdmin: s[ISSUER_ADMIN],
    governance,
    token: c("digitalToken"),
    governanceToken: vgt,
    identityRegistry: c("identityRegistry"),
    complianceRules: c("complianceRules"),
    oracleManager,
    investorTypeRegistry: c("investorTypeRegistry"),
    // The smoke does not deploy DynamicListManager (option 84); optional in the plan.
    dynamicListManager: undefined,
    // Both factories join the plan (2F.5, M4); the escrow leg deployed one.
    escrowWalletFactory: c("escrowFactory"),
    onchainIDFactory: c("onchainIDFactory"),
    privacyManager,
    zkVerifier,
    // 4.2: KeyManager holds no power; option 12's identity authorizes it.
    keyManager: c("keyManager"),
    keyManagerIdentity: state.keyLifecycle?.identity,
    // 4.4: ConsensusOracle is the manager's ownerless engine, not handed over.
    oracles: ["whitelistOracle", "blacklistOracle"].map(c),
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

  // 4.4: ops (the operator) may pause a node; the deployer no longer may.
  const node = s[1].address;
  await oracleManager
    .connect(s[OPS])
    .pauseOracle.staticCall(node)
    .catch((e) =>
      failures.push(
        `4.4: ops cannot pause a node: ${e.message.split("\n")[0]}`,
      ),
    );
  if (
    await oracleManager.pauseOracle.staticCall(node).then(
      () => true,
      () => false,
    )
  )
    failures.push("4.4: the deployer still pauses oracle nodes");

  // 3.3: after the ceremony the deployer can no longer publish a root; ops can.
  try {
    await privacyManager.publishWhitelistRoot.staticCall(root);
    failures.push("3.3: the deployer still publishes whitelist roots");
  } catch (e) {
    const r = revertOf(e, privacyManager.interface);
    if (r.name !== "NotListOperator" && !/NotListOperator/.test(r.message)) {
      failures.push(
        `3.3: deployer root publish wrong revert: ${r.message.split("\n")[0]}`,
      );
    }
  }
  try {
    await privacyManager.connect(s[OPS]).publishWhitelistRoot.staticCall(root);
  } catch (e) {
    failures.push(
      `3.3: ops cannot publish a whitelist root: ${e.message.split("\n")[0]}`,
    );
  }

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
  // No recovery out of or into governance. On VGT the D23 hook refuses
  // both (it checks the lost and the new wallet before anything else); on
  // VSC, where governance is not trusted (G5, Task 4.1), canReceive refuses
  // an account trusted on any token (M1).
  const voter = s[VOTERS[0]].address;
  const voterId = await c("identityRegistry").identity(voter);
  // Review L2: the VSC refusal below must come from the any-token trust
  // guard, not from VSC's whitelist gate (which returns the same false).
  const rules = c("complianceRules");
  const vscAddr = await c("digitalToken").getAddress();
  if (!(await rules.isTrustedOnAnyToken(govAddr))) {
    failures.push("G5: governance is not trusted on any token (D21)");
  }
  if (await rules["isTrustedContract(address,address)"](vscAddr, govAddr)) {
    failures.push("G5: governance is trusted on VSC; trust it on VGT only");
  }
  const hook = /GovernanceToken: trusted contract/;
  const opsVsc = c("digitalToken").connect(s[OPS]);
  const recoveries = [
    [
      "VGT recoveryAddress(governance, fresh)",
      hook,
      () =>
        opsVgt.recoveryAddress.staticCall(
          govAddr,
          ethers.Wallet.createRandom().address,
          ethers.ZeroAddress,
        ),
    ],
    [
      "VGT recoveryAddress(voter, governance)",
      hook,
      () => opsVgt.recoveryAddress.staticCall(voter, govAddr, voterId),
    ],
    [
      "VSC recoveryAddress(voter, governance)",
      /^Recovery blocked by compliance$/,
      () => opsVsc.recoveryAddress.staticCall(voter, govAddr, voterId),
    ],
  ];
  for (const [name, refused, call] of recoveries) {
    try {
      await call();
      failures.push(`D23: ops ${name} succeeded`);
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

  // 4.7: option 82 end to end after the ceremony (ops is the VGT agent).
  await require("./demo-smoke-workflow").runWorkflowSmoke(state, failures);

  // 3.5: the CI step "Whitelist root + proof CLI" runs scripts/zk/ against
  // this node; it needs the addresses and the verified wallets' OnchainIDs.
  if (process.env.DEMO_SMOKE_OUT) {
    const users = [];
    for (const i of [PROPOSER, ...VOTERS]) {
      users.push({
        index: i,
        wallet: s[i].address,
        onchainID: await c("identityRegistry").identity(s[i].address),
      });
    }
    const addr = (x) => x.getAddress();
    require("fs").writeFileSync(
      process.env.DEMO_SMOKE_OUT,
      JSON.stringify(
        {
          privacyManager: await addr(privacyManager),
          zkVerifier: await addr(zkVerifier),
          complianceRules: await addr(c("complianceRules")),
          token: await addr(c("digitalToken")),
          identityRegistry: await addr(c("identityRegistry")),
          keyManager: await addr(c("keyManager")),
          ops: { index: OPS, wallet: s[OPS].address },
          users,
        },
        null,
        2,
      ),
    );
  }

  if (result.ok) {
    console.log(
      `✅ Handover ceremony: ${result.checks.length} checks pass, ${result.residual.length ? "with warnings (see below)" : "the deployer holds no power"}.`,
    );
    for (const w of result.warnings) console.log(`   ⚠️  ${w}`);
  }
}

/**
 * D12 (b), plan v2 Task 4.6: option 80 prints each listed signer's VGT
 * delegation, labelled "recorded, not counted". Nothing in the smoke
 * delegates, so every line must say "none" and 0, matching the chain.
 * Called from demo-smoke.js with the captured governance output (lives
 * here only to keep demo-smoke.js under 500 lines).
 */
async function checkDelegationLines(state, output, failures) {
  const vgt = state.getContract("governanceToken");
  const lines = output.match(/delegate: .*\(recorded, not counted: D12\)/g);
  if (!vgt || !lines || lines.length !== 5) {
    failures.push(
      `option 80 printed ${lines ? lines.length : 0} D12 delegation lines, expected 5`,
    );
    return;
  }
  for (let i = 0; i < 5; i++) {
    const a = state.signers[i].address;
    const delIn = (await vgt.getVotingPower(a)) - (await vgt.balanceOf(a));
    if ((await vgt.getDelegate(a)) !== ethers.ZeroAddress || delIn !== 0n)
      failures.push(`signer ${i} has a VGT delegation the smoke never made`);
    else if (!/delegate: none, delegated-in: 0\.0 VGT/.test(lines[i]))
      failures.push(
        `option 80 D12 line ${i} disagrees with chain: ${lines[i]}`,
      );
  }
}

module.exports = { runHandoverSmoke, checkDelegationLines };
