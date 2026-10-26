/**
 * What the chain says about one deploy record entry, for the Recorder
 * (deployRecord.ts): its receipt once it has its confirmations, and the
 * transaction mined at its nonce.
 *
 * Review D-2 round 3: an entry is never dropped from the record and never
 * planned again at another nonce. No answer of one node proves a sent
 * transaction was never mined (a lagging or dishonest node shows exactly
 * that picture), so nothing is concluded from it: an entry whose hash the
 * node does not know, or that has none, is sent again at its recorded
 * nonce with its recorded payload. Its nonce can mine once, so whatever
 * the node says the entry deploys at most once: the transaction at that
 * nonce is adopted when it is the entry, refused by name when it is
 * another, and whatever the node cannot show is a refusal with the entry
 * kept.
 */
import { ethers } from "hardhat";
import { DeployRecord, Stray, TxEntry } from "./deployRecordFile";

/** Thrown when a re-run cannot follow its record: nothing more is sent. */
export class RecordRefusal extends Error {
  name = "RecordRefusal";
}

export type Raw = (method: string, params?: unknown[]) => Promise<any>;

const same = (a?: string | null, b?: string | null) =>
  String(a ?? "").toLowerCase() === String(b ?? "").toLowerCase();

/** What in `e` the deploy never records that way (an edited record), or "". */
function edited(e: TxEntry): string {
  const data = String(e.data);
  if (!ethers.isHexString(data) || ethers.keccak256(data) !== e.dataHash)
    return "data (its keccak256 is not its dataHash)";
  if (!Number.isSafeInteger(e.nonce) || e.nonce < 0)
    return "nonce (not a nonce)";
  if (!/^\d+$/.test(String(e.value))) return "value (not a decimal amount)";
  if (!ethers.isAddress(e.from)) return "sender (not an address)";
  if (e.to !== null && !ethers.isAddress(e.to))
    return "target (not an address)";
  return "";
}

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

  /**
   * Round 4 (A4): `e`'s payload is the one the deploy recorded, so a
   * resume that sends it again sends that transaction or nothing.
   */
  unedited(e: TxEntry): void {
    const bad = edited(e);
    if (bad) {
      throw new RecordRefusal(
        `record entry #${this.rec.txs.indexOf(e)} (${e.label}): its recorded ${bad}: an edited record; kept, nothing sent`,
      );
    }
  }

  /** Transactions sent again at their recorded nonce. */
  resent = 0;

  /** The transaction mined at `e`'s nonce, adopted when it is `e`. */
  private async adopt(e: TxEntry, why: string): Promise<void> {
    const t = await this.findMined(e);
    if (!t) {
      throw new RecordRefusal(
        `${why} is used, but this node shows no transaction at it since block ${e.block}: a lagging RPC; kept in the record, resume against a synced RPC`,
      );
    }
    if (!this.sameTx(e, t)) {
      throw new RecordRefusal(
        `${why} went to ${t.hash}, another transaction: refusing`,
      );
    }
    this.log(`   ↪️  ${e.label}: mined as ${t.hash}; adopted`);
    e.hash = t.hash;
  }

  /**
   * `e` sent again at its nonce with its recorded payload (the signer
   * re-sends or fee-bumps the same transaction), its new hash saved
   * before anything else is read. Returns "" once sent, else the node's
   * answer.
   */
  private async resend(e: TxEntry, why: string): Promise<string> {
    if (!e.data) {
      throw new RecordRefusal(
        `${why} is unused, and the entry has no recorded payload to send again (recorded before review D-2 round 3): kept in the record, resume against a synced RPC`,
      );
    }
    const n = this.rec.txs.indexOf(e);
    try {
      const hash = await this.raw("eth_sendTransaction", [
        {
          from: e.from,
          ...(e.to ? { to: e.to } : {}),
          value: ethers.toQuantity(BigInt(e.value)),
          data: e.data,
          ...(e.gas ? { gas: e.gas } : {}),
          nonce: ethers.toQuantity(e.nonce),
        },
      ]);
      if (!/^0x[0-9a-fA-F]{64}$/.test(String(hash)))
        throw new Error(`no transaction hash (${hash})`);
      e.resent = true;
      e.hash = hash;
      e.status = "sent";
      this.save();
      this.resent++;
      this.log(
        `   📤 #${n} ${e.label}: sent again at its nonce ${e.nonce}: ${hash}`,
      );
    } catch (x: any) {
      return `; the node answered: ${String(x?.message ?? x).split("\n")[0]}`;
    }
    // Round 5 (lane C F1): the next read is what the signer sent.
    const t = await this.raw("eth_getTransactionByHash", [e.hash]);
    if (t) this.stray(e, t, n);
    return "";
  }

  /**
   * Round 5 (lane C F1): `t`, under the hash the record's re-send of `e`
   * got back, is from `e`'s sender at another nonce: the signer sent it
   * outside the record. It is recorded as a stray, never as `e`: the hash
   * is cleared, so `e`'s own transaction is adopted at its nonce.
   */
  private stray(e: TxEntry, t: any, n: number): void {
    const at = Number(t.nonce);
    if (!e.resent || !same(t.from, e.from) || at === e.nonce) return;
    // Round 6 (G1): not a transaction outside the record, so no stray.
    const k = this.accounted(t.hash, t.from, at, e);
    if (k !== null) {
      const known =
        k >= 0
          ? `record entry #${k}'s transaction`
          : `an older transaction (nonce ${at}, before the record's startNonce ${this.rec.startNonce})`;
      delete e.hash;
      delete e.resent;
      e.status = "sending";
      this.save();
      throw new RecordRefusal(
        `record entry #${n} (${e.label}): the signer answered its re-send with ${t.hash}, ${known}, not a new one: nothing recorded as a stray; the entry's own transaction is looked up at its nonce on the next run: fix the signer, then resume against a synced RPC; kept in the record, nothing more is sent`,
      );
    }
    const strays = (this.rec.strays ??= []);
    if (!strays.some((s) => same(s.hash, t.hash))) {
      const from = ethers.getAddress(t.from);
      strays.push({ hash: t.hash, from, nonce: at, entry: n, label: e.label });
    }
    delete e.hash;
    delete e.resent;
    e.status = "sending";
    this.save();
    throw new RecordRefusal(
      `record entry #${n} (${e.label}): ${t.hash} ${t.blockNumber ? "mined" : "sent"} at nonce ${at} from ${t.from}, not as the entry recorded (nonce ${e.nonce} from ${e.from}): a transaction the signer sent at nonce ${at} outside the record, recorded as a stray, never the entry; the entry's own transaction is looked up at its nonce on the next run: fix the signer, then resume against a synced RPC; kept in the record, nothing more is sent`,
    );
  }

  /**
   * Round 6 (G1): the entry whose transaction `hash` is (its index), or
   * -1 when it is the deployer's from before the record's start (`at`
   * below startNonce), or null: only then is it outside the record.
   */
  private accounted(hash: string, from: string, at: number, not?: TxEntry) {
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
    const t = s && (await this.raw("eth_getTransactionByHash", [s.hash]));
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
   * which hold nonces outside the record's entries. Round 7 (GB): one
   * the node does not show may have been replaced at its nonce.
   */
  async outside(deployer: string): Promise<number> {
    let mined = 0;
    this.strayLines = [];
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
      const by = t ? null : await this.replacement(s);
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
   * Round 7 (GB): stray `s`, which this node does not show. With its
   * nonce free it is dropped (null); with the nonce used, the sender's
   * transaction there (`replacedBy`, once found) replaced it, unless it
   * is a record entry (null): counted as a mined stray, never adopted.
   */
  private async replacement(s: Stray): Promise<any> {
    const id = `stray ${s.hash} (nonce ${s.nonce}, the re-send of entry #${s.entry})`;
    if ((await this.count(s.from, "latest")) <= s.nonce) return null;
    // An entry of the record took the nonce: read by its hash, no scan.
    const own = this.rec.txs.find(
      (e) => e.hash && same(e.from, s.from) && e.nonce === s.nonce,
    );
    const o = own && (await this.raw("eth_getTransactionByHash", [own.hash]));
    if (!s.replacedBy && o?.blockNumber && this.sameTx(own!, o)) return null;
    const t = s.replacedBy
      ? await this.raw("eth_getTransactionByHash", [s.replacedBy])
      : await this.findMined({
          from: s.from,
          nonce: s.nonce,
          block: this.rec.fromBlock,
          label: id,
        } as TxEntry);
    const fits =
      t?.blockNumber && same(t.from, s.from) && Number(t.nonce) === s.nonce;
    if (s.replacedBy && !fits) {
      throw new RecordRefusal(
        `${id}: its replacement ${s.replacedBy} is not shown mined from ${s.from} at nonce ${s.nonce}: refusing`,
      );
    }
    if (!fits || this.rec.txs.some((e) => this.sameTx(e, t))) return null;
    if (!s.replacedBy) {
      s.replacedBy = t.hash;
      this.save();
    }
    return t;
  }

  /**
   * The receipt of `e` once it has its confirmations. A hash the node
   * does not know (replaced, evicted, reorged, a lagging node), or none
   * (an intent): the transaction mined at its nonce is adopted when it is
   * this entry in every field; with the nonce unused and nothing pending
   * there, `e` is sent again at that nonce, once. Anything else is a
   * refusal naming the reason, the entry kept.
   */
  async receipt(e: TxEntry): Promise<any> {
    const n = this.rec.txs.indexOf(e);
    let resent: string | null = null;
    for (;;) {
      const r = e.hash
        ? await this.raw("eth_getTransactionReceipt", [e.hash])
        : null;
      if (r) {
        if (!same(r.transactionHash, e.hash)) {
          throw new RecordRefusal(
            `record entry #${n} (${e.label}): the node returned the receipt of ${r.transactionHash} for ${e.hash}: an inconsistent RPC; kept in the record, re-run against a synced RPC`,
          );
        }
        const head = Number(await this.raw("eth_blockNumber"));
        if (head - Number(r.blockNumber) + 1 >= this.confirmations) {
          await this.isTheEntry(e, n);
          return r;
        }
      } else if (
        !e.hash ||
        !(await this.raw("eth_getTransactionByHash", [e.hash]))
      ) {
        const why = `record entry #${n} (${e.label}): ${e.hash ?? "its transaction"} is unknown to the node and ${e.from}'s nonce ${e.nonce}`;
        if ((await this.count(e.from, "latest")) > e.nonce) {
          await this.adopt(e, why);
          continue;
        }
        if ((await this.count(e.from, "pending")) > e.nonce) {
          throw new RecordRefusal(
            `${why} is pending with another transaction: wait for it to mine, then re-run`,
          );
        }
        if (resent !== null) {
          throw new RecordRefusal(
            `${why} is unused after it was sent again at that nonce${resent}: a lagging or inconsistent RPC; kept in the record, resume against a synced RPC`,
          );
        }
        this.log(
          `   ⏳ ${e.label}: entry #${n} unknown to this node; re-checking by sending it again at its nonce ${e.nonce}`,
        );
        resent = await this.resend(e, why);
        continue;
      }
      await new Promise((ok) => setTimeout(ok, 1000));
    }
  }

  /**
   * Round 4 (A1): the transaction mined under `e.hash` is `e` in every
   * field (sender, nonce, target, value, calldata), whatever the signer
   * did with the nonce field: one that drops it can mine a re-send at the
   * next nonce, and that transaction never becomes the entry.
   */
  private async isTheEntry(e: TxEntry, n: number): Promise<void> {
    const t = await this.raw("eth_getTransactionByHash", [e.hash]);
    if (!t) {
      throw new RecordRefusal(
        `record entry #${n} (${e.label}): ${e.hash} has a receipt but the node does not show the transaction: an inconsistent RPC; kept in the record, re-run against a synced RPC`,
      );
    }
    if (!this.sameTx(e, t)) {
      this.stray(e, t, n);
      throw new RecordRefusal(
        `record entry #${n} (${e.label}): ${e.hash} mined at nonce ${Number(t.nonce)} from ${t.from}, not as the entry recorded (nonce ${e.nonce} from ${e.from}, its target, value and calldata): the signer did not send it as recorded; kept in the record, nothing more is sent`,
      );
    }
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
