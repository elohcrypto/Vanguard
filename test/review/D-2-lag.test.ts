// Review D-2, rounds 2 and 3 (ported from the swarm's attack-u2-lag and
// attack-u2-chain, inverted): a sent entry never leaves the deploy
// record. A backend K blocks behind (K = 1..10), head reads from mixed
// backends, a receipt of another transaction, or an unknown hash never
// drop a mined deploy transaction or send it twice: an entry the node
// does not know is sent again at its recorded nonce (round 3).
import { expect } from "chai";
import { ethers, network } from "hardhat";
import { Recorder } from "../../scripts/production/deployRecord";
import {
  EntryChain,
  RecordRefusal,
} from "../../scripts/production/deployRecordChain";
import { loadRecord } from "../../scripts/production/deployRecordFile";
import * as h from "../helpers/deployRecordFlow";

describe("D-2 a lag longer than two blocks keeps a mined deploy transaction", function () {
  const box = h.files();

  /** A node K blocks behind: head, receipts, hashes and counts at head - K. */
  function lagging(K: number) {
    const p: any = network.provider;
    const request = p.request.bind(p);
    const send = p.send?.bind(p);
    const st = { on: false };
    const shim = async (a: any) => {
      if (!st.on) return request(a);
      const seen = Number(await request({ method: "eth_blockNumber" })) - K;
      const m = a.method;
      if (m === "eth_blockNumber") return ethers.toQuantity(seen);
      if (
        m === "eth_getTransactionReceipt" ||
        m === "eth_getTransactionByHash"
      ) {
        const t = await request({
          method: "eth_getTransactionByHash",
          params: [a.params[0]],
        });
        if (t && t.blockNumber && Number(t.blockNumber) > seen) return null;
        return request(a);
      }
      if (m === "eth_getTransactionCount")
        return request({
          method: m,
          params: [a.params[0], ethers.toQuantity(seen)],
        });
      return request(a);
    };
    p.request = shim;
    if (send)
      p.send = (m: string, x?: unknown[]) =>
        shim({ method: m, params: x ?? [] });
    return {
      st,
      restore: () => {
        p.request = request;
        if (send) p.send = send;
      },
    };
  }

  /** IdentityRegistry contracts the deployer created from nonce `start` on. */
  async function created(start: number) {
    const [d] = await ethers.getSigners();
    const out: string[] = [];
    for (let n = start; n < (await h.nonce()); n++) {
      const a = ethers.getCreateAddress({ from: d.address, nonce: n });
      if ((await ethers.provider.getCode(a)) !== "0x") out.push(a);
    }
    return out;
  }

  const deploy = async () => {
    const ir = await (
      await ethers.getContractFactory("IdentityRegistry")
    ).deploy();
    await ir.waitForDeployment();
    return ir.getAddress();
  };

  for (const K of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]) {
    it(`K=${K}: the mined deploy stays in the record and is never sent again`, async function () {
      for (let i = 0; i < 12; i++)
        await network.provider.request({ method: "evm_mine" });
      const start = await h.nonce();
      const node = lagging(K);
      try {
        // run 1: the deploy is sent; the process dies before any receipt read
        const r1 = new Recorder(box.file, await h.fresh(box.file), 1, () => {});
        await r1.install();
        await (await ethers.getContractFactory("IdentityRegistry")).deploy();
        r1.remove();

        // run 2 resumes against the lagging backend
        node.st.on = true;
        const r2 = new Recorder(box.file, loadRecord(box.file)!, 1, () => {});
        const settled = await r2.install().then(
          () => "",
          (e: Error) => e.message,
        );
        if (settled) {
          expect(settled).to.match(
            /kept in the record, resume against a synced RPC/,
          );
        }
        expect(loadRecord(box.file)!.txs, "the entry is kept").to.have.length(
          1,
        );
        node.st.on = false;
        const r3 = settled
          ? new Recorder(box.file, loadRecord(box.file)!, 1, () => {})
          : r2;
        if (settled) await r3.install();
        try {
          await deploy();
          await r3.finish();
          expect([r3.sent, r3.reused]).to.deep.equal([0, 1]);
        } finally {
          r3.remove();
        }
        expect(await created(start), "one deploy").to.have.length(1);
        await h.settle(box.file, loadRecord(box.file)!);
      } finally {
        node.restore();
      }
    });
  }
});

