/**
 * Deep review L-3 and its two security reviews (Task 5.17 slice C): every
 * open removeOracle proposal, anyone's, judged together with this
 * proposer's own (open, or planned for round 2), before each vote and
 * each removal's execution, since executeProposal is permissionless and
 * removeOracle checks no floor: a cancel vote is no guard once a removal
 * has passed (anyone may execute it first).
 *
 * assessRemovals: one group per LIVE node under removal (one node's
 * proposals count once; removing a node that is not registered removes
 * nothing). Hazardous: a FOREIGN removal whose presence turns a safe set
 * into an unsafe one in some order of execution; this proposer's own only
 * when its own set is unsafe alone; fail closed past the first 12 distinct
 * nodes (own first; 2^12 subsets), named so.
 *
 * Holding round 2 (liveness, slice C review H-1: a stranger must not
 * block the rotation with proposals nobody votes for): only a foreign
 * hazard that passes on the votes cast now, still voting or past its vote
 * (then executable by anyone). The old "every uncast vote FOR" estimate
 * held for any unvoted proposal while investors are registered (they
 * count in eligibleVotersAtCreation and never vote), so it is gone. The
 * precheck right before each own removal executes re-assesses this, the
 * real guard against one that starts passing later. A foreign hazard
 * still voting gets this run's votes against only when it passes now or
 * has a FOR vote, and only from voters whose free VGT keeps this run's
 * own proposals paid for: no stranger's spam locks the operator's VGT.
 */
import { ethers } from "hardhat";
import { nodesNow, refusalFor, weightsOf } from "./postCeremonyRemovals";

const Votes = require("../../demo/utils/HandoverVotes");
const { addrOf, same } = require("../../demo/utils/HandoverChecks");

const CAP = 12;
const CAPPED = `beyond the ${CAP} removals checked together: refused (fail closed)`;

/** Every open removeOracle proposal on the manager: [{ id, node, p }]. */
export async function allOpenRemovals(o: any) {
  const gov = o.governance;
  const om = o.oracleManager;
  const target = await addrOf(om);
  const sel = om.interface.getFunction("removeOracle").selector;
  const out = [];
  for (let id = 1; id <= Number(await gov.proposalCount()); id++) {
    const [p] = await gov.getProposal(id);
    if (Number(p.status) !== 1 || !same(p.target, target)) continue;
    if (!String(p.callData).startsWith(sel)) continue;
    const [node] = om.interface.decodeFunctionData("removeOracle", p.callData);
    out.push({ id, node, p });
  }
  return out;
}

/**
 * The hazards among the open removals, with `planned` (nodes round 2 is
 * about to remove) counted as this proposer's own. Returns { hazards:
 * id -> why, foreign: hazardous ids not this proposer's, open: [{ id,
 * node, p, own }] }.
 */
export async function assessRemovals(
  o: any,
  proposer: any,
  planned: string[] = [],
) {
  const me = await addrOf(proposer);
  const open = (await allOpenRemovals(o)).map((r) => ({
    ...r,
    own: same(r.p.proposer, me),
  }));
  const { f, live } = await nodesNow(o);
  const w = await weightsOf(o, live);
  const groups: { node: string; ids: number[]; own: boolean }[] = [];
  const add = (node: string, id: number | null, own: boolean) => {
    if (!live.some((a: string) => same(a, node))) return;
    let g = groups.find((x) => same(x.node, node));
    if (!g) groups.push((g = { node, ids: [], own: false }));
    if (id !== null) g.ids.push(id);
    g.own ||= own;
  };
  for (const r of open) add(r.node, r.id, r.own);
  for (const n of planned) add(n, null, true);
  groups.sort((x, y) => Number(y.own) - Number(x.own));
  const hazards = new Map<number, string>();
  const mark = (g: any, why: string) => {
    for (const id of g.ids) if (!hazards.has(id)) hazards.set(id, why);
  };
  for (const g of groups.slice(CAP)) mark(g, CAPPED);
  const checked = groups.slice(0, CAP);
  const unsafe = (set: any[]) =>
    refusalFor(
      live.filter((a: string) => !set.some((g) => same(g.node, a))),
      w,
      f,
    );
  const subsets = (gs: any[]) =>
    Array.from({ length: (1 << gs.length) - 1 }, (_, m) =>
      gs.filter((_g, i) => (m + 1) & (1 << i)),
    );
  const own = checked.filter((g) => g.own);
  const ownWhy = subsets(own).map(unsafe).find(Boolean);
  if (ownWhy)
    for (const g of own) mark(g, `this proposer's own removals: ${ownWhy}`);
  for (const set of subsets(checked)) {
    const why = unsafe(set);
    if (!why) continue;
    for (const g of set)
      if (!g.own && !unsafe(set.filter((x) => x !== g)))
        mark(g, `with the other open removals ${why}`);
  }
  const foreign = new Set(
    [...hazards.keys()].filter((id) => !open.find((r) => r.id === id)!.own),
  );
  return { hazards, foreign, open };
}

