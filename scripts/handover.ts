/**
 * Handover ceremony CLI (plan v2 Task 2C.1). The deployer (wallet 0) gives up
 * every power; governance takes the core contracts by vote.
 *
 *   HANDOVER_CONFIG=handover.json npx hardhat run scripts/handover.ts --network <net>
 *
 * handover.json (addresses, wallet indices from docs/TESTNET_DEMO.md):
 *   {
 *     "token": "0x..", "governanceToken": "0x..", "identityRegistry": "0x..",
 *     "complianceRules": "0x..",
 *     "oracleManager": "0x..", "governance": "0x..",
 *     "investorTypeRegistry": "0x..",          // optional, in the plan (type 0)
 *     "dynamicListManager": "0x..",            // optional, demo option 84
 *     "escrowWalletFactory": "0x.." | null,     // required key (2F.5), null = not deployed
 *     "onchainIDFactory": "0x.." | null,        // required key (2F.5), null = not deployed
 *     "privacyManager": "0x.." | null,          // required key (3.3), null = not deployed
 *     "zkVerifier": "0x.." | null,              // required key (3.3), ZKVerifierIntegrated
 *     "keyManager": "0x..",                     // KeyManager (4.2); required when
 *                                               // onchainIDFactory pins it (4.11)
 *     "keyManagerIdentity": "0x..",             // optional (4.2), the demo OnchainID
 *     "oracles": ["0x..", "0x.."],              // optional, one-step Ownable
 *     "issuers": ["0x..", "0x.."],              // optional, ClaimIssuer
 *     "feeWallets": ["0x.."],                   // optional, escrow fee wallets to check
 *     "fromBlock": 1234567,                     // optional, <= the IdentityRegistry deploy block
 *     "logChunk": 5000,                         // optional, eth_getLogs block range
 *     "ops": 10, "guardian": 11, "issuerAdmin": 9,
 *     "proposer": 1, "voters": [2, 3, 6]
 *   }
 *
 * The power set is read from chain (demo/utils/HandoverPowers.js): an
 * "oracles"/"issuers" list that omits a contract bound on chain is refused;
 * leave a list out to use the chain's set. "issuerAdmin" (a wallet index,
 * not ops/guardian/deployer) is required whenever the registry trusts an
 * issuer: the ceremony hands every deployer-held issuer to it (D25 b).
 * Both factory keys must be present; null states "none". The OnchainIDFactory
 * is unreachable from the core contracts, so only the config names it; the
 * escrow factory is also read from every trusted escrow's factory(), and a
 * config that does not name it is refused. The two privacy keys follow the
 * same rule (3.3): null is refused when governance is already bound to the
 * contract (types 11/12), "zkVerifier" must be the verifier PrivacyManager
 * uses (so null is refused whenever a PrivacyManager is named), a
 * PrivacyManager ComplianceRules wires for VSC or VGT (3.4) counts as bound
 * (it must be named, and two different ones wired or bound are refused), a
 * testingMode verifier is refused, and so is any PrivacyManager, wrapper or
 * circuit verifier whose runtime code hash is not the compiled artifact's
 * (demo/utils/HandoverCodeHash.js; the refusal names both hashes and is
 * printed unchanged after "❌ Handover failed: "). A "fromBlock" after the
 * IdentityRegistry deploy is refused (the scans would miss earlier agents).
 * KeyManager (4.2) has no owner, so nothing is handed over: a "keyManager"
 * with no code, or whose code is not the compiled KeyManager, is refused,
 * and so is a "keyManagerIdentity" that has not authorized it, that the
 * deployer owns, manages, holds a MANAGEMENT key on or is a recovery agent
 * of (4.11), that does not pin it as its recovery manager or that
 * authorizes any other manager (getManagers() must be exactly [KeyManager],
 * 4.11), or that is named without "keyManager"; the completion check
 * proves the deployer holds no KeyManager power and that the identity
 * authorizes it (demo/utils/HandoverKeys.js). A named "onchainIDFactory"
 * is checked with or without "keyManager": its recoveryManagerCodeHash
 * must be zero or the compiled KeyManager's, and a recovery manager it
 * pins must be named as "keyManager" (4.11). OracleManager (4.4) must bind a consensus
 * engine whose code is the compiled ConsensusOracle and that serves it
 * (the engine has no owner, so it is not handed over); the deployer step
 * makes ops the manager's operator, and an operator other than ops is
 * refused once governance owns the manager (demo/utils/HandoverOracles.js).
 *
 * Every contract in ACCEPTANCE_PLAN (demo/utils/HandoverChecks.js) given here
 * is nominated and accepted by vote, InvestorTypeRegistry included; a
 * preflight refuses to start before the first transaction if any
 * precondition fails. Exits non-zero on any failure. The ceremony itself is
 * demo/utils/Handover.js.
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

/**
 * The whole CLI run for a parsed handover.json (`path` names it in errors).
 * Exported so test/production/HandoverCli.test.ts drives it in-process.
 */
