/**
 * Claim signers after the ceremony (plan v2 Task 5.15, owner Q17 = A;
 * readiness review M-2). A Safe issuer admin cannot sign claims (the
 * issuers check EIP-191 signatures only, no ERC-1271), so once the
 * ceremony revoked the deployer's key no claim can be issued until the
 * admin adds an EOA CLAIM_SIGNER key. This exports, as the issuer admin's
 * Safe batch (the Task 5.13 RoleCalls path), one addIssuerKey per issuer:
 * a KYC signer on the KYC issuer and a separate AML signer on the AML
 * issuer (purpose 3, CLAIM_SIGNER; never MANAGEMENT). Exit 3 while the
 * batch waits for its owners; a re-run proves each effect on chain, and
 * refuses another one. An issuer admin the signer holds sends the calls.
 *
 *   CLAIM_SIGNERS=kyc:0xA,aml:0xB DEPLOY_RECORD=<record> \
 *     HANDOVER_CONFIG=<handover.json> \
 *     npx hardhat run scripts/production/claimSigners.ts --network remote
 *
 * Refused before any export: an issuer the ceremony has not handed to the
 * issuer admin (or still carrying the deployer's key), the same key for
 * both, a key that is the deployer's, governance's, a role's, a node's or
 * a voter's (D25 b), or one the issuer revoked before (a revoked key
 * cannot be added again: choose another). Then list both addresses in
 * handover.json "claimSigners": the day-2 audit accepts them there.
 */
import * as fs from "fs";
import { ethers, network } from "hardhat";
import { handoverArgs } from "../handoverConfig";
import { guardDeployer } from "./cliGuards";

const { installRetry } = require("../../demo/utils/RpcRetry");
const { scrubKnown } = require("./redact");
const { requireEffects } = require("../../demo/utils/RoleCalls");
const { addrOf, same } = require("../../demo/utils/HandoverChecks");

const CLAIM_SIGNER = 3;
const keyOf = (a: string) => ethers.solidityPackedKeccak256(["address"], [a]);

/** CLAIM_SIGNERS "kyc:0xA,aml:0xB" as { kyc, aml }. */
export function parseSigners(text = ""): { kyc: string; aml: string } {
  const out: Record<string, string> = {};
  for (const part of text
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean)) {
    const [k, a] = part.split(":");
    if (!["kyc", "aml"].includes(k) || !ethers.isAddress(a)) {
      throw new Error(
        `CLAIM_SIGNERS: "${part}" is not kyc:<address> or aml:<address>`,
      );
    }
    out[k] = ethers.getAddress(a);
  }
  if (!out.kyc || !out.aml)
    throw new Error("CLAIM_SIGNERS names kyc:<address>,aml:<address>");
  if (same(out.kyc, out.aml))
    throw new Error("the KYC and AML claim signers must be separate keys");
  return out as { kyc: string; aml: string };
}

/** "done" | "pending" | why, for `signer` as a CLAIM_SIGNER key of `issuer`. */
async function signerStatus(issuer: any, signer: string): Promise<string> {
  const k = await issuer.issuerKeys(keyOf(signer));
  if (k.key === ethers.ZeroHash) return "pending";
  if (k.revoked)
    return `${signer}'s key was revoked on this issuer; a revoked key cannot be added again`;
  if (Number(k.purpose) !== CLAIM_SIGNER)
    return `${signer} holds purpose ${k.purpose}, not CLAIM_SIGNER (3)`;
  return "done";
}

