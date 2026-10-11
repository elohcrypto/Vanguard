/**
 * @fileoverview Handover ceremony: the acceptance votes (step 4) and the
 * voter check. Moved out of Handover.js and HandoverChecks.js (plan v2
 * Task 4.13) to keep both under 500 lines; Handover.js re-exports every
 * function callers used before. `proposeCall`, `castAcceptanceVotes` and
 * `settleProposal` are also the demo's one vote path (options 83b/83d,
 * GovernedCalls.js).
 */

const { ethers } = require("hardhat");
const { advancePast } = require("./ChainTime");
const {
  eligibleVotersNow,
  voterAgeRefusal,
  walletControlRefusal,
} = require("./ChainTime");
const {
  addrOf,
  same,
  planFor,
  withBoundRegistry,
  fail,
} = require("./HandoverChecks");
const { withDerivedContracts } = require("./HandoverDerive");

const STATUS = [
  "Pending",
  "Active",
  "Approved",
  "Rejected",
  "Executed",
  "Cancelled",
];
const EXECUTED = 4;

const OWNABLE = new ethers.Interface(["function acceptOwnership()"]);

function check(cond, msg) {
  if (!cond) throw new Error(`Handover: ${msg}`);
}

async function send(p) {
  return (await p).wait();
}

const vgtOf = async (g) =>
  ethers.getContractAt("GovernanceToken", await g.governanceToken());

/**
 * Create a proposal; returns its id. Approves the creation fee first. The
 * description is `${title} (${source})`: callers outside the ceremony name
 * themselves in `source`.
 */
async function proposeCall(
  governance,
  proposer,
  proposalType,
  target,
  callData,
  title,
  source = "handover ceremony",
) {
  const vgt = await vgtOf(governance);
  const govAddr = await governance.getAddress();
  await send(
    vgt
      .connect(proposer)
      .approve(govAddr, await governance.proposalCreationCost()),
  );
  const before = await governance.proposalCount();
  await send(
    governance
      .connect(proposer)
      .createProposal(
        proposalType,
        title,
        `${title} (${source})`,
        await addrOf(target),
        callData,
      ),
  );
  const id = await governance.proposalCount();
  check(id === before + 1n, `proposal for "${title}" was not created`);
  return Number(id);
}

async function proposeAcceptOwnership(
  governance,
  proposer,
  target,
  proposalType,
  label,
) {
  return proposeCall(
    governance,
    proposer,
    proposalType,
    target,
    OWNABLE.encodeFunctionData("acceptOwnership"),
    `Accept ownership of ${label}`,
  );
}

async function castAcceptanceVotes(governance, proposalId, voters) {
  const vgt = await vgtOf(governance);
  const govAddr = await governance.getAddress();
  const cost = await governance.votingCost();
  for (const v of voters) {
    await send(vgt.connect(v).approve(govAddr, cost));
    await send(
      governance.connect(v).castVote(proposalId, true, "Support handover"),
    );
  }
}

/**
 * Wait out voting and the execution delay, then execute. Throws (with
 * err.code "NOT_PASSED" or "NOT_EXECUTED") unless the proposal Executed.
 */
async function settleProposal(
  governance,
  proposalId,
  label = `proposal #${proposalId}`,
) {
  const [p] = await governance.getProposal(proposalId);
  await advancePast(
    p.executionTime > p.votingEnds ? p.executionTime : p.votingEnds,
    `${label}: voting period + execution delay`,
  );
  const [, , , canExecute] = await governance.getProposal(proposalId);
  const fail = (code, why) =>
    Object.assign(
      new Error(`Handover: proposal #${proposalId} (${label}) ${why}`),
      { code },
    );
  if (!canExecute) throw fail("NOT_PASSED", "did not clear quorum/approval");
  await send(governance.executeProposal(proposalId));
  const [after] = await governance.getProposal(proposalId);
  const status = Number(after.status);
  if (status !== EXECUTED) {
    throw fail("NOT_EXECUTED", `settled as ${STATUS[status]}, not Executed`);
  }
  return status;
}

/**
 * Step 4 for every ACCEPTANCE_PLAN contract nominated to governance, then
 * any queued registry proposals. `contracts` maps plan keys to contracts.
 */