export async function runHandover(
  cfg: any,
  phase = "full",
  path = "handover.json",
): Promise<void> {
  for (const k of [
    "token",
    "governanceToken",
    "identityRegistry",
    "complianceRules",
    "oracleManager",
    "governance",
  ]) {
    if (!cfg[k]) throw new Error(`${path}: missing "${k}" address`);
  }
  for (const k of ["ops", "guardian", "proposer"]) {
    if (!Number.isInteger(cfg[k]))
      throw new Error(`${path}: "${k}" must be a wallet index`);
  }
  if (cfg.issuerAdmin !== undefined && !Number.isInteger(cfg.issuerAdmin)) {
    throw new Error(`${path}: "issuerAdmin" must be a wallet index`);
  }
  for (const k of [
    "escrowWalletFactory",
    "onchainIDFactory",
    "privacyManager",
    "zkVerifier",
  ]) {
    if (!(k in cfg)) {
      throw new Error(
        `${path}: missing "${k}" (an address, or null when not deployed): the deployer owns it until the ceremony hands it over`,
      );
    }
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

  const args = {
    // Start of the trusted-contract event scan (the check reads logs in
    // chunks from here to the latest block).
    fromBlock: cfg.fromBlock,
    logChunk: cfg.logChunk,
    deployer: wallet(0),
    ops: wallet(cfg.ops),
    guardian: wallet(cfg.guardian),
    issuerAdmin:
      cfg.issuerAdmin === undefined ? undefined : wallet(cfg.issuerAdmin),
    feeWallets: cfg.feeWallets,
    governance: await at("VanguardGovernance", cfg.governance),
    token: await at("Token", cfg.token),
    governanceToken: await at("GovernanceToken", cfg.governanceToken),
    identityRegistry: await at("IdentityRegistry", cfg.identityRegistry),
    complianceRules: await at("ComplianceRules", cfg.complianceRules),
    oracleManager: await at("OracleManager", cfg.oracleManager),
    investorTypeRegistry: cfg.investorTypeRegistry
      ? await at("InvestorTypeRegistry", cfg.investorTypeRegistry)
      : undefined,
    dynamicListManager: cfg.dynamicListManager
      ? await at("DynamicListManager", cfg.dynamicListManager)
      : undefined,
    escrowWalletFactory: cfg.escrowWalletFactory
      ? await at("EscrowWalletFactory", cfg.escrowWalletFactory)
      : undefined,
    onchainIDFactory: cfg.onchainIDFactory
      ? await at("OnchainIDFactory", cfg.onchainIDFactory)
      : undefined,
    privacyManager: cfg.privacyManager
      ? await at("PrivacyManager", cfg.privacyManager)
      : undefined,
    zkVerifier: cfg.zkVerifier
      ? await at("ZKVerifierIntegrated", cfg.zkVerifier)
      : undefined,
    keyManager: cfg.keyManager
      ? await at("KeyManager", cfg.keyManager)
      : undefined,
    keyManagerIdentity: cfg.keyManagerIdentity,
    // Left out: the ceremony uses the set read from chain.
    oracles: cfg.oracles
      ? await Promise.all(
          cfg.oracles.map((a: string) => ethers.getContractAt(ORACLE_ABI, a)),
        )
      : undefined,
    issuers: cfg.issuers
      ? await Promise.all(cfg.issuers.map((a: string) => at("ClaimIssuer", a)))
      : undefined,
  };

  const proposer = wallet(cfg.proposer);
  const voters = cfg.voters.map(wallet);
  const govAddr = cfg.governance.toLowerCase();
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
    const o = await withBoundRegistry(args, console.log);
    await preflight(o, { acceptOnly: true });
    registryProposals = await pendingRegistryProposals(o);
    await checkVoters(
      o,
      proposer,
      voters,
      (await acceptances(o)) + registryProposals.length,
    );
  } else {
    const o = await withBoundRegistry(args);
    const reg = o.investorTypeRegistry;
    // Registry calls become proposals only when governance already owns it.
    const regVotes =
      reg && (await reg.owner()).toLowerCase() === govAddr
        ? (await pendingRegistryProposals(o)).length
        : 0;
    await checkVoters(o, proposer, voters, (await acceptances(o)) + regVotes);
    console.log("🔑 Handover: deployer powers");
    registryProposals = (await handoverDeployerPowers(args)).registryProposals;
  }

  console.log("\n🏛️  Handover: governance accepts by vote");
  const contracts: Record<string, any> = {};
  for (const e of ACCEPTANCE_PLAN) contracts[e.key] = (args as any)[e.key];
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
