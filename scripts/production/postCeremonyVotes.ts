/**
 * The governance votes just after the ceremony (plan v2 Task 5.15; owner
 * Q15 = A, D50 / R-56-2, and Q20 = B), by the ceremony's vote engine
 * (demo/utils/HandoverVotes.js openAll / settleAll):
 *   1. registerOracle for each production node (NEW_NODES);
 *   2. setTrustedAttestor(circuit, Ax, Ay, true) for each issuer key the
 *      day-2 audit flags as trusted by the deployer (the same key,
 *      re-approved by governance: the deployer no longer vouches);
 *   3. removeOracle for each node the deployer registered (D50).
 * 1 and 2 are proposed together; 3 a gap later (an hour divided by
 * TIME_SCALE), so every removal matures after every registration even if
 * someone else executes it (executeProposal is anyone's). All are voted
 * in the same voting period, then settled in that order: registrations
 * first, each confirmed registered; each removal is checked just before
 * it executes against the nodes then registered (MIN_NODES left, none
 * alone at the consensus bar), and not executed otherwise. The first
 * failure stops the run; a re-run adopts what is open, in the same order.
 *
 * Refused before any proposal: a handover.json snapshot from another
 * chain; an unfinished ceremony; a NEW_NODES entry that is not a
 * checksummed address, is zero, repeated, the deployer, governance, a
 * role, a voter, the proposer or a claim signer, or a node the vote did
 * not register; a final node set below MIN_NODES or with one node at the
 * bar. A new node a vote already registered is skipped (a re-run).
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
const { advancePast } = require("../../demo/utils/ChainTime");
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

/**
 * The proposals in two waves ({ wave1, wave2 }: registrations and
 * re-approvals, then removals), refused before any is made when a rule in
 * the header fails. `voters` holds the proposer and the voters.
 */
export async function postCeremonyItems(
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
  const f = await nodeFacts(o);
  const live = f.nodes.map((n: any) => n.addr);
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
  const old = f.nodes.filter(
    (n: any) =>
      !n.byGovernance && n.registeredBy && same(n.registeredBy, dAddr),
  );
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
  const registered = async (a: string) =>
    (await om.getRegisteredOracles()).some((x: string) => same(x, a));
  const wave1: any[] = fresh.map((n) => ({
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
    verify: async () => {
      if (!(await registered(n.address)))
        throw new Error(`${n.address} is not a node after its vote`);
    },
  }));
  for (const k of await deployerTrustedAttestors(o, dAddr)) {
    wave1.push({
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
  const wave2 = old.map((n: any) => ({
    label: `remove deployer-era node ${n.addr} (${n.name})`,
    title: `D50: remove deployer-era node ${n.name}`,
    proposalType: ORACLE_PARAMETERS,
    target: om,
    callData: om.interface.encodeFunctionData("removeOracle", [
      n.addr,
      "D50 rotation after the ceremony",
    ]),
    // Read just before it executes: the nodes then registered.
    precheck: async () => {
      const now = await om.getRegisteredOracles();
      const left = now.filter((a: string) => !same(a, n.addr));
      const no = await setRefusal(o, left, await nodeFacts(o));
      if (no) throw new Error(`removing ${n.addr} now: ${no}; not executed`);
    },
    verify: async () => {
      if (await registered(n.addr))
        throw new Error(`${n.addr} is still a node after its vote`);
    },
  }));
  return { wave1, wave2 };
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

/** Both waves opened (the gap between them) and settled in order. */
export async function runPostCeremony(
  o: any,
  proposer: any,
  voters: any[],
  waves: any,
  log = console.log,
) {
  const gov = o.governance;
  const args = { governance: gov, proposer, voters, log };
  const open1 = await Votes.openAll({ ...args, items: waves.wave1 });
  let open2: any[] = [];
  if (waves.wave2.length) {
    if (open1.length) {
      const made = [];
      for (const x of open1)
        made.push(Number((await gov.getProposal(x.id))[0].createdAt));
      const gap = Math.max(
        60,
        Math.floor(3600 / Number(await gov.TIME_SCALE())),
      );
      await advancePast(
        Math.max(...made) + gap,
        `removals proposed ${gap} s after the registrations`,
        { margin: 0 },
      );
    }
    open2 = await Votes.openAll({ ...args, items: waves.wave2 });
  }
  log(
    `   🗳️  ${open1.length + open2.length} proposal(s) open together (${open1.length}, then ${open2.length} removals)`,
  );
  await Votes.settleAll({ ...args, open: [...open1, ...open2] });
}

async function main(): Promise<void> {
  installRetry(network.provider);
  const path = process.env.HANDOVER_CONFIG;
  if (!path) throw new Error("set HANDOVER_CONFIG to the handover JSON file");
  const cfg = JSON.parse(fs.readFileSync(path, "utf8"));
  requireSameChain(path, Number((await ethers.provider.getNetwork()).chainId));
  const { args, wallet } = await handoverArgs(cfg, "audit", path);
  const o = await withDerivedContracts(args);
  const proposer = wallet(cfg.proposer);
  const voters = cfg.voters.map(wallet);
  const waves = await postCeremonyItems(
    o,
    parseNodes(process.env.NEW_NODES),
    cfg,
    [proposer, ...voters],
  );
  const n = waves.wave1.length + waves.wave2.length;
  if (!n) {
    console.log(
      "✅ nothing to vote: no deployer-era node or deployer-trusted issuer key, no new node",
    );
    return;
  }
  await Votes.checkVoters(o, proposer, voters, n);
  await runPostCeremony(o, proposer, voters, waves);
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
