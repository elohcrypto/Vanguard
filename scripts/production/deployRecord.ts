/**
 * Plan v2 Task 5.7: the deploy record, deployments/<chainId>.json, and
 * the provider hook that keeps it (DEPLOY_RECORD overrides the path).
 *
 * Every transaction the deploy sends is recorded in order, atomically
 * (temporary file, fsync, rename): an intent (sender, pinned nonce, the
 * block it was read at) before it is sent, its hash once sent, and its
 * receipt (status, contract address, runtime code hash, artifact label)
 * before the next transaction. A re-run replays: the deploy flows run
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
import * as fs from "fs";
import * as path from "path";
import { artifacts, ethers, network } from "hardhat";

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
  txs: TxEntry[];
  contracts: Record<string, string>;
  complete: boolean;
}

const same = (a?: string | null, b?: string | null) =>
  String(a ?? "").toLowerCase() === String(b ?? "").toLowerCase();
const LOCAL = new Set([31337, 1337]);
const READS_AT = new Set([
  "eth_call",
  "eth_getCode",
  "eth_getBalance",
  "eth_getStorageAt",
  "eth_getTransactionCount",
]);

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

let names: { bytecode: string; name: string }[] | null = null;
let selectors: Map<string, string> | null = null;

/** The artifact whose creation code `data` starts with, else "create". */
async function createLabel(data: string): Promise<string> {
  if (!names) {
    names = [];
    for (const fq of await artifacts.getAllFullyQualifiedNames()) {
      const a = await artifacts.readArtifact(fq);
      if (a.bytecode.length > 2) {
        names.push({
          bytecode: a.bytecode.toLowerCase(),
          name: a.contractName,
        });
      }
    }
    names.sort((x, y) => y.bytecode.length - x.bytecode.length);
  }
  const d = data.toLowerCase();
  return `new ${names.find((n) => d.startsWith(n.bytecode))?.name ?? "contract"}`;
}

/** `to`.fn for a call, fn read from the compiled ABIs by selector. */
async function callLabel(to: string, data: string): Promise<string> {
  if (!selectors) {
    selectors = new Map();
    for (const fq of await artifacts.getAllFullyQualifiedNames()) {
      const i = new ethers.Interface((await artifacts.readArtifact(fq)).abi);
      i.forEachFunction((f) => selectors!.set(f.selector, f.name));
    }
  }
  return `${ethers.getAddress(to).slice(0, 10)}….${selectors.get(data.slice(0, 10)) ?? data.slice(0, 10)}`;
}

/** Thrown when a re-run cannot follow its record: nothing more is sent. */
export class RecordRefusal extends Error {
  name = "RecordRefusal";
}

export class Recorder {
  sent = 0;
  reused = 0;
  private cursor = 0;
  private last: TxEntry | null = null;
  private raw!: (method: string, params?: unknown[]) => Promise<any>;
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

  /**
   * Entries a replay meets, in order. A reverted one is replayed too: the
   * flow sees the same revert and takes the same branch.
   */
  private live(): TxEntry[] {
    return this.rec.txs;
  }

