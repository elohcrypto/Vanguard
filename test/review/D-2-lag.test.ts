// Review D-2, round 2 (ported from the swarm's attack-u2-lag and
// attack-u2-chain, inverted): a sent entry leaves the deploy record only
// on evidence read from a node whose head is past the send. A backend K
// blocks behind (K > 2), head reads from mixed backends, a receipt of
// another transaction, or a hash seen pending between two unknown reads
// never drop a mined deploy transaction or send it twice.
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

  for (const K of [1, 2, 3, 5, 10]) {
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
        expect(loadRecord(box.file)!.txs[0].minedAt).to.equal(undefined);

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

describe("D-2 EntryChain: unsent only on evidence from past the send", function () {
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

  it("U2: head reads from a fresh and a lagging backend unsend nothing", async function () {
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

  it("a head that never reaches two past the send refuses, the entry kept", async function () {
    const e = { ...entry(), sentAtBlock: 100 };
    let reads = 0;
    const raw = async (m: string) => {
      if (m === "eth_blockNumber")
        return hex(Math.min(90 + Math.floor(reads++ / 2), 101));
      if (m === "eth_getTransactionCount") return "0x5";
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
      /cannot be read at block 102 or later \(two past the send\); its head is block 101: a lagging RPC; kept in the record, resume against a synced RPC/,
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
    expect(e.minedAt).to.equal(undefined);
    expect(saves.n).to.equal(0);
  });

  it("U5: unknown, pending, unknown: dropped only on a count two past the pending sighting", async function () {
    const e = entry();
    let blocks = 0;
    let byHash = 0;
    let pendingAt = -1;
    const tags: string[] = [];
    const head = () => 100 + Math.floor(blocks / 2);
    const raw = async (m: string, p: any[] = []) => {
      if (m === "eth_getTransactionByHash") {
        byHash++;
        if (byHash === 2) {
          pendingAt = head();
          return { hash, blockNumber: null };
        }
        return null;
      }
      if (m === "eth_getTransactionCount") {
        tags.push(p[1]);
        return "0x5"; // nonce 5 unused
      }
      if (m === "eth_blockNumber") {
        blocks++;
        return hex(head());
      }
      return null;
    };
    const r = await chain(raw, e).receipt(e);
    expect(r).to.equal(null); // evicted for real: unsent (M-2)
    expect(pendingAt).to.be.greaterThan(0);
    const pinned = tags.filter((t) => /^0x/.test(t)).map(Number);
    expect(pinned, "a count pinned to a block").to.not.be.empty;
    expect(Math.max(...pinned)).to.be.at.least(pendingAt + 2);
  });
});
