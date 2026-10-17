/**
 * The governance votes just after the ceremony (plan v2 Task 5.15; owner
 * Q15 = A, D50 / R-56-2, and Q20 = B), proposed together and settled in
 * order by the ceremony's vote engine (demo/utils/HandoverVotes.js
 * voteAll: one voting period and delay for the set; the first that does
 * not pass stops the run; a re-run adopts what is open):
 *   1. registerOracle for each production node (NEW_NODES);
 *   2. setTrustedAttestor(circuit, Ax, Ay, true) for each issuer key the
 *      day-2 audit flags as trusted by the deployer: the same key,
 *      re-approved by governance, so the deployer no longer vouches;
 *   3. removeOracle for each node the deployer registered (D50), settled
 *      after the registrations.
 * Before any proposal: governance must own OracleManager and
 * PrivacyManager (the ceremony completed), a new node may not be the
 * deployer, a role, governance, a voter or already a node, and the node
 * set after every vote must keep MIN_NODES nodes with none alone at the
 * consensus bar (checked on the final set, not only at execution).
 *
 *   NEW_NODES=0xA:NAME,0xB:NAME HANDOVER_CONFIG=<handover.json> \
 *     npx hardhat run scripts/production/postCeremonyVotes.ts --network remote
 *
 * Afterwards add the new nodes to handover.json's "oracleNodes" (the
 * day-2 audit acknowledges every node) and run HANDOVER_PHASE=audit.
 */
import * as fs from "fs";
import { ethers, network } from "hardhat";
import { handoverArgs } from "../handoverConfig";

const { installRetry } = require("../../demo/utils/RpcRetry");
const { voteAll, checkVoters } = require("../../demo/utils/HandoverVotes");
const { withDerivedContracts } = require("../../demo/utils/HandoverDerive");
const { addrOf, same } = require("../../demo/utils/HandoverChecks");
const { nodeFacts } = require("../../demo/utils/HandoverNodes");
const {
  deployerTrustedAttestors,
} = require("../../demo/utils/HandoverPrivacy");

const ORACLE_PARAMETERS = 2;
const PRIVACY_PARAMETERS = 11;

/** NEW_NODES "0xA:NAME,0xB:NAME" as [{ address, name }]. */
export function parseNodes(text = ""): { address: string; name: string }[] {
  return text
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean)
    .map((x) => {
      const [a, name] = x.split(":");
      if (!ethers.isAddress(a) || !name) {
        throw new Error(`NEW_NODES: "${x}" is not <address>:<name>`);
      }
      return { address: ethers.getAddress(a), name };
    });
}

/** The proposals, refused before any is made when a rule above fails. */
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
  const taken = [dAddr, govAddr];
  for (const r of [o.ops, o.guardian, o.issuerAdmin, ...voters])
    if (r) taken.push(await addrOf(r));
  for (const n of nodes) {
    if (live.some((a: string) => same(a, n.address)))
      throw new Error(`${n.address} is already a node`);
    if (taken.some((a) => same(a, n.address)))
      throw new Error(
        `${n.address} is the deployer, governance, a role or a voter: a node is a key of its own (D25 b)`,
      );
  }
  const old = f.nodes.filter(
    (n: any) =>
      !n.byGovernance && n.registeredBy && same(n.registeredBy, dAddr),
  );
  // The node set once every vote ran: MIN_NODES, and none alone at the bar.
  const engine = await ethers.getContractAt(
    ["function weightOf(address) view returns (uint256)"],
    await o.oracleManager.consensusEngine(),
  );
  const after = [
    ...live.filter((a: string) => !old.some((n: any) => same(n.addr, a))),
    ...nodes.map((n) => n.address),
  ];
  const weights = await Promise.all(after.map((a) => engine.weightOf(a)));
  const total = weights.reduce((t: bigint, w: bigint) => t + w, 0n);
  const heavy = weights.reduce((m: bigint, w: bigint) => (w > m ? w : m), 0n);
  if (
    after.length < f.minNodes ||
    heavy * 100n >= total * BigInt(f.threshold)
  ) {
    throw new Error(
      `after the rotation ${after.length} node(s) would remain${after.length < f.minNodes ? `, below MIN_NODES (${f.minNodes})` : `, one alone at the ${f.threshold}% bar`}: register more production nodes (NEW_NODES)`,
    );
  }
  const om = o.oracleManager;
  const pm = o.privacyManager;
  const items: any[] = nodes.map((n) => ({
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
      if (
        !(await om.getRegisteredOracles()).some((a: string) =>
          same(a, n.address),
        )
      )
        throw new Error(`${n.address} is not a node after its vote`);
    },
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
  for (const n of old) {
    items.push({
      label: `remove deployer-era node ${n.addr} (${n.name})`,
      title: `D50: remove deployer-era node ${n.name}`,
      proposalType: ORACLE_PARAMETERS,
      target: om,
      callData: om.interface.encodeFunctionData("removeOracle", [
        n.addr,
        "D50 rotation after the ceremony",
      ]),
      verify: async () => {
        if (
          (await om.getRegisteredOracles()).some((a: string) => same(a, n.addr))
        )
          throw new Error(`${n.addr} is still a node after its vote`);
      },
    });
  }
  return items;
}

async function main(): Promise<void> {
  installRetry(network.provider);
  const path = process.env.HANDOVER_CONFIG;
  if (!path) throw new Error("set HANDOVER_CONFIG to the handover JSON file");
  const cfg = JSON.parse(fs.readFileSync(path, "utf8"));
  const { args, wallet } = await handoverArgs(cfg, "audit", path);
  const o = await withDerivedContracts(args);
  const proposer = wallet(cfg.proposer);
  const voters = cfg.voters.map(wallet);
  const nodes = parseNodes(process.env.NEW_NODES);
  const items = await postCeremonyItems(o, nodes, cfg, [proposer, ...voters]);
  if (!items.length) {
    console.log(
      "✅ nothing to vote: no deployer-era node or deployer-trusted issuer key, no new node",
    );
    return;
  }
  await checkVoters(o, proposer, voters, items.length);
  console.log(
    `🗳️  Post-ceremony votes (${items.length}): ${items.map((i) => i.label).join("; ")}`,
  );
  await voteAll({
    governance: o.governance,
    proposer,
    voters,
    items,
    log: console.log,
  });
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
