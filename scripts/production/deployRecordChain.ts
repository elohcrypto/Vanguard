/**
 * What the chain says about one deploy record entry, for the Recorder
 * (deployRecord.ts): its receipt once it has its confirmations, the
 * transaction mined at its nonce, and the re-check a "never mined"
 * answer needs first.
 *
 * Review D-2: one lagging read (a load-balanced backend that has not
 * imported the block and never saw the transaction) used to drop a mined
 * transaction from the record; a re-run then sent that step again, or
 * refused every resume. Now nothing is concluded unmined before it is
 * read again two blocks later with fresh nonce counts, and an entry whose
 * receipt a node ever returned (minedAt) is never dropped.
 */
import { ethers } from "hardhat";
import { DeployRecord, TxEntry } from "./deployRecordFile";

/** Thrown when a re-run cannot follow its record: nothing more is sent. */
export class RecordRefusal extends Error {
  name = "RecordRefusal";
}

export type Raw = (method: string, params?: unknown[]) => Promise<any>;

const same = (a?: string | null, b?: string | null) =>
  String(a ?? "").toLowerCase() === String(b ?? "").toLowerCase();
const LOCAL = new Set([31337]);
/** Seconds a stuck head may take before the re-check gives up. */
const HEAD_WAIT = 120;

export class EntryChain {
  constructor(
    private raw: Raw,
    private rec: DeployRecord,
    private confirmations: number,
    private log: (m: string) => void,
    private save: () => void,
  ) {}

  count = async (from: string, tag: string) =>
    Number(await this.raw("eth_getTransactionCount", [from, tag]));

  /** `t` (a mined transaction) is record entry `e` in every field. */
  sameTx(e: TxEntry, t: any): boolean {
    return (
      same(t.from, e.from) &&
      Number(t.nonce) === e.nonce &&
      same(t.to, e.to) &&
      BigInt(t.value) === BigInt(e.value) &&
      ethers.keccak256(t.input) === e.dataHash
    );
  }

  /** `r`, a receipt a node returned for `e`: kept with the entry. */
  mined(e: TxEntry, r: any): void {
    if (e.minedAt !== undefined) return;
    e.minedAt = Number(r.blockNumber);
    this.save();
  }

  /**
   * Once the head is two blocks on, for a re-read. A dev node makes a
   * block only on a send, so the two are mined here on 31337.
   */
  async twoBlocks(): Promise<void> {
    const from = Number(await this.raw("eth_blockNumber"));
    for (let s = 0; ; s++) {
      const head = Number(await this.raw("eth_blockNumber"));
      if (head >= from + 2) return;
      if (LOCAL.has(this.rec.chainId)) await this.raw("evm_mine");
      else if (s >= HEAD_WAIT) {
        throw new RecordRefusal(
          `the node's head stayed at block ${head} for ${HEAD_WAIT} s: a stalled RPC; nothing was dropped from the record, re-run against a synced RPC`,
        );
      } else await new Promise((ok) => setTimeout(ok, 1000));
    }
  }

  /**
   * The receipt of `e` once it has its confirmations. A hash the node no
   * longer knows (replaced, evicted; M-2): the transaction mined at its
   * nonce is adopted when it is this entry in every field; with the nonce
   * unused and nothing pending there, null (never mined: unsent again),
   * but only when a re-read two blocks later agrees and no node ever
   * returned its receipt (D-2); anything else is a refusal naming the
   * reason, the entry kept.
   */
  async receipt(e: TxEntry): Promise<any> {
    const n = this.rec.txs.indexOf(e);
    for (let rechecked = false; ;) {
      const r = await this.raw("eth_getTransactionReceipt", [e.hash]);
      if (r) {
        this.mined(e, r);
        const head = Number(await this.raw("eth_blockNumber"));
        if (head - Number(r.blockNumber) + 1 >= this.confirmations) return r;
      } else if (!(await this.raw("eth_getTransactionByHash", [e.hash]))) {
        const why = `record entry #${n} (${e.label}): ${e.hash} is unknown to the node and ${e.from}'s nonce ${e.nonce}`;
        if ((await this.count(e.from, "latest")) > e.nonce) {
          const t = await this.findMined(e);
          if (!t || !this.sameTx(e, t)) {
            throw new RecordRefusal(
              `${why} went to ${t ? t.hash : "a transaction past the scan"}, another transaction: refusing`,
            );
          }
          this.log(`   ↪️  ${e.label}: mined as ${t.hash}; adopted`);
          e.hash = t.hash;
          continue;
        }
        if ((await this.count(e.from, "pending")) > e.nonce) {
          throw new RecordRefusal(
            `${why} is pending with another transaction: wait for it to mine, then re-run`,
          );
        }
        if (!rechecked) {
          this.log(
            `   ⏳ ${e.label}: entry #${n} unknown to this node; re-checking two blocks on`,
          );
          await this.twoBlocks();
          rechecked = true;
          continue;
        }
        if (e.minedAt !== undefined) {
          throw new RecordRefusal(
            `${why} is unused there, but a node returned its receipt at block ${e.minedAt}: a lagging or inconsistent RPC; kept in the record, re-run against a synced RPC`,
          );
        }
        return null;
      }
      await new Promise((ok) => setTimeout(ok, 1000));
    }
  }

  /**
   * Whether `e.from` used nonce `e.nonce` (the latest count above it);
   * a no is read again two blocks later before it is the answer (D-2).
   */
  async used(e: TxEntry): Promise<boolean> {
    if ((await this.count(e.from, "latest")) > e.nonce) return true;
    if ((await this.count(e.from, "pending")) > e.nonce) return false;
    this.log(
      `   ⏳ ${e.label}: entry #${this.rec.txs.indexOf(e)}'s nonce ${e.nonce} unused on this node; re-checking two blocks on`,
    );
    await this.twoBlocks();
    return (await this.count(e.from, "latest")) > e.nonce;
  }

  /** The mined transaction from `e.from` at `e.nonce` since `e.block`. */
  async findMined(e: TxEntry): Promise<any> {
    const head = Number(await this.raw("eth_blockNumber"));
    if (head - e.block > 5000) {
      throw new RecordRefusal(
        `${e.label}: ${e.from} used nonce ${e.nonce} more than 5000 blocks after the intent (block ${e.block}); find that transaction and record it by hand`,
      );
    }
    for (let b = e.block; b <= head; b++) {
      const blk = await this.raw("eth_getBlockByNumber", [
        ethers.toQuantity(b),
        true,
      ]);
      for (const t of blk?.transactions ?? []) {
        if (same(t.from, e.from) && Number(t.nonce) === e.nonce) return t;
      }
    }
    return null;
  }
}
