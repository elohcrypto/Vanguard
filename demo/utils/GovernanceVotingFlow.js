/**
 * @fileoverview Governance options 77-78: vote, execute
 * @module GovernanceVotingFlow
 * @description Casts a vote on a proposal and executes a passed one.
 * Moved out of demo/modules/GovernanceModule.js (plan v2 Task 4.8). Each
 * function takes the module instance `mod` first (its state, promptUser,
 * logger and sibling methods) and runs the option's code unchanged.
 */

const {
  displaySection,
  displaySuccess,
  displayError,
} = require("./DisplayHelpers");
const { walletControlRefusal } = require("./ChainTime");
const { ethers } = require("hardhat");

/** Option 77: Vote on Proposal */
async function voteOnProposal(mod) {
  displaySection("VOTE ON GOVERNANCE PROPOSAL", "✅");

  const vanguardGovernance = mod.state.getContract("vanguardGovernance");
  const governanceToken = mod.state.getContract("governanceToken");

  if (!vanguardGovernance || !governanceToken) {
    displayError("Deploy Governance Token system first (option 74)");
    return;
  }

  try {
    // Show all available proposals
    console.log("\n📋 AVAILABLE PROPOSALS:");
    console.log("=".repeat(60));

    const statusNames = [
      "Pending",
      "Active",
      "Approved",
      "Rejected",
      "Executed",
      "Cancelled",
    ];

    let foundProposals = false;
    const activeProposals = [];

    // Check proposals 1-20
    for (let i = 1; i <= 20; i++) {
      try {
        const result = await vanguardGovernance.getProposal(i);
        const proposal = result[0];

        if (proposal.title && proposal.title.length > 0) {
          foundProposals = true;
          const statusNum = Number(proposal.status);
          const status = statusNames[statusNum];
          const type = mod._proposalTypeName(proposal.proposalType);
          // Votes are counts (votesFor += 1), not token amounts:
          // formatEther would render 3 votes as
          // "0.000000000000000003".
          const votesFor = proposal.votesFor.toString();
          const votesAgainst = proposal.votesAgainst.toString();
          const totalVotes = proposal.votesFor + proposal.votesAgainst;

          let percentage = "";
          if (totalVotes > 0n) {
            const forPct = (
              (Number(proposal.votesFor) * 100) /
              Number(totalVotes)
            ).toFixed(1);
            percentage = ` (${forPct}% FOR)`;
          }

          console.log(`\n${i}. ${proposal.title}`);
          console.log(`   Type: ${type} | Status: ${status}`);
          console.log(
            `   Votes: ${votesFor} FOR, ${votesAgainst} AGAINST${percentage}`,
          );

          if (statusNum === 1) {
            // Active
            activeProposals.push(i);
          }
        }
      } catch (error) {
        break;
      }
    }

    if (!foundProposals) {
      displayError("No proposals found. Create a proposal first (option 76)");
      return;
    }

    if (activeProposals.length === 0) {
      console.log("\n⚠️  No active proposals available for voting");
      console.log(
        "   All proposals are either pending, executed, or cancelled",
      );
      return;
    }

    console.log("\n" + "=".repeat(60));
    console.log(
      `💡 Active proposals you can vote on: ${activeProposals.join(", ")}`,
    );

    const proposalId = await mod.promptUser("\nEnter proposal ID to vote on: ");

    // Get proposal details
    const result = await vanguardGovernance.getProposal(parseInt(proposalId));
    const proposal = result[0];

    console.log("\n📋 PROPOSAL INFO:");
    console.log(`   Title: ${proposal.title}`);
    console.log(`   Status: ${statusNames[Number(proposal.status)]}`);

    // Show who may actually vote: castVote requires isVerified(msg.sender)
    // and a balance covering the voting fee; each eligible voter is worth
    // exactly 1 vote. Voting is not token-weighted and there is no
    // snapshot, so no VGT amount is shown as a weight.
    const idRegistryForVoters = mod.state.getContract("identityRegistry");
    const voteFee = await vanguardGovernance.votingCost();
    // D25: only identities bound at or before this proposal's cutoff vote.
    // Jumping time cannot help: the cutoff is frozen at creation.
    const cutoff = proposal.voterAgeCutoff;

    console.log("\n👥 ELIGIBLE VOTERS (1 vote each):");
    console.log(`   Voting fee: ${ethers.formatEther(voteFee)} VGT`);
    const voters = [];
    for (let i = 0; i < Math.min(10, mod.state.signers.length); i++) {
      const addr = mod.state.signers[i].address;
      const balance = await governanceToken.balanceOf(addr);
      const verified = await idRegistryForVoters.isVerified(addr);
      const canPay = balance >= voteFee;
      const at = verified
        ? await idRegistryForVoters.identityRegisteredAt(
            await idRegistryForVoters.identity(addr),
          )
        : 0n;
      const noControl = verified
        ? await walletControlRefusal(idRegistryForVoters, addr)
        : null;

      if (verified && (at === 0n || at > cutoff)) {
        console.log(
          `${i}. ${addr} - ⚠️ Identity too new to vote: bound after this proposal's cutoff (created minVoterAge after the identity, a new proposal admits it)`,
        );
      } else if (noControl) {
        console.log(`${i}. ${addr} - ⚠️ Wallet ${noControl}`);
      } else if (verified && canPay) {
        console.log(`${i}. ${addr}`);
        console.log(
          `   ✅ Verified, ${ethers.formatEther(balance)} VGT — worth 1 vote`,
        );
        voters.push(i);
      } else if (verified) {
        console.log(
          `${i}. ${addr} - ⚠️ Verified but only ${ethers.formatEther(balance)} VGT (cannot pay fee)`,
        );
      } else if (balance > 0n) {
        console.log(
          `${i}. ${addr} - ⚠️ Holds ${ethers.formatEther(balance)} VGT but NOT KYC/AML verified`,
        );
      }
    }

    if (voters.length === 0) {
      // Eligibility is checked at castVote time, not at proposal creation:
      // a voter funded and verified after the proposal exists may vote.
      // An earlier message here said the opposite ("tokens distributed
      // AFTER proposal creation cannot vote") — verified false on chain.
      displayError("No signer is both verified and able to pay the vote fee");
      console.log("\n💡 SOLUTION:");
      console.log(
        "   1. Verify the signer (KYC) and distribute VGT (option 75)",
      );
      console.log(
        "   2. Then vote — eligibility is checked when the vote is cast",
      );
      return;
    }

    const voterChoice = await mod.promptUser(
      `\nSelect voter (${voters.join(", ")}): `,
    );
    const voterIndex = parseInt(voterChoice);

    if (!voters.includes(voterIndex)) {
      displayError(
        "Invalid voter selection, or that signer is not eligible to vote",
      );
      return;
    }

    const voter = mod.state.signers[voterIndex];
    const voterBalance = await governanceToken.balanceOf(voter.address);

    console.log(`\n🗳️  Voting as: ${voter.address}`);
    console.log(
      `   This vote counts as 1 (fee: ${ethers.formatEther(voteFee)} VGT of ${ethers.formatEther(voterBalance)} VGT held)`,
    );

    const support = await mod.promptUser("\nVote FOR (y) or AGAINST (n): ");
    const reason = await mod.promptUser("Enter reason (optional): ");

    const tx = await vanguardGovernance
      .connect(voter)
      .castVote(
        parseInt(proposalId),
        support.toLowerCase() === "y",
        reason || "",
      );
    await tx.wait();

    displaySuccess("VOTE CAST SUCCESSFULLY!");
    console.log(`   Voter: ${voter.address}`);
    console.log(`   Weight: 1 vote (all verified voters are equal)`);
    console.log(
      `   Support: ${support.toLowerCase() === "y" ? "FOR" : "AGAINST"}`,
    );
  } catch (error) {
    // castVote reverts with "Insufficient tokens for voting" or
    // "Must be KYC/AML verified"; no contract emits "No voting power",
    // so the branch that used to key on it was unreachable.
    displayError(`Voting failed: ${error.message}`);
  }
}

