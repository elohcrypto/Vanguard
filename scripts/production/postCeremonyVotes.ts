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
 * Task 5.17 (deep review L-3): at each run's start and before each vote,
 * every open removal (anyone's) is checked with the others in every
 * order; one that could leave an invalid set is voted AGAINST while it
 * still votes, and cancelled by vote once passed. A cancel vote is no
 * guard once a removal has passed: anyone may execute it first.
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
import { guardDeployer } from "./cliGuards";
import {
  cancelHazards,
  nodesNow,
  refusalFor,
  removalPrecheck,
  setRefusal,
  weightsOf,
} from "./postCeremonyRemovals";
import {
  assessRemovals,
  cancelCandidates,
  holdForForeignHazards,
  voteAgainstHazards,
} from "./removalHazards";

export { cancelHazards };

const { installRetry } = require("../../demo/utils/RpcRetry");
const { scrubKnown } = require("./redact");
const Votes = require("../../demo/utils/HandoverVotes");
const { withDerivedContracts } = require("../../demo/utils/HandoverDerive");
const { addrOf, same } = require("../../demo/utils/HandoverChecks");
const { nodeFacts, roleOf } = require("../../demo/utils/HandoverNodes");
const {
  deployerTrustedAttestors,
} = require("../../demo/utils/HandoverPrivacy");

const ORACLE_PARAMETERS = 2;
const PRIVACY_PARAMETERS = 11;

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
    // Deep review M-5: the node checks' own rule (an agent included).
    const role = await roleOf({ ...o, voterWallets: voters }, n.address);
    if (role)
      throw new Error(
        `${n.address} is ${role}: a node is a key of its own (D25 b)`,
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
  // Deep review contracts L-2: no list oracle's floor above the votes a
  // query of the rotated set resolves with (TooFewVoters forever).
  const floor = await floorRefusal(o, after, f);
  if (floor) throw new Error(`after the rotation ${floor}`);
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
 * Deep review contracts L-2: the first list oracle (the config's, and the
 * ones ComplianceRules binds to VSC) whose minimumConsensusOracles is
 * above the fewest of `after` that reach the bar, as its refusal; null.
 */
export async function floorRefusal(o: any, after: string[], f: any) {
  const { fewestToReach, floorRow } = require("../../demo/utils/HandoverNodes");
  const engine = await ethers.getContractAt(
    ["function weightOf(address) view returns (uint256)"],
    await o.oracleManager.consensusEngine(),
  );
  const ws = await Promise.all(after.map((a) => engine.weightOf(a)));
  // Below MIN_NODES the rotation is refused by its own check.
  const fewest =
    after.length < f.minNodes ? null : fewestToReach(ws, f.threshold);
  const list: Promise<string>[] = [...(o.oracles || [])].map(addrOf);
  const vsc = o.token && (await addrOf(o.token));
  for (const g of ["whitelistOracle", "blacklistOracle"])
    if (vsc && o.complianceRules) list.push(o.complianceRules[g](vsc));
  const seen = new Set<string>();
  for (const a of await Promise.all(list)) {
    if (a === ethers.ZeroAddress || seen.has(a.toLowerCase())) continue;
    seen.add(a.toLowerCase());
    const c = await ethers.getContractAt(
      ["function minimumConsensusOracles() view returns (uint8)"],
      a,
    );
    const min = await c.minimumConsensusOracles().catch(() => null);
    const row = floorRow(`list oracle ${a}`, min, fewest, f.threshold);
    if (row && !row.ok) return row.fix;
  }
  return null;
}

/**
 * Round 2's proposals: a removal per deployer-era node, refused unless
 * every production node is registered now and every subset of the
 * removals leaves a valid set (anyone may execute them in any order).
 */
export async function roundTwoItems(
  o: any,
  nodes: any[],
  proposer: any = o.voterWallets?.[0],
) {
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
    precheck: removalPrecheck(o, n.addr, proposer),
    // L-3: and before its votes, with every open removal (anyone's).
    prevote: async (id: number) =>
      (await assessRemovals(o, proposer)).hazards.get(id) ?? null,
  }));
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
  // Slice C review H-1: the votes against below keep this run's own
  // proposals paid for, at most a registration per new node, a
  // re-approval per deployer-trusted key and a removal per old node.
  const own =
    nodes.length +
    (await deployerTrustedAttestors(o, await addrOf(o.deployer))).length +
    (await nodesNow(o)).old.length;
  // L-3: hazardous open removals still voting are voted against first.
  await voteAgainstHazards(o, proposer, voters, log, [], own);
  // A hazard left by a stopped run is settled first (final review L-1).
  await cancelHazards(
    o,
    proposer,
    voters,
    await cancelCandidates(o, proposer),
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
  // Security reviews of L-3: round 2's removals, planned, judged with
  // every open removal; held only for a foreign hazard passing now.
  const planned = (await nodesNow(o)).old.map((n: any) => n.addr);
  await voteAgainstHazards(o, proposer, voters, log, planned, planned.length);
  await holdForForeignHazards(o, proposer, planned, log);
  const two = await roundTwoItems(o, nodes, proposer);
  if (two.length) {
    await Votes.checkVoters(o, proposer, voters, two.length);
    log(
      `   🗳️  round 2: ${two.length} removal(s), every production node registered`,
    );
    const open = await Votes.openAll({ ...args, items: two });
    // Again now the removals exist: a foreign one proposed meanwhile.
    await voteAgainstHazards(o, proposer, voters, log);
    await holdForForeignHazards(o, proposer, [], log);
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
  guardDeployer(args.deployer, args.governance); // R-56-5
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
    console.error(`❌ Post-ceremony votes failed: ${scrubKnown(e.message)}`);
    process.exitCode = 1;
  });
}
