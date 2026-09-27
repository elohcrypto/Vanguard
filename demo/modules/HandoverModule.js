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
} = require("../utils/DisplayHelpers");
const {
  ACCEPTANCE_PLAN,
  handoverDeployerPowers,
  proposeAcceptOwnership,
  castAcceptanceVotes,
  settleProposal,
  assertHandoverComplete,
} = require("../utils/Handover");
const { ethers } = require("hardhat");

/** ACCEPTANCE_PLAN key -> DemoState contract key. */
const STATE_KEY = {
  token: "digitalToken",
  governanceToken: "governanceToken",
  identityRegistry: "identityRegistry",
  complianceRules: "complianceRules",
  oracleManager: "oracleManager",
  governance: "vanguardGovernance",
};

/** Wallet indices from docs/TESTNET_DEMO.md (multisigs on Sepolia). */
const OPS_INDEX = 10;
const GUARDIAN_INDEX = 11;

const same = (a, b) => a.toLowerCase() === b.toLowerCase();

class HandoverModule {
  constructor(state, logger, promptUser) {
    this.state = state;
    this.logger = logger;
    this.promptUser = promptUser;
  }

  /** Everything the ceremony reads from state; null (after a message) if incomplete. */
  _ceremonyArgs() {
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
    if (!ops || !guardian) {
      displayError(
        `Handover needs wallets ${OPS_INDEX} (ops) and ${GUARDIAN_INDEX} (guardian); only ${s.signers.length} loaded`,
      );
      return null;
    }
    const pick = (keys) =>
      keys.map((k) => s.getContract(k)).filter((c) => Boolean(c));
    return {
      deployer: s.signers[0],
      ops,
      guardian,
      governance: s.getContract("vanguardGovernance"),
      token: s.getContract("digitalToken"),
      governanceToken: s.getContract("governanceToken"),
      identityRegistry: s.getContract("identityRegistry"),
      complianceRules: s.getContract("complianceRules"),
      oracleManager: s.getContract("oracleManager"),
      investorTypeRegistry: s.getContract("investorTypeRegistry") || undefined,
      oracles: pick(["whitelistOracle", "blacklistOracle", "consensusOracle"]),
      issuers: pick(["kycIssuer", "amlIssuer"]),
    };
  }

  /** Option 83c */
  async handoverStep1() {
    displaySection(
      "HANDOVER STEP 1: DEPLOYER GRANTS OPS/GUARDIAN, NOMINATES GOVERNANCE",
      "🔑",
    );
    const args = this._ceremonyArgs();
    if (!args) return;
    console.log(`   Deployer: ${args.deployer.address} (wallet 0)`);
    console.log(`   Ops:      ${args.ops.address} (wallet ${OPS_INDEX})`);
    console.log(
      `   Guardian: ${args.guardian.address} (wallet ${GUARDIAN_INDEX})`,
    );
    console.log(`   Governance: ${await args.governance.getAddress()}`);
    try {
      const report = await handoverDeployerPowers(args);
      displaySuccess("DEPLOYER POWERS HANDED OVER; GOVERNANCE NOMINATED");
      for (const r of report.registryProposals) {
        console.log(`   ⚠️  still needs a type-0 proposal: ${r.label}`);
      }
      console.log(
        "   💡 Next: 83d (governance accepts by vote), then 83e (verify)",
      );
    } catch (error) {
      displayError(`Handover step 1 failed: ${error.message}`);
    }
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
    for (const e of ACCEPTANCE_PLAN) {
      const c = this.state.getContract(STATE_KEY[e.key]);
      if (!c) {
        summary.push(`   ⚠️  ${e.label}: not deployed`);
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
      if (!done) break; // the refusal applies to every remaining vote too
    }
    console.log("\n📋 OWNERSHIP BEFORE -> AFTER:");
    summary.forEach((l) => console.log(l));
  }

  /** Option 83e */
  async verifyHandover() {
    displaySection("HANDOVER STEP 3: VERIFY THE DEPLOYER HOLDS NO POWER", "🔍");
    const args = this._ceremonyArgs();
    if (!args) return;
    try {
      const { ok, checks } = await assertHandoverComplete(args);
      for (const c of checks)
        console.log(`   ${c.ok ? "✅" : "❌"} ${c.label}`);
      console.log(
        ok
          ? "\n   ✅ Handover complete: the deployer holds no power."
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
    const governanceToken = this.state.getContract("governanceToken");
    const identityRegistry = this.state.getContract("identityRegistry");
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
        displayError(
          `This governance was deployed against a different ${label}.`,
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

      // Quorum is a share of registered identities.
      const eligible = await identityRegistry.registeredIdentityCount();
      const t = await vanguardGovernance.proposalThresholds(proposalType);
      const quorumPct = Number(t.quorumPercentage) / 100;
      const needed = Math.ceil((Number(eligible) * quorumPct) / 100);
      console.log(`\n🗳️  VOTE REQUIREMENTS (${typeName}):`);
      console.log(`   Eligible voters: ${eligible}`);
      console.log(`   Quorum:   ${quorumPct}% → at least ${needed} vote(s)`);
      console.log(
        `   Approval: ${Number(t.approvalPercentage) / 100}% of votes cast must be FOR`,
      );

      // Report the two prerequisites SEPARATELY: after a bare deploy the
      // eligible-voter set is usually just the governance contract itself,
      // so "no VGT" is the wrong diagnosis — verified identities are missing.
      const proposalCost = await vanguardGovernance.proposalCreationCost();
      const voteCost = await vanguardGovernance.votingCost();
      const verifiedHumans = [];
      const usable = [];
      for (let i = 0; i < Math.min(10, this.state.signers.length); i++) {
        const s = this.state.signers[i];
        if (same(s.address, govAddr)) continue;
        if (!(await identityRegistry.isVerified(s.address))) continue;
        verifiedHumans.push(s);
        const bal = await governanceToken.balanceOf(s.address);
        if (bal >= proposalCost + voteCost) usable.push(s);
      }
      console.log(
        `   Verified signers: ${verifiedHumans.length} | holding enough VGT: ${usable.length}`,
      );

      if (usable.length < 2) {
        displayError(
          `Need a proposer plus at least one other voter (found ${usable.length} usable).`,
        );
        if (verifiedHumans.length < 2) {
          console.log(
            `   ⚠️  Only ${verifiedHumans.length} verified signer(s). Voting requires KYC/AML identities.`,
          );
          console.log(
            "   💡 Run option 23 (Investor Onboarding) or 24 (Create Normal Users) first,",
          );
          console.log(
            "      then options 3 and 4 to issue KYC/AML claims to those signers.",
          );
        } else {
          console.log(
            `   ⚠️  ${verifiedHumans.length} signer(s) are verified but hold under ${ethers.formatEther(proposalCost + voteCost)} VGT.`,
          );
          console.log(
            "   💡 Use option 75a to mint VGT, then 75 or 75b to distribute it to them.",
          );
        }
        return false;
      }

      const proposer = usable[0];
      const voters = usable.slice(1); // the proposer may not vote on its own proposal
      if (voters.length < needed) {
        displayError(
          `Only ${voters.length} eligible voter(s) besides the proposer; quorum needs ${needed}.`,
        );
        return false;
      }

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
