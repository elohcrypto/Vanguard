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

/** Every voter votes yes; one that already voted (a re-run) is skipped. */
async function castAcceptanceVotes(governance, proposalId, voters) {
  const vgt = await vgtOf(governance);
  const govAddr = await governance.getAddress();
  const cost = await governance.votingCost();
  for (const v of voters) {
    if (await governance.hasVoted(proposalId, await addrOf(v))) continue;
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

const ACTIVE = 1;

/**
 * Whether proposal `p` clears its type's quorum and approval with the
 * votes cast, as executeProposal judges it (review M-1: in the execution
 * delay canExecute is false for a passing proposal too).
 */
async function passes(governance, p) {
  const t = await governance.proposalThresholds(p.proposalType);
  const total = p.votesFor + p.votesAgainst;
  const eligible = p.eligibleVotersAtCreation;
  return (
    total > 0n &&
    eligible > 0n &&
    total * 10000n >= eligible * t.quorumPercentage &&
    (p.votesFor * 10000n) / total >= t.approvalPercentage
  );
}

/**
 * Every Active proposal `proposer` made: { id, p, live }. Live: still
 * voting, or its vote over and passing (waiting for, or past, its
 * execution delay); otherwise it ended without passing.
 */
async function proposalsBy(governance, proposer) {
  const pAddr = await addrOf(proposer);
  const now = (await ethers.provider.getBlock("latest")).timestamp;
  const out = [];
  for (let id = 1; id <= Number(await governance.proposalCount()); id++) {
    const [p] = await governance.getProposal(id);
    if (!same(p.proposer, pAddr) || Number(p.status) !== ACTIVE) continue;
    const voting = now <= p.votingEnds;
    out.push({ id, p, live: voting || (await passes(governance, p)) });
  }
  return out;
}

/**
 * Task 5.15 (H-1, Q14 = A): `items` ({ label, ok?, title?, proposalType,
 * target, callData, precheck?, verify? }) are proposed together and every
 * voter votes on each (openAll), then they are settled in the given order
 * (settleAll), so the whole set takes one voting period and delay, not one
 * per item. The first that does not pass or execute, or whose precheck
 * throws (read just before it executes), stops the run: those executed
 * stay, and a re-run adopts the proposals still open. Adopted only: the
 * same proposer's proposal of the same type, target and calldata, still
 * voting or passed but not executed; one that ended without passing is
 * settled as Rejected, reported, never adopted.
 */
async function openAll({ governance, proposer, voters, items, log }) {
  const mine = await proposalsBy(governance, proposer);
  const taken = new Set();
  const open = [];
  for (const it of items) {
    const target = await addrOf(it.target);
    const matches = mine.filter(
      (m) =>
        !taken.has(m.id) &&
        Number(m.p.proposalType) === Number(it.proposalType) &&
        same(m.p.target, target) &&
        same(m.p.callData, it.callData),
    );
    const live = matches.filter((m) => m.live).pop();
    // Past its vote without passing: settled (Rejected, deposits
    // refundable) so no open proposal is left on a plan contract.
    for (const m of matches.filter((x) => !x.live)) {
      await send(governance.connect(proposer).executeProposal(m.id));
      log(
        `   ⚠️  proposal #${m.id} (${it.label}) is past its vote without passing: not adopted; settled as ${STATUS[Number((await governance.getProposal(m.id))[0].status)]}, a new one is proposed`,
      );
    }
    let id;
    if (live) {
      id = live.id;
      taken.add(id);
      log(`   ↪️  ${it.label}: proposal #${id} already open; adopted`);
    } else {
      id = await proposeCall(
        governance,
        proposer,
        it.proposalType,
        it.target,
        it.callData,
        it.title || it.label,
      );
    }
    open.push({ ...it, id });
  }
  if (!open.length) return open;
  log(
    `   🗳️  ${open.length} proposal(s) open at once: ${open.map((o) => `#${o.id}`).join(", ")}`,
  );
  for (const o of open) {
    const [p] = await governance.getProposal(o.id);
    if ((await chainNow()) <= p.votingEnds) {
      await module.exports.castAcceptanceVotes(governance, o.id, voters);
    }
  }
  return open;
}

const chainNow = async () =>
  (await ethers.provider.getBlock("latest")).timestamp;

async function settleAll({ governance, proposer, open, log }) {
  if (!open.length) return;
  const [first] = await governance.getProposal(open[0].id);
  for (const o of open) {
    // Through module.exports, so a test can stop the run part-way.
    try {
      if (o.precheck) await o.precheck();
      // R-56c-3: executed by the proposer, never the default wallet 0.
      await module.exports.settleProposal(
        governance.connect(proposer),
        o.id,
        o.label,
      );
    } catch (e) {
      e.message += `; stopped here: proposals settled before it stay, a re-run finishes the rest (${open.length - open.indexOf(o)} left)`;
      throw e;
    }
    if (o.verify) await o.verify();
    log(`   ✅ ${o.ok || o.label} (proposal #${o.id})`);
  }
  log(
    `   ⏱️  ${open.length} proposal(s) settled ${(await chainNow()) - Number(first.createdAt)} s of chain time after #${open[0].id} was created`,
  );
}

/** openAll, then settleAll: the ceremony's acceptances (Q14 = A). */
async function voteAll(args) {
  await settleAll({ ...args, open: await openAll(args) });
}

/**
 * Step 4 for every ACCEPTANCE_PLAN contract nominated to governance, then
 * any queued registry proposals, all in one parallel vote (voteAll).
 * `contracts` maps plan keys to contracts.
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
  const items = [];
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
    items.push({
      label: e.label,
      ok: `${e.label}: owned by governance`,
      title: `Accept ownership of ${e.label}`,
      proposalType: e.proposalType,
      target: c,
      callData: OWNABLE.encodeFunctionData("acceptOwnership"),
      verify: async () =>
        check(
          same(await c.owner(), govAddr),
          `${e.label} owner is not governance after the vote`,
        ),
    });
  }
  for (const r of registryProposals) items.push({ ...r });
  await voteAll({ governance, proposer, voters, items, log });
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
  voteAll,
  openAll,
  settleAll,
  proposeCall,
  proposeAcceptOwnership,
  castAcceptanceVotes,
  settleProposal,
  acceptAllByVote,
  checkVoters,
};
