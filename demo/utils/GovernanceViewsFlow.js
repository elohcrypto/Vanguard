/**
 * @fileoverview Governance options 80-81: dashboard, compliance enforcement
 * @module GovernanceViewsFlow
 * @description The governance dashboard and the VSC/VGT compliance enforcement test.
 * Moved out of demo/modules/GovernanceModule.js (plan v2 Task 4.8). Each
 * function takes the module instance `mod` first (its state, promptUser,
 * logger and sibling methods) and runs the option's code unchanged.
 */

"use strict";

const {
  displaySection,
  displaySuccess,
  displayError,
} = require("./DisplayHelpers");
const { ethers } = require("hardhat");
const { PROPOSAL_TYPE_NAMES } = require("./GovernanceProposalFlow");

/** Option 80: Governance Dashboard */
async function showDashboard(mod) {
  displaySection("GOVERNANCE DASHBOARD", "📈");

  const governanceToken = mod.state.getContract("governanceToken");
  const vanguardGovernance = mod.state.getContract("vanguardGovernance");

  if (!governanceToken || !vanguardGovernance) {
    displayError("Deploy Governance Token first (option 74)");
    return;
  }

  try {
    const totalSupply = await governanceToken.totalSupply();
    const ownerBalance = await governanceToken.balanceOf(
      mod.state.signers[0].address,
    );

    console.log("\n🪙 GOVERNANCE TOKEN INFO:");
    console.log(`   Name: Vanguard Governance Token`);
    console.log(`   Symbol: VGT`);
    console.log(`   Total Supply: ${ethers.formatEther(totalSupply)} VGT`);
    console.log(`   Owner Balance: ${ethers.formatEther(ownerBalance)} VGT`);
    // GovernanceToken.getVotingPower() returns a TOKEN BALANCE plus VGT
    // delegated in. No contract reads it for any decision; votes are
    // counted 1 per verified person. Delegation is recorded, not counted
    // (D12 b, wiring after the external audit): each signer below shows
    // its delegate and delegated-in VGT, labelled as such.

    // Get governance parameters
    const proposalCost = await vanguardGovernance.proposalCreationCost();
    const votingCost = await vanguardGovernance.votingCost();
    const proposalCount = await vanguardGovernance.proposalCount();

    console.log("\n⚖️ GOVERNANCE PARAMETERS:");
    console.log("=".repeat(70));
    console.log(
      `   Proposal Creation Cost: ${ethers.formatEther(proposalCost)} VGT`,
    );
    console.log(
      `   Voting Cost: ${ethers.formatEther(votingCost)} VGT per vote`,
    );
    console.log(`   Total Proposals: ${proposalCount}`);

    console.log("\n📊 VOTING SYSTEM:");
    console.log("=".repeat(70));
    console.log("Fair Voting:");
    console.log("   • 1 Person = 1 Vote (Equal for all)");
    console.log("   • Only KYC/AML verified users can vote");
    console.log("   • Passed proposals: Tokens BURNED 🔥");
    console.log("   • Failed proposals: Tokens RETURNED 💰");
    console.log("   • Quorum + approval thresholds vary BY PROPOSAL TYPE");

    const idRegistry = mod.state.getContract("identityRegistry");
    if (idRegistry) {
      const eligibleVoters = await idRegistry.registeredIdentityCount();
      console.log(
        `   • Eligible voters (registered identities): ${eligibleVoters}`,
      );
    }
    console.log("\n   Thresholds (quorum / approval):");
    for (let t = 0; t < PROPOSAL_TYPE_NAMES.length; t++) {
      const { quorumPct, approvalPct } = await mod._thresholdsFor(
        vanguardGovernance,
        t,
      );
      console.log(
        `   • ${PROPOSAL_TYPE_NAMES[t].padEnd(20)} ${quorumPct}% / ${approvalPct}%`,
      );
    }
    console.log("");
    console.log(
      "💡 Note: Token balance shown below is for distribution purposes only.",
    );
    console.log(
      "   Voting power is ALWAYS 1 vote per verified user, regardless of balance.",
    );

    // Show user balances
    const identityRegistry = mod.state.getContract("identityRegistry");
    console.log("\n👥 USER BALANCES & VOTING POWER:");
    console.log("=".repeat(70));
    console.log(
      "💡 Roles below are chain reads (owner(), ownerWallet(), the oracle manager's registry), not the demo's signer plan",
    );
    console.log("");

    for (let i = 0; i < Math.min(5, mod.state.signers.length); i++) {
      const balance = await governanceToken.balanceOf(
        mod.state.signers[i].address,
      );
      const isVerified = await identityRegistry.isVerified(
        mod.state.signers[i].address,
      );

      const roles = await _chainRoles(mod.state, mod.state.signers[i].address);
      const role = ` (chain: ${roles.length ? roles.join(", ") : "no role read"})`;
      console.log(`\nSigner ${i}${role}:`);
      console.log(`   VGT Balance: ${ethers.formatEther(balance)} VGT`);
      // D12 (b): delegation is recorded on VGT, never counted by castVote.
      const addr = mod.state.signers[i].address;
      const del = await governanceToken.getDelegate(addr);
      const delIn = (await governanceToken.getVotingPower(addr)) - balance;
      console.log(
        `   delegate: ${del === ethers.ZeroAddress ? "none" : del}, delegated-in: ${ethers.formatEther(delIn)} VGT (recorded, not counted: D12)`,
      );
      console.log(
        `   Voting Power: ${isVerified ? "1 vote (equal)" : "0 votes (not verified)"}`,
      );
      console.log(
        `   KYC/AML Status: ${isVerified ? "✅ Verified" : "▫️ Not Verified"}`,
      );
    }
  } catch (error) {
    displayError(`Dashboard error: ${error.message}`);
  }
}

