/**
 * Plan v2 Task 5.7: the provider hook that keeps the deploy record
 * (its file: deployRecordFile.ts; what the chain says about one entry:
 * deployRecordChain.ts).
 *
 * Every transaction the deploy sends is recorded in order, atomically
 * (temporary file, fsync, rename): an intent (sender, pinned nonce, the
 * block it was read at, the payload until it is mined) before it is sent,
 * its hash once sent, and its receipt (status, contract address, runtime
 * code hash, artifact label) before the next transaction. An entry is
 * never dropped: one the node does not know is sent again at its nonce
 * (deployRecordChain.ts). A re-run replays: the deploy flows run
 * again and every transaction the record holds is answered from it, never
 * sent, in the record's order (sender, target, value, calldata and chain
 * must match the next entry; anything else is a refusal), with each read
 * pinned to the block the original run read it at, so every branch the
 * flows take is the one they took. A contract is reused only while its
 * code hash on chain is the recorded one. When the record is exhausted
 * the flows continue live: a deploy killed at any point resumes where it
 * stopped, and a complete one re-runs sending nothing. Replay reads past
 * state: on a public chain the RPC must serve historical blocks (archive).
 */
import { ethers, network } from "hardhat";
import { EntryChain, RecordRefusal } from "./deployRecordChain";
import { DeployRecord, saveRecord, TxEntry } from "./deployRecordFile";
import { callLabel, createLabel } from "./deployRecordLabels";

export { RecordRefusal };

const same = (a?: string | null, b?: string | null) =>
  String(a ?? "").toLowerCase() === String(b ?? "").toLowerCase();
const LOCAL = new Set([31337]);
const READS_AT = new Set([
  "eth_call",
  "eth_getCode",
  "eth_getBalance",
  "eth_getStorageAt",
  "eth_getTransactionCount",
]);

export class Recorder {
  private sends = 0;
  reused = 0;
  private cursor = 0;
  private last: TxEntry | null = null;
  private raw!: (method: string, params?: unknown[]) => Promise<any>;
  private chain!: EntryChain;
  private uninstall: (() => void) | null = null;

  constructor(
    private file: string,
    public rec: DeployRecord,
    private confirmations: number,
    private log: (m: string) => void = console.log,
  ) {}

  private save() {
    saveRecord(this.file, this.rec);
  }

  /** Transactions sent this run, those sent again at their nonce included. */
  get sent(): number {
    return this.sends + (this.chain?.resent ?? 0);
  }

  /**
   * Entries a replay meets, in order. A reverted one is replayed too: the
   * flow sees the same revert and takes the same branch.
   */
  private live(): TxEntry[] {
    return this.rec.txs;
  }

  /**
   * Hook the provider (request, send and sendAsync; review D-6: every
   * entry point), then settle the record against the chain before any
   * read the flows make. Returns once the record is consistent; throws
   * otherwise.
   */
  async install(): Promise<void> {
    const p: any = network.provider;
    const request = p.request.bind(p);
    const send = typeof p.send === "function" ? p.send.bind(p) : null;
    const sendAsync =
      typeof p.sendAsync === "function" ? p.sendAsync.bind(p) : null;
    this.raw = (method, params = []) => request({ method, params });
    this.chain = new EntryChain(
      this.raw,
      this.rec,
      this.confirmations,
      this.log,
      () => this.save(),
    );
    p.request = (a: any) => this.handle(a.method, a.params ?? []);
    if (send) p.send = (m: string, a?: unknown[]) => this.handle(m, a ?? []);
    if (sendAsync) {
      p.sendAsync = (q: any, done: (e: any, r?: any) => void) =>
        this.handle(q.method, q.params ?? []).then(
          (result) => done(null, { id: q.id, jsonrpc: "2.0", result }),
          done,
        );
    }
    this.uninstall = () => {
      p.request = request;
      if (send) p.send = send;
      if (sendAsync) p.sendAsync = sendAsync;
    };
    try {
      await this.settle();
    } catch (e) {
      this.remove();
      throw e;
    }
  }

