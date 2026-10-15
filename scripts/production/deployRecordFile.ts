/**
 * Plan v2 Task 5.7: the deploy record's file, deployments/<chainId>.json
 * (DEPLOY_RECORD overrides the path): its shape, the atomic write and the
 * read. The provider hook that fills it: deployRecord.ts.
 */
import * as fs from "fs";
import * as path from "path";

export interface TxEntry {
  from: string;
  to: string | null;
  value: string;
  dataHash: string;
  gas?: string;
  nonce: number;
  /** The latest block when the intent was written: replay reads here. */
  block: number;
  hash?: string;
  status: "sending" | "sent" | "confirmed" | "reverted";
  contract?: string;
  codeHash?: string;
  gasUsed?: string;
  label: string;
}

export interface DeployRecord {
  version: 1;
  chainId: number;
  configDigest: string;
  deployer: string;
  /** The block before the first deploy transaction: the scans' start. */
  fromBlock: number;
  /** Random, made with the record: identity salts derive from it. */
  salt: string;
  txs: TxEntry[];
  contracts: Record<string, string>;
  complete: boolean;
}

export function recordPath(chainId: number): string {
  return (
    process.env.DEPLOY_RECORD || path.join("deployments", `${chainId}.json`)
  );
}

/** Write `rec` to `file` atomically: temp file, fsync, rename. */
export function saveRecord(file: string, rec: DeployRecord): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  const fd = fs.openSync(tmp, "w");
  try {
    fs.writeSync(fd, JSON.stringify(rec, null, 2) + "\n");
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
}

export function loadRecord(file: string): DeployRecord | null {
  if (!fs.existsSync(file)) return null;
  const rec = JSON.parse(fs.readFileSync(file, "utf8"));
  if (
    rec.version !== 1 ||
    !Number.isInteger(rec.chainId) ||
    !Array.isArray(rec.txs)
  ) {
    throw new Error(`${file}: not a deploy record (version 1)`);
  }
  return rec;
}