  /**
   * Hook the provider (request and send, as PostCeremony.guardDeployerKey
   * does), then settle the record against the chain before any read the
   * flows make. Returns once the record is consistent; throws otherwise.
   */
  async install(): Promise<void> {
    const p: any = network.provider;
    const request = p.request.bind(p);
    const send = typeof p.send === "function" ? p.send.bind(p) : null;
    this.raw = (method, params = []) => request({ method, params });
    p.request = (a: any) => this.handle(a.method, a.params ?? []);
    if (send) p.send = (m: string, a?: unknown[]) => this.handle(m, a ?? []);
    this.uninstall = () => {
      p.request = request;
      if (send) p.send = send;
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
  private refused: RecordRefusal | null = null;

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
    if (
      /^eth_(sign|signTransaction|signTypedData|sendRawTransaction)/.test(
        method,
      ) ||
      method === "personal_sign"
    ) {
      throw new RecordRefusal(
        `the deploy process never signs (${method} refused): keys live in the external signer`,
      );
    }
    if (
      /^(evm_|hardhat_)/.test(method) &&
      method !== "hardhat_metadata" &&
      !LOCAL.has(this.rec.chainId)
    ) {
      throw new RecordRefusal(
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
    const block = Number(await this.raw("eth_blockNumber"));
    const e: TxEntry = {
      from,
      to: tx.to ? ethers.getAddress(tx.to) : null,
      value: BigInt(tx.value ?? 0).toString(),
      dataHash: ethers.keccak256(data),
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
    this.save();
    this.last = e;
    this.cursor = this.live().length;
    this.sent++;
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

  /**
   * The receipt of `hash` once it has `confirmations`; a transaction the
   * node no longer knows (dropped, replaced) is a refusal, not a hang.
   */
  private async receipt(hash: string): Promise<any> {
    for (;;) {
      const r = await this.raw("eth_getTransactionReceipt", [hash]);
      if (r) {
        const head = Number(await this.raw("eth_blockNumber"));
        if (head - Number(r.blockNumber) + 1 >= this.confirmations) return r;
      } else if (!(await this.raw("eth_getTransactionByHash", [hash]))) {
        throw new RecordRefusal(
          `transaction ${hash} is unknown to the node (dropped or replaced): find what took its nonce, then re-run`,
        );
      }
      await new Promise((ok) => setTimeout(ok, 1000));
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
    this.save();
  }

  /** The last sent transaction's receipt into the record. */
  async confirmLast(): Promise<void> {
    if (!this.last) return;
    const e = this.last;
    this.last = null;
    await this.confirm(e, await this.receipt(e.hash!));
  }

  /** The mined transaction from `e.from` at `e.nonce` since `e.block`. */
  private async findMined(e: TxEntry): Promise<any> {
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
    for (const e of [...this.rec.txs]) {
      if (e.status === "sending") {
        const used =
          Number(
            await this.raw("eth_getTransactionCount", [e.from, "latest"]),
          ) > e.nonce;
        const t = used ? await this.findMined(e) : null;
        if (
          used &&
          (!t || !same(t.to, e.to) || ethers.keccak256(t.input) !== e.dataHash)
        ) {
          throw new RecordRefusal(
            `${e.from} used nonce ${e.nonce} for a transaction that is not record entry #${this.rec.txs.indexOf(e)} (${e.label}): refusing`,
          );
        }
        if (!t) {
          const pending = Number(
            await this.raw("eth_getTransactionCount", [e.from, "pending"]),
          );
          if (pending > e.nonce) {
            throw new RecordRefusal(
              `${e.from}'s nonce ${e.nonce} is pending (${e.label}): wait for it to mine, then re-run`,
            );
          }
          this.rec.txs.splice(this.rec.txs.indexOf(e), 1); // never sent
          this.log(
            `   ↩️  ${e.label}: was never sent; dropped from the record`,
          );
          continue;
        }
        e.hash = t.hash;
        e.status = "sent";
        this.log(
          `   ↪️  ${e.label}: sent before the stop (${t.hash}); adopted`,
        );
      }
      if (e.status === "sent")
        await this.confirm(e, await this.receipt(e.hash!));
    }
    this.save();
    const own = this.rec.txs.filter((e) => same(e.from, this.rec.deployer));
    const nonce = Number(
      await this.raw("eth_getTransactionCount", [this.rec.deployer, "latest"]),
    );
    if (own.length && nonce !== own[0].nonce + own.length) {
      throw new RecordRefusal(
        `the deployer's nonce is ${nonce} but the record accounts for ${own[0].nonce + own.length}: a transaction outside the record; refusing to resume`,
      );
    }
    let contracts = 0;
    for (const [n, e] of this.rec.txs.entries()) {
      const t = await this.raw("eth_getTransactionByHash", [e.hash]);
      if (
        !t ||
        !same(t.from, e.from) ||
        Number(t.nonce) !== e.nonce ||
        ethers.keccak256(t.input) !== e.dataHash
      ) {
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
