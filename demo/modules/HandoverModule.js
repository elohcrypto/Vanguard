/**
 * @fileoverview Handover ceremony module
 * @module HandoverModule
 * @description Menu options 83c/83d/83e (plan v2 Task 2C.1) and the one
 * accept-ownership-by-vote flow that option 83b also uses. The ceremony
 * itself lives in demo/utils/Handover.js, shared with scripts/handover.ts,
 * the demo smoke and test/production/Handover.test.ts.
 */

const {
  displaySection,
  displaySuccess,
  displayError,
  displayWarning,
} = require("../utils/DisplayHelpers");
const {
  ACCEPTANCE_PLAN,
  findStrays,
  handoverDeployerPowers,
  proposeCall,
  proposeAcceptOwnership,
  castAcceptanceVotes,
  settleProposal,
  assertHandoverComplete,
} = require("../utils/Handover");
const { pickVoters } = require("../utils/VoterPicker");
const { attestorPublicKey } = require("../../scripts/zk/attest");

/** ACCEPTANCE_PLAN key -> DemoState contract key. */
const STATE_KEY = {
  token: "digitalToken",
  governanceToken: "governanceToken",
  identityRegistry: "identityRegistry",
  complianceRules: "complianceRules",
  oracleManager: "oracleManager",
  dynamicListManager: "dynamicListManager",
  investorTypeRegistry: "investorTypeRegistry",
  escrowWalletFactory: "escrowFactory",
  onchainIDFactory: "onchainIDFactory",
  privacyManager: "privacyManager",
  zkVerifier: "zkVerifierIntegrated",
  governance: "vanguardGovernance",
};

/** Wallet indices from docs/TESTNET_SETUP.md (multisigs on Sepolia). */
const OPS_INDEX = 10;
const GUARDIAN_INDEX = 11;
// Owns the claim issuers the deployer holds; never ops (2F.5, D25 b).
const ISSUER_ADMIN_INDEX = 9;

const same = (a, b) => a.toLowerCase() === b.toLowerCase();

class HandoverModule {
  constructor(state, logger, promptUser) {
    this.state = state;
    this.logger = logger;
    this.promptUser = promptUser;
  }

  /**
   * Everything the ceremony reads from state; null (after a message) if
   * incomplete. Task 4.13 (R-413-9): the demo acknowledges what it
   * created itself, the nodes options 31/32 registered (state.oracleConfig)
   * and the attestor key option 1 trusted (state.attestorKey); anything
   * else registered or trusted on chain is still refused.
   */
  async _ceremonyArgs() {
    const s = this.state;
    const missing = [
      ["vanguardGovernance", "74"],
      ["digitalToken", "21"],
      ["governanceToken", "74"],
      ["identityRegistry", "1"],
      ["complianceRules", "1"],
      ["oracleManager", "31"],
    ].filter(([k]) => !s.getContract(k));
    if (missing.length) {
      displayError(
        `Handover needs ${missing.map(([k, o]) => `${k} (option ${o})`).join(", ")}`,
      );
      return null;
    }
    const ops = s.signers[OPS_INDEX];
    const guardian = s.signers[GUARDIAN_INDEX];
    const issuerAdmin = s.signers[ISSUER_ADMIN_INDEX];
    if (!ops || !guardian || !issuerAdmin) {
      displayError(
        `Handover needs wallets ${ISSUER_ADMIN_INDEX} (issuerAdmin), ${OPS_INDEX} (ops) and ${GUARDIAN_INDEX} (guardian); only ${s.signers.length} loaded`,
      );
      return null;
    }
    const pick = (keys) =>
      keys.map((k) => s.getContract(k)).filter((c) => Boolean(c));
    // Log scans start at option 1's first deploy (review M-3, Task 4.13).
    let fromBlock = s.deployStartBlock ?? s.identityRegistryDeployBlock;
    if (fromBlock === undefined && s.complianceRulesDeployBlock !== undefined) {
      fromBlock = s.complianceRulesDeployBlock;
      displayWarning(
        `IdentityRegistry deploy block not recorded: scanning from the ComplianceRules deploy (block ${fromBlock}); a registry agent added before it would be missed`,
      );
    }
    const oracleNodes = [...s.oracleConfig.values()].map((x) => x.address);
    const attestors = s.attestorKey
      ? [(await attestorPublicKey(s.attestorKey)).Ax.toString()]
      : [];
    return {
      fromBlock,
      oracleNodes,
      attestors,
      extraTrusted: [],
      // Task 4.17 (D54): the owner fee wallet option 61 gives the escrow
      // factory (EscrowSetupFlow: wallet 1), acknowledged when it exists.
      feeWallets:
        s.getContract("escrowFactory") && s.signers[1]
          ? [s.signers[1].address]
          : [],
      snapshot: s.handoverSnapshot,
      deployer: s.signers[0],
      ops,
      guardian,
      issuerAdmin,
      governance: s.getContract("vanguardGovernance"),
      token: s.getContract("digitalToken"),
      governanceToken: s.getContract("governanceToken"),
      identityRegistry: s.getContract("identityRegistry"),
      complianceRules: s.getContract("complianceRules"),
      oracleManager: s.getContract("oracleManager"),
      investorTypeRegistry: s.getContract("investorTypeRegistry") || undefined,
      // Optional: only when option 84 deployed it.
      dynamicListManager: s.getContract("dynamicListManager") || undefined,
      // Optional (2F.5): option 60 / option 1 deploy them.
      escrowWalletFactory: s.getContract("escrowFactory") || undefined,
      onchainIDFactory: s.getContract("onchainIDFactory") || undefined,
      // Optional (3.3): option 1 deploys them (option 41 when run alone);
      // a testingMode verifier is refused by the preflight.
      privacyManager: s.getContract("privacyManager") || undefined,
      zkVerifier: s.getContract("zkVerifierIntegrated") || undefined,
      // 4.2/4.11: option 1 pins this KeyManager on the OnchainIDFactory,
      // so it must be named (it holds no power; nothing is handed over).
      keyManager: s.getContract("keyManager") || undefined,
      // Option 12's demo identity authorizes it (as in the demo smoke).
      keyManagerIdentity: s.keyLifecycle?.identity,
      // ConsensusOracle is the manager's ownerless engine (4.4), not here.
      oracles: pick(["whitelistOracle", "blacklistOracle"]),
      issuers: pick(["kycIssuer", "amlIssuer"]),
    };
  }