/**
 * The roles the chain records for `addr` (option 80): contract owners, the
 * escrow factory's fee wallet, oracle registrations and the emergency flag.
 */
async function _chainRoles(state, addr) {
  const roles = [];
  const same = (a) => a.toLowerCase() === addr.toLowerCase();
  for (const [key, label] of [
    ["digitalToken", "VSC owner"],
    ["governanceToken", "VGT owner"],
    ["vanguardGovernance", "governance owner"],
    ["kycIssuer", "KYC issuer owner"],
    ["amlIssuer", "AML issuer owner"],
  ]) {
    const c = state.getContract(key);
    if (c && same(await c.owner())) roles.push(label);
  }
  const factory = state.getContract("escrowFactory");
  if (factory && same(await factory.ownerWallet()))
    roles.push("escrow fee wallet");
  const om = state.getContract("oracleManager");
  if (om && (await om.isRegisteredOracle(addr))) {
    roles.push(`oracle node ${await om.getOracleName(addr)}`);
    if (await om.isEmergencyOracle(addr)) roles.push("emergency oracle");
  }
  return roles;
}

/** Option 81: Test Compliance Enforcement */
async function testComplianceEnforcement(mod) {
  displaySection("TEST COMPLIANCE ENFORCEMENT (VSC & VGT)", "🔒");

  const digitalToken = mod.state.getContract("digitalToken");
  const governanceToken = mod.state.getContract("governanceToken");

  if (!digitalToken) {
    displayError("Deploy Digital Token (VSC) first (option 21)");
    return;
  }

  if (!governanceToken) {
    displayError("Deploy Governance Token (VGT) first (option 74)");
    return;
  }

  try {
    console.log("\n📊 TESTING COMPLIANCE ENFORCEMENT...");
    console.log("=".repeat(70));

    // The test's two users: wallet 1 (verified by option 61 or 89:1) and
    // wallet 9 (issuerAdmin, never onboarded). Every line below is a chain
    // read or a receipt (R-48-6): a prerequisite this run does not meet
    // is said so (ℹ️, not run), never reported as a failure.
    const deployer = mod.state.signers[0];
    const verifiedUser = mod.state.signers[1];
    const unverifiedUser = mod.state.signers[9];
    const identityRegistry = mod.state.getContract("identityRegistry");
    const isVerified1 = await identityRegistry.isVerified(verifiedUser.address);
    const isVerified9 = await identityRegistry.isVerified(
      unverifiedUser.address,
    );
    const senderOk = await identityRegistry.isVerified(deployer.address);
    const vsc = ethers.parseEther("1000");
    const vscBal = await digitalToken.balanceOf(deployer.address);
    const results = {};

    console.log("\n👤 USER VERIFICATION STATUS (chain):");
    console.log(
      `   Wallet 1, the verified user (${verifiedUser.address.slice(0, 10)}...): ${isVerified1 ? "✅ VERIFIED" : "ℹ️  NOT VERIFIED (prerequisite: option 61 or 89:1 onboards it)"}`,
    );
    console.log(
      `   Wallet 9, the unverified user (${unverifiedUser.address.slice(0, 10)}...): ${isVerified9 ? "ℹ️  VERIFIED (prerequisite: the blocked tests need it unverified)" : "✅ NOT VERIFIED"}`,
    );
    const need1 = isVerified1 ? [] : ["wallet 1 is not KYC/AML verified"];
    const need9 = isVerified9 ? ["wallet 9 is verified: nothing to block"] : [];
    const needSender = [
      ...(senderOk ? [] : ["the deployer (wallet 0) is not verified"]),
      ...(vscBal >= vsc ? [] : ["the deployer holds under 1000 VSC"]),
    ].map((m) => `${m} (options 22 and 25 onboard and fund the issuer)`);
    const reasonOf = (e) => e.reason ?? e.shortMessage ?? e.message;

    console.log("\n" + "=".repeat(70));
    console.log("PART 1: VSC TRANSFER CONTROL");
    console.log("=".repeat(70));
    await _step(
      "TEST 1.1: VSC transfer to verified user",
      [...needSender, ...need1],
      async () => {
        await (await digitalToken.transfer(verifiedUser.address, vsc)).wait();
        const balance = await digitalToken.balanceOf(verifiedUser.address);
        console.log(`   ✅ SUCCESS: Transferred 1000 VSC to verified user`);
        console.log(`   Balance: ${ethers.formatEther(balance)} VSC`);
      },
      results,
      "vscAllowed",
    );
    await _step(
      "TEST 1.2: VSC transfer to unverified user (should FAIL)",
      [...needSender, ...need9],
      () =>
        _expectRefusal(
          digitalToken.transfer(unverifiedUser.address, vsc),
          reasonOf,
        ),
      results,
      "vscBlocked",
    );

    console.log("\n" + "=".repeat(70));
    console.log("PART 2: VGT TRANSFER CONTROL");
    console.log("=".repeat(70));
    const vgt = ethers.parseEther("5000");
    const canDistribute =
      (await governanceToken.owner()).toLowerCase() ===
        deployer.address.toLowerCase() ||
      (await governanceToken.isAgent(deployer.address));
    const needVgt = [
      ...(canDistribute ? [] : ["the deployer is neither VGT owner nor agent"]),
      ...((await governanceToken.balanceOf(deployer.address)) >= vgt
        ? []
        : ["the deployer holds under 5000 VGT (option 75a mints)"]),
    ];
    await _step(
      "TEST 2.1: VGT distribution to verified user",
      [...needVgt, ...need1],
      async () => {
        await (
          await governanceToken.distributeGovernanceTokens(
            [verifiedUser.address],
            [vgt],
          )
        ).wait();
        const balance = await governanceToken.balanceOf(verifiedUser.address);
        console.log(`   ✅ SUCCESS: Distributed 5000 VGT to verified user`);
        console.log(`   Balance: ${ethers.formatEther(balance)} VGT`);
      },
      results,
      "vgtAllowed",
    );
    const vgtBal1 = await governanceToken.balanceOf(verifiedUser.address);
    await _step(
      "TEST 2.2: VGT transfer to unverified user (should FAIL)",
      [
        ...need1,
        ...(vgtBal1 >= ethers.parseEther("100")
          ? []
          : ["wallet 1 holds under 100 VGT"]),
        ...need9,
      ],
      () =>
        _expectRefusal(
          governanceToken
            .connect(verifiedUser)
            .transfer(unverifiedUser.address, ethers.parseEther("100")),
          reasonOf,
        ),
      results,
      "vgtBlocked",
    );

    console.log("\n" + "=".repeat(70));
    console.log("PART 3: VGT VOTING CONTROL");
    console.log("=".repeat(70));
    // Voting eligibility is NOT a token balance. castVote requires
    // identityRegistry.isVerified(msg.sender) (the real gate) and a balance
    // covering votingCost (the fee); each verified voter counts as 1 vote.
    // TEST 3.2 reads isVerified, not a balance: the unverified user holds
    // 0 VGT too, so a balance check would pass for that reason alone.
    const governanceForVoting = mod.state.getContract("vanguardGovernance");
    const votingFee = governanceForVoting
      ? await governanceForVoting.votingCost()
      : 0n;
    const verifiedBal = await governanceToken.balanceOf(verifiedUser.address);
    const unverifiedBal = await governanceToken.balanceOf(
      unverifiedUser.address,
    );
    console.log(
      `\n   Voting fee: ${ethers.formatEther(votingFee)} VGT per vote`,
    );
    console.log("\n🧪 TEST 3.1: Verified user may vote");
    console.log(
      `   KYC/AML verified: ${isVerified1 ? "✅ yes" : "ℹ️  no (prerequisite)"}`,
    );
    console.log(
      `   Can pay fee: ${verifiedBal >= votingFee ? "✅ yes" : "ℹ️  no (prerequisite)"} (${ethers.formatEther(verifiedBal)} VGT)`,
    );
    const canVote = isVerified1 && verifiedBal >= votingFee;
    console.log(
      `   ${canVote ? "✅ CAN vote — worth 1 vote" : "ℹ️  CANNOT vote this run: a prerequisite above is missing"}`,
    );
    results.vote = canVote ? "proven" : "skipped";
    console.log("\n🧪 TEST 3.2: Unverified user is blocked by verification");
    console.log(
      `   KYC/AML verified: ${isVerified9 ? "ℹ️  yes (prerequisite: wallet 9 should stay unverified)" : "✅ no"}`,
    );
    console.log(`   VGT balance: ${ethers.formatEther(unverifiedBal)} VGT`);
    console.log(
      `   ${isVerified9 ? "ℹ️  nothing to block this run" : "✅ CANNOT vote — blocked by isVerified, independent of balance"}`,
    );
    results.voteBlocked = isVerified9 ? "skipped" : "proven";

    // Summary: what this run proved, from the receipts and reads above.
    console.log("\n" + "=".repeat(70));
    const glyph = { proven: "✅", skipped: "ℹ️ ", failed: "❌" };
    const word = { proven: "proven", skipped: "not run", failed: "FAILED" };
    const failed = Object.values(results).includes("failed");
    if (failed) displayError("COMPLIANCE ENFORCEMENT TEST: a step FAILED");
    else displaySuccess("COMPLIANCE ENFORCEMENT TEST COMPLETE");
    console.log("=".repeat(70));
    console.log("\n📋 THIS RUN:");
    for (const [key, label] of [
      ["vscAllowed", "VSC transfer to a verified user allowed"],
      ["vscBlocked", "VSC transfer to an unverified user refused"],
      ["vgtAllowed", "VGT distribution to a verified user allowed"],
      ["vgtBlocked", "VGT transfer to an unverified user refused"],
      ["vote", "verified user may vote (isVerified and the fee)"],
      ["voteBlocked", "unverified user cannot vote (isVerified)"],
    ]) {
      const r = results[key];
      console.log(`   ${glyph[r]} ${label}: ${word[r]}`);
    }
  } catch (error) {
    displayError(`Test failed: ${error.message}`);
  }
}

/**
 * Run one test step when every prerequisite holds; otherwise say which is
 * missing (ℹ️, not run). A throw from `fn` is a real failure (❌).
 * @private
 */
async function _step(label, missing, fn, results, key) {
  console.log(`\n🧪 ${label}`);
  if (missing.length) {
    for (const m of missing) console.log(`   ℹ️  Not run: ${m}`);
    results[key] = "skipped";
    return;
  }
  try {
    await fn();
    results[key] = "proven";
  } catch (error) {
    console.log(`   ❌ FAILED: ${error.message}`);
    results[key] = "failed";
  }
}

/** `tx` must revert; its reason is printed. A success is a real failure. */
async function _expectRefusal(tx, reasonOf) {
  let receipt = null;
  try {
    receipt = await (await tx).wait();
  } catch (error) {
    console.log(`   ✅ SUCCESS: Transfer BLOCKED by ComplianceRules`);
    console.log(`   Reason: ${reasonOf(error)}`);
    return;
  }
  throw new Error(
    `transfer succeeded (tx ${receipt.hash}): the gate did not refuse`,
  );
}

module.exports = { showDashboard, testComplianceEnforcement };
