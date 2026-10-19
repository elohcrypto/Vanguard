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
 * Throws when removing `node` now would leave an invalid node set alone,
 * or (Task 5.17, the L-3 security review) when `proposer` is given and an
 * open foreign removal passing on the votes cast now (still voting, or
 * executable by anyone) would make the open removals unsafe with it
 * (removalHazards.ts, slice C review H-1).
 */
export function removalPrecheck(o: any, node: string, proposer?: any) {
  return async () => {
    const now = await o.oracleManager.getRegisteredOracles();
    const left = now.filter((a: string) => !same(a, node));
    const no = await setRefusal(o, left, await nodeFacts(o));
    if (no) throw new Error(`removing ${node} now: ${no}; not executed`);
    if (!proposer) return;
    const { holdForForeignHazards } = require("./removalHazards");
    try {
      await holdForForeignHazards(o, proposer);
    } catch (e: any) {
      throw new Error(`removing ${node} now: ${e.message}; not executed`);
    }
  };
}
