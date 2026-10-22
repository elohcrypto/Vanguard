// Review U2 round 3 (the round-3 mutants R05, R07, R10, R12, R14, R16 and
// R24 that survived the first run): each case fails when its guard is
// removed. An entry the node cannot place is refused with the entry
// kept, a re-send is sent once, saved before the next read and only with
// a real hash, a mined entry drops its payload, and the dev-call
// allowlist matches whole method names.
import { expect } from "chai";
import { ethers, network } from "hardhat";
import { Recorder } from "../../scripts/production/deployRecord";
import {
  EntryChain,
  RecordRefusal,
} from "../../scripts/production/deployRecordChain";
import {
  loadRecord,
  saveRecord,
} from "../../scripts/production/deployRecordFile";
import * as h from "../helpers/deployRecordFlow";

describe("U2 round 3: an entry stays, a re-send is one checked send", function () {
  this.timeout(120000);
  const box = h.files();
  const load = () => loadRecord(box.file)!;
  const H = "0x" + "ab".repeat(32);
  const H2 = "0x" + "ef".repeat(32);
  const entry = (): any => ({
    from: "0x00000000000000000000000000000000000000aa",
    to: null,
    value: "0",
    dataHash: ethers.keccak256("0x6001"),
    data: "0x6001",
    nonce: 5,
    block: 100,
    status: "sent",
    hash: H,
    label: "x",
  });
  const chain = (raw: any, e: any, save = () => {}) =>
    new EntryChain(
      raw,
      { chainId: 11155111, txs: [e] } as any,
      1,
      () => {},
      save,
    );
  let real: typeof setTimeout;
  beforeEach(() => {
    real = global.setTimeout;
    (global as any).setTimeout = (f: any) => real(f, 0);
  });
  afterEach(() => {
    (global as any).setTimeout = real;
  });
  const settled = (p: Promise<any>) =>
    p.then(
      (r) => r,
      (x) => x,
    );

  it("R05: a mined entry keeps no payload; an unmined one keeps it", async function () {
    const r1 = new Recorder(box.file, await h.fresh(box.file), 1, () => {});
    await r1.install();
    const f = await ethers.getContractFactory("IdentityRegistry");
    await f.deploy();
    r1.remove();
    const { data } = await f.getDeployTransaction();
    expect(load().txs[0].data, "kept until mined").to.equal(data);
    await h.settle(box.file, load());
    expect(load().txs[0].status).to.equal("confirmed");
    expect(load().txs[0], "dropped once mined").to.not.have.property("data");
  });

  it("R07: an intent whose nonce went to a transaction the node cannot show is refused, kept", async function () {
    const rec = await h.fresh(box.file);
    const [d] = await ethers.getSigners();
    const nonce = await h.nonce();
    await (await d.sendTransaction({ to: h.AGENT })).wait();
    rec.txs.push({
      from: d.address,
      to: h.AGENT,
      value: "0",
      dataHash: ethers.keccak256("0x"),
      data: "0x",
      nonce,
      // after the block that holds its nonce: the scan cannot show it
      block: (await ethers.provider.getBlockNumber()) + 1,
      status: "sending",
      label: "pay",
    });
    saveRecord(box.file, rec);
    await expect(h.settle(box.file, load())).to.be.rejectedWith(
      `${d.address}'s nonce ${nonce} is used, but this node shows no transaction at it since block`,
    );
    expect(load().txs).to.have.length(1);
  });

  it("R10: a sent entry whose nonce is used, its transaction not shown, is refused, kept", async function () {
    const e = entry();
    const raw = async (m: string) =>
      m === "eth_getTransactionCount"
        ? "0x6"
        : m === "eth_blockNumber"
          ? "0x70"
          : m === "eth_getBlockByNumber"
            ? { transactions: [] }
            : null;
    const out = await settled(chain(raw, e).receipt(e));
    expect(out).to.be.instanceOf(RecordRefusal);
    expect(out.message).to.match(
      /nonce 5 is used, but this node shows no transaction at it since block 100: a lagging RPC; kept in the record/,
    );
  });

  /** A node that never knows the hash and leaves nonce 5 unused. */
  const unknown =
    (send: (p: any) => any) =>
    async (m: string, p: any[] = []) =>
      m === "eth_getTransactionCount"
        ? "0x5"
        : m === "eth_sendTransaction"
          ? send(p[0])
          : m === "eth_blockNumber"
            ? "0x70"
            : null;

  it("R12: a send answered without a hash is no send: the entry keeps its hash", async function () {
    const e = entry();
    const out = await settled(
      chain(
        unknown(() => null),
        e,
      ).receipt(e),
    );
    expect(out).to.be.instanceOf(RecordRefusal);
    expect(out.message).to.contain(
      "the node answered: no transaction hash (null)",
    );
    expect(e.hash).to.equal(H);
  });

  it("R14: a re-send's hash is saved before the next read", async function () {
    const e = entry();
    let saved = "";
    let atNextRead: string | null = null;
    let sent = false;
    const send = unknown(() => ((sent = true), H2));
    const raw = async (m: string, p: any[] = []) => {
      if (sent && atNextRead === null) atNextRead = saved;
      return send(m, p);
    };
    await settled(chain(raw, e, () => (saved = e.hash)).receipt(e));
    expect(atNextRead).to.equal(H2);
  });

  it("R16: an entry unknown again after its re-send is refused, sent once", async function () {
    const e = entry();
    const sends: any[] = [];
    const raw = unknown((tx) => {
      sends.push(tx);
      if (sends.length > 1) throw new Error("sent a second time");
      return H2;
    });
    const out = await settled(chain(raw, e).receipt(e));
    expect(out).to.be.instanceOf(RecordRefusal);
    expect(out.message).to.match(
      /is unused after it was sent again at that nonce: a lagging or inconsistent RPC; kept in the record/,
    );
    expect(sends).to.have.length(1);
  });

  it("R24: off a dev chain a method is allowed only as a whole eth_, net_ or web3_ name", async function () {
    const p: any = network.provider;
    const request = p.request.bind(p);
    const seen: string[] = [];
    p.request = async (a: any) => {
      seen.push(a.method);
      return a.method === "eth_chainId" ? "0xaa36a7" : request(a);
    };
    const rec = await h.fresh(box.file);
    rec.chainId = 11155111;
    const r = new Recorder(box.file, rec, 1, () => {});
    await r.install();
    try {
      for (const m of [
        "eth_chainId\n",
        "eth_sendTransaction ",
        "net_version x",
      ]) {
        await expect(p.request({ method: m, params: [] })).to.be.rejectedWith(
          "no dev-node call off a dev chain",
        );
      }
    } finally {
      r.remove();
      p.request = request;
    }
    expect(seen.filter((m) => /\s/.test(m))).to.deep.equal([]);
  });
});
