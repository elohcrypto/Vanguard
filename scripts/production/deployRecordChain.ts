/**
 * What the chain says about one deploy record entry, for the Recorder
 * (deployRecord.ts): its receipt once it has its confirmations, the
 * transaction mined at its nonce, and the evidence a "never mined" answer
 * needs first.
 *
 * Review D-2: a sent entry leaves the record only on evidence read from a
 * node whose head is past the send: its nonce unused at a block at least
 * two past the head the send was made at (sentAtBlock), or past the last
 * time a node still knew the hash, read pinned to that block so a backend
 * without it cannot answer, and the hash still unknown. A node short of
 * that block lags: the entry is kept and the run refused. An entry whose
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
/** Seconds a node may stay short of the evidence block: then refused. */
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
    if (e.minedAt !== undefined || !same(r.transactionHash, e.hash)) return;
    e.minedAt = Number(r.blockNumber);
    this.save();
  }

  /**
   * `e.from`'s nonce count at a block at least `target`, read pinned to
   * that block (a backend without it cannot answer). A dev node mines up
   * to it; elsewhere a node still short of it after HEAD_WAIT seconds
   * lags: refused, the entry kept.
   */
  async countAt(e: TxEntry, target: number, why: string): Promise<number> {
    let last = "";
    for (let s = 0; ; s++) {
      const head = Number(await this.raw("eth_blockNumber"));
      if (head >= target) {
        try {
          return await this.count(e.from, ethers.toQuantity(head));
        } catch (x: any) {
          last = `; its count at block ${head}: ${x.message}`;
        }
      } else if (LOCAL.has(this.rec.chainId)) {
        await this.raw("evm_mine");
        continue;
      } else last = `; its head is block ${head}`;
      if (s >= HEAD_WAIT) {
        throw new RecordRefusal(
          `${why} cannot be read at block ${target} or later (two past the send)${last}: a lagging RPC; kept in the record, resume against a synced RPC`,
        );
      }
      await new Promise((ok) => setTimeout(ok, 1000));
    }
  }

  /** The transaction mined at `e`'s nonce, adopted when it is `e`. */
  private async adopt(e: TxEntry, why: string): Promise<void> {
    const t = await this.findMined(e);
    if (!t || !this.sameTx(e, t)) {
      throw new RecordRefusal(
        `${why} went to ${t ? t.hash : "a transaction past the scan"}, another transaction: refusing`,
      );
    }
    this.log(`   ↪️  ${e.label}: mined as ${t.hash}; adopted`);
    e.hash = t.hash;
  }

  /**
   * The receipt of `e` once it has its confirmations. A hash the node no
   * longer knows (replaced, evicted; M-2): the transaction mined at its
   * nonce is adopted when it is this entry in every field; null (never
   * mined: unsent again) only on the evidence above (D-2); anything else
   * is a refusal naming the reason, the entry kept.
   */
  async receipt(e: TxEntry): Promise<any> {
    const n = this.rec.txs.indexOf(e);
    // Review D-2 (U5): a hash seen again moves the bar past that sighting.
    let bar = (e.sentAtBlock ?? e.block) + 2;
    let seen = false;
    for (;;) {
      const r = await this.raw("eth_getTransactionReceipt", [e.hash]);
      if (r) {
        if (!same(r.transactionHash, e.hash)) {
          throw new RecordRefusal(
            `record entry #${n} (${e.label}): the node returned the receipt of ${r.transactionHash} for ${e.hash}: an inconsistent RPC; kept in the record, re-run against a synced RPC`,
          );
        }
        this.mined(e, r);
        const head = Number(await this.raw("eth_blockNumber"));
        if (head - Number(r.blockNumber) + 1 >= this.confirmations) return r;
      } else if (await this.raw("eth_getTransactionByHash", [e.hash])) {
        seen = true;
      } else {
        if (seen)
          bar = Math.max(bar, Number(await this.raw("eth_blockNumber")) + 2);
        seen = false;
        const why = `record entry #${n} (${e.label}): ${e.hash} is unknown to the node and ${e.from}'s nonce ${e.nonce}`;
        if ((await this.count(e.from, "latest")) > e.nonce) {
          await this.adopt(e, why);
          continue;
        }
        if ((await this.count(e.from, "pending")) > e.nonce) {
          throw new RecordRefusal(
            `${why} is pending with another transaction: wait for it to mine, then re-run`,
          );
        }
        this.log(
          `   ⏳ ${e.label}: entry #${n} unknown to this node; re-checking at block ${bar} (two past the send)`,
        );
        if ((await this.countAt(e, bar, why)) > e.nonce) {
          await this.adopt(e, why);
          continue;
        }
        if (await this.raw("eth_getTransactionByHash", [e.hash])) {
          seen = true;
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
   * a no is the answer only at a block two past the intent's (D-2).
   */
  async used(e: TxEntry): Promise<boolean> {
    if ((await this.count(e.from, "latest")) > e.nonce) return true;
    if ((await this.count(e.from, "pending")) > e.nonce) return false;
    const n = this.rec.txs.indexOf(e);
    this.log(
      `   ⏳ ${e.label}: entry #${n}'s nonce ${e.nonce} unused on this node; re-checking at block ${e.block + 2}`,
    );
    const why = `record entry #${n} (${e.label}): ${e.from}'s nonce ${e.nonce}`;
    return (await this.countAt(e, e.block + 2, why)) > e.nonce;
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
