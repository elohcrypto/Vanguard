/**
 * The governance votes just after the ceremony (plan v2 Task 5.15; owner
 * Q15 = A, D50 / R-56-2, and Q20 = B), in TWO ROUNDS (the lead's ruling):
 * executeProposal is anyone's and removeOracle checks no node minimum, so
 * a removal that has passed can be executed by a stranger before the
 * registrations; no off-chain order can prevent that.
 *   Round 1: registerOracle for each production node (NEW_NODES) and
 *     setTrustedAttestor(circuit, Ax, Ay, true) for each issuer key the
 *     day-2 audit flags as the deployer's (the same key, re-approved by
 *     governance), proposed together, voted, settled; the first failure
 *     stops the run.
 *   Round 2: only once every production node is registered (read from
 *     the chain, not from round 1), removeOracle for each deployer-era
 *     node, proposed only when EVERY order and subset of the removals
 *     leaves MIN_NODES nodes with none alone at the consensus bar; each
 *     is checked again just before this CLI executes it.
 * The phase is the chain's: a re-run runs round 1 while anything of it is
 * missing (adopting its open proposals), never proposes a removal while a
 * production node is missing, and adopts open removals by the same rules
 * (demo/utils/HandoverVotes.js openAll / settleAll). Calendar: two voting
 * periods and delays (about 20 days at TIME_SCALE 1), not one.
 *
 * Refused before any proposal: a handover.json snapshot from another
 * chain; an unfinished ceremony; a NEW_NODES entry that is not a
 * checksummed address, is zero, repeated, the deployer, governance, a
 * role, a voter, the proposer or a claim signer, or a node no vote
 * registered; a final node set below MIN_NODES or with one node at the
 * bar. A production node a vote already registered is skipped (a re-run).
 *
 *   NEW_NODES=0xA:NAME,0xB:NAME HANDOVER_CONFIG=<handover.json> \
 *     npx hardhat run scripts/production/postCeremonyVotes.ts --network remote
 *
 * Afterwards set handover.json "oracleNodes" to the nodes it prints (the
 * day-2 audit acknowledges every node) and run HANDOVER_PHASE=audit.
 */
import * as fs from "fs";
import { ethers, network } from "hardhat";
import { handoverArgs } from "../handoverConfig";

const { installRetry } = require("../../demo/utils/RpcRetry");
const Votes = require("../../demo/utils/HandoverVotes");
const { withDerivedContracts } = require("../../demo/utils/HandoverDerive");
const { addrOf, same } = require("../../demo/utils/HandoverChecks");
const { nodeFacts } = require("../../demo/utils/HandoverNodes");
const {
  deployerTrustedAttestors,
} = require("../../demo/utils/HandoverPrivacy");

const ORACLE_PARAMETERS = 2;
const PRIVACY_PARAMETERS = 11;
const SYSTEM_PARAMETERS = 4;

/** NEW_NODES "0xA:NAME,0xB:NAME" as [{ address, name }]; checksummed. */
export function parseNodes(text = ""): { address: string; name: string }[] {
  const out = text
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean)
    .map((x) => {
      const [a, name] = x.split(":");
      if (!name || !ethers.isAddress(a) || a !== ethers.getAddress(a)) {
        throw new Error(
          `NEW_NODES: "${x}" is not <checksummed address>:<name>`,
        );
      }
      if (a === ethers.ZeroAddress)
        throw new Error("NEW_NODES: the zero address");
      return { address: a, name };
    });
  const dup = out.find(
    (n, i) => out.findIndex((m) => m.address === n.address) !== i,
  );
  if (dup) throw new Error(`NEW_NODES lists ${dup.address} twice`);
  return out;
}

/** address (lower case) -> engine weight, read once. */
async function weightsOf(o: any, nodes: string[]) {
  const engine = await ethers.getContractAt(
    ["function weightOf(address) view returns (uint256)"],
    await o.oracleManager.consensusEngine(),
  );
  const m = new Map<string, bigint>();
  for (const a of nodes) m.set(a.toLowerCase(), await engine.weightOf(a));
  return m;
}