  remove(): void {
    if (this.uninstall) this.uninstall();
    this.uninstall = null;
  }

  /** The first refusal stays: a flow that catches it sends nothing more. */
  private refused: Error | null = null;

  /** Task 5.13 (review LOW-1): external roles' addresses, by role. */
  private external: Record<string, string> = {};

  /** Refuse any send from these roles, whatever keys the signer holds. */
  refuseFrom(roles: Record<string, string>): void {
    this.external = { ...roles };
  }

  /** Task 5.13: a role pause (or refusal) stops every later send too. */
  halt(e: Error): void {
    this.refused ??= e;
  }

  private async handle(method: string, params: any[]): Promise<any> {
    if (this.refused && method === "eth_sendTransaction") throw this.refused;
    try {
      return await this.dispatch(method, params);
    } catch (e) {
      if (e instanceof RecordRefusal) this.refused ??= e;
      throw e;
    }
  }

  private async dispatch(method: string, params: any[]): Promise<any> {
    // Every transaction goes through the record: none signed elsewhere.
    // Messages (the issuers' claim signatures) are the signer's to sign.
    if (
      method === "eth_signTransaction" ||
      method === "eth_sendRawTransaction"
    ) {
      throw new RecordRefusal(
        `the deploy sends only through its record and the external signer (${method} refused)`,
      );
    }
    if (
      /^(evm_|hardhat_|anvil_)/.test(method) &&
      method !== "hardhat_metadata" &&
      !LOCAL.has(this.rec.chainId)
    ) {
      // Review D-6: a plain error, not a sticky refusal: a probe that
      // catches it (ChainTime.canJumpTime) does not stop the deploy.
      throw new Error(
        `${method} refused on chain ${this.rec.chainId}: no dev-node call off a dev chain`,
      );
    }
    const next = this.live()[this.cursor];
    if (method === "eth_sendTransaction") return this.sendTx(params[0]);
    if (next) {
      // Replay: the state the original run read before this entry.
      if (method === "eth_estimateGas") {
        if (!this.matches(next, params[0]))
          throw this.diverged(next, params[0]);
        return next.gas ?? "0x0";
      }
      if (method === "eth_blockNumber") return ethers.toQuantity(next.block);
      if (
        method === "eth_getBlockByNumber" &&
        /^(latest|pending)$/.test(params[0])
      ) {
        return this.raw(method, [
          ethers.toQuantity(next.block),
          ...params.slice(1),
        ]);
      }
      if (READS_AT.has(method)) {
        const at = method === "eth_getStorageAt" ? 2 : 1;
        const q = [...params];
        if (q[at] === undefined || /^(latest|pending)$/.test(q[at]))
          q[at] = ethers.toQuantity(next.block);
        return this.raw(method, q);
      }
    }
    return this.raw(method, params);
  }

  private matches(e: TxEntry, tx: any): boolean {
    return (
      same(e.from, tx.from) &&
      same(e.to, tx.to ?? null) &&
      BigInt(e.value) === BigInt(tx.value ?? 0) &&
      e.dataHash === ethers.keccak256(tx.data ?? tx.input ?? "0x")
    );
  }

  private diverged(e: TxEntry, tx: any, label = "another transaction") {
    return new RecordRefusal(
      `the deploy diverged from its record at entry #${this.rec.txs.indexOf(e)} (${e.label} from ${e.from}); it now sends ${label} from ${tx.from}: refusing (a changed flow, config or chain)`,
    );
  }

