#!/usr/bin/env node
/**
 * Non-interactive smoke test of the demo's real deployment path.
 *
 * The interactive demo (`npm run demo:interactive:proof`) exercises code the
 * unit tests do not: ContractDeployer wires contracts together the way an
 * operator would. It cannot run in CI because readline over a non-TTY pipe
 * closes before the first prompt resolves, and deployment sits behind menu
 * option 1.
 *
 * This drives the same ContractDeployer directly and asserts the wiring is
 * real — reading state back from chain rather than trusting console output.
 *
 * Usage: npx hardhat run scripts/demo-smoke.js --network localhost
 * Exits non-zero on any failure so CI can gate on it.
 */

const { ethers } = require("hardhat");
const DemoState = require("../demo/core/DemoState");
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
];

async function main() {
  const failures = [];

  const state = new DemoState();
  if (state.initialize) await state.initialize();
  // demo/index.js:114 does this; DemoState.initialize() does not.
  state.signers = await ethers.getSigners();

  const deployer = new ContractDeployer(state, new EnhancedLogger());
  await deployer.deployAllContracts();
  await deployer.deployComplianceRules();

  // deployDigitalTokenSystem is the only place a Token receives its compliance
  // address, and it must run the production-compliance guard first. Capture
  // its output so the guard's success line can be asserted below; the guard
  // throwing is caught by main()'s catch and fails the run outright.
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

  const captured = [];
  const realLog = console.log;
  console.log = (...args) => captured.push(args.join(" "));
  try {
    await gov.deployGovernanceSystem();
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
  const InvestorTypeRegistry = await ethers.getContractFactory(
    "InvestorTypeRegistry",
  );
  const registry = await InvestorTypeRegistry.deploy();
  await registry.waitForDeployment();
  state.setContract("investorTypeRegistry", registry);

  const govContract = state.getContract("vanguardGovernance");
  if (!govContract) {
    failures.push(
      "vanguardGovernance not registered after deployGovernanceSystem",
    );
  } else {
    const govAddr = await govContract.getAddress();
    const deployerAddr = state.signers[0].address;

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

    for (let i = 0; i < 4; i++) {
      const s = state.signers[i];
      if (!(await idReg.isVerified(s.address))) {
        // Identity address only needs to be non-zero for the registry.
        await idReg.registerIdentity(s.address, s.address, 840);
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
  // balance from an abandoned token-weighted design, and getVotingPowerAt()
  // is not a real snapshot (nothing writes _votingPowerSnapshots, so it
  // returns the CURRENT balance for any snapshotId).
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
