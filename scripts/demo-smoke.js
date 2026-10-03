#!/usr/bin/env node
/**
 * Non-interactive smoke test of the demo's real deployment path.
 *
 * The interactive demo (`npm run demo:interactive:proof`) exercises code the
 * unit tests do not: ContractDeployer wires contracts together the way an
 * operator would. It cannot run in CI because readline over a non-TTY pipe
 * closes before the first prompt resolves.
 *
 * This drives the same ContractDeployer directly and asserts the wiring is
 * real — reading state back from chain rather than trusting console output.
 *
 * Usage: npx hardhat run scripts/demo-smoke.js --network localhost
 * Exits non-zero on any failure so CI can gate on it.
 */

const { ethers } = require("hardhat");
const DemoState = require("../demo/core/DemoState");
const { attestAll } = require("../demo/utils/Kyc");
const { advancePastVoterAge } = require("../demo/utils/ChainTime");
const ContractDeployer = require("../demo/core/ContractDeployer");
const { EnhancedLogger } = require("../demo/logging");

/** Contracts the demo must have deployed and registered in state. */
const EXPECTED = [
  "onchainIDFactory",
  "kycIssuer",
  "amlIssuer",
  "identityRegistry",
  "complianceRules",
  "digitalToken",
  "oracleManager",
  "whitelistOracle",
  "blacklistOracle",
  "consensusOracle",
  "zkVerifierIntegrated",
  "privacyManager",
];

