/**
 * Voter onboarding on a production deploy (plan v2 Task 5.15, readiness
 * review H-2; runbook section 3, D25), on any chain, through the external
 * signer: the handover.json's proposer and voters become verified
 * identities by the demo's one onboarding path (demo/utils/Onboard.js:
 * the OnchainID, the KYC and AML claims the issuers' owner signs, the
 * registry entry, the verification cache), and each is topped up to
 * VOTER_VGT (default 1,000) VGT, minted by the deployer (a VGT agent
 * until the ceremony). Every step is read back first, so a re-run sends
 * only what is missing. Nothing moves the clock: it prints when each
 * identity is old enough to vote (registeredAt + governance.minVoterAge)
 * and the earliest time the ceremony's full phase can pass its voter check.
 *
 *   SIGNER_RPC_URL=http://127.0.0.1:1248 DEPLOY_RECORD=<record> \
 *     HANDOVER_CONFIG=<handover.json> \
 *     npx hardhat run scripts/production/onboardVoters.ts --network remote
 *
 * Refused: an incomplete record, a chain other than the record's, a voter
 * that is the deployer, a role or a consensus node (D25 b: one key never
 * both runs the system and votes), and a run after the ceremony (the
 * deployer then registers no one: ops does, by its own path).
 */
import * as fs from "fs";
import { ethers, network } from "hardhat";

const DemoState = require("../../demo/core/DemoState");
const { onboard } = require("../../demo/utils/Onboard");
const { installRetry } = require("../../demo/utils/RpcRetry");

const ARTIFACT: Record<string, string> = {
  onchainIDFactory: "OnchainIDFactory",
  identityRegistry: "IdentityRegistry",
  kycIssuer: "ClaimIssuer",
  amlIssuer: "ClaimIssuer",
  complianceRules: "ComplianceRules",
  digitalToken: "Token",
  governanceToken: "GovernanceToken",
  vanguardGovernance: "VanguardGovernance",
};

/** When `wallet` may vote: { identity, registeredAt, eligibleAt } (unix s). */
async function eligibility(state: any, wallet: string) {
  const reg = state.getContract("identityRegistry");
  const gov = state.getContract("vanguardGovernance");
  const identity = await reg.identity(wallet);
  const registeredAt = Number(await reg.identityRegisteredAt(identity));
  return {
    identity,
    registeredAt,
    eligibleAt: registeredAt + Number(await gov.minVoterAge()),
  };
}

/** Onboard every voter of `cfg` on the deploy `rec`; returns the latest eligibleAt. */
export async function onboardVoters(
  rec: any,
  cfg: any,
  log: (m: string) => void = console.log,
): Promise<number> {
  if (!rec.complete) throw new Error("the deploy record is not complete");
  const chainId = Number((await ethers.provider.getNetwork()).chainId);
  if (rec.chainId !== chainId) {
    throw new Error(
      `the deploy record is for chain ${rec.chainId}, not ${chainId}`,
    );
  }
  const state = new DemoState();
  state.signers = await ethers.getSigners();
  for (const [k, name] of Object.entries(ARTIFACT)) {
    state.setContract(k, await ethers.getContractAt(name, rec.contracts[k]));
  }
  const reg = state.getContract("identityRegistry");
  const vgt = state.getContract("governanceToken");
  const deployer = state.signers[0];
  if (
    !(await reg.isAgent(deployer.address)) ||
    !(await vgt.isAgent(deployer.address))
  ) {
    throw new Error(
      "the deployer is no longer an IdentityRegistry and VGT agent (the ceremony ran): ops registers voters after it",
    );
  }
  const roles = new Set<string>(
    [deployer.address, ...(cfg.oracleNodes || [])].map((a: string) =>
      a.toLowerCase(),
    ),
  );
  for (const k of ["ops", "guardian", "issuerAdmin"]) {
    const v = cfg[k];
    const a = typeof v === "string" ? v : state.signers[v]?.address;
    if (a) roles.add(a.toLowerCase());
  }
  const target = ethers.parseEther(process.env.VOTER_VGT || "1000");
  let last = 0;
  for (const i of [cfg.proposer, ...cfg.voters]) {
    const s = state.signers[i];
    if (!s) throw new Error(`wallet ${i} is not an account of the signer`);
    if (roles.has(s.address.toLowerCase())) {
      throw new Error(
        `wallet ${i} ${s.address} is the deployer, a role or a consensus node: a voter is a key of its own (D25 b)`,
      );
    }
    const r = await onboard(state, s.address, { label: `voter ${i}` });
    if (!r.verified) throw new Error(`wallet ${i} ${s.address} did not verify`);
    const bal = await vgt.balanceOf(s.address);
    if (bal < target) await (await vgt.mint(s.address, target - bal)).wait();
    const e = await eligibility(state, s.address);
    last = Math.max(last, e.eligibleAt);
    log(
      `   ✅ wallet ${i} ${s.address}: verified (identity ${e.identity}), ${ethers.formatEther(target > bal ? target : bal)} VGT${r.created || r.registered || r.attested ? "" : " (already onboarded)"}; votes from ${new Date(e.eligibleAt * 1000).toISOString()}`,
    );
  }
  const now = (await ethers.provider.getBlock("latest"))!.timestamp;
  log(
    last > now
      ? `⏳ voters registered; the ceremony's full phase passes its voter check from ${new Date(last * 1000).toISOString()} (chain time now ${new Date(now * 1000).toISOString()}, ${last - now} s to wait)`
      : "✅ voters registered and old enough to vote now",
  );
  return last;
}

async function main(): Promise<void> {
  installRetry(network.provider);
  const read = (k: string) => {
    const f = process.env[k];
    if (!f) throw new Error(`set ${k}`);
    return JSON.parse(fs.readFileSync(f, "utf8"));
  };
  await onboardVoters(read("DEPLOY_RECORD"), read("HANDOVER_CONFIG"));
}

if (require.main === module) {
  main().catch((e) => {
    console.error(`❌ ${e.message}`);
    process.exitCode = 1;
  });
}