/** setRefusal on weights already read. */
function refusalFor(after: string[], w: Map<string, bigint>, f: any) {
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
async function setRefusal(
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
async function nodesNow(o: any) {
  const f = await nodeFacts(o);
  const dAddr = await addrOf(o.deployer);
  const old = f.nodes.filter(
    (n: any) =>
      !n.byGovernance && n.registeredBy && same(n.registeredBy, dAddr),
  );
  return { f, live: f.nodes.map((n: any) => n.addr), old };
}

/**
 * Round 1's proposals (registrations of the production nodes not yet
 * registered, then the re-approvals), after every refusal in the header.
 * `voters` holds the proposer and the voters.
 */
export async function roundOneItems(
  o: any,
  nodes: any[],
  cfg: any,
  voters: any[],
) {
  const govAddr = await addrOf(o.governance);
  const dAddr = await addrOf(o.deployer);
  for (const [k, label] of [
    ["oracleManager", "OracleManager"],
    ["privacyManager", "PrivacyManager"],
  ]) {
    if (!o[k] || !same(await o[k].owner(), govAddr)) {
      throw new Error(
        `${label} is not governance's: finish the ceremony first`,
      );
    }
  }
  const { f, live, old } = await nodesNow(o);
  const taken = [dAddr, govAddr, ...(cfg.claimSigners || [])];
  for (const r of [o.ops, o.guardian, o.issuerAdmin, ...voters])
    if (r) taken.push(await addrOf(r));
  const fresh = [];
  for (const n of nodes) {
    if (taken.some((a) => same(a, n.address)))
      throw new Error(
        `${n.address} is the deployer, governance, a role, a voter or a claim signer: a node is a key of its own (D25 b)`,
      );
    const known = f.nodes.find((x: any) => same(x.addr, n.address));
    if (known && !known.byGovernance)
      throw new Error(
        `${n.address} is already a node, not one a vote registered: not a production node`,
      );
    if (!known) fresh.push(n);
  }
  const after = [
    ...live.filter((a: string) => !old.some((n: any) => same(n.addr, a))),
    ...fresh.map((n) => n.address),
  ];
  const why = await setRefusal(o, after, f);
  if (why)
    throw new Error(
      `after the rotation ${why}: register more production nodes (NEW_NODES)`,
    );
  const om = o.oracleManager;
  const pm = o.privacyManager;
  const items: any[] = fresh.map((n) => ({
    label: `register production node ${n.address} (${n.name})`,
    title: `D50: register node ${n.name}`,
    proposalType: ORACLE_PARAMETERS,
    target: om,
    callData: om.interface.encodeFunctionData("registerOracle", [
      n.address,
      n.name,
      "production node (D50)",
      500,
    ]),
  }));
  for (const k of await deployerTrustedAttestors(o, dAddr)) {
    items.push({
      label: `re-approve issuer key Ax ${k.ax} for ${k.name} (Q20)`,
      title: `Q20: re-approve the ${k.name} issuer key`,
      proposalType: PRIVACY_PARAMETERS,
      target: pm,
      callData: pm.interface.encodeFunctionData("setTrustedAttestor", [
        k.circuitId,
        k.ax,
        k.ay,
        true,
      ]),
    });
  }
  return items;
}

/**
 * Round 2's proposals: a removal per deployer-era node, refused unless
 * every production node is registered now and every subset of the
 * removals leaves a valid set (anyone may execute them in any order).
 */
export async function roundTwoItems(o: any, nodes: any[]) {
  const { f, live, old } = await nodesNow(o);
  const missing = nodes.filter(
    (n) => !live.some((a: string) => same(a, n.address)),
  );
  if (missing.length) {
    throw new Error(
      `round 2 not proposed: production node(s) ${missing.map((n) => n.address).join(", ")} not registered on chain`,
    );
  }
  // Review I-4: 2^k subsets, from weights read once; k bounded.
  if (old.length > 12) {
    throw new Error(
      `round 2 not proposed: ${old.length} deployer-era nodes; more than 12 cannot be checked in every order (remove some by separate votes first)`,
    );
  }
  const weights = await weightsOf(o, live);
  for (let mask = 1; mask < 1 << old.length; mask++) {
    const gone = old.filter((_: any, i: number) => mask & (1 << i));
    const left = live.filter(
      (a: string) => !gone.some((n: any) => same(n.addr, a)),
    );
    const why = refusalFor(left, weights, f);
    if (why)
      throw new Error(
        `round 2 not proposed: removing ${gone.map((n: any) => n.addr).join(", ")} ${why}`,
      );
  }
  const om = o.oracleManager;
  return old.map((n: any) => ({
    label: `remove deployer-era node ${n.addr} (${n.name})`,
    title: `D50: remove deployer-era node ${n.name}`,
    proposalType: ORACLE_PARAMETERS,
    target: om,
    callData: om.interface.encodeFunctionData("removeOracle", [
      n.addr,
      "D50 rotation after the ceremony",
    ]),
    // Read just before this CLI executes it: the nodes then registered.
    precheck: removalPrecheck(o, n.addr),
  }));
}

/** Throws when removing `node` now would leave an invalid node set. */
function removalPrecheck(o: any, node: string) {
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
async function openRemovals(o: any, proposer: any) {
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

/** The handover.json snapshot's chain is the connected one. */
export function requireSameChain(path: string, chainId: number) {
  const f = `${path}.snapshot.json`;
  if (!fs.existsSync(f))
    throw new Error(`${f}: no ceremony snapshot; run the ceremony first`);
  const snap = JSON.parse(fs.readFileSync(f, "utf8"));
  if (snap.chainId !== chainId) {
    throw new Error(
      `${path} is for chain ${snap.chainId}, not the connected chain ${chainId}`,
    );
  }
}

/** Round 1, then round 2, each from the chain's state. */
export async function runPostCeremony(
  o: any,
  proposer: any,
  voters: any[],
  nodes: any[],
  cfg: any,
  log = console.log,
) {
  const args = { governance: o.governance, proposer, voters, log };
  // A hazard left by a stopped run is settled first (final review L-1).
  await cancelHazards(
    o,
    proposer,
    voters,
    await openRemovals(o, proposer),
    log,
  );
  const one = await roundOneItems(o, nodes, cfg, [proposer, ...voters]);
  if (one.length) {
    await Votes.checkVoters(o, proposer, voters, one.length);
    log(
      `   🗳️  round 1: ${one.length} proposal(s), registrations and re-approvals`,
    );
    await Votes.settleAll({
      ...args,
      open: await Votes.openAll({ ...args, items: one }),
    });
  }
  const two = await roundTwoItems(o, nodes);
  if (two.length) {
    await Votes.checkVoters(o, proposer, voters, two.length);
    log(
      `   🗳️  round 2: ${two.length} removal(s), every production node registered`,
    );
    const open = await Votes.openAll({ ...args, items: two });
    try {
      await Votes.settleAll({ ...args, open });
    } catch (e: any) {
      if (/ now: .* not executed/.test(e.message))
        await cancelHazards(o, proposer, voters, open, log);
      throw e;
    }
  }
  if (!one.length && !two.length)
    log(
      "✅ nothing to vote: no deployer-era node or deployer-trusted issuer key, no new node",
    );
}

async function main(): Promise<void> {
  installRetry(network.provider);
  const path = process.env.HANDOVER_CONFIG;
  if (!path) throw new Error("set HANDOVER_CONFIG to the handover JSON file");
  const cfg = JSON.parse(fs.readFileSync(path, "utf8"));
  requireSameChain(path, Number((await ethers.provider.getNetwork()).chainId));
  const { args, wallet } = await handoverArgs(cfg, "audit", path);
  const o = await withDerivedContracts(args);
  const nodes = parseNodes(process.env.NEW_NODES);
  await runPostCeremony(
    o,
    wallet(cfg.proposer),
    cfg.voters.map(wallet),
    nodes,
    cfg,
  );
  const live = await o.oracleManager.getRegisteredOracles();
  console.log(`✅ post-ceremony votes executed; nodes now ${live.join(", ")}`);
  console.log(
    `   set handover.json "oracleNodes" to ${JSON.stringify(live)}, then run HANDOVER_PHASE=audit`,
  );
}

if (require.main === module) {
  main().catch((e) => {
    console.error(`❌ Post-ceremony votes failed: ${e.message}`);
    process.exitCode = 1;
  });
}