/** The two role steps, after every refusal above. */
export async function claimSignerSteps(
  o: any,
  rec: any,
  signers: { kyc: string; aml: string },
  voters: any[],
) {
  const admin = o.issuerAdmin;
  if (!admin) throw new Error(`handover.json names no "issuerAdmin"`);
  const adminAddr = await addrOf(admin);
  const dAddr = await addrOf(o.deployer);
  const taken = [
    dAddr,
    await addrOf(o.governance),
    adminAddr,
    ...(o.oracleNodes || []),
  ];
  for (const r of [o.ops, o.guardian, ...voters])
    if (r) taken.push(await addrOf(r));
  const steps = [];
  for (const [kind, signer] of Object.entries(signers)) {
    if (taken.some((a) => same(a, signer))) {
      throw new Error(
        `${kind} claim signer ${signer} is the deployer, governance, a role, a node or a voter: a claim signer is a key of its own (D25 b)`,
      );
    }
    const issuer = await ethers.getContractAt(
      "ClaimIssuer",
      rec.contracts[`${kind}Issuer`],
    );
    const label = kind.toUpperCase();
    const deployerKey = await issuer.issuerKeys(keyOf(dAddr));
    if (
      !same(await issuer.owner(), adminAddr) ||
      (deployerKey.key !== ethers.ZeroHash && !deployerKey.revoked)
    ) {
      throw new Error(
        `the ${label} issuer is not the issuer admin's alone yet (owner ${await issuer.owner()}): finish the ceremony first`,
      );
    }
    const st = await signerStatus(issuer, signer);
    if (st !== "done" && st !== "pending")
      throw new Error(`${label} claim signer: ${st}`);
    steps.push({
      id: `claimSigners.${kind}`,
      role: admin,
      roleLabel: "issuerAdmin",
      contract: issuer,
      name: "ClaimIssuer",
      fn: "addIssuerKey",
      args: [keyOf(signer), CLAIM_SIGNER, 1],
      purpose: `the ${label} issuer accepts claims signed by ${signer} (CLAIM_SIGNER, an EOA: the Safe cannot sign, M-2)`,
      status: () => signerStatus(issuer, signer),
    });
  }
  return steps;
}

/**
 * Whether `issuer` accepts a claim `signer` signs (ClaimIssuer.verifyClaim,
 * a read): a probe claim on `identity`, signed through the external
 * signer, nothing issued.
 */
export async function probeSignature(
  issuer: any,
  signer: any,
  identity: string,
): Promise<boolean> {
  const { signClaim } = require("../../demo/utils/Kyc");
  const data = ethers.toUtf8Bytes("claim-signer probe");
  const sig = await signClaim(signer, issuer, identity, 6, data, {});
  return issuer.verifyClaim(identity, 6, 1, data, "", 0, sig);
}

async function main(): Promise<void> {
  installRetry(network.provider);
  const read = (k: string) => {
    const f = process.env[k];
    if (!f) throw new Error(`set ${k}`);
    return [f, JSON.parse(fs.readFileSync(f, "utf8"))];
  };
  const [path, cfg] = read("HANDOVER_CONFIG");
  const [, rec] = read("DEPLOY_RECORD");
  const { args, wallet } = await handoverArgs(cfg, "audit", path);
  guardDeployer(args.deployer, args.governance); // R-56-5
  const voters = [cfg.proposer, ...cfg.voters].map(wallet);
  const steps = await claimSignerSteps(
    args,
    rec,
    parseSigners(process.env.CLAIM_SIGNERS),
    voters,
  );
  if (!args.issuerAdmin.external) {
    for (const s of steps) {
      if ((await s.status()) === "pending") {
        const c: any = s.contract.connect(args.issuerAdmin);
        await (await c[s.fn](...s.args)).wait();
      }
    }
  }
  const base = `${path}.claim-signers`;
  const fresh = !fs.existsSync(`${base}.issuer-admin-transactions.json`);
  await requireEffects(steps, base, "Vanguard claim signers", { fresh });
  for (const s of steps) console.log(`   ✅ ${s.purpose}: live`);
  // The issuer accepts each new key's signature, where the signer holds it.
  const held = (await ethers.getSigners()).map((x) => x.address.toLowerCase());
  const probe = await addrOf(voters[0]);
  for (const s of steps) {
    const who = s.purpose.match(/signed by (0x[0-9a-fA-F]{40})/)![1];
    if (!held.includes(who.toLowerCase())) {
      console.log(`   ℹ️  probe skipped: the signer does not hold ${who}`);
      continue;
    }
    const ok = await probeSignature(
      s.contract,
      await ethers.getSigner(who),
      probe,
    );
    if (!ok) throw new Error(`the issuer refuses a claim signed by ${who}`);
    console.log(
      `   ✅ a claim signed by ${who} verifies on ${await s.contract.getAddress()} (verifyClaim)`,
    );
  }
  console.log(
    `   add both to handover.json: "claimSigners": ${JSON.stringify(Object.values(parseSigners(process.env.CLAIM_SIGNERS)))} (the day-2 audit accepts them there)`,
  );
}

if (require.main === module) {
  main().catch((e) => {
    if (e.name === "RoleCallsPending") {
      console.log(e.lines.join("\n"));
      console.log(
        "   execute it in the issuer admin's Safe, then run this again: it checks the effects on chain",
      );
      process.exitCode = 3;
      return;
    }
    console.error(`❌ Claim signers failed: ${scrubKnown(e.message)}`);
    process.exitCode = 1;
  });
}