/** Option 78: Execute Proposal */
async function executeProposal(mod) {
  displaySection("EXECUTE GOVERNANCE PROPOSAL", "⚡");

  const vanguardGovernance = mod.state.getContract("vanguardGovernance");
  if (!vanguardGovernance) {
    displayError("Deploy Governance Token system first (option 74)");
    return;
  }

  try {
    // Show all proposals that can be executed
    console.log("\n📋 PROPOSALS READY FOR EXECUTION:");
    console.log("=".repeat(60));

    const statusNames = [
      "Pending",
      "Active",
      "Approved",
      "Rejected",
      "Executed",
      "Cancelled",
    ];

    let foundExecutable = false;
    const executableProposals = [];

    // Check proposals 1-20
    for (let i = 1; i <= 20; i++) {
      try {
        const result = await vanguardGovernance.getProposal(i);
        const proposal = result[0];
        const canExecuteNow = result[3];

        if (proposal.title && proposal.title.length > 0) {
          const statusNum = Number(proposal.status);
          const status = statusNames[statusNum];
          const type = mod._proposalTypeName(proposal.proposalType);
          const votesFor = proposal.votesFor.toString();
          const votesAgainst = proposal.votesAgainst.toString();
          const totalVotes = proposal.votesFor + proposal.votesAgainst;

          let percentage = "";
          if (totalVotes > 0n) {
            const forPct = (
              (Number(proposal.votesFor) * 100) /
              Number(totalVotes)
            ).toFixed(1);
            const againstPct = (
              (Number(proposal.votesAgainst) * 100) /
              Number(totalVotes)
            ).toFixed(1);
            percentage = ` (${forPct}% FOR, ${againstPct}% AGAINST)`;
          }

          // Still finalizable if Active or Approved.
          //
          // Note executeProposal() handles BOTH outcomes: a
          // proposal that passes runs its callData and burns the
          // locked tokens; one that fails is marked Rejected and
          // REFUNDS them. So this list must not be filtered by
          // canExecute — hiding failing proposals would strand
          // every voter's locked VGT with no way to reclaim it.
          // canExecute is shown per-proposal instead.
          if (statusNum === 1 || statusNum === 2) {
            foundExecutable = true;
            executableProposals.push(i);

            const { quorumPct, approvalPct } = await mod._thresholdsFor(
              vanguardGovernance,
              proposal.proposalType,
            );
            const outcome = canExecuteNow
              ? "✅ will PASS — callData executes, tokens burned"
              : `❌ will FAIL thresholds (needs ${quorumPct}% quorum, ${approvalPct}% approval) — deposits become claimable (78a)`;

            console.log(`\n${i}. ${proposal.title}`);
            console.log(`   Type: ${type} | Status: ${status}`);
            console.log(
              `   Votes: ${votesFor} FOR, ${votesAgainst} AGAINST${percentage}`,
            );
            console.log(`   Outcome: ${outcome}`);
          }
        }
      } catch (error) {
        break;
      }
    }

    if (!foundExecutable) {
      displayError("No proposals ready for execution");
      console.log("   Proposals must be Active or Approved to execute");
      return;
    }

    console.log("\n" + "=".repeat(60));
    console.log(`💡 Executable proposals: ${executableProposals.join(", ")}`);

    const proposalId = await mod.promptUser("\nEnter proposal ID to execute: ");

    // Get proposal details
    const result = await vanguardGovernance.getProposal(parseInt(proposalId));
    const proposal = result[0];

    console.log("\n📋 PROPOSAL DETAILS:");
    console.log(`   ID: ${proposalId}`);
    console.log(`   Title: ${proposal.title}`);
    console.log(`   Description: ${proposal.description}`);
    console.log(`   Votes FOR: ${proposal.votesFor}`);
    console.log(`   Votes AGAINST: ${proposal.votesAgainst}`);

    const totalVotes = proposal.votesFor + proposal.votesAgainst;
    if (totalVotes > 0n) {
      const forPercentage = (
        (Number(proposal.votesFor) * 100) /
        Number(totalVotes)
      ).toFixed(2);
      const againstPercentage = (
        (Number(proposal.votesAgainst) * 100) /
        Number(totalVotes)
      ).toFixed(2);
      console.log(`   FOR: ${forPercentage}% | AGAINST: ${againstPercentage}%`);
    }

    // Turnout and thresholds come from the chain so the user knows
    // which outcome executing will produce before they confirm.
    const { quorumPct, approvalPct } = await mod._thresholdsFor(
      vanguardGovernance,
      proposal.proposalType,
    );
    console.log(`   Turnout: ${Number(result[2]) / 100}% of eligible voters`);
    console.log(`   Required: ${quorumPct}% quorum, ${approvalPct}% approval`);
    console.log(
      result[3]
        ? "   Outcome if executed: PASS — callData runs, locked VGT burned 🔥"
        : "   Outcome if executed: FAIL — proposal rejected, each deposit claimable via 78a 💰",
    );

    const confirm = await mod.promptUser("\nExecute this proposal? (y/n): ");
    if (confirm.toLowerCase() !== "y") {
      displayError("Execution cancelled");
      return;
    }

    const tx = await vanguardGovernance.executeProposal(parseInt(proposalId));
    const receipt = await tx.wait();

    // A mined receipt is not a success. executeProposal settles THREE
    // outcomes without reverting: passed and ran (ProposalExecuted),
    // failed a threshold (Rejected, refund, no event), or passed the vote
    // but the target call reverted (ProposalExecutionFailed, refund).
    // Read the outcome from the log, not from the fact that it mined.
    const outcome = { executed: false, failed: null };
    for (const log of receipt.logs) {
      let parsed;
      try {
        parsed = vanguardGovernance.interface.parseLog(log);
      } catch {
        continue;
      }
      if (parsed?.name === "ProposalExecuted") outcome.executed = true;
      if (parsed?.name === "ProposalExecutionFailed")
        outcome.failed = parsed.args.reason;
    }

    if (outcome.executed) {
      displaySuccess("PROPOSAL EXECUTED — callData ran, locked VGT burned");
      // D20: show the expiry a ListUpdate wrote (a date or "never").
      const DynamicListModule = require("../modules/DynamicListModule");
      for (const line of DynamicListModule.listExpiries(mod.state, receipt))
        console.log(`   ${line}`);
    } else if (outcome.failed !== null) {
      let why = outcome.failed;
      try {
        const err = vanguardGovernance.interface.parseError(outcome.failed);
        if (err) why = `${err.name}(${err.args.map(String).join(", ")})`;
      } catch {
        // Not one of governance's own errors; show the raw bytes.
      }
      displayError("PROPOSAL PASSED THE VOTE BUT ITS TARGET CALL REVERTED");
      console.log(`   Reason: ${why}`);
      console.log(
        "   Marked Rejected. Each participant claims their own VGT (option 78a).",
      );
      console.log("   This is terminal — submit a corrected proposal.");
    } else {
      displayError("PROPOSAL REJECTED — thresholds not met");
      console.log(
        "   Each participant claims their own VGT deposit (option 78a).",
      );
    }
    console.log(`   Transaction: ${tx.hash}`);
  } catch (error) {
    displayError(`Execution failed: ${error.message}`);
  }
}

module.exports = { voteOnProposal, executeProposal };