  /** Option 83c */
  async handoverStep1() {
    displaySection(
      "HANDOVER STEP 1: DEPLOYER GRANTS OPS/GUARDIAN, NOMINATES GOVERNANCE",
      "🔑",
    );
    const args = await this._ceremonyArgs();
    if (!args) return;
    console.log(`   Deployer: ${args.deployer.address} (wallet 0)`);
    console.log(`   Ops:      ${args.ops.address} (wallet ${OPS_INDEX})`);
    console.log(
      `   Guardian: ${args.guardian.address} (wallet ${GUARDIAN_INDEX})`,
    );
    console.log(
      `   Issuer admin: ${args.issuerAdmin.address} (wallet ${ISSUER_ADMIN_INDEX})`,
    );
    console.log(`   Governance: ${await args.governance.getAddress()}`);
    console.log(
      `   Acknowledged: ${args.oracleNodes.length} node(s), ${args.attestors.length} attestor key(s), ${args.extraTrusted.length} extra trusted`,
    );
    try {
      if (!(await this._removeStrays(args))) return;
      const report = await handoverDeployerPowers(args);
      displaySuccess("DEPLOYER POWERS HANDED OVER; GOVERNANCE NOMINATED");
      // 83e compares the completion with what the preflight found.
      this.state.handoverSnapshot = report.snapshot;
      // Governance owns the registry (83b ran first): 83d votes these.
      this.state.handoverRegistryProposals = report.registryProposals;
      for (const r of report.registryProposals) {
        console.log(`   ⚠️  queued for 83d (type-0 proposal): ${r.label}`);
      }
      console.log(
        "   💡 Next: 83d (governance accepts by vote), then 83e (verify)",
      );
    } catch (error) {
      // A preflight refusal is the gate working, not a failure (R-48-6).
      if (/^Handover: /.test(error.message)) {
        console.log(`   ⛔ Handover refused: ${error.message.slice(10)}`);
      } else displayError(`Handover step 1 failed: ${error.message}`);
    }
  }