  private async sendTx(tx: any): Promise<string> {
    for (const [role, a] of Object.entries(this.external)) {
      if (same(a, tx.from)) {
        throw new RecordRefusal(
          `${role} ${ethers.getAddress(a)} is external: the deploy never sends as it (its calls are exported for its owners)`,
        );
      }
    }
    await this.confirmLast();
    const live = this.live();
    const next = live[this.cursor];
    const data: string = tx.data ?? tx.input ?? "0x";
    const label = tx.to
      ? await callLabel(tx.to, data)
      : await createLabel(data);
    const n = this.rec.txs.indexOf(next);
    if (next) {
      if (!this.matches(next, tx)) throw this.diverged(next, tx, label);
      if (next.contract) await this.checkCode(next, n);
      this.cursor++;
      this.reused++;
      this.log(
        `   ⏭️  #${n} ${next.label}: skipped (recorded${next.contract ? ", code hash ok" : ""})`,
      );
      return next.hash!;
    }
    const from = ethers.getAddress(tx.from);
    const nonce = Number(
      await this.raw("eth_getTransactionCount", [from, "pending"]),
    );
    // Deep review M-1: a lagging RPC (a load-balanced backend behind the
    // others) can answer a pending count below the mined one. That nonce
    // is used already; recorded as an intent, every resume would refuse
    // it. A hard stop before anything is saved or sent.
    const mined = Number(
      await this.raw("eth_getTransactionCount", [from, "latest"]),
    );
    if (nonce < mined) {
      throw new RecordRefusal(
        `the RPC reports ${from}'s pending nonce ${nonce} below its mined nonce ${mined}: a lagging or inconsistent node; nothing was recorded or sent, re-run against a synced RPC`,
      );
    }
    const block = Number(await this.raw("eth_blockNumber"));
    const e: TxEntry = {
      from,
      to: tx.to ? ethers.getAddress(tx.to) : null,
      value: BigInt(tx.value ?? 0).toString(),
      dataHash: ethers.keccak256(data),
      data,
      gas: tx.gas,
      nonce,
      block,
      status: "sending",
      label,
    };
    this.rec.txs.push(e);
    this.save(); // the intent, before anything leaves this process
    const hash: string = await this.raw("eth_sendTransaction", [
      { ...tx, nonce: ethers.toQuantity(nonce) },
    ]);
    e.hash = hash;
    e.status = "sent";
    this.save(); // the hash, before anything else is read (F2 LOW-2)
    this.last = e;
    this.cursor = this.live().length;
    this.sends++;
    this.log(`   📤 #${this.rec.txs.length - 1} ${label}: sent ${hash}`);
    return hash;
  }

  private async checkCode(e: TxEntry, n: number): Promise<void> {
    const code = await this.raw("eth_getCode", [e.contract, "latest"]);
    if (ethers.keccak256(code) !== e.codeHash) {
      throw new RecordRefusal(
        `record entry #${n} (${e.label}) says ${e.contract} has code hash ${e.codeHash}; the chain has ${ethers.keccak256(code)}: refusing (never deploys over a recorded contract)`,
      );
    }
  }

  private async confirm(e: TxEntry, r: any): Promise<void> {
    e.status = Number(r.status) === 1 ? "confirmed" : "reverted";
    e.gasUsed = BigInt(r.gasUsed).toString();
    if (r.contractAddress && e.status === "confirmed") {
      e.contract = ethers.getAddress(r.contractAddress);
      e.codeHash = ethers.keccak256(
        await this.raw("eth_getCode", [e.contract, "latest"]),
      );
    }
    delete e.data; // mined: never sent again
    this.save();
  }

  /** The last sent transaction's receipt into the record. */
  async confirmLast(): Promise<void> {
    if (!this.last) return;
    const e = this.last;
    this.last = null;
    await this.confirm(e, await this.chain.receipt(e));
  }

  /**
   * Deep review M-1: `e` (an intent) took its nonce from a stale pending
   * count, so the nonce is an EARLIER record entry's, whose transaction is
   * mined as recorded. RpcRetry's stale check refused that send, so `e`
   * never left the process (a record written before the sendTx check).
   */
  private async staleIntent(e: TxEntry): Promise<boolean> {
    const earlier = this.rec.txs
      .slice(0, this.rec.txs.indexOf(e))
      .find((x) => x.hash && same(x.from, e.from) && x.nonce === e.nonce);
    if (!earlier) return false;
    const t = await this.raw("eth_getTransactionByHash", [earlier.hash]);
    return !!t?.blockNumber && this.chain.sameTx(earlier, t);
  }

