/**
 * The handover.json checks scripts/handover.ts makes before anything is
 * read from the chain (moved out of it in plan v2 Task 5.15 to keep it
 * under 500 lines): known keys only, addresses where addresses belong,
 * roles as wallet indices or (Task 5.13) the address of a role the signer
 * does not hold, and a known HANDOVER_PHASE. Throws naming the file.
 */
import { ethers } from "ethers";

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
}
