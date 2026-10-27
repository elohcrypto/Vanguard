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
import { TxEntry } from "./deployRecordFile";
import { RecordRefusal, same, StrayChain } from "./deployRecordStrays";

export { RecordRefusal, StrayChain };
export type { Raw } from "./deployRecordStrays";

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

/**
 * Each entry against the chain; the strays and the reads both share:
 * StrayChain (deployRecordStrays.ts).
 */
export class EntryChain extends StrayChain {
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
    const t = await this.minedAt(e);
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
    // Round 8 (GG2): a stray of this send is looked for from here; (J)
    // saved as the re-send's intent before the send leaves. Round 9 (B,
    // GJ1): the earliest intent is kept, so a later re-send never moves
    // the scan past an unrecorded stray of an earlier one.
    const head = Number(await this.raw("eth_blockNumber"));
    const kept = e.resendFrom;
    e.resendFrom ??= head;
    this.save();
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
      if (e.hash && !e.resent) e.sentHash = e.hash;
      e.resent = true;
      e.hash = hash;
      e.status = "sent";
      this.save();
      this.resent++;
      this.log(
        `   📤 #${n} ${e.label}: sent again at its nonce ${e.nonce}: ${hash}`,
      );
    } catch (x: any) {
      // Round 10 (D, GB-C, R10-C3): the node refused the send itself, so
      // nothing of it is out: an intent it set goes; an earlier one stays.
      // Round 11 (A, GH10-1, R11-C1): only a JSON-RPC error answer (a
      // numeric code) is a refusal; a transport failure (a 502, a
      // timeout, a reset) may have forwarded the send, and the intent is
      // what finds its stray. (R11-C4: the non-hash reply's own Error
      // carries no code, so no flag for "answered" is needed.)
      if (kept === undefined && typeof x?.code === "number") {
        delete e.resendFrom;
        this.save();
      }
      return `; the node answered: ${String(x?.message ?? x).split("\n")[0]}`;
    }
    // Round 5 (lane C F1): the next read is what the signer sent.
    const t = await this.raw("eth_getTransactionByHash", [e.hash]);
    if (t) this.stray(e, t, n, head);
    return "";
  }

  /**
   * Round 5 (lane C F1): `t`, under the hash the record's re-send of `e`
   * got back, is from `e`'s sender at another nonce: the signer sent it
   * outside the record. It is recorded as a stray, never as `e`: the hash
   * is cleared, so `e`'s own transaction is adopted at its nonce.
   */
  private stray(e: TxEntry, t: any, n: number, head: number): void {
    const at = Number(t.nonce);
    // Round 7 (lane C c1): another sender's transaction is neither the
    // entry's nor a stray of its sender's: its hash goes, nothing stays.
    if (!same(t.from, e.from)) {
      delete e.hash;
      delete e.resent;
      e.status = "sending";
      this.save();
      throw new RecordRefusal(
        `record entry #${n} (${e.label}): ${t.hash} ${t.blockNumber ? "mined" : "sent"} at nonce ${at} from ${ethers.getAddress(t.from)}, another sender's transaction, not the entry's and not the deployer's stray: nothing recorded; the entry's own transaction is looked up at its nonce on the next run: fix the signer, then resume against a synced RPC; kept in the record, nothing more is sent`,
      );
    }
    if (!e.resent || at === e.nonce) return;
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
      const block = t.blockNumber ? Number(t.blockNumber) : head;
      strays.push({
        hash: t.hash,
        from,
        nonce: at,
        entry: n,
        label: e.label,
        block,
      });
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
          await this.isTheEntry(e, n, head);
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
  private async isTheEntry(e: TxEntry, n: number, head: number): Promise<void> {
    const t = await this.raw("eth_getTransactionByHash", [e.hash]);
    if (!t) {
      throw new RecordRefusal(
        `record entry #${n} (${e.label}): ${e.hash} has a receipt but the node does not show the transaction: an inconsistent RPC; kept in the record, re-run against a synced RPC`,
      );
    }
    if (!this.sameTx(e, t)) {
      this.stray(e, t, n, head);
      throw new RecordRefusal(
        `record entry #${n} (${e.label}): ${e.hash} mined at nonce ${Number(t.nonce)} from ${t.from}, not as the entry recorded (nonce ${e.nonce} from ${e.from}, its target, value and calldata): the signer did not send it as recorded; kept in the record, nothing more is sent`,
      );
    }
  }
}
