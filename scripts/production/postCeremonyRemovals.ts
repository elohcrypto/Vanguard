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

/**
 * L-3: ids of the open removeOracle proposals (anyone's, `open`: [{ id,
 * node }]) that, executed in some order with the others, leave an invalid
 * node set now. Subsets of up to 12 removals (2^k).
 */
export async function hazardousRemovals(
  o: any,
  open: any[],
): Promise<Set<number>> {
  const { f, live } = await nodesNow(o);
  const w = await weightsOf(o, live);
  const bad = new Set<number>();
  const k = Math.min(open.length, 12);
  for (let mask = 1; mask < 1 << k; mask++) {
    const gone = open.filter((_: any, i: number) => mask & (1 << i));
    const left = live.filter((a: string) => !gone.some((g) => same(g.node, a)));
    if (refusalFor(left, w, f)) for (const g of gone) bad.add(g.id);
  }
  return bad;
}

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
 * L-3, at the run's start: each hazardous open removal still voting gets
 * this run's votes against; the ones past their vote are left to
 * cancelHazards (the cancel races anyone's execution).
 */
export async function voteAgainstHazards(
  o: any,
  voters: any[],
  log = console.log,
) {
  const open = await allOpenRemovals(o);
  const bad = await hazardousRemovals(o, open);
  const now = (await ethers.provider.getBlock("latest"))!.timestamp;
  for (const r of open.filter((x) => bad.has(x.id))) {
    if (now > Number(r.p.votingEnds)) continue;
    log(
      `   ⚠️  removal #${r.id} (${r.node}) could leave an invalid node set with the other open removals: voting against while it votes (a cancel vote is no guard once it has passed)`,
    );
    await Votes.castAcceptanceVotes(o.governance, r.id, voters, false);
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
 * Review L-1 (final): this proposer's open removeOracle proposals, as
 * items cancelHazards can judge, so a re-run after a kill during a
 * cancel vote adopts and settles that vote before anything else.
 */
export async function openRemovals(o: any, proposer: any) {
  const gov = o.governance;
  const om = o.oracleManager;
  const me = await addrOf(proposer);
  const target = await addrOf(om);
  const sel = om.interface.getFunction("removeOracle").selector;
  const out = [];
  for (let id = 1; id <= Number(await gov.proposalCount()); id++) {
    const [p] = await gov.getProposal(id);
    if (
      Number(p.status) !== 1 ||
      !same(p.proposer, me) ||
      !same(p.target, target)
    )
      continue;
    if (!String(p.callData).startsWith(sel)) continue;
    const [node] = om.interface.decodeFunctionData("removeOracle", p.callData);
    out.push({ id, precheck: removalPrecheck(o, node) });
  }
  return out;
}