async function acceptAllByVote({
  governance,
  contracts,
  proposer,
  voters,
  registryProposals = [],
  log = console.log,
}) {
  const govAddr = await governance.getAddress();
  // Task 4.13: the plan contracts come from governance; a given one is
  // an assertion. An unbound optional registry is left out (preflight
  // warned about it).
  contracts = await withBoundRegistry(
    await withDerivedContracts({ ...contracts, governance }),
  );
  const vote = async (id, label) => {
    await castAcceptanceVotes(governance, id, voters);
    await settleProposal(governance, id, label);
  };
  for (const e of planFor(contracts)) {
    const c = contracts[e.key];
    check(c, `no contract given for ${e.label}`);
    if (same(await c.owner(), govAddr)) {
      log(`   ✅ ${e.label}: already owned by governance`);
      continue;
    }
    check(
      same(await c.pendingOwner(), govAddr),
      `${e.label} has not nominated governance`,
    );
    const id = await proposeAcceptOwnership(
      governance,
      proposer,
      c,
      e.proposalType,
      e.label,
    );
    await vote(id, e.label);
    check(
      same(await c.owner(), govAddr),
      `${e.label} owner is not governance after the vote`,
    );
    log(`   ✅ ${e.label}: owned by governance (proposal #${id})`);
  }
  for (const r of registryProposals) {
    const id = await proposeCall(
      governance,
      proposer,
      r.proposalType,
      r.target,
      r.callData,
      r.label,
    );
    await vote(id, r.label);
    log(`   ✅ ${r.label} (proposal #${id})`);
  }
}

/**
 * The proposer and every voter must be able to pay for `count` proposals
 * before step 1 sends anything: verified, not frozen, and enough free VGT
 * (proposalCreationCost each for the proposer, votingCost each per voter).
 */
async function checkVoters(o, proposer, voters, count) {
  if (count === 0) return;
  const n = BigInt(count);
  const pAddr = await addrOf(proposer);
  const vAddrs = await Promise.all(voters.map(addrOf));
  const dup = vAddrs.find((a, i) => vAddrs.findIndex((b) => same(a, b)) !== i);
  if (dup) fail(`voter ${dup} is listed twice; each wallet votes once`);
  // Quorum as on chain: votes * 10000 >= eligible (aged identities, D25) * quorum.
  const eligible = await eligibleVotersNow(o.governance, o.identityRegistry);
  for (const e of planFor(o)) {
    const q = (await o.governance.proposalThresholds(e.proposalType))
      .quorumPercentage;
    if (BigInt(vAddrs.length) * 10000n < eligible * q) {
      fail(
        `${vAddrs.length} voter(s) cannot reach the ${e.typeName} quorum (${Number(q) / 100}% of ${eligible} registered identities old enough to vote); add voters`,
      );
    }
  }
  // A whitelist oracle on VGT gates the fee transfers of every party.
  const wl = await o.complianceRules.whitelistOracle(
    await addrOf(o.governanceToken),
  );
  const wlOracle = same(wl, ethers.ZeroAddress)
    ? null
    : await ethers.getContractAt(
        ["function isWhitelisted(address) view returns (bool)"],
        wl,
      );
  const need = [
    [pAddr, "proposer", (await o.governance.proposalCreationCost()) * n],
  ];
  const vote = (await o.governance.votingCost()) * n;
  for (const a of vAddrs) {
    if (same(a, pAddr))
      fail(
        `voter ${a} is the proposer; a proposer cannot vote on its own proposal`,
      );
    need.push([a, "voter", vote]);
  }
  const vgt = o.governanceToken;
  for (const [a, role, amount] of need) {
    if (wlOracle && !(await wlOracle.isWhitelisted(a))) {
      fail(
        `${role} ${a} is not on the whitelist oracle bound to VGT (${wl}); its fee transfer would fail`,
      );
    }
    if (!(await o.identityRegistry.isVerified(a))) {
      fail(
        `${role} ${a} is not verified in the IdentityRegistry; governance refuses its ${role === "voter" ? "vote" : "proposal"}`,
      );
    }
    const why =
      (await voterAgeRefusal(o.governance, o.identityRegistry, a)) ||
      (await walletControlRefusal(o.identityRegistry, a));
    if (why) fail(`${role} ${a} ${why}`);
    if (await vgt.isFrozen(a)) fail(`${role} ${a} is frozen on VGT`);
    const free = await vgt.getFreeBalance(a);
    if (free < amount) {
      fail(
        `${role} ${a} holds ${ethers.formatEther(free)} free VGT; ${count} proposal(s) need ${ethers.formatEther(amount)}`,
      );
    }
  }
}

module.exports = {
  proposeCall,
  proposeAcceptOwnership,
  castAcceptanceVotes,
  settleProposal,
  acceptAllByVote,
  checkVoters,
};