describe("D-2 EntryChain: an unknown entry is kept and sent again at its nonce", function () {
  this.timeout(60000);
  const hash = "0x" + "ab".repeat(32);
  const entry = (): any => ({
    from: "0x00000000000000000000000000000000000000aa",
    to: null,
    value: "0",
    dataHash: "0x" + "00".repeat(32),
    nonce: 5,
    block: 100,
    status: "sent",
    hash,
    label: "x",
  });
  const hex = (n: number) => "0x" + n.toString(16);
  let real: typeof setTimeout;
  beforeEach(() => {
    real = global.setTimeout;
    (global as any).setTimeout = (f: any) => real(f, 0);
  });
  afterEach(() => {
    (global as any).setTimeout = real;
  });
  const chain = (raw: any, e: any, log: string[] = [], saves = { n: 0 }) =>
    new EntryChain(
      raw,
      { chainId: 11155111, txs: [e] } as any,
      1,
      (m) => log.push(m),
      () => saves.n++,
    );

  it("U2: head reads from a fresh and a lagging backend drop nothing", async function () {
    const e = entry();
    let reads = 0;
    const raw = async (m: string, p: any[] = []) => {
      if (m === "eth_blockNumber") return hex(reads++ % 2 ? 103 : 100);
      if (m === "eth_getTransactionCount") {
        // the lagging backend answers every other read; it has no block 101+
        if (/^0x/.test(p[1]) && Number(p[1]) > 100)
          throw new Error("header not found");
        return "0x5";
      }
      return null;
    };
    const out = await chain(raw, e)
      .receipt(e)
      .then(
        (r) => r,
        (x) => x,
      );
    expect(out).to.be.instanceOf(RecordRefusal);
    expect(out.message).to.match(
      /record entry #0 \(x\): .* kept in the record, resume against a synced RPC/,
    );
  });

  it("U4: a receipt of another transaction is refused and stamps nothing", async function () {
    const e = entry();
    const saves = { n: 0 };
    const other = {
      transactionHash: "0x" + "cd".repeat(32),
      blockNumber: "0x70",
      status: "0x1",
      gasUsed: "0x5208",
      contractAddress: null,
    };
    const raw = async (m: string) =>
      m === "eth_getTransactionReceipt"
        ? other
        : m === "eth_blockNumber"
          ? "0x80"
          : null;
    const out = await chain(raw, e, [], saves)
      .receipt(e)
      .then(
        (r) => r,
        (x) => x,
      );
    expect(out).to.be.instanceOf(RecordRefusal);
    expect(out.message).to.match(/receipt of 0x(cd){32}/);
    expect(saves.n).to.equal(0);
  });

  it("U5: an unknown hash is sent again at its nonce with its recorded payload, never dropped", async function () {
    const data = "0x60016002";
    const e = { ...entry(), data, dataHash: ethers.keccak256(data), gas: "0x5208" };
    const H2 = "0x" + "ef".repeat(32);
    const sends: any[] = [];
    let byHash = 0;
    const raw = async (m: string, p: any[] = []) => {
      if (m === "eth_getTransactionByHash" && p[0] === H2)
        return { hash: H2, from: e.from, nonce: "0x5", to: null, value: "0x0", input: data }; // mined, as the entry (round 4)
      if (m === "eth_getTransactionByHash")
        return byHash++ === 1 ? { hash } : null;
      if (m === "eth_getTransactionCount") return "0x5"; // nonce 5 unused
      if (m === "eth_sendTransaction") {
        sends.push(p[0]);
        return H2;
      }
      if (m === "eth_getTransactionReceipt" && p[0] === H2)
        return { transactionHash: H2, blockNumber: "0x70", status: "0x1" };
      if (m === "eth_blockNumber") return "0x70";
      return null;
    };
    const r = await chain(raw, e).receipt(e);
    expect(sends).to.deep.equal([
      { from: e.from, value: "0x0", data: e.data, gas: e.gas, nonce: "0x5" },
    ]);
    expect([r.transactionHash, e.hash, e.status]).to.deep.equal([
      H2,
      H2,
      "sent",
    ]);
  });
});
