/**
 * @fileoverview The demo's one voter picker (plan v2 Task 4.7): a proposer
 * plus voters for a governance vote, chosen among the demo wallets 0-9.
 * Used by the handover votes (options 83b, 83d: HandoverModule) and the
 * complete governance workflow (option 82: GovernanceWorkflow.js).
 */

const { ethers } = require("hardhat");
const { displayError } = require("./DisplayHelpers");
const {
  advancePastVoterAge,
  eligibleVotersNow,
  walletControlRefusal,
} = require("./ChainTime");

/** issuerAdmin 9, ops 10, guardian 11 (docs/TESTNET_DEMO.md) never vote. */
const ROLE_WALLETS = [9, 10, 11];

const same = (a, b) => a.toLowerCase() === b.toLowerCase();

/**
 * Verified wallets among 0-9 that may act through their identity: the role
 * wallets and governance itself excluded, in index order.
 */
async function verifiedHumans(state) {
  const gov = state.getContract("vanguardGovernance");
  const idReg = state.getContract("identityRegistry");
  const govAddr = await gov.getAddress();
  const out = [];
  for (let i = 0; i < Math.min(10, state.signers.length); i++) {
    if (ROLE_WALLETS.includes(i)) continue; // review N-3
    const s = state.signers[i];
    if (same(s.address, govAddr)) continue;
    if (!(await idReg.isVerified(s.address))) continue;
    if (await walletControlRefusal(idReg, s.address)) continue;
    out.push(s);
  }
  return out;
}

/**
 * Proposer plus voters for a `proposalType` vote: verified wallets that hold
 * the proposal fee plus the voting fee. Prints the requirements; returns
 * null (after the refusal with its diagnosis) when there are too few.
 * Returns { proposer, voters, needed }: the proposer never votes (the
 * contract refuses "Proposer cannot vote on own proposal"); `needed` is the
 * advisory quorum count.
 */
async function pickVoters(state, proposalType, typeName) {
  const gov = state.getContract("vanguardGovernance");
  const vgt = state.getContract("governanceToken");
  const idReg = state.getContract("identityRegistry");

  // Report the two prerequisites SEPARATELY: missing verified voters and
  // missing VGT are different fixes.
  const stake = (await gov.proposalCreationCost()) + (await gov.votingCost());
  const humans = await verifiedHumans(state);
  const usable = [];
  for (const s of humans) {
    if ((await vgt.balanceOf(s.address)) >= stake) usable.push(s);
  }
  console.log(
    `   Verified signers: ${humans.length} | holding enough VGT: ${usable.length}`,
  );

  if (usable.length < 2) {
    displayError(
      `Need a proposer plus at least one other voter (found ${usable.length} usable).`,
    );
    if (humans.length < 2) {
      console.log(
        `   ⚠️  Only ${humans.length} verified signer(s). Voting requires KYC/AML identities.`,
      );
      console.log(
        "   💡 Run option 23 (Investor Onboarding) or 24 (Create Normal Users) first;",
      );
      console.log(
        "      options 6 and 7 issue KYC/AML claims to any of them still unverified.",
      );
    } else {
      console.log(
        `   ⚠️  ${humans.length} signer(s) are verified but hold under ${ethers.formatEther(stake)} VGT.`,
      );
      console.log(
        "   💡 Option 75a mints VGT to them (a VGT agent signs); 75 distributes from the agent's balance.",
      );
    }
    return null;
  }

  // D25: only identities minVoterAge old propose, vote and count toward
  // quorum. Jumps on a dev node; on a real network waits it out.
  await advancePastVoterAge(gov, idReg, usable);
  const eligible = await eligibleVotersNow(gov, idReg);
  const t = await gov.proposalThresholds(proposalType);
  const quorumPct = Number(t.quorumPercentage) / 100;
  const needed = Math.ceil((Number(eligible) * quorumPct) / 100);
  console.log(`\n🗳️  VOTE REQUIREMENTS (${typeName}):`);
  console.log(`   Eligible voters (identities old enough): ${eligible}`);
  console.log(`   Quorum:   ${quorumPct}% → at least ${needed} vote(s)`);
  console.log(
    `   Approval: ${Number(t.approvalPercentage) / 100}% of votes cast must be FOR`,
  );

  const proposer = usable[0];
  const voters = usable.slice(1); // the proposer may not vote on its own proposal
  if (voters.length < needed) {
    displayError(
      `Only ${voters.length} eligible voter(s) besides the proposer; quorum needs ${needed}.`,
    );
    return null;
  }
  return { proposer, voters, needed };
}

module.exports = { pickVoters, verifiedHumans, ROLE_WALLETS };
