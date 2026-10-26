// Review D-2, round 5 (ported from lane C's F1, inverted): a re-send the
// signer mined at another nonce is a stray: recorded outside the record,
// refused by name once and never the entry; a healthy resume adopts the
// entry's own transaction at its nonce and completes, the stray counted in
// the deployer's nonce and printed with its cost. Anything else the deployer
// sent outside the record still refuses.
import { expect } from "chai";
import { ethers, network } from "hardhat";
import { Recorder } from "../../scripts/production/deployRecord";
import {
  loadRecord,
  saveRecord,
} from "../../scripts/production/deployRecordFile";
import * as h from "../helpers/deployRecordFlow";

describe("D-2 round 5: a re-send mined at another nonce is a stray, never the entry", function () {
  this.timeout(120000);
  const box = h.files();
  const load = () => loadRecord(box.file)!;
  let realST: any;
  beforeEach(() => {
    realST = global.setTimeout;
    (global as any).setTimeout = (f: any, ms: any, ...a: any[]) =>
      realST(f, Math.min(ms ?? 0, 2), ...a);
  });
  afterEach(() => {
    (global as any).setTimeout = realST;
  });
  const { node, created } = h;
  const accepted = () => h.accepted(box.file);
  const sendOne = (refuse = false) => h.sendOne(box.file, refuse);
  const kmData = async () =>
    (
      await (
        await ethers.getContractFactory("KeyManager")
      ).getDeployTransaction()
    ).data;
  /**
   * Lane C F1: entry #0 mined at `start`; the resume runs behind a backend
   * that hides it (its receipt, its transaction, the deployer's counts)
   * until the first send, and a signer that drops the nonce field, so the
   * re-send mines at `start + 1`: a stray deploy.
   */
  async function strayed(held = false) {
    const start = await h.nonce();
    await sendOne();
    const automine = (on: boolean) =>
      network.provider.request({ method: "evm_setAutomine", params: [on] });
    if (held) await automine(false); // the node holds the stray pending
    const own = load().txs[0].hash!;
    const st = { lie: true, sends: 0 };
    const restore = node(async (a, request) => {
      if (a.method === "eth_sendTransaction") {
        st.sends++;
        st.lie = false;
        const { nonce, ...rest } = a.params[0]; // this signer ignores it
        return request({ method: a.method, params: [rest] });
      }
      if (!st.lie) return undefined;
      if (a.method === "eth_getTransactionCount")
        return ethers.toQuantity(start);
      const hides =
        a.method === "eth_getTransactionByHash" ||
        a.method === "eth_getTransactionReceipt";
      return hides && a.params[0] === own ? null : undefined;
    });
    let err = "";
    try {
      err = await accepted();
    } finally {
      restore();
      if (held) {
        await automine(true);
        await network.provider.request({ method: "evm_mine" });
      }
    }
    return { start, own, err, sends: st.sends };
  }

  it("F2 (lane C F1): a re-send the signer mined at another nonce is a stray: refused by name, never the entry; a healthy resume adopts the entry's own transaction and completes", async function () {
    const [d] = await ethers.getSigners();
    const { start, own, err, sends } = await strayed();
    expect(sends, "the one re-send").to.equal(1);
    const stray = (load() as any).strays?.[0]?.hash;
    expect(err).to.match(
      new RegExp(
        `record entry #0 \\(new IdentityRegistry\\): ${stray} mined at nonce ${start + 1} from 0x[0-9a-fA-F]{40}, not as the entry recorded \\(nonce ${start} from .*: a transaction the signer sent at nonce ${start + 1} outside the record`,
      ),
    );
    const rec: any = load();
    expect(rec.strays).to.deep.equal([
      {
        hash: stray,
        from: d.address,
        nonce: start + 1,
        entry: 0,
        label: "new IdentityRegistry",
      },
    ]);
    expect([
      rec.txs[0].status,
      rec.txs[0].hash,
      !!rec.txs[0].data,
    ]).to.deep.equal(["sending", undefined, true]);
    const lines: string[] = [];
    const r = new Recorder(box.file, load(), 1, (m) => lines.push(m));
    await r.install();
    r.remove();
    const e = load().txs[0];
    const [mine, theirs] = await created(start);
    expect([e.status, e.hash, e.contract]).to.deep.equal([
      "confirmed",
      own,
      mine,
    ]);
    expect(theirs, "the stray deploy stays on chain").to.not.equal(undefined);
    expect(lines.join("\n")).to.match(
      new RegExp(
        `nonce ${start + 1}: ${stray}, the signer's re-send of entry #0 \\(new IdentityRegistry\\) at another nonce: outside the record, never adopted; it cost ${d.address} [0-9.]+ ETH and created ${theirs}`,
      ),
    );
    expect(await h.nonce()).to.equal(start + 2);
  });

  it("F2 (lane C case 1): a nonce-dropping signer's re-send at the entry's own nonce is the entry, no stray", async function () {
    const start = await h.nonce();
    await sendOne(true);
    let sends = 0;
    const restore = node(async (a, request) => {
      if (a.method !== "eth_sendTransaction") return undefined;
      sends++;
      const { nonce, ...rest } = a.params[0]; // this signer ignores it
      return request({ method: a.method, params: [rest] });
    });
    let err = "";
    try {
      err = await accepted();
    } finally {
      restore();
    }
    const rec: any = load();
    expect([err, sends, rec.strays]).to.deep.equal(["accepted", 1, undefined]);
    expect(rec.txs.map((t: any) => [t.nonce, t.status])).to.deep.equal([
      [start, "confirmed"],
    ]);
    expect(await created(start)).to.have.length(1);
  });

  it("F2 (lead condition a): a first send mined at another nonce is refused as round 4 refused it, no stray", async function () {
    const start = await h.nonce();
    let lie = true;
    const restore = node(async (a, request) => {
      const pending =
        a.method === "eth_getTransactionCount" && a.params[1] === "pending";
      if (pending && lie) {
        lie = false; // the record asks for start + 1; the node gives start
        return ethers.toQuantity(start + 1);
      }
      if (a.method !== "eth_sendTransaction") return undefined;
      const { nonce, ...rest } = a.params[0]; // this signer ignores it
      return request({ method: a.method, params: [rest] });
    });
    let err = "";
    try {
      err = await h
        .run(box.file, await h.fresh(box.file), async () =>
          (
            await (await ethers.getContractFactory("IdentityRegistry")).deploy()
          ).waitForDeployment(),
        )
        .then(
          () => "",
          (e: Error) => e.message,
        );
    } finally {
      restore();
    }
    expect(err).to.match(
      new RegExp(
        `mined at nonce ${start} from 0x[0-9a-fA-F]{40}, not as the entry recorded \\(nonce ${start + 1} from .*: the signer did not send it as recorded; kept in the record`,
      ),
    );
    const rec: any = load();
    expect([rec.strays, rec.txs[0].status, !!rec.txs[0].hash]).to.deep.equal([
      undefined,
      "sent",
      true,
    ]);
  });

  it("F2: a stray the node still holds pending is refused at once by name, and counted once mined", async function () {
    const { start, err } = await strayed(true);
    const rec: any = load();
    expect(err).to.contain(
      `${rec.strays?.[0]?.hash} sent at nonce ${start + 1} from`,
    );
    expect(err).to.contain(
      `a transaction the signer sent at nonce ${start + 1} outside the record`,
    );
    expect(await accepted(), "once it mined").to.equal("accepted");
    expect(await h.nonce()).to.equal(start + 2);
  });

  it("F2: with a stray recorded, a deployer transaction the record does not hold still refuses", async function () {
    const [d] = await ethers.getSigners();
    await strayed();
    expect(await accepted(), "the healthy resume").to.equal("accepted");
    await (await d.sendTransaction({ to: h.AGENT })).wait();
    expect(await accepted()).to.match(
      /the deployer's nonce is \d+ but the record accounts for \d+: a transaction outside the record; refusing to resume/,
    );
  });

  it("F2: a stray the chain shows at another nonce than recorded is refused by name", async function () {
    const { start } = await strayed();
    const rec: any = load();
    expect(rec.strays, "a stray recorded").to.have.length(1);
    const stray = rec.strays[0].hash;
    rec.strays[0].nonce = start + 7;
    saveRecord(box.file, rec);
    expect(await accepted()).to.equal(
      `stray ${stray} (nonce ${start + 7}, the re-send of entry #0): the chain shows it from ${rec.strays[0].from} at nonce ${start + 1}, not as recorded: refusing`,
    );
  });

  it("F2 (round 6 E): a later unsent intent at the stray's nonce is stale: dropped, never sent", async function () {
    const [d] = await ethers.getSigners();
    const start = await h.nonce();
    await sendOne();
    const rec = load();
    const data = await kmData();
    rec.txs.push({
      from: d.address,
      to: null,
      value: "0",
      dataHash: ethers.keccak256(data),
      data,
      nonce: start + 1,
      block: await ethers.provider.getBlockNumber(),
      status: "sending",
      label: "new KeyManager",
    });
    saveRecord(box.file, rec);
    const own = rec.txs[0].hash!;
    let lie = true;
    const restore = node(async (a, request) => {
      if (a.method === "eth_sendTransaction") {
        lie = false;
        const { nonce, ...rest } = a.params[0];
        return request({ method: a.method, params: [rest] });
      }
      if (!lie) return undefined;
      if (a.method === "eth_getTransactionCount")
        return ethers.toQuantity(start);
      const hides =
        a.method === "eth_getTransactionByHash" ||
        a.method === "eth_getTransactionReceipt";
      return hides && a.params[0] === own ? null : undefined;
    });
    try {
      expect(await accepted()).to.contain(
        `a transaction the signer sent at nonce ${start + 1} outside the record`,
      );
    } finally {
      restore();
    }
    expect(await accepted()).to.equal("accepted");
    expect(load().txs.map((t) => [t.nonce, t.status])).to.deep.equal([
      [start, "confirmed"],
    ]);
    expect(await h.nonce(), "nothing sent for the dropped intent").to.equal(
      start + 2,
    );
  });
});
