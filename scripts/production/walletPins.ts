/**
 * Task 5.17 slice B (deep review M-2): handover.json's wallet indices
 * pinned to addresses.
 *
 * The external signer (scripts/production/signer.js) orders its keystores
 * by file name, and handover.json names the deployer, the roles, the
 * proposer and the voters by index into that order. A keystore added
 * between phases (claim-kyc.json sorts before deployer.json) shifted every
 * role with nothing noticing. So handover.json carries "accounts": the
 * address each index it uses had when it was written,
 *
 *   "accounts": { "0": "0xDeployer…", "1": "0xOps…", "4": "0xProposer…" }
 *
 * and every phase and post-ceremony CLI refuses, before any send, a
 * signer whose wallet at a pinned index is another address. The pins are
 * required off the dev chain (31337) and whenever a deploy record is
 * named; there wallet 0 must also be the record's deployer. On 31337
 * with no record (the demo, the tests) a config without pins is read as
 * before; one with pins is checked the same way.
 */
import * as fs from "fs";
import { ethers } from "hardhat";
import { loadRecord, recordPath } from "./deployRecordFile";

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const DEV_CHAIN = 31337;

/** Each wallet index `cfg` uses -> the roles it holds there. */
export function usedIndices(cfg: any): Map<number, string[]> {
  const m = new Map<number, string[]>();
  const add = (i: unknown, role: string) => {
    if (Number.isInteger(i))
      m.set(i as number, [...(m.get(i as number) || []), role]);
  };
  add(0, "deployer");
  for (const k of ["ops", "guardian", "issuerAdmin"]) add(cfg[k], k);
  add(cfg.proposer, "proposer");
  for (const v of cfg.voters || []) add(v, "voter");
  return m;
}

/** The "accounts" pins for `cfg`, from the signer's accounts in order. */
export function pinsFor(cfg: any, accounts: string[]): Record<string, string> {
  const pins: Record<string, string> = {};
  for (const i of [...usedIndices(cfg).keys()].sort((a, b) => a - b)) {
    if (!accounts[i])
      throw new Error(`wallet ${i} is not an account of the signer`);
    pins[String(i)] = ethers.getAddress(accounts[i]);
  }
  return pins;
}

/** "accounts", when present: an object of wallet index -> address. */
export function validatePins(cfg: any, path: string): void {
  if (cfg.accounts === undefined) return;
  const a = cfg.accounts;
  const ok =
    a &&
    typeof a === "object" &&
    !Array.isArray(a) &&
    Object.entries(a).every(
      ([k, v]) => /^(0|[1-9][0-9]*)$/.test(k) && ethers.isAddress(v as string),
    );
  if (!ok) {
    throw new Error(
      `${path}: "accounts" must map wallet indices to addresses ({ "0": "0x…" })`,
    );
  }
}

/**
 * The deploy record a run names: DEPLOY_RECORD, or (off the dev chain,
 * where a default-path file is a leftover of local runs)
 * deployments/<chainId>.json when it exists.
 */
export function namedRecord(
  chainId: number,
): { file: string; deployer: string } | null {
  if (!process.env.DEPLOY_RECORD && chainId === DEV_CHAIN) return null;
  const file = recordPath(chainId);
  if (!fs.existsSync(file)) return null;
  return { file, deployer: loadRecord(file)!.deployer };
}

/**
 * Refuse (throw) a signer whose wallets are not the ones `cfg` pins, and
 * a wallet 0 that is not the named record's deployer. `wallets` are the
 * signer's accounts in index order. Call before any send.
 */
export function checkWallets(
  cfg: any,
  wallets: { address: string }[],
  path: string,
  chainId: number,
  record = namedRecord(chainId),
): void {
  validatePins(cfg, path);
  if (cfg.accounts === undefined) {
    if (chainId !== DEV_CHAIN || record) {
      throw new Error(
        `${path}: no "accounts" pins (wallet index -> address), required on chain ${chainId}${record ? ` and with the deploy record ${record.file}` : ""}: the signer orders its keystores by file name, so an index alone can name another key (deep review M-2); write them from the signer's eth_accounts`,
      );
    }
  } else {
    for (const [i, roles] of usedIndices(cfg)) {
      const pin = cfg.accounts[String(i)];
      const got = wallets[i]?.address;
      if (!pin) {
        throw new Error(
          `${path}: wallet ${i} (${roles.join(", ")}) has no "accounts" pin`,
        );
      }
      if (!got || !same(got, pin)) {
        throw new Error(
          `${path}: wallet ${i} (${roles.join(", ")}) is ${got ?? "missing"} but "accounts" pins ${ethers.getAddress(pin)}: the signer's keystores changed (a file added, removed or renamed?); refusing before any send`,
        );
      }
    }
  }
  if (record && !same(wallets[0]?.address ?? "", record.deployer)) {
    throw new Error(
      `wallet 0 is ${wallets[0]?.address ?? "missing"} but the deploy record ${record.file} names the deployer ${record.deployer}: refusing before any send`,
    );
  }
}
