// Review D-2, round 11 (item D, LOW): the record rules lane G's lever
// found unpinned at b7b314c (g-mutants-10.txt), one pin each: G02 (every
// lagging listed stray is named), G10 (a nonce below the record is
// refused too), G28 (a re-send reply is a 32-byte hash), G30 (the node's
// answer is quoted by its first line), G41/G42 (the bound is exactly
// 5000 blocks), G45 (a re-send mined in its intent's own block is its
// re-send). D-2-pins-9 is at 495 lines, so they live here.
import { expect } from "chai";
import { ethers, network } from "hardhat";
import { saveRecord } from "../../scripts/production/deployRecordFile";
import * as h from "../helpers/deployRecordFlow";
import { strays } from "../helpers/deployRecordStrays";

describe("D-2 round 11 pins: lane G's round-10 survivors", function () {
  this.timeout(600000);
  const s = strays();
  const mine = (n: number) =>
    network.provider.request({
      method: "hardhat_mine",
      params: [ethers.toQuantity(n)],
    });

  it("P-G02: two listed strays lagging on this node are both named", async function () {
    const start = await h.nonce();
    await h.sendOne(s.box.file);
    for (let i = 0; i < 2; i++) {
      const restore = s.liar(start, s.load().txs[0].hash!);
      try {
        expect(await h.accepted(s.box.file)).to.contain("not as the entry recorded");
      } finally {
        restore();
      }
    }
    const rows = s.load().strays!.map((x) => x.hash);
    expect(rows).to.have.length(2);
    const lag = h.node(async (a) =>
      a.method === "eth_getTransactionReceipt" && rows.includes(a.params[0])
        ? null
        : undefined,
    );
    let res = "";
    try {
      res = await s.resume();
    } finally {
      lag();
    }
    const one = (x: string) =>
      `stray ${x} is listed but not shown mined on this node: a lagging RPC; resume against a synced RPC`;
    expect(res).to.equal(
      `the deployer's nonce is ${start + 3} but the record accounts for ${start + 1}: a transaction outside the record; refusing to resume (${one(rows[0])}; ${one(rows[1])})`,
    );
    expect(await s.resume(), "the node caught up").to.equal("accepted");
  });

  it("P-G10: a node whose count is below the record's is refused, not accepted", async function () {
    const start = await h.nonce();
    await h.sendOne(s.box.file);
    expect(await s.resume()).to.equal("accepted");
    const behind = h.node(async (a) =>
      a.method === "eth_getTransactionCount" && a.params[1] === "latest"
        ? ethers.toQuantity(start)
        : undefined,
    );
    let res = "";
    try {
      res = await s.resume();
    } finally {
      behind();
    }
    expect(res).to.equal(
      `the deployer's nonce is ${start} but the record accounts for ${start + 1}: a transaction outside the record; refusing to resume`,
    );
  });

  /** A resume whose re-send of entry #0 the node answers by `reply`. */
  async function answered(reply: (rest: any, request: any) => Promise<any>) {
    const start = await h.nonce();
    await h.sendOne(s.box.file);
    const hide = s.load().txs[0].hash!;
    const restore = h.node(async (a, request) => {
      if (a.method === "eth_sendTransaction") {
        const { nonce, ...rest } = a.params[0];
        return reply(rest, request);
      }
      if (a.method === "eth_getTransactionCount")
        return ethers.toQuantity(start);
      const hides =
        a.method === "eth_getTransactionByHash" ||
        a.method === "eth_getTransactionReceipt";
      return hides && a.params[0] === hide ? null : undefined;
    });
    try {
      return { res: await h.accepted(s.box.file), hide };
    } finally {
      restore();
    }
  }

  it("P-G28: a re-send answered by a short hex string is no transaction hash: quoted, never recorded", async function () {
    const { res, hide } = await answered(async (rest, request) => {
      await request({ method: "eth_sendTransaction", params: [rest] });
      return "0x1234";
    });
    expect(res).to.contain("; the node answered: no transaction hash (0x1234)");
    expect(s.load().txs[0].hash, "the entry's own hash stays").to.equal(hide);
    expect(s.load().txs[0].resendFrom, "the intent is kept").to.be.a("number");
  });

  it("P-G30: the node's refusal is quoted by its first line only", async function () {
    const { res } = await answered(async () => {
      throw Object.assign(new Error("signer down\n    at the signer's stack"), {
        code: -32000,
      });
    });
    expect(res).to.contain("; the node answered: signer down");
    expect(res).to.not.contain("the signer's stack");
  });

  /**
   * Two entries mined; 5100 blocks on, entry #1's payload hand-sent at
   * the next free nonce (its killed re-send); entry #1's intent set
   * `back` blocks before the block it mined in, the head.
   */
  async function unrecorded(back: number) {
    const [d] = await ethers.getSigners();
    const start = await h.nonce();
    const rec = await h.fresh(s.box.file);
    await h.run(s.box.file, rec, () => h.flow(2)).catch(() => {});
    expect(await h.accepted(s.box.file)).to.equal("accepted");
    const r = s.load();
    await mine(5100);
    const ir = await ethers.getContractAt("IdentityRegistry", r.txs[1].to!);
    const data =
      r.txs[1].data ?? ir.interface.encodeFunctionData("addAgent", [h.AGENT]);
    const tx = await d.sendTransaction({ to: r.txs[1].to!, data, nonce: start + 2 });
    const at = (await tx.wait())!.blockNumber;
    expect(await ethers.provider.getBlockNumber()).to.equal(at);
    r.txs[1].resendFrom = at - back;
    saveRecord(s.box.file, r);
    return { d, start, hash: tx.hash, from: at - back };
  }

  it("P-G42: exactly 5000 blocks after the intent the scan still runs and finds the re-send", async function () {
    const { hash } = await unrecorded(5000);
    expect(await s.resume()).to.equal("accepted");
    expect(s.load().strays!.map((x) => x.hash)).to.deep.equal([hash]);
  });

  it("P-G41: 5001 blocks after the intent the scan is refused", async function () {
    const { d, start, from } = await unrecorded(5001);
    expect(await s.resume()).to.contain(
      `nonce ${start + 2}: the chain head (block ${from + 5001}) is more than 5000 blocks past entry #1 (${s.load().txs[1].label})'s intent (block ${from}), the earliest the record keeps, and those 5000 blocks hold no transaction of ${d.address} at nonce ${start + 2}`,
    );
  });

  it("P-G45: a re-send mined in its intent's own block is its re-send", async function () {
    const { hash } = await unrecorded(0);
    expect(await s.resume()).to.equal("accepted");
    expect(s.load().strays!.map((x) => x.hash)).to.deep.equal([hash]);
  });
});
