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
 *     "investorTypeRegistry": "0x..",          // optional
 *     "oracles": ["0x..", "0x..", "0x.."],      // optional, one-step Ownable
 *     "issuers": ["0x..", "0x.."],              // optional, ClaimIssuer
 *     "ops": 10, "guardian": 11, "proposer": 1, "voters": [2, 3, 6]
 *   }
 *
 * Exits non-zero on any failure. The ceremony itself is demo/utils/Handover.js.
 */
// ponytail: a JSON file via HANDOVER_CONFIG is the ceiling (hardhat run has no
// argv passthrough); a typed CLI can replace it later.
import { ethers } from "hardhat";
import * as fs from "fs";

const {
  ACCEPTANCE_PLAN,
  handoverDeployerPowers,
  acceptAllByVote,
  assertHandoverComplete,
} = require("../demo/utils/Handover");

async function main(): Promise<void> {
  const path = process.env.HANDOVER_CONFIG;
  if (!path) throw new Error("set HANDOVER_CONFIG to the handover JSON file");
  const cfg = JSON.parse(fs.readFileSync(path, "utf8"));
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
    deployer: wallet(0),
    ops: wallet(cfg.ops),
    guardian: wallet(cfg.guardian),
    governance: await at("VanguardGovernance", cfg.governance),
    token: await at("Token", cfg.token),
    governanceToken: await at("GovernanceToken", cfg.governanceToken),
    identityRegistry: await at("IdentityRegistry", cfg.identityRegistry),
    complianceRules: await at("ComplianceRules", cfg.complianceRules),
    oracleManager: await at("OracleManager", cfg.oracleManager),
    investorTypeRegistry: cfg.investorTypeRegistry
      ? await at("InvestorTypeRegistry", cfg.investorTypeRegistry)
      : undefined,
    oracles: await Promise.all(
      (cfg.oracles || []).map((a: string) =>
        at("@openzeppelin/contracts/access/Ownable.sol:Ownable", a),
      ),
    ),
    issuers: await Promise.all(
      (cfg.issuers || []).map((a: string) => at("ClaimIssuer", a)),
    ),
  };

  console.log("🔑 Handover: deployer powers");
  const report = await handoverDeployerPowers(args);

  console.log("\n🏛️  Handover: governance accepts by vote");
  const contracts: Record<string, any> = {};
  for (const e of ACCEPTANCE_PLAN) contracts[e.key] = (args as any)[e.key];
  await acceptAllByVote({
    governance: args.governance,
    contracts,
    proposer: wallet(cfg.proposer),
    voters: cfg.voters.map(wallet),
    registryProposals: report.registryProposals,
  });

  console.log("\n🔍 Handover: verify");
  const { ok, checks } = await assertHandoverComplete(args);
  for (const c of checks) console.log(`   ${c.ok ? "✅" : "❌"} ${c.label}`);
  if (!ok) throw new Error("handover incomplete (see ❌ above)");
  console.log("\n✅ Handover complete: the deployer holds no power.");
}

main().catch((e) => {
  console.error(`❌ Handover failed: ${e.message}`);
  process.exitCode = 1;
});
