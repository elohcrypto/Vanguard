/**
 * Handover ceremony CLI (plan v2 Task 2C.1; Task 4.13 derives everything
 * from one root). The deployer (wallet 0) gives up every power; governance
 * takes the core contracts by vote.
 *
 *   HANDOVER_CONFIG=handover.json npx hardhat run scripts/handover.ts --network <net>
 *
 * handover.json (wallet indices from docs/TESTNET_SETUP.md):
 *   {
 *     "governance": "0x..",                   // the one root: every other
 *                                             // contract is derived from it
 *     "ops": 10, "guardian": 11, "issuerAdmin": 9,  // or a multisig address
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
 * The full phase writes `<config>.snapshot.json` (what the preflight
 * found, the governance address, the chain id and the block the preflight
 * read); `HANDOVER_PHASE=accept` requires it, refuses another chain or a
 * block after step 1's first transaction, and the completion check then
 * proves nothing appeared since step 1 (M-1, L-9). Re-running the full
 * phase refreshes the preflight. A key set to `null` asserts the contract
 * does not exist: refused when governance derives one, a residual warning
 * when it cannot (R-413-12).
 *
 * The three acknowledgement lists default to empty: on a first handover
 * any registered node, trusted attestor key or trusted contract outside
 * governance and the registrars' wallets is refused. An address key of an
 * older config ("token", "governanceToken", "identityRegistry",
 * "complianceRules", "oracleManager", "investorTypeRegistry",
 * "dynamicListManager", "escrowWalletFactory", "onchainIDFactory",
 * "privacyManager", "zkVerifier", "keyManager", the "oracles" / "issuers"
 * lists) is an assertion: refused when it differs from what governance
 * derives (R-413-1). The OnchainIDFactory, an escrow factory that is no
 * registrar yet, an unwired privacy pair and a KeyManager nothing pins are
 * unreachable from governance before step 3 binds them, so those may
 * still be named (R-413-2). Any other key is refused. The ceremony, every
 * refusal and every completion line: demo/utils/Handover*.js.
 *
 * HANDOVER_PHASE=accept resumes after a partial run: it skips the deployer
 * steps and only votes the acceptances (and registry proposals) still
 * pending, then verifies. Before any transaction the proposer and every
 * voter must be verified and hold the VGT fees for every proposal. Task
 * 5.6b (B-6): the full phase also writes `<config>.snapshot.json.sha256`
 * and prints the digest; the accept phase requires HANDOVER_SNAPSHOT_SHA256
 * and refuses a snapshot whose digest differs (HandoverSnapshotFile.js).
 *
 * Task 5.13: ops, guardian or issuerAdmin given as an address, or at an
 * address holding code, is external (a multisig). The full phase sends
 * none of its calls: after the snapshot it writes them as Safe batch files
 * (`<config>.<role>-transactions.json`) and exits 3, before any vote; the
 * accept phase proves each effect on chain first (demo/utils/RoleCalls.js,
 * HandoverRoleCalls.js).
 *
 * HANDOVER_PHASE=preflight (Task 5.7) runs the full phase's checks up to
 * its first transaction and sends nothing: "✅ Preflight passed" or the
 * refusal. The production deploy runs it on the handover.json it writes.
 * HANDOVER_PHASE=audit is the day-2 re-check: read-only, every completion
 * line against the state governance derives now, with the config's
 * acknowledgements and no snapshot or voting window, so a change made by
 * vote passes and any deployer power or unacknowledged holder fails. It
 * refuses while governance does not own every plan contract.
 */
// ponytail: a JSON file via HANDOVER_CONFIG is the ceiling (hardhat run has no
// argv passthrough); a typed CLI can replace it later.
import { ethers } from "hardhat";
import * as fs from "fs";

// Whitelist/Blacklist oracles have listManager(); an oracle without it
// reverts, which the ceremony treats as "no writer role".
const ORACLE_ABI = [
  "function owner() view returns (address)",
  "function pendingOwner() view returns (address)",
  "function transferOwnership(address)",
  "function acceptOwnership()",
  "function listManager() view returns (address)",
  "function setListManager(address)",
];

const {
  ACCEPTANCE_PLAN,
  auditHandover,
  handoverDeployerPowers,
  acceptAllByVote,
  pendingRegistryProposals,
  preflight,
  checkVoters,
  assertHandoverComplete,
} = require("../demo/utils/Handover");
const {
  addrOf,
  planFor,
  withBoundRegistry,
} = require("../demo/utils/HandoverChecks");
const { withDerivedContracts } = require("../demo/utils/HandoverDerive");
const {
  reserveSnapshotFile,
  writeSnapshotFile,
  readSnapshotFile,
  sidecarOf,
} = require("../demo/utils/HandoverSnapshotFile");
const {
  resolveRole,
  requireEffects,
  vetRole,
} = require("../demo/utils/RoleCalls");
const {
  refuseFullRerun,
  stepsFromSnapshot,
} = require("../demo/utils/HandoverRoleCalls");

