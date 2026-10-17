/**
 * The handover.json checks scripts/handover.ts makes before anything is
 * read from the chain (moved out of it in plan v2 Task 5.15 to keep it
 * under 500 lines): known keys only, addresses where addresses belong,
 * roles as wallet indices or (Task 5.13) the address of a role the signer
 * does not hold, and a known HANDOVER_PHASE. Throws naming the file.
 */
import { ethers } from "hardhat";

const { resolveRole, vetRole } = require("../demo/utils/RoleCalls");

export function validateHandoverConfig(
  cfg: any,
  phase: string,
  path: string,
): void {
  const ADDRESS_KEYS = (
    "token governanceToken identityRegistry complianceRules oracleManager " +
    "investorTypeRegistry dynamicListManager escrowWalletFactory " +
    "onchainIDFactory privacyManager zkVerifier keyManager keyManagerIdentity"
  ).split(" ");
  const LIST_KEYS =
    "oracles issuers feeWallets oracleNodes attestors extraTrusted claimSigners".split(
      " ",
    );
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
}

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

/**
 * The ceremony's arguments for a checked handover.json: the signer's
 * wallets by index, the roles (an address is external, Task 5.13; vetted,
 * review LOW-5), the config's lists, governance, and every contract the
 * config names (null asserts absence, R-413-12). `wallet(i)` refuses an
 * index the signer does not hold. Shared by scripts/handover.ts and the
 * post-ceremony CLIs (scripts/production/postCeremonyVotes.ts,
 * claimSigners.ts).
 */
export async function handoverArgs(
  cfg: any,
  phase: string,
  path: string,
): Promise<{ args: Record<string, any>; wallet: (i: number) => any }> {
  validateHandoverConfig(cfg, phase, path);
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
    // Task 5.15 (Q17 = A): claim signers the day-2 audit accepts, and the
    // voters, whose keys may not be one of them.
    claimSigners: cfg.claimSigners || [],
    voterWallets: [cfg.proposer, ...cfg.voters].map(wallet),
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
  return { args, wallet };
}
