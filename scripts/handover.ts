/**
 * Handover ceremony CLI (plan v2 Task 2C.1; Task 4.13 derives everything
 * from one root). The deployer (wallet 0) gives up every power; governance
 * takes the core contracts by vote.
 *
 *   HANDOVER_CONFIG=handover.json npx hardhat run scripts/handover.ts --network <net>
 *
 * handover.json (wallet indices from docs/TESTNET_DEMO.md):
 *   {
 *     "governance": "0x..",                   // the one root: every other
 *                                             // contract is derived from it
 *     "ops": 10, "guardian": 11, "issuerAdmin": 9,
 *     "proposer": 1, "voters": [2, 3, 6],
 *     "fromBlock": 1234567,                   // optional, before every deploy
 *     "logChunk": 5000,                       // optional, eth_getLogs range
 *     "keyManagerIdentity": "0x..",           // optional, the demo OnchainID
 *     "feeWallets": ["0x.."],                 // optional, escrow fee wallets
 *     "oracleNodes": ["0x.."],                // acknowledged consensus nodes
 *     "attestors": ["<Ax>"],                  // acknowledged attestor keys
 *     "extraTrusted": ["0x.."]                // acknowledged trusted contracts
 *   }
 *
 * The three acknowledgement lists default to empty: on a first handover
 * nothing is acknowledged and any registered node, trusted attestor key
 * or trusted contract outside governance and the registrars' wallets is
 * refused. An address key of an older config ("token", "governanceToken",
 * "identityRegistry", "complianceRules", "oracleManager",
 * "investorTypeRegistry", "dynamicListManager", "escrowWalletFactory",
 * "onchainIDFactory", "privacyManager", "zkVerifier", "keyManager", and
 * the "oracles" / "issuers" lists) is still accepted as an assertion:
 * refused when it differs from what governance derives (R-413-1). The
 * OnchainIDFactory, an escrow factory that is no registrar yet, an unwired
 * privacy pair and a KeyManager nothing pins are unreachable from
 * governance before step 3 binds them, so those may still be named
 * (R-413-2). Any other key is refused. The ceremony itself, every
 * refusal and every completion line: demo/utils/Handover*.js.
 *
 * HANDOVER_PHASE=accept resumes after a partial run: it skips the deployer
 * steps and only votes the acceptances (and registry proposals) still
 * pending, then verifies. Before any transaction the proposer and every
 * voter must be verified and hold the VGT fees for every proposal.
 */
// ponytail: a JSON file via HANDOVER_CONFIG is the ceiling (hardhat run has no
// argv passthrough); a typed CLI can replace it later.
import { ethers } from "hardhat";
import * as fs from "fs";

// Whitelist/Blacklist oracles have listManager(); an oracle without it
// reverts, which the ceremony treats as "no writer role".
const ORACLE_ABI = [
  "function owner() view returns (address)",
  "function transferOwnership(address)",
  "function listManager() view returns (address)",
  "function setListManager(address)",
];

const {
  ACCEPTANCE_PLAN,
  handoverDeployerPowers,
  acceptAllByVote,
  pendingRegistryProposals,
  preflight,
  checkVoters,
  assertHandoverComplete,
} = require("../demo/utils/Handover");
const { planFor, withBoundRegistry } = require("../demo/utils/HandoverChecks");
const { withDerivedContracts } = require("../demo/utils/HandoverDerive");

/**
 * The whole CLI run for a parsed handover.json (`path` names it in errors).
 * Exported so test/production/HandoverCli.test.ts drives it in-process.
 */