  /**
   * Before any flow runs: adopt or drop each unfinished entry, check that
   * the deployer's nonce is fully accounted for, and every recorded
   * transaction and contract against the chain.
   */
  private async settle(): Promise<void> {
    const chain = Number(await this.raw("eth_chainId"));
    if (chain !== this.rec.chainId) {
      throw new RecordRefusal(
        `${this.file} is for chain ${this.rec.chainId}, not ${chain}`,
      );
    }
    if (!Number.isInteger(this.rec.startNonce)) {
      throw new RecordRefusal(
        `${this.file} has no startNonce (a record made before review D-2): a resume cannot account for the deployer's nonce; start a new record`,
      );
    }
    for (const e of [...this.rec.txs]) {
      if (e.status === "sending" && (await this.staleIntent(e))) {
        this.rec.txs.splice(this.rec.txs.indexOf(e), 1); // never sent
        this.log(
          `   ↩️  ${e.label}: its nonce ${e.nonce} is record entry #${this.rec.txs.findIndex((x) => same(x.from, e.from) && x.nonce === e.nonce)}'s (an intent read from a lagging RPC, never sent); dropped from the record`,
        );
        continue;
      }
      const n = this.rec.txs.indexOf(e);
      // An intent the stop left: mined before it (adopted), pending, or
      // not seen (receipt() sends it again at its nonce).
      if (e.status === "sending") {
        if ((await this.chain.count(e.from, "latest")) > e.nonce) {
          const t = await this.chain.findMined(e);
          if (!t) {
            throw new RecordRefusal(
              `${e.from}'s nonce ${e.nonce} is used, but this node shows no transaction at it since block ${e.block} (record entry #${n}, ${e.label}): a lagging RPC; kept in the record, resume against a synced RPC`,
            );
          }
          if (!this.chain.sameTx(e, t)) {
            throw new RecordRefusal(
              `${e.from} used nonce ${e.nonce} for a transaction that is not record entry #${n} (${e.label}): refusing`,
            );
          }
          e.hash = t.hash;
          e.status = "sent";
          this.log(
            `   ↪️  ${e.label}: sent before the stop (${t.hash}); adopted`,
          );
        } else if ((await this.chain.count(e.from, "pending")) > e.nonce) {
          throw new RecordRefusal(
            `${e.from}'s nonce ${e.nonce} is pending (${e.label}): wait for it to mine, then re-run`,
          );
        }
      }
      if (e.status === "sending" || e.status === "sent")
        await this.confirm(e, await this.chain.receipt(e));
    }
    this.save();
    const own = this.rec.txs.filter((e) => same(e.from, this.rec.deployer));
    const nonce = Number(
      await this.raw("eth_getTransactionCount", [this.rec.deployer, "latest"]),
    );
    // Review D-2: from the record's start, so an empty record and a
    // dropped first entry are counted too.
    const accounted = this.rec.startNonce + own.length;
    if (nonce !== accounted) {
      throw new RecordRefusal(
        `the deployer's nonce is ${nonce} but the record accounts for ${accounted}: a transaction outside the record; refusing to resume`,
      );
    }
    let contracts = 0;
    for (const [n, e] of this.rec.txs.entries()) {
      const t = await this.raw("eth_getTransactionByHash", [e.hash]);
      if (!t || !this.chain.sameTx(e, t)) {
        throw new RecordRefusal(
          `record entry #${n} (${e.label}): transaction ${e.hash} is not on chain as recorded: refusing`,
        );
      }
      if (e.contract) {
        await this.checkCode(e, n);
        contracts++;
      }
    }
    if (this.rec.txs.length) {
      this.log(
        `✅ ${this.file}: ${this.rec.txs.length} transactions and ${contracts} contracts match the chain (code hashes)`,
      );
    }
  }

  /** After the flows: every live entry was met exactly once. */
  async finish(): Promise<void> {
    if (this.refused) throw this.refused;
    await this.confirmLast();
    const live = this.live();
    if (this.cursor !== live.length) {
      const e = live[this.cursor];
      throw new RecordRefusal(
        `record entry #${this.rec.txs.indexOf(e)} (${e.label}) was never replayed: the flows took another path than the recorded run; refusing`,
      );
    }
  }
}
