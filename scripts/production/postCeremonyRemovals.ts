/**
 * The node-set checks of scripts/production/postCeremonyVotes.ts, moved
 * here unchanged in Task 5.17 (the 500-line rule) beside the deep review
 * L-3 hazard checks: a removal is checked with every open removal in
 * every order, voted against while it votes, cancelled by vote once
 * passed (a cancel vote is no guard once a removal has passed: anyone may
 * execute it first).
 */
import { ethers } from "hardhat";

const Votes = require("../../demo/utils/HandoverVotes");
const { addrOf, same } = require("../../demo/utils/HandoverChecks");
const { nodeFacts } = require("../../demo/utils/HandoverNodes");

const SYSTEM_PARAMETERS = 4;

/** address (lower case) -> engine weight, read once. */
export async function weightsOf(o: any, nodes: string[]) {
  const engine = await ethers.getContractAt(
    ["function weightOf(address) view returns (uint256)"],
    await o.oracleManager.consensusEngine(),
  );
  const m = new Map<string, bigint>();
  for (const a of nodes) m.set(a.toLowerCase(), await engine.weightOf(a));
  return m;
}

/** setRefusal on weights already read. */
export function refusalFor(after: string[], w: Map<string, bigint>, f: any) {
  const ws = after.map((a) => w.get(a.toLowerCase()) ?? 0n);
  const total = ws.reduce((t, x) => t + x, 0n);
  const heavy = ws.reduce((m, x) => (x > m ? x : m), 0n);
  if (after.length < f.minNodes)
    return `${after.length} node(s) would remain, below MIN_NODES (${f.minNodes})`;
  if (heavy * 100n >= total * BigInt(f.threshold))
    return `${after.length} node(s) would remain, one alone at the ${f.threshold}% bar`;
  return null;
}

/**
 * Review M-2: a passed removal whose execution would now leave an invalid
 * node set stays executable by anyone (executeProposal has no window,
 * removeOracle no node floor). Each such open proposal of `open` is
 * printed as a standing hazard and cancelled by a SystemParameters vote
 * (VanguardGovernance.cancelProposal, owner = governance itself); the
 * removal is proposed again by a later run once safe. Returns the ids.
 */
export async function cancelHazards(
  o: any,
  proposer: any,
  voters: any[],
  open: any[],
  log = console.log,
) {
  const gov = o.governance;
  const ids: number[] = [];
  for (const x of open) {
    const [p] = await gov.getProposal(x.id);
    if (Number(p.status) !== 1 || !x.precheck) continue;
    if (
      await x.precheck().then(
        () => false,
        () => true,
      )
    )
      ids.push(x.id);
  }
  if (!ids.length) return ids;
  for (const id of ids)
    log(
      `   ⚠️  STANDING HAZARD: proposal #${id} (a removal) would leave an invalid node set if anyone executed it now; a cancelProposal vote follows`,
    );
  const items = ids.map((id) => ({
    label: `cancel hazardous removal #${id}`,
    proposalType: SYSTEM_PARAMETERS,
    target: gov,
    callData: gov.interface.encodeFunctionData("cancelProposal", [id]),
  }));
  await Votes.checkVoters(o, proposer, voters, items.length);
  const args = { governance: gov, proposer, voters, log };
  await Votes.settleAll({
    ...args,
    open: await Votes.openAll({ ...args, items }),
  });
  return ids;
}

/** The node set `after` keeps MIN_NODES and no node at the bar, or why not. */
export async function setRefusal(
  o: any,
  after: string[],
  f: any,
): Promise<string | null> {
  const engine = await ethers.getContractAt(
    ["function weightOf(address) view returns (uint256)"],
    await o.oracleManager.consensusEngine(),
  );
  const w: bigint[] = await Promise.all(after.map((a) => engine.weightOf(a)));
  const total = w.reduce((t, x) => t + x, 0n);
  const heavy = w.reduce((m, x) => (x > m ? x : m), 0n);
  if (after.length < f.minNodes)
    return `${after.length} node(s) would remain, below MIN_NODES (${f.minNodes})`;
  if (heavy * 100n >= total * BigInt(f.threshold))
    return `${after.length} node(s) would remain, one alone at the ${f.threshold}% bar`;
  return null;
}

/** The registered nodes, the deployer-era ones, the facts. */
export async function nodesNow(o: any) {
  const f = await nodeFacts(o);
  const dAddr = await addrOf(o.deployer);
  const old = f.nodes.filter(
    (n: any) =>
      !n.byGovernance && n.registeredBy && same(n.registeredBy, dAddr),
  );
  return { f, live: f.nodes.map((n: any) => n.addr), old };
}