/** Task 5.7: what the preflight phase's deployer throws at its first send. */
export class PreflightStop extends Error {
  name = "PreflightStop";
}

/** `signer`, refusing every transaction with PreflightStop. */
function stopAtFirstSend(signer: any): any {
  return new Proxy(signer, {
    get(t, p) {
      if (p === "sendTransaction") {
        return async () => {
          throw new PreflightStop("stopped before the first transaction");
        };
      }
      if (p === "connect") return (pr: any) => stopAtFirstSend(t.connect(pr));
      const v = Reflect.get(t, p, t);
      return typeof v === "function" ? v.bind(t) : v;
    },
  });
}

/**
 * HANDOVER_PHASE=preflight (Task 5.7): the full phase's deployer steps
 * with a deployer that refuses to send, so every check the ceremony makes
 * before its first transaction runs and nothing is sent. Passes only when
 * the run stops at that refusal; any other error is the verdict. Voters
 * are not checked (they register later, D25; the full phase checks them).
 */
export async function preflightOnly(
  args: any,
  powers: (o: any) => Promise<unknown> = handoverDeployerPowers,
): Promise<void> {
  const log = (m: string) => (/⚠️/.test(m) ? console.log(m) : undefined);
  try {
    await powers({ ...args, deployer: stopAtFirstSend(args.deployer), log });
  } catch (e) {
    if (!(e instanceof PreflightStop)) throw e;
    console.log(
      "✅ Preflight passed: every check before the ceremony's first transaction holds (voters are checked by the full phase)",
    );
    return;
  }
  throw new Error("preflight: the deployer steps ended without a transaction");
}

/**
 * The whole CLI run for a parsed handover.json (`path` names it in errors).
 * Exported so test/production/HandoverCli.test.ts drives it in-process.
 */