  /**
   * Task 4.13 (R-413-4): the preflight refuses every stray grant; the
   * demo, as the operator's console, lists them and offers to send the
   * owner call for each as the deployer. Returns false when the operator
   * declines (the preflight would refuse) or a removal fails.
   */
  async _removeStrays(args) {
    const strays = await findStrays(args);
    if (!strays.length) return true;
    console.log(
      `\n   ⛔ ${strays.length} stray grant(s) the preflight refuses:`,
    );
    for (const x of strays) console.log(`      - ${x.what}`);
    const a = await this.promptUser(
      `   Remove them now as the deployer (${strays.length} transaction(s))? (y/N): `,
    );
    if (!/^y(es)?$/i.test(a)) {
      displayWarning(
        "Left in place: 83c would be refused until they are removed",
      );
      return false;
    }
    const gov = this.state.getContract("vanguardGovernance");
    const govAddr = (await gov.getAddress()).toLowerCase();
    const reg = this.state.getContract("investorTypeRegistry");
    const regAddr = reg ? (await reg.getAddress()).toLowerCase() : null;
    const queued = [];
    for (const x of strays) {
      const target = (await x.on.getAddress()).toLowerCase();
      // L-8: governance already owns the registry (83b ran): a type-0 vote.
      if (target === regAddr && (await reg.owner()).toLowerCase() === govAddr) {
        queued.push({
          label: `remove ${x.what}`,
          proposalType: 0,
          target: await x.on.getAddress(),
          callData: x.on.interface.encodeFunctionData(x.fn, x.args),
        });
        console.log(`   🗳️  queued as an InvestorTypeConfig vote: ${x.what}`);
        continue;
      }
      await (await x.on.connect(this.state.signers[0])[x.fn](...x.args)).wait();
      console.log(`   ✅ removed as the deployer: ${x.what}`);
    }
    if (queued.length) {
      this.state.handoverRegistryProposals = queued;
      await this._settleRegistryProposals(gov);
      if ((this.state.handoverRegistryProposals || []).length) return false;
    }
    return true;
  }

  /** Option 83d */
  async acceptAllOwnershipByVote() {
    displaySection(
      "HANDOVER STEP 2: GOVERNANCE ACCEPTS OWNERSHIP BY VOTE",
      "🏛️",
    );
    const gov = this.state.getContract("vanguardGovernance");
    if (!gov) {
      displayError("Deploy the governance system (option 74) first");
      return;
    }
    const govAddr = await gov.getAddress();
    const summary = [];
    let refused = false;
    for (const e of ACCEPTANCE_PLAN) {
      const c = this.state.getContract(STATE_KEY[e.key]);
      if (!c) {
        summary.push(
          `   ⚠️  ${e.label}: not deployed${e.optional ? " (optional)" : ""}`,
        );
        continue;
      }
      const before = await c.owner();
      if (!same(await c.pendingOwner(), govAddr)) {
        summary.push(
          same(before, govAddr)
            ? `   ✅ ${e.label}: already owned by governance`
            : `   ⚠️  ${e.label}: governance not nominated (run 83c)`,
        );
        continue;
      }
      const done = await this.acceptOwnershipByVote({ target: c, ...e });
      summary.push(
        `   ${done ? "✅" : "❌"} ${e.label}: owner ${before} -> ${await c.owner()}`,
      );
      if (!done) {
        refused = true;
        break; // the refusal applies to every remaining vote too
      }
    }
    console.log("\n📋 OWNERSHIP BEFORE -> AFTER:");
    summary.forEach((l) => console.log(l));
    if (!refused) await this._settleRegistryProposals(gov);
  }

  /** Vote through the InvestorTypeRegistry calls 83c queued; clears the list. */
  async _settleRegistryProposals(gov) {
    const queued = this.state.handoverRegistryProposals || [];
    if (queued.length === 0) return;
    console.log(`\n📝 Settling ${queued.length} queued registry proposal(s)`);
    try {
      while (queued.length) {
        const r = queued[0];
        const pick = await pickVoters(
          this.state,
          r.proposalType,
          "InvestorTypeConfig",
        );
        if (!pick) return;
        const id = await proposeCall(
          gov,
          pick.proposer,
          r.proposalType,
          r.target,
          r.callData,
          r.label,
        );
        await castAcceptanceVotes(gov, id, pick.voters);
        await settleProposal(gov, id, r.label);
        console.log(`   ✅ ${r.label} (proposal #${id})`);
        queued.shift();
      }
    } catch (error) {
      displayError(`Registry proposal failed: ${error.message}`);
    }
  }