async function main() {
  const failures = [];

  const state = new DemoState();
  if (state.initialize) await state.initialize();
  state.signers = await ethers.getSigners(); // as demo/index.js does

  const deployer = new ContractDeployer(state, new EnhancedLogger());
  await deployer.deployAllContracts();
  await deployer.deployComplianceRules();

  // The production-compliance guard runs before the Token gets its compliance
  // address: its success line is asserted below, a throw fails the run.
  const deployLog = [];
  const realDeployLog = console.log;
  console.log = (...args) => deployLog.push(args.join(" "));
  try {
    await deployer.deployDigitalTokenSystem();
  } finally {
    console.log = realDeployLog;
  }
  if (!deployLog.some((l) => /reports production-ready/.test(l))) {
    failures.push(
      "compliance guard did not run before Token deployment (no 'reports production-ready' line)",
    );
  }

  await deployer.deployOracleSystem();

  // 1. Every expected contract exists and has code on chain.
  for (const name of EXPECTED) {
    const c = state.getContract(name);
    if (!c) {
      failures.push(`${name}: not registered in demo state`);
      continue;
    }
    const addr = await c.getAddress();
    if ((await ethers.provider.getCode(addr)) === "0x") {
      failures.push(`${name}: no code at ${addr}`);
    }
  }

  // 1b. Both KYC (6) and AML (7) are required claim topics, each with its
  //     trusted issuer wired (plan Task 1R.3). Without this, KYC alone
  //     would still verify a wallet that never had an AML claim issued.
  {
    const identityRegistry = state.getContract("identityRegistry");
    const amlIssuer = state.getContract("amlIssuer");
    const topics = (await identityRegistry.getClaimTopics()).map(Number);
    if (topics.length !== 2 || topics[0] !== 6 || topics[1] !== 7) {
      failures.push(
        `identityRegistry.getClaimTopics() = [${topics.join(", ")}], expected [6, 7]`,
      );
    }
    const amlTrustedIssuers =
      await identityRegistry.getTrustedIssuersForClaimTopic(7);
    const amlIssuerAddr = await amlIssuer.getAddress();
    if (
      !amlTrustedIssuers
        .map((a) => a.toLowerCase())
        .includes(amlIssuerAddr.toLowerCase())
    ) {
      failures.push(
        `getTrustedIssuersForClaimTopic(7) = [${amlTrustedIssuers.join(", ")}], expected to include AML issuer ${amlIssuerAddr}`,
      );
    }
  }

  // 2. The token's dependencies point at the contracts the demo deployed.
  //    This is what the setter/constructor code-length guards protect: a
  //    mis-wired dependency reverts later inside transfer(), not here.
  const token = state.getContract("digitalToken");
  if (token) {
    const checks = [
      ["identityRegistry", await token.identityRegistry(), "identityRegistry"],
      ["compliance", await token.compliance(), null],
    ];
    for (const [label, wired, expectKey] of checks) {
      if ((await ethers.provider.getCode(wired)) === "0x") {
        failures.push(`token.${label}() -> ${wired} has no code`);
      }
      if (expectKey) {
        const expected = await state.getContract(expectKey).getAddress();
        if (wired.toLowerCase() !== expected.toLowerCase()) {
          failures.push(`token.${label}() = ${wired}, expected ${expected}`);
        }
      }
    }

    // 3. The guards reject a non-contract. If this succeeds, a guard regressed.
    const eoa = state.signers[9].address;
    try {
      await token.setIdentityRegistry(eoa);
      failures.push("token.setIdentityRegistry(EOA) succeeded — guard missing");
    } catch {
      /* expected */
    }
  }

  // 3b. Task 2A.1: the one oracle deploy path (ContractDeployer.deployOracleSystem,
  //     now the only implementation) must bind the blacklist oracle into
  //     ComplianceRules for this token.
  const rulesForOracle = state.getContract("complianceRules");
  const blacklistOracleContract = state.getContract("blacklistOracle");
  if (token && rulesForOracle && blacklistOracleContract) {
    const tokenAddr = await token.getAddress();
    const boundOracle = await rulesForOracle.blacklistOracle(tokenAddr);
    const expectedOracle = await blacklistOracleContract.getAddress();
    if (boundOracle.toLowerCase() !== expectedOracle.toLowerCase()) {
      failures.push(
        `rules.blacklistOracle(token) = ${boundOracle}, expected ${expectedOracle}`,
      );
    }
  }

  // 3c. Task 2A.4b: the token-aware compliance marker must be true once
  //     setTokenIdentityRegistry bound a registry for this token
  //     (deployDigitalTokenSystem asserts this too via assertTokenCompliant;
  //     re-read it here as an independent, on-chain confirmation).
  if (token && rulesForOracle) {
    const tokenAddr = await token.getAddress();
    // Overloaded on-chain (isProductionCompliance() and
    // isProductionCompliance(address)); bracket-call to disambiguate, same
    // as test/compliance/FailClosed.test.ts.
    const isProdForToken =
      await rulesForOracle["isProductionCompliance(address)"](tokenAddr);
    if (!isProdForToken) {
      failures.push(
        `rules.isProductionCompliance(token) = false, expected true after setTokenIdentityRegistry`,
      );
    }
  }

  // 4. The governance demo must report facts read from the chain, not
  //    literals. It previously printed vote COUNTS through formatEther
  //    ("0.000000000000000003 VGT" for 3 votes), "Type: undefined" for
  //    proposal types 6-9, and the hardcoded strings "(70%)", "(30%)",
  //    "Participation: 100%" and "≥51%" regardless of the real tally.
  //
  //    Capture the module's real output and assert those cannot return.
  const GovernanceModule = require("../demo/modules/GovernanceModule");
  const gov = new GovernanceModule(
    state,
    new EnhancedLogger(),
    async () => "n",
  );

  // Deploy the InvestorTypeRegistry BEFORE governance, as option 51 precedes
  // option 74 in the demo. VanguardGovernance binds each proposal type to the
  // contract it governs at construction; a registry deployed afterwards is not
  // the bound InvestorTypeConfig target and every proposal against it reverts
  // TargetNotBoundToType.
  const InvestorTypeRegistry = await ethers.getContractFactory(
    "InvestorTypeRegistry",
  );
  const registry = await InvestorTypeRegistry.deploy();
  await registry.waitForDeployment();
  state.setContract("investorTypeRegistry", registry);

  // Task 2A.2: this script deploys InvestorTypeRegistry directly rather than
  // via InvestorTypeModule.deployInvestorTypeSystem (option 51), so wire it
  // to the token here the same way that module now does at the end of its
  // deploy call.
  if (token) {
    const registryAddr = await registry.getAddress();
    await (await token.setInvestorTypeRegistry(registryAddr)).wait();
    const wiredRegistry = await token.investorTypeRegistry();
    if (wiredRegistry === ethers.ZeroAddress) {
      failures.push(
        "token.investorTypeRegistry() is zero after setInvestorTypeRegistry",
      );
    } else if (wiredRegistry.toLowerCase() !== registryAddr.toLowerCase()) {
      failures.push(
        `token.investorTypeRegistry() = ${wiredRegistry}, expected ${registryAddr}`,
      );
    }
  }

  // D22 (a): the treasury (signer 0) and, for D26, demo-smoke-escrow.js's
  // fee wallets (4, 5) are exempt from investor caps; owner only, so set
  // before governance owns the registry. demo-smoke-escrow.js asserts both.
  for (const w of [0, 4, 5].map((i) => state.signers[i].address))
    await (await registry.setInvestorLimitExempt(w, true)).wait();

  // D21: option 74 must not register governance as an identity, so the
  // quorum denominator is unchanged by deploying it.
  const idRegD21 = state.getContract("identityRegistry");
  const idCountBefore = await idRegD21.registeredIdentityCount();
  let idCountAfterDeploy;
  const captured = [];
  const realLog = console.log;
  console.log = (...args) => captured.push(args.join(" "));
  try {
    await gov.deployGovernanceSystem();
    idCountAfterDeploy = await idRegD21.registeredIdentityCount();
    await gov.showDashboard();
    // testComplianceEnforcement reports voting ELIGIBILITY. It must derive
    // that from isVerified() + the fee, never from a token balance. It is
    // driven here because a detector over output only guards code paths that
    // actually run.
    await gov.testComplianceEnforcement();
  } finally {
    console.log = realLog;
  }
  const output = captured.join("\n");

  // 5. Ownership of InvestorTypeRegistry must move to governance ONLY through
  //    a passed proposal. The registry is Ownable2Step and VanguardGovernance
  //    can only make external calls via executeProposal, so a bare
  //    transferOwnership must leave ownership where it was.
  const govContract = state.getContract("vanguardGovernance");
  if (!govContract) {
    failures.push(
      "vanguardGovernance not registered after deployGovernanceSystem",
    );
  } else {
    const govAddr = await govContract.getAddress();
    const deployerAddr = state.signers[0].address;

    // D21: governance holds VGT fees as a trusted contract with no identity.
    if (idCountAfterDeploy !== idCountBefore) {
      failures.push(
        `registeredIdentityCount went ${idCountBefore} -> ${idCountAfterDeploy} across option 74 — governance must not be registered`,
      );
    }
    if ((await idRegD21.identity(govAddr)) !== ethers.ZeroAddress) {
      failures.push(
        "governance has a registry identity — it must hold fees as a trusted contract (D21)",
      );
    }
    if (!(await rulesForOracle.isTrustedContract(govAddr))) {
      failures.push(
        "governance is not a trusted contract — VGT fee pulls and refunds will revert (D21)",
      );
    }

    await registry.transferOwnership(govAddr);
    if ((await registry.owner()) !== deployerAddr) {
      failures.push(
        "InvestorTypeRegistry ownership moved on transferOwnership alone — Ownable2Step regressed to one-step",
      );
    }
    if ((await registry.pendingOwner()) !== govAddr) {
      failures.push(
        "InvestorTypeRegistry did not record governance as pendingOwner",
      );
    }

    // Give the vote a real electorate: verified identities holding enough VGT
    // to pay the proposal and voting fees. Without this the handover method
    // correctly refuses to proceed (too few eligible voters), which would
    // leave the vote path untested.
    const idReg = state.getContract("identityRegistry");
    const vgt = state.getContract("governanceToken");
    const proposalFee = await govContract.proposalCreationCost();
    const voteFee = await govContract.votingCost();
    const stake = proposalFee + voteFee;
    const OID0 = await ethers.getContractFactory("OnchainID");

    for (let i = 0; i < 4; i++) {
      const s = state.signers[i];
      if (!(await idReg.isVerified(s.address))) {
        // A real OnchainID is required: isVerified() reads claims off the
        // identity contract, and registration alone no longer verifies.
        // Both KYC and AML topics are required (Task 1R.3).
        const id = await OID0.deploy(s.address);
        await idReg.registerIdentity(s.address, await id.getAddress(), 840);
        await attestAll(state, await id.getAddress(), `voter:${i}`);
      }
      if ((await vgt.balanceOf(s.address)) < stake) {
        await vgt.distributeGovernanceTokens([s.address], [stake * 2n]);
      }
    }

    // Drive the real vote-driven handover.
    const ownershipLog = [];
    const realLog2 = console.log;
    console.log = (...args) => ownershipLog.push(args.join(" "));
    try {
      await gov.acceptRegistryOwnershipByVote();
    } finally {
      console.log = realLog2;
    }

    const finalOwner = await registry.owner();
    if (finalOwner !== govAddr) {
      failures.push(
        `governance did not take ownership by vote (owner is ${finalOwner}); output: ${ownershipLog.join(" | ").slice(0, 300)}`,
      );
    }

    // The quorum denominator counts voters only: every registration so far
    // is a signer (governance is trusted, not registered).
    let signerIds = 0n;
    for (const s of state.signers) {
      if ((await idReg.identity(s.address)) !== ethers.ZeroAddress) signerIds++;
    }
    const idCount = await idReg.registeredIdentityCount();
    if (idCount !== signerIds) {
      failures.push(
        `registeredIdentityCount = ${idCount}, expected ${signerIds} (registered signers) — something other than a voter is registered`,
      );
    }
  }

  if (output.length === 0) {
    failures.push("governance demo produced no output to check");
  }

  // formatEther on a vote count yields a long fractional-wei string.
  if (/0\.0{15}\d/.test(output)) {
    failures.push(
      "governance output contains a fractional-wei value — a vote count is being formatted with formatEther",
    );
  }
  if (output.includes("undefined")) {
    failures.push(
      "governance output contains 'undefined' — a lookup table is shorter than the on-chain enum",
    );
  }
  for (const literal of ["≥51%", "<51%", "Participation: 100%"]) {
    if (output.includes(literal)) {
      failures.push(
        `governance output contains the hardcoded literal "${literal}" — it must be read from the chain`,
      );
    }
  }
  // Positive check: real thresholds are being read and rendered.
  if (!/\d+% quorum/.test(output)) {
    failures.push(
      "governance output never shows a quorum percentage read from proposalThresholds()",
    );
  }

  // Voting weight must never be shown as a VGT amount. Every verified voter
  // is worth exactly 1 vote; GovernanceToken.getVotingPower() returns a token
  // balance from an abandoned token-weighted design. (The snapshot API that
  // once sat beside it has been removed; the second check below stays as a
  // regression guard against the wording coming back.)
  if (/Voting Power[^\n]*VGT/.test(output)) {
    failures.push(
      "governance output shows voting weight as a VGT amount — votes are 1 per verified person, not token-weighted",
    );
  }
  if (/[Ss]napshot VGT/.test(output)) {
    failures.push(
      "governance output shows a 'Snapshot VGT' value — snapshots hold no historical balance",
    );
  }

  // 6. The rewritten wait handlers must work on a dev node. Governance
  //    option 79 (timeTravel9Days) reads the newest Active proposal's
  //    deadline from chain and jumps past it; the proposal must then
  //    execute. Escrow option 73b (timeTravel14Days) reads
  //    submittedAt + DISPUTE_WINDOW off the wallet the demo recorded and
  //    jumps past it; a payee release must then succeed. Both handlers
  //    used to hardcode evm_increaseTime with fixed day counts. 73b once
  //    read a `.address` field the demo never wrote (it stores
  //    `walletAddress`), which only a driven run could catch — hence this.
  {
    const signers = state.signers;
    const [owner, , , , , , alice, bob, carol] = signers;
    const govC = state.getContract("vanguardGovernance");
    const vgt = state.getContract("governanceToken");
    const idReg = state.getContract("identityRegistry");
    const govAddr2 = await govC.getAddress();
    // Register + fund three investors so a proposal can pass.
    const OID = await ethers.getContractFactory("OnchainID");
    for (const sgn of [alice, bob, carol]) {
      if (!(await idReg.isVerified(sgn.address))) {
        const id = await OID.deploy(sgn.address);
        await idReg.registerIdentity(sgn.address, await id.getAddress(), 840);
        await attestAll(
          state,
          await id.getAddress(),
          `investor:${sgn.address}`,
        );
      }
      if ((await vgt.balanceOf(sgn.address)) < ethers.parseEther("50"))
        await vgt.transfer(sgn.address, ethers.parseEther("100"));
      await vgt.connect(sgn).approve(govAddr2, ethers.MaxUint256);
    }
    // D25: identities propose and vote only once minVoterAge old.
    await advancePastVoterAge(govC, idReg, [alice, bob, carol]);
    // Type must match the target: a proposal against governance itself is
    // SystemParameters (createProposal reverts TargetNotBoundToType otherwise).
    // Governance has no fallback, so empty calldata would fail at execution;
    // call a harmless view so the proposal EXECUTES and 79 can be checked.
    await govC
      .connect(alice)
      .createProposal(
        4,
        "smoke wait",
        "d",
        govAddr2,
        govC.interface.encodeFunctionData("proposalCount"),
      );
    const pid = await govC.proposalCount();
    await govC.connect(bob).castVote(pid, true, "y");
    await govC.connect(carol).castVote(pid, true, "y");
    const yesGov = new GovernanceModule(
      state,
      new EnhancedLogger(),
      async () => "y",
    );
    const l79 = [];
    const rl79 = console.log;
    console.log = (...a) => l79.push(a.join(" "));
    try {
      await yesGov.timeTravel9Days();
    } finally {
      console.log = rl79;
    }
    const [pAfter] = await govC.getProposal(pid);
    const nowTs = (await ethers.provider.getBlock("latest")).timestamp;
    if (!(nowTs > Number(pAfter.executionTime))) {
      failures.push(
        `option 79 did not advance past the proposal deadline; output: ${l79.join(" | ").slice(0, 200)}`,
      );
    } else {
      const rc = await (await govC.executeProposal(pid)).wait();
      const names = rc.logs
        .map((l) => {
          try {
            return govC.interface.parseLog(l)?.name;
          } catch {
            return null;
          }
        })
        .filter(Boolean);
      if (!names.includes("ProposalExecuted"))
        failures.push(
          `after option 79, executeProposal emitted ${names.join(",")} not ProposalExecuted`,
        );
    }

    // Escrow (73b) and mint limits (2E.3) on the real VSC: demo-smoke-escrow.js.
    await require("./demo-smoke-escrow").runEscrowSmoke(state, failures);
  }

  // 7. Plan 2C.1: the handover ceremony, last because it strips the deployer.
  await require("./demo-smoke-handover").runHandoverSmoke(state, failures);

  if (failures.length) {
    console.error(`\n❌ Demo smoke test failed (${failures.length}):`);
    for (const f of failures) console.error(`   - ${f}`);
    process.exit(1);
  }

  console.log(
    `\n✅ Demo smoke test passed: ${EXPECTED.length} contracts deployed and wired.`,
  );
}

main().catch((e) => {
  console.error(`\n❌ Demo smoke test errored: ${e.message.split("\n")[0]}`);
  process.exit(1);
});
