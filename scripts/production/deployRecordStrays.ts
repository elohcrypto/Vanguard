/**
 * The strays of a deploy record, for the Recorder (deployRecord.ts) through
 * EntryChain (deployRecordChain.ts), which extends this class: each stray
 * as the chain shows it (mined, pending, replaced or dropped), the nonce
 * account's share of them, and the chain reads both files share. Moved
 * out of deployRecordChain.ts unchanged (U2 round 8, the 500-line rule).
 */
import { ethers } from "hardhat";
import { DeployRecord, Stray, TxEntry } from "./deployRecordFile";

/** Thrown when a re-run cannot follow its record: nothing more is sent. */
export class RecordRefusal extends Error {
  name = "RecordRefusal";
}

export type Raw = (method: string, params?: unknown[]) => Promise<any>;

/** Round 8 (GG2): the operator's DEPLOY_FILL_HASH and the stray it fills. */
type Fill = { s: Stray; t: any };

export const same = (a?: string | null, b?: string | null) =>
  String(a ?? "").toLowerCase() === String(b ?? "").toLowerCase();

export class StrayChain {
  constructor(
    protected raw: Raw,
    protected rec: DeployRecord,
    protected confirmations: number,
    protected log: (m: string) => void,
    protected save: () => void,
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

  /**
   * Round 6 (G1): the entry whose transaction `hash` is (its index), or
   * -1 when it is the deployer's from before the record's start (`at`
   * below startNonce), or null: only then is it outside the record.
   */
  protected accounted(hash: string, from: string, at: number, not?: TxEntry) {
    const k = this.rec.txs.findIndex((x) => x !== not && same(x.hash, hash));
    if (k >= 0) return k;
    const older = same(from, this.rec.deployer) && at < this.rec.startNonce;
    return older ? -1 : null;
  }

  /**
   * Round 6 (G3): "stray <hash>" when `e` is an intent (status sending, no
   * hash) whose nonce a recorded stray of `e`'s sender holds mined, so `e`
   * can never mine; else "". Both must hold: the chain shows the stray
   * mined from that sender at that nonce, and its hash is in rec.strays
   * (the record's own re-send). Any other transaction at the nonce keeps
   * the refusal by name, and a sent entry there is never dropped.
   */
  async heldByStray(e: TxEntry): Promise<string> {
    if (e.status !== "sending" || e.hash) return "";
    const s = (this.rec.strays ?? []).find(
      (x) => same(x.from, e.from) && x.nonce === e.nonce,
    );
    // Round 8 (GG8): a replaced stray's transaction is its replacement's.
    const t =
      s &&
      (await this.raw("eth_getTransactionByHash", [s.replacedBy ?? s.hash]));
    return t?.blockNumber &&
      same(t.from, s!.from) &&
      Number(t.nonce) === s!.nonce
      ? `stray ${s!.hash}`
      : "";
  }

  /** Round 5: what each stray cost, printed by every resume and at the end. */
  strayLines: string[] = [];

  /**
   * Round 5: each stray as the chain shows it (refused unless from its
   * sender at its nonce), printed; returns the deployer's mined ones,
   * which hold nonces outside the record's entries. Round 7 (GH): read
   * before any entry is settled, so nothing is sent while one is pending;
   * one the node does not show is a replacement, a gap or dropped.
   */
  async outside(deployer: string): Promise<number> {
    let mined = 0;
    this.strayLines = [];
    const fill = await this.fill();
    for (const s of this.rec.strays ?? []) {
      const of = `nonce ${s.nonce}: ${s.hash}, the signer's re-send of entry #${s.entry} (${s.label}) at another nonce`;
      const id = `stray ${s.hash} (nonce ${s.nonce}, the re-send of entry #${s.entry})`;
      const k = this.accounted(s.hash, s.from, s.nonce);
      if (k !== null) {
        const known =
          k >= 0
            ? `record entry #${k}'s transaction`
            : `below the record's startNonce ${this.rec.startNonce}`;
        throw new RecordRefusal(
          `${id} is ${known}: the record's strays list is inconsistent (a stray is a transaction the record does not otherwise account for); remove it from strays, then re-run`,
        );
      }
      const t = await this.raw("eth_getTransactionByHash", [s.hash]);
      if (t && (!same(t.from, s.from) || Number(t.nonce) !== s.nonce)) {
        throw new RecordRefusal(
          `stray ${s.hash} (nonce ${s.nonce}, the re-send of entry #${s.entry}): the chain shows it from ${ethers.getAddress(t.from)} at nonce ${Number(t.nonce)}, not as recorded: refusing`,
        );
      }
      // Round 6 (G2): no entry is planned behind a pending stray.
      if (t && !t.blockNumber) {
        throw new RecordRefusal(
          `${id} is pending on this node: wait for it to mine or drop, then re-run`,
        );
      }
      const by = t ? null : await this.replacement(s, fill);
      if (typeof by === "string") {
        this.strayLines.push(
          `   ⚠️  ${of}: dropped, its nonce taken by stray ${by}`,
        );
        continue;
      }
      const x = t ?? by;
      const r = x
        ? await this.raw("eth_getTransactionReceipt", [x.hash])
        : null;
      if (!x) {
        this.strayLines.push(`   ⚠️  ${of}: dropped, not counted`);
      } else if (!r) {
        this.strayLines.push(
          `   ⚠️  ${of}: not mined on this node, not counted`,
        );
      } else {
        const fee =
          BigInt(r.gasUsed) * BigInt(r.effectiveGasPrice ?? x.gasPrice);
        const made = r.contractAddress
          ? ` and created ${ethers.getAddress(r.contractAddress)}, which the record does not own`
          : "";
        const was = by
          ? `nonce ${s.nonce}: stray ${s.hash} replaced by ${by.hash},`
          : `${of}:`;
        this.strayLines.push(
          `   ⚠️  ${was} outside the record, never adopted; it cost ${s.from} ${ethers.formatEther(fee + BigInt(x.value))} ETH${made}`,
        );
        if (same(s.from, deployer)) mined++;
      }
    }
    for (const l of this.strayLines) this.log(l);
    return mined;
  }

  /**
   * Round 7 (GB): stray `s`, which this node does not show, trusted as
   * gone only when its sender has nothing pending the node hides (lane C
   * cp). With its nonce free it is dropped (null), unless (GH) a record
   * entry of its sender waits above it: a gap only a fill closes. With the
   * nonce used, the sender's transaction there (`replacedBy`, once found)
   * replaced it, unless it is a record entry (null): counted as a mined
   * stray, never adopted. Round 8 (GG1): or another recorded stray's (its
   * hash returned): the nonce is counted once, as that stray's.
   */
  private async replacement(s: Stray, fill: Fill | null): Promise<any> {
    const id = `stray ${s.hash} (nonce ${s.nonce}, the re-send of entry #${s.entry})`;
    const who = same(s.from, this.rec.deployer) ? "the deployer" : s.from;
    const mined = await this.count(s.from, "latest");
    const pending = await this.count(s.from, "pending");
    // Round 8 (GG4): the record's own sent entries in that pending range
    // that the node shows pending are not hidden; they are awaited.
    let hidden = pending - mined;
    for (const e of this.rec.txs) {
      if (hidden <= 0) break;
      if (e.status !== "sent" || !same(e.from, s.from)) continue;
      if (e.nonce < mined || e.nonce >= pending) continue;
      const o = await this.raw("eth_getTransactionByHash", [e.hash]);
      if (o && !o.blockNumber) hidden--;
    }
    if (hidden > 0) {
      throw new RecordRefusal(
        `${id} is not shown by this node but ${who} has ${hidden} pending transactions it does not show: a lagging or inconsistent RPC; wait or re-run against a synced RPC`,
      );
    }
    if (mined <= s.nonce) {
      const k = this.rec.txs.findIndex(
        (e) => same(e.from, s.from) && e.nonce > s.nonce,
      );
      if (k >= 0) {
        throw new RecordRefusal(
          `${id} is dropped and its nonce is unfilled below record entry #${k}'s nonce ${this.rec.txs[k].nonce}: fill nonce ${s.nonce} from ${who} (a cancel to self), then resume; if this node lags, re-run against a synced RPC`,
        );
      }
      return null;
    }
    // An entry of the record took the nonce: read by its hash, no scan.
    const own = this.rec.txs.find(
      (e) => e.hash && same(e.from, s.from) && e.nonce === s.nonce,
    );
    const o = own && (await this.raw("eth_getTransactionByHash", [own.hash]));
    if (!s.replacedBy && o?.blockNumber && this.sameTx(own!, o)) return null;
    // Round 8 (GG1): another stray of the sender mined there (its hash or
    // its replacement's): read by its hash, no scan.
    for (const x of s.replacedBy ? [] : (this.rec.strays ?? [])) {
      if (x === s || !same(x.from, s.from) || x.nonce !== s.nonce) continue;
      const w = await this.raw("eth_getTransactionByHash", [
        x.replacedBy ?? x.hash,
      ]);
      if (w?.blockNumber && same(w.from, s.from) && Number(w.nonce) === s.nonce)
        return x.hash;
    }
    // Round 8 (GG2): the operator's fill by its hash, else a scan from
    // the stray's block (an older row: the record's fromBlock).
    const t = s.replacedBy
      ? await this.raw("eth_getTransactionByHash", [s.replacedBy])
      : fill?.s === s
        ? fill.t
        : await this.findMined(
            {
              from: s.from,
              nonce: s.nonce,
              block: s.block ?? this.rec.fromBlock,
              label: id,
            } as TxEntry,
            "pass the hash of the transaction that filled it as DEPLOY_FILL_HASH=<hash>, then resume",
          );
    const fits =
      t?.blockNumber && same(t.from, s.from) && Number(t.nonce) === s.nonce;
    if (s.replacedBy && !fits) {
      throw new RecordRefusal(
        `${id}: its replacement ${s.replacedBy} is not shown mined from ${s.from} at nonce ${s.nonce}: refusing`,
      );
    }
    if (!fits || this.rec.txs.some((e) => this.sameTx(e, t))) return null;
    // Round 8 (GG1): another stray's transaction is never a replacement,
    // nor an earlier stray's replacement (a round-7 record's own pair).
    const all = this.rec.strays ?? [];
    const twin = all.find(
      (x) =>
        x !== s &&
        (same(x.hash, t.hash) ||
          (same(x.replacedBy, t.hash) && all.indexOf(x) < all.indexOf(s))),
    );
    if (twin) return twin.hash;
    if (!s.replacedBy) {
      s.replacedBy = t.hash;
      this.save();
    }
    return t;
  }

  /**
   * Round 8 (GG2): `e`'s transaction at its nonce, read by the hash of its
   * own earlier send when the record kept one, else found by a scan.
   */
  async minedAt(e: TxEntry): Promise<any> {
    const t =
      e.sentHash && (await this.raw("eth_getTransactionByHash", [e.sentHash]));
    return t?.blockNumber && this.sameTx(e, t) ? t : this.findMined(e);
  }

  /**
   * Round 8 (GG2): DEPLOY_FILL_HASH, the operator's fill of a stray's
   * nonce, verified by its hash: shown, no record entry, no stray itself,
   * at a recorded stray's sender and nonce, mined. Null when unset.
   */
  private async fill(): Promise<Fill | null> {
    const hash = process.env.DEPLOY_FILL_HASH;
    if (!hash) return null;
    const no = (why: string) =>
      new RecordRefusal(`DEPLOY_FILL_HASH ${hash} ${why}: refusing`);
    if (!/^0x[0-9a-fA-F]{64}$/.test(hash))
      throw no("is not a transaction hash");
    const t = await this.raw("eth_getTransactionByHash", [hash]);
    if (!t) throw no("is not shown by this node");
    const k = this.rec.txs.findIndex((e) => this.sameTx(e, t));
    if (k >= 0) throw no(`is record entry #${k}'s transaction, not a fill`);
    const all = this.rec.strays ?? [];
    const x = all.find((y) => same(y.hash, hash));
    if (x) throw no(`is stray ${x.hash} itself, not a fill`);
    const s = all.find(
      (y) => same(y.from, t.from) && y.nonce === Number(t.nonce),
    );
    if (!s) {
      throw no(
        `is ${ethers.getAddress(t.from)}'s transaction at nonce ${Number(t.nonce)}, not at a recorded stray's sender and nonce`,
      );
    }
    if (!t.blockNumber) throw no("is not mined on this node");
    return { s, t };
  }

  /** The mined transaction from `e.from` at `e.nonce` since `e.block`. */
  async findMined(
    e: TxEntry,
    how = "find that transaction and record it by hand",
  ): Promise<any> {
    const head = Number(await this.raw("eth_blockNumber"));
    if (head - e.block > 5000) {
      throw new RecordRefusal(
        `${e.label}: ${e.from} used nonce ${e.nonce} more than 5000 blocks after the intent (block ${e.block}); ${how}`,
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