  /** Option 83e */
  async verifyHandover() {
    displaySection("HANDOVER STEP 3: VERIFY THE DEPLOYER HOLDS NO POWER", "🔍");
    const args = await this._ceremonyArgs();
    if (!args) return;
    // M-1: 83e compares with what 83c's preflight found; a demo restarted
    // between them has no snapshot and cannot prove the chain stood still.
    if (!args.snapshot) {
      console.log(
        "   ⛔ no preflight snapshot in this session: run 83c first (a restart loses it); nothing proves the chain did not change since step 1",
      );
      return;
    }
    try {
      const { ok, checks, warnings, residual } =
        await assertHandoverComplete(args);
      for (const c of checks)
        console.log(`   ${c.ok ? "✅" : "❌"} ${c.label}`);
      for (const w of warnings) console.log(`   ⚠️  ${w}`);
      console.log(
        ok
          ? residual.length
            ? "\n   ⚠️  Handover complete with warnings: see above."
            : "\n   ✅ Handover complete: the deployer holds no power."
          : `\n   ⚠️  Handover incomplete: ${checks.filter((c) => !c.ok).length} check(s) open.`,
      );
    } catch (error) {
      console.log(`   ⚠️  Verification could not read state: ${error.message}`);
    }
  }

  /**
   * Governance takes a contract it was nominated for, by an actual vote.
   * Finds verified VGT-holding signers among wallets 0-9, refuses with a
   * diagnosis when there are too few. Returns true when governance owns it.
   */
  async acceptOwnershipByVote({
    target,
    proposalType,
    label,
    typeName,
    deployHint = "Deploy it BEFORE governance (option 74).",
    nominateHint = "Run option 83c to nominate it first.",
  }) {
    const vanguardGovernance = this.state.getContract("vanguardGovernance");
    try {
      const govAddr = await vanguardGovernance.getAddress();
      const targetAddr = await target.getAddress();
      const ownerNow = await target.owner();
      const pending = await target.pendingOwner();

      console.log(`\n📋 CURRENT OWNERSHIP STATE (${label}):`);
      console.log(`   Contract:      ${targetAddr}`);
      console.log(`   Owner:         ${ownerNow}`);
      console.log(`   Pending owner: ${pending}`);

      const bound = await vanguardGovernance.boundTarget(proposalType);
      if (!same(bound, targetAddr)) {
        // An expected refusal (e.g. 51 run after 74), not an error.
        console.log(
          `⛔ This governance was deployed against a different ${label}.`,
        );
        console.log(`   Bound ${typeName} target: ${bound}`);
        console.log(`   💡 ${deployHint}`);
        return false;
      }
      if (same(ownerNow, govAddr)) {
        console.log(
          `\n   ✅ Governance already owns ${label} — nothing to do.`,
        );
        return true;
      }
      if (!same(pending, govAddr)) {
        displayError(`Governance is not the pending owner. ${nominateHint}`);
        return false;
      }

      const pick = await pickVoters(this.state, proposalType, typeName);
      if (!pick) return false;
      const { proposer, voters } = pick;

      console.log("\n📝 Step 1: Creating the proposal...");
      const proposalId = await proposeAcceptOwnership(
        vanguardGovernance,
        proposer,
        target,
        proposalType,
        label,
      );
      console.log(
        `   ✅ Proposal #${proposalId} created by ${proposer.address}`,
      );

      console.log("\n📝 Step 2: Casting votes...");
      await castAcceptanceVotes(vanguardGovernance, proposalId, voters);
      voters.forEach((v) =>
        console.log(`   ✅ ${v.address} voted FOR (1 vote)`),
      );
      const [, totalVotes, participationBps] =
        await vanguardGovernance.getProposal(proposalId);
      console.log(
        `   Tally: ${totalVotes} vote(s), turnout ${Number(participationBps) / 100}%`,
      );

      console.log("\n📝 Step 3: Ownership BEFORE execution:");
      console.log(`   Owner: ${await target.owner()}`);
      console.log("   ⏳ The vote alone changes nothing.");

      console.log(
        "\n⏰ Step 4: Advancing past the voting period and execution delay, then executing...",
      );
      try {
        await settleProposal(vanguardGovernance, proposalId, label);
      } catch (error) {
        if (error.code !== "NOT_PASSED") throw error;
        displayError(
          "Proposal did not clear quorum/approval — ownership will NOT move.",
        );
        console.log(
          "   This is the gate working: too few voters means no handover.",
        );
        return false;
      }

      const finalOwner = await target.owner();
      displaySuccess("OWNERSHIP TRANSFERRED BY GOVERNANCE VOTE!");
      console.log(`   Owner now:     ${finalOwner}`);
      console.log(`   Pending owner: ${await target.pendingOwner()} (cleared)`);
      const ok = same(finalOwner, govAddr);
      console.log(
        ok
          ? `   ✅ VanguardGovernance owns ${label}`
          : "   ❌ Unexpected owner — handover did not complete",
      );
      return ok;
    } catch (error) {
      displayError(`Ownership handover failed: ${error.message}`);
      return false;
    }
  }
}

module.exports = HandoverModule;