export async function runHandover(
  cfg: any,
  phase = "full",
  path = "handover.json",
): Promise<void> {
  const ADDRESS_KEYS = (
    "token governanceToken identityRegistry complianceRules oracleManager " +
    "investorTypeRegistry dynamicListManager escrowWalletFactory " +
    "onchainIDFactory privacyManager zkVerifier keyManager keyManagerIdentity"
  ).split(" ");
  const LIST_KEYS =
    "oracles issuers feeWallets oracleNodes attestors extraTrusted".split(" ");
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
  if (!Number.isInteger(cfg.proposer))
    throw new Error(`${path}: "proposer" must be a wallet index`);
  // Task 5.13: a role the CLI does not sign for (a multisig) is an address.
  for (const k of ["ops", "guardian", "issuerAdmin"]) {
    const v = cfg[k];
    if (k === "issuerAdmin" && v === undefined) continue;
    if (!Number.isInteger(v) && !(typeof v === "string" && ethers.isAddress(v)))
      throw new Error(
        `${path}: "${k}" must be a wallet index, or the address of a role this signer does not hold (a multisig)`,
      );
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
  if (!["full", "accept", "audit", "preflight"].includes(phase)) {
    throw new Error(
      `HANDOVER_PHASE must be "accept", "audit", "preflight" or unset, got "${phase}"`,
    );
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
  const role = async (k: string) => {
    if (cfg[k] === undefined) return undefined;
    const r = await resolveRole(
      typeof cfg[k] === "string" ? cfg[k] : wallet(cfg[k]),
      k,
    );
    await vetRole(r, wallet(0).address); // review LOW-5
    return r;
  };

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
    ops: await role("ops"),
    guardian: await role("guardian"),
    issuerAdmin: await role("issuerAdmin"),
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
    // R-413-12: null is an assertion of absence and must reach the ceremony.
    if (k in cfg) args[k] = cfg[k] === null ? null : await at(name, cfg[k]);
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

  const snapshotPath = `${path}.snapshot.json`;
  // HANDOVER_PHASE=audit (Task 5.6b): Handover.auditHandover, which demo
  // option 83f runs too (Task 5.12).
  if (phase === "audit") return auditHandover(args);
  // HANDOVER_PHASE=preflight (Task 5.7): the full phase's checks, no send.
  if (phase === "preflight") return preflightOnly(args);
  let registryProposals: any[];
  if (phase === "accept") {
    console.log("⏭️  HANDOVER_PHASE=accept: deployer steps skipped");
    // M-1: the completion compares with what the full phase's preflight
    // found; without that file nothing proves the chain stood still.
    if (!fs.existsSync(snapshotPath)) {
      throw new Error(
        `${snapshotPath}: no preflight snapshot from the full phase; the accept phase cannot prove the chain did not change since step 1`,
      );
    }
    // B-6 (Task 5.6b): its ceremonyTxs, block and nonce bound the voting
    // window, so an edited file could launder a deployer transaction into
    // the ceremony's: the digest is checked before anything is parsed.
    const { snap, digest } = readSnapshotFile(
      snapshotPath,
      process.env.HANDOVER_SNAPSHOT_SHA256 || undefined,
    );
    console.log(`   snapshot sha256: ${digest} (matches the full phase's)`);
    if (String(snap.governance).toLowerCase() !== govAddr) {
      throw new Error(
        `${snapshotPath} was taken for governance ${snap.governance}, not ${cfg.governance}`,
      );
    }
    // L-9: the same chain, and a preflight that preceded step 1 (the first
    // AgentAdded(ops) on VSC is step 1's first transaction).
    const chainId = Number((await ethers.provider.getNetwork()).chainId);
    // L-13: both numbers must be integers; NaN compares as "fine".
    if (!Number.isInteger(snap.chainId) || !Number.isInteger(snap.block)) {
      throw new Error(
        `${snapshotPath}: "chainId" and "block" must be integers (got ${JSON.stringify(snap.chainId)}, ${JSON.stringify(snap.block)})`,
      );
    }
    if (snap.chainId !== chainId) {
      throw new Error(
        `${snapshotPath} was taken on chain ${snap.chainId}, not ${chainId}`,
      );
    }
    const token = await at("Token", await args.governance.boundTarget(3));
    const { scanLogs } = require("../demo/utils/HandoverScans");
    const grants = await scanLogs(
      token,
      token.filters.AgentAdded(await addrOf(args.ops)),
      args,
    );
    if (!grants.length) {
      throw new Error(
        `${snapshotPath}: step 1's first transaction (AgentAdded(ops) on VSC) not found from block ${cfg.fromBlock ?? 0}; cannot place the preflight`,
      );
    }
    if (snap.block > grants[0].blockNumber) {
      throw new Error(
        `${snapshotPath} was taken at block ${snap.block}, after step 1 began at block ${grants[0].blockNumber}: it is no preflight`,
      );
    }
    args.snapshot = snap.snapshot;
    console.log(`   snapshot: ${snapshotPath} (block ${snap.block})`);
    const o = await withBoundRegistry(
      await withDerivedContracts(args, console.log),
      console.log,
    );
    await preflight(o, { acceptOnly: true });
    // Task 5.13: every external role call's effect, before any vote.
    const steps = await stepsFromSnapshot(o, snap.snapshot.roleCalls);
    await requireEffects(steps, path, "Vanguard handover");
    registryProposals = await pendingRegistryProposals(o);
    await checkVoters(
      o,
      proposer,
      voters,
      (await acceptances(o)) + registryProposals.length,
    );
  } else {
    refuseFullRerun(snapshotPath, cfg.governance);
    const o = await withBoundRegistry(await withDerivedContracts(args));
    const reg = o.investorTypeRegistry;
    // Registry calls become proposals only when governance already owns it.
    const regVotes =
      reg && (await reg.owner()).toLowerCase() === govAddr
        ? (await pendingRegistryProposals(o)).length
        : 0;
    await checkVoters(o, proposer, voters, (await acceptances(o)) + regVotes);
    // B-6: an unwritable directory stops the run before step 1.
    const release = reserveSnapshotFile(snapshotPath);
    console.log("🔑 Handover: deployer powers");
    const report = await handoverDeployerPowers(args).catch((e: Error) => {
      release();
      throw e;
    });
    registryProposals = report.registryProposals;
    args.snapshot = report.snapshot; // completion compares with preflight
    const { digest, replaced } = writeSnapshotFile(snapshotPath, {
      governance: cfg.governance,
      chainId: Number((await ethers.provider.getNetwork()).chainId),
      block: report.preflightBlock, // L-9: the block the preflight read
      snapshot: report.snapshot,
    });
    console.log(`   snapshot written: ${snapshotPath}`);
    if (replaced)
      console.log(`   (replaced a snapshot with sha256 ${replaced})`);
    console.log(
      `   snapshot sha256: ${digest} (in ${sidecarOf(snapshotPath)}; record this line outside the run directory)`,
    );
    // Task 5.13: external roles' calls go to their owners; stop (exit 3).
    if (report.snapshot.roleCalls) {
      const steps = await stepsFromSnapshot(args, report.snapshot.roleCalls);
      await requireEffects(steps, path, "Vanguard handover", { fresh: true });
    }
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
    if (e.name === "RoleCallsPending") {
      // Task 5.13: paused, not done (exit 3): execute, then resume.
      console.log(e.lines.join("\n"));
      console.log(
        "   execute each file in its multisig, then run HANDOVER_PHASE=accept (with HANDOVER_SNAPSHOT_SHA256)",
      );
      process.exitCode = 3;
      return;
    }
    console.error(`❌ Handover failed: ${e.message}`);
    process.exitCode = 1;
  });
}