export async function runHandover(
  cfg: any,
  phase = "full",
  path = "handover.json",
): Promise<void> {
  const ADDRESS_KEYS = [
    "token",
    "governanceToken",
    "identityRegistry",
    "complianceRules",
    "oracleManager",
    "investorTypeRegistry",
    "dynamicListManager",
    "escrowWalletFactory",
    "onchainIDFactory",
    "privacyManager",
    "zkVerifier",
    "keyManager",
    "keyManagerIdentity",
  ];
  const LIST_KEYS = [
    "oracles",
    "issuers",
    "feeWallets",
    "oracleNodes",
    "attestors",
    "extraTrusted",
  ];
  const allowed = new Set([
    "governance",
    "ops",
    "guardian",
    "issuerAdmin",
    "proposer",
    "voters",
    "fromBlock",
    "logChunk",
    ...ADDRESS_KEYS,
    ...LIST_KEYS,
  ]);
  for (const k of Object.keys(cfg)) {
    if (!allowed.has(k)) {
      throw new Error(
        `${path}: unknown key "${k}" (allowed: ${[...allowed].join(", ")})`,
      );
    }
  }
  if (!ethers.isAddress(cfg.governance)) {
    throw new Error(`${path}: "governance" must be the governance address`);
  }
  for (const k of ADDRESS_KEYS) {
    if (cfg[k] != null && !ethers.isAddress(cfg[k])) {
      throw new Error(`${path}: "${k}" must be an address or null`);
    }
  }
  for (const k of LIST_KEYS) {
    if (cfg[k] === undefined) continue;
    const ok =
      Array.isArray(cfg[k]) &&
      cfg[k].every((x: unknown) =>
        k === "attestors"
          ? /^(0x[0-9a-fA-F]+|[0-9]+)$/.test(String(x))
          : ethers.isAddress(x),
      );
    if (!ok) {
      throw new Error(
        `${path}: "${k}" must list ${k === "attestors" ? "attestor Ax values" : "addresses"}`,
      );
    }
  }
  for (const k of ["ops", "guardian", "proposer"]) {
    if (!Number.isInteger(cfg[k]))
      throw new Error(`${path}: "${k}" must be a wallet index`);
  }
  if (cfg.issuerAdmin !== undefined && !Number.isInteger(cfg.issuerAdmin)) {
    throw new Error(`${path}: "issuerAdmin" must be a wallet index`);
  }
  if (cfg.fromBlock !== undefined && !Number.isInteger(cfg.fromBlock)) {
    throw new Error(`${path}: "fromBlock" must be a block number`);
  }
  if (
    cfg.logChunk !== undefined &&
    !(Number.isInteger(cfg.logChunk) && cfg.logChunk >= 100)
  ) {
    throw new Error(`${path}: "logChunk" must be a block count >= 100`);
  }
  if (phase !== "full" && phase !== "accept") {
    throw new Error(`HANDOVER_PHASE must be "accept" or unset, got "${phase}"`);
  }
  if (!Array.isArray(cfg.voters) || cfg.voters.length === 0) {
    throw new Error(`${path}: "voters" must list wallet indices`);
  }

  const signers = await ethers.getSigners();
  const wallet = (i: number) => {
    if (!signers[i])
      throw new Error(`wallet ${i} is not configured on this network`);
    return signers[i];
  };
  const at = (name: string, a: string) => ethers.getContractAt(name, a);

  const ARTIFACT: Record<string, string> = {
    token: "Token",
    governanceToken: "GovernanceToken",
    identityRegistry: "IdentityRegistry",
    complianceRules: "ComplianceRules",
    oracleManager: "OracleManager",
    investorTypeRegistry: "InvestorTypeRegistry",
    dynamicListManager: "DynamicListManager",
    escrowWalletFactory: "EscrowWalletFactory",
    onchainIDFactory: "OnchainIDFactory",
    privacyManager: "PrivacyManager",
    zkVerifier: "ZKVerifierIntegrated",
    keyManager: "KeyManager",
  };
  const args: Record<string, any> = {
    // Start of the event scans (read in chunks from here to the latest block).
    fromBlock: cfg.fromBlock,
    logChunk: cfg.logChunk,
    deployer: wallet(0),
    ops: wallet(cfg.ops),
    guardian: wallet(cfg.guardian),
    issuerAdmin:
      cfg.issuerAdmin === undefined ? undefined : wallet(cfg.issuerAdmin),
    feeWallets: cfg.feeWallets,
    oracleNodes: cfg.oracleNodes || [],
    attestors: cfg.attestors || [],
    extraTrusted: cfg.extraTrusted || [],
    governance: await at("VanguardGovernance", cfg.governance),
    keyManagerIdentity: cfg.keyManagerIdentity,
    // Assertions (R-413-1): what an older config names is checked against
    // the derivation; a key left out is derived.
    oracles: cfg.oracles
      ? await Promise.all(
          cfg.oracles.map((a: string) => ethers.getContractAt(ORACLE_ABI, a)),
        )
      : undefined,
    issuers: cfg.issuers
      ? await Promise.all(cfg.issuers.map((a: string) => at("ClaimIssuer", a)))
      : undefined,
  };
  for (const [k, name] of Object.entries(ARTIFACT)) {
    if (cfg[k]) args[k] = await at(name, cfg[k]);
  }
  // R-413-2: a contract unreachable from governance before step 3 binds it
  // must be stated (an address, or null for "not deployed") unless derived.
  const derived = await withDerivedContracts(args);
  for (const k of [
    "escrowWalletFactory",
    "onchainIDFactory",
    "privacyManager",
    "zkVerifier",
  ]) {
    if (!(k in cfg) && derived[k] == null) {
      throw new Error(
        `${path}: missing "${k}" (an address, or null when not deployed): governance does not derive it before step 3 binds it, so the deployer would keep it`,
      );
    }
  }
  const proposer = wallet(cfg.proposer);
  const voters = cfg.voters.map(wallet);
  const govAddr = String(cfg.governance).toLowerCase();
  // Acceptance votes still to run: plan contracts governance does not own.
  const acceptances = async (o: any) => {
    let n = 0;
    for (const e of planFor(o)) {
      if ((await o[e.key].owner()).toLowerCase() !== govAddr) n++;
    }
    return n;
  };

  let registryProposals: any[];
  if (phase === "accept") {
    console.log("⏭️  HANDOVER_PHASE=accept: deployer steps skipped");
    const o = await withBoundRegistry(
      await withDerivedContracts(args, console.log),
      console.log,
    );
    await preflight(o, { acceptOnly: true });
    registryProposals = await pendingRegistryProposals(o);
    await checkVoters(
      o,
      proposer,
      voters,
      (await acceptances(o)) + registryProposals.length,
    );
  } else {
    const o = await withBoundRegistry(await withDerivedContracts(args));
    const reg = o.investorTypeRegistry;
    // Registry calls become proposals only when governance already owns it.
    const regVotes =
      reg && (await reg.owner()).toLowerCase() === govAddr
        ? (await pendingRegistryProposals(o)).length
        : 0;
    await checkVoters(o, proposer, voters, (await acceptances(o)) + regVotes);
    console.log("🔑 Handover: deployer powers");
    const report = await handoverDeployerPowers(args);
    registryProposals = report.registryProposals;
    args.snapshot = report.snapshot; // completion compares with preflight
  }

  console.log("\n🏛️  Handover: governance accepts by vote");
  const contracts: Record<string, any> = {};
  for (const e of ACCEPTANCE_PLAN) contracts[e.key] = args[e.key];
  await acceptAllByVote({
    governance: args.governance,
    contracts,
    proposer,
    voters,
    registryProposals,
  });

  console.log("\n🔍 Handover: verify");
  const { ok, checks, warnings, residual } = await assertHandoverComplete(args);
  for (const c of checks) console.log(`   ${c.ok ? "✅" : "❌"} ${c.label}`);
  for (const w of warnings) console.log(`   ⚠️  ${w}`);
  if (!ok) throw new Error("handover incomplete (see ❌ above)");
  // Review B-L3: a deployer-trusted issuer key or deployer-published root
  // still vouches, so "no power" would overstate it.
  console.log(
    residual.length
      ? "\n⚠️  Handover complete with warnings: see above."
      : "\n✅ Handover complete: the deployer holds no power.",
  );
}

async function main(): Promise<void> {
  const path = process.env.HANDOVER_CONFIG;
  if (!path) throw new Error("set HANDOVER_CONFIG to the handover JSON file");
  const cfg = JSON.parse(fs.readFileSync(path, "utf8"));
  await runHandover(cfg, process.env.HANDOVER_PHASE || "full", path);
}

// `hardhat run` executes this file as the main module; a test imports it.
if (require.main === module) {
  main().catch((e) => {
    console.error(`❌ Handover failed: ${e.message}`);
    process.exitCode = 1;
  });
}