const CAP = 12;

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
 * Deep review L-3 and its security review: every open removeOracle
 * proposal (anyone's), judged together. One group per LIVE node under
 * removal (several proposals removing one node count once; removing a
 * node that is not registered removes nothing). Hazardous:
 *  - a FOREIGN removal (another proposer's) whose presence turns a safe
 *    set of open removals into an unsafe one (it leaves too few nodes, or
 *    one node alone at the bar), in some order of execution;
 *  - this proposer's own removals only when its own set is unsafe by
 *    itself (round 2 never proposes such a set);
 *  - fail closed: every removal past the first 12 distinct nodes (own
 *    first; 2^12 subsets are checked), named as such.
 * Returns { hazards: id -> why, foreign: hazardous ids not this
 * proposer's, open: [{ id, node, p, own }] }.
 */
export async function assessRemovals(o: any, proposer: any) {
  const me = await addrOf(proposer);
  const open = (await allOpenRemovals(o)).map((r) => ({
    ...r,
    own: same(r.p.proposer, me),
  }));
  const { f, live } = await nodesNow(o);
  const w = await weightsOf(o, live);
  const groups: { node: string; ids: number[]; own: boolean }[] = [];
  for (const r of open) {
    if (!live.some((a: string) => same(a, r.node))) continue;
    let g = groups.find((x) => same(x.node, r.node));
    if (!g) groups.push((g = { node: r.node, ids: [], own: false }));
    g.ids.push(r.id);
    g.own ||= r.own;
  }
  groups.sort((x, y) => Number(y.own) - Number(x.own));
  const hazards = new Map<number, string>();
  const mark = (g: any, why: string) => {
    for (const id of g.ids) if (!hazards.has(id)) hazards.set(id, why);
  };
  for (const g of groups.slice(CAP))
    mark(
      g,
      `beyond the ${CAP} removals checked together: refused (fail closed)`,
    );
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

/**
 * L-3, at the run's start: each hazardous open removal still voting gets
 * this run's votes against (a voter that proposed it cannot vote on it);
 * the ones past their vote are cancelHazards' (a cancel vote is no guard
 * once a removal has passed: anyone may execute it first).
 */
export async function voteAgainstHazards(
  o: any,
  proposer: any,
  voters: any[],
  log = console.log,
) {
  const { hazards, open } = await assessRemovals(o, proposer);
  const now = (await ethers.provider.getBlock("latest"))!.timestamp;
  for (const r of open.filter((x) => hazards.has(x.id))) {
    if (now > Number(r.p.votingEnds)) continue;
    log(
      `   ⚠️  removal #${r.id} (${r.node}${r.own ? "" : `, proposed by ${r.p.proposer}`}) ${hazards.get(r.id)}: voting against while it votes (a cancel vote is no guard once it has passed)`,
    );
    const mine = [];
    for (const v of voters)
      if (!same(await addrOf(v), r.p.proposer)) mine.push(v);
    await Votes.castAcceptanceVotes(o.governance, r.id, mine, false);
  }
}

/** Throws when removing `node` now would leave an invalid node set. */
export function removalPrecheck(o: any, node: string) {
  return async () => {
    const now = await o.oracleManager.getRegisteredOracles();
    const left = now.filter((a: string) => !same(a, node));
    const no = await setRefusal(o, left, await nodeFacts(o));
    if (no) throw new Error(`removing ${node} now: ${no}; not executed`);
  };
}

/**
 * Review L-1 (final), widened by the L-3 security review: the open
 * removals cancelHazards judges, every proposer's: a hazardous one past
 * its vote and passing (anyone may execute it), and this proposer's own
 * that would now leave an invalid set alone (a re-run after a kill during
 * a cancel vote adopts and settles that vote before anything else).
 */
export async function cancelCandidates(o: any, proposer: any) {
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

/**
 * Round 2 is held while a foreign hazardous removal is open (voting, or
 * passed and executable by anyone): throws naming the proposals.
 */
export async function holdForForeignHazards(o: any, proposer: any) {
  const { hazards, foreign, open } = await assessRemovals(o, proposer);
  if (!foreign.size) return;
  const named = open
    .filter((r) => foreign.has(r.id))
    .map(
      (r) => `#${r.id} (${r.node}, by ${r.p.proposer}: ${hazards.get(r.id)})`,
    );
  throw new Error(
    `round 2 held: open removal proposal(s) ${named.join("; ")} would leave an invalid node set with this run's removals; vote them down or cancel them by vote (a re-run votes against a voting one and cancels a passed one), then re-run`,
  );
}