/** The foreign hazards that hold round 2 (see the header): [{ r, why, over }]. */
async function holding(o: any, a: any) {
  const now = (await ethers.provider.getBlock("latest"))!.timestamp;
  const out = [];
  for (const r of a.open.filter((x: any) => a.foreign.has(x.id)))
    if (await Votes.passes(o.governance, r.p))
      out.push({
        r,
        why: a.hazards.get(r.id),
        over: now > Number(r.p.votingEnds),
      });
  return out;
}

/**
 * Each hazardous open removal still voting gets this run's votes against
 * (the proposer's and the voters', none from the proposal's own proposer):
 * this proposer's own always, a foreign one only when it passes now or
 * has a FOR vote (review H-1). A wallet votes only while its free VGT
 * after the vote still pays for `reserve` own proposals of this run
 * (proposalCreationCost each for the proposer, votingCost for a voter);
 * the others are named as skipped. `planned` as in assessRemovals.
 */
export async function voteAgainstHazards(
  o: any,
  proposer: any,
  voters: any[],
  log = console.log,
  planned: string[] = [],
  reserve = 0,
) {
  const gov = o.governance;
  const { hazards, open } = await assessRemovals(o, proposer, planned);
  const now = (await ethers.provider.getBlock("latest"))!.timestamp;
  const me = await addrOf(proposer);
  const vote = await gov.votingCost();
  const make = await gov.proposalCreationCost();
  for (const r of open.filter((x) => hazards.has(x.id))) {
    if (now > Number(r.p.votingEnds)) continue;
    if (!r.own && r.p.votesFor === 0n && !(await Votes.passes(gov, r.p))) {
      log(
        `   ℹ️  removal #${r.id} (${r.node}, by ${r.p.proposer}) ${hazards.get(r.id)}, but nobody voted for it: no vote against (the precheck before each removal re-checks)`,
      );
      continue;
    }
    log(
      `   ⚠️  removal #${r.id} (${r.node}${r.own ? "" : `, proposed by ${r.p.proposer}`}) ${hazards.get(r.id)}: voting against while it votes (a cancel vote is no guard once it has passed)`,
    );
    const mine = [];
    for (const v of [proposer, ...voters]) {
      const a = await addrOf(v);
      if (same(a, r.p.proposer) || (await gov.hasVoted(r.id, a))) continue;
      const keep = BigInt(reserve) * (same(a, me) ? make : vote);
      const free = await o.governanceToken.getFreeBalance(a);
      if (free >= keep + vote) mine.push(v);
      else
        log(
          `   ⚠️  removal #${r.id}: ${a} skipped, its free VGT ${ethers.formatEther(free)} keeps ${ethers.formatEther(keep)} for this run's ${reserve} own proposal(s)`,
        );
    }
    await Votes.castAcceptanceVotes(gov, r.id, mine, false);
  }
}

/**
 * Throws naming each foreign hazard that holds round 2 (passing on the
 * votes cast now); `planned` as in assessRemovals. One that does not pass
 * now is reported in the log only.
 */
export async function holdForForeignHazards(
  o: any,
  proposer: any,
  planned: string[] = [],
  log = console.log,
) {
  const a = await assessRemovals(o, proposer, planned);
  const held = await holding(o, a);
  for (const r of a.open.filter((x: any) => a.foreign.has(x.id)))
    if (!held.some((h: any) => h.r.id === r.id))
      log(
        `   ℹ️  removal #${r.id} (${r.node}, by ${r.p.proposer}) ${a.hazards.get(r.id)}, but it does not pass on the votes cast now: not holding round 2 (the precheck before each removal re-checks)`,
      );
  if (!held.length) return;
  const named = held.map(
    ({ r, why, over }: any) =>
      `#${r.id} (${r.node}, by ${r.p.proposer}: ${why}; ${over ? "its vote is over and it passed: anyone may execute it" : "still voting"})`,
  );
  throw new Error(
    `round 2 held: open removal proposal(s) ${named.join("; ")} pass on the votes cast now and would leave an invalid node set with this run's removals; a re-run votes against one still voting and cancels one whose vote is over by a cancelProposal vote (cancelCandidates), then re-run`,
  );
}

/**
 * Review L-1 (final), widened: the open removals cancelHazards judges,
 * every proposer's: a foreign hazard past its vote and passing (anyone
 * may execute it), and this proposer's own that would now leave an
 * invalid set alone or with such a hazard (a re-run after a kill during a
 * cancel vote adopts and settles that vote before anything else).
 */
export async function cancelCandidates(o: any, proposer: any) {
  const { removalPrecheck } = require("./postCeremonyRemovals");
  const { hazards, open } = await assessRemovals(o, proposer);
  const now = (await ethers.provider.getBlock("latest"))!.timestamp;
  const out = [];
  for (const r of open) {
    const over = now > Number(r.p.votingEnds);
    if (!r.own && !(over && (await Votes.passes(o.governance, r.p)))) continue;
    out.push({
      id: r.id,
      precheck: async () => {
        if (hazards.has(r.id)) throw new Error(hazards.get(r.id));
        if (r.own) await removalPrecheck(o, r.node)();
      },
    });
  }
  return out;
}
