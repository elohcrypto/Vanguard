// Review D-2, round 6: the stray guards the round-5 attacker's mutants
// H02, H03, H08 and H12 found untested (G), and a record whose chain id
// was edited (lane F's F-1: its own refusal after one eth_chainId read,
// before anything is sent) (I).
import { expect } from "chai";
import { ethers, network } from "hardhat";
import { Recorder } from "../../scripts/production/deployRecord";
import {
  loadRecord,
  saveRecord,
} from "../../scripts/production/deployRecordFile";
import * as h from "../helpers/deployRecordFlow";

describe("D-2 round 6: the stray guards and the chain id, pinned", function () {
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
  const accepted = () => h.accepted(box.file);

  /**
   * Entry #0 (mined at `start`) settled behind a backend that hides it
   * (its transaction, receipt and the deployer's counts at `start`); the
   * signer answers the re-send with `answer(request, a)`.
   */
  async function lagging(
    start: number,
    answer: (request: any, a: any) => Promise<any>,
  ) {
    const hide = load().txs[0].hash;
    let lie = true;
    const restore = h.node(async (a, request) => {
      if (a.method === "eth_sendTransaction") {
        lie = false;
        return answer(request, a);
      }
      if (!lie) return undefined;
      if (a.method === "eth_getTransactionCount")
        return ethers.toQuantity(start);
      const hides =
        a.method === "eth_getTransactionByHash" ||
        a.method === "eth_getTransactionReceipt";
      return hides && hide && a.params[0] === hide ? null : undefined;
    });
    try {
      return await accepted();
    } finally {
      restore();
    }
  }

  it("G (H02): a re-send answered with another sender's transaction is no stray: refused as not the entry, the entry kept", async function () {
    const start = await h.nonce();
    await h.sendOne(box.file);
    const [, other] = await ethers.getSigners();
    const theirs = (await (
      await other.sendTransaction({ to: h.AGENT })
    ).wait())!;
    const err = await lagging(start, async () => theirs.hash);
    expect(err).to.contain(
      `record entry #0 (new IdentityRegistry): ${theirs.hash} mined at nonce`,
    );
    expect(err).to.contain(
      "the signer did not send it as recorded; kept in the record",
    );
    expect((load() as any).strays, "no stray").to.equal(undefined);
  });

  it("G (H03): a stray the signer answers twice is listed once; the healthy resume completes", async function () {
    const start = await h.nonce();
    await h.sendOne(box.file);
    const drop = (request: any, a: any) => {
      const { nonce, ...rest } = a.params[0];
      return request({ method: a.method, params: [rest] });
    };
    expect(await lagging(start, drop)).to.contain("outside the record");
    const stray = load().strays![0].hash;
    expect(await lagging(start, async () => stray)).to.contain(
      `a transaction the signer sent at nonce ${start + 1} outside the record`,
    );
    expect(load().strays!.map((s) => s.hash)).to.deep.equal([stray]);
    expect(await accepted()).to.equal("accepted");
    expect(await h.nonce()).to.equal(start + 2);
  });

  it("G (H08): another sender's listed stray is not counted in the deployer's nonce", async function () {
    const [, other] = await ethers.getSigners();
    const rec = await h.fresh(box.file);
    const t = (await (await other.sendTransaction({ to: h.AGENT })).wait())!;
    const tx = (await ethers.provider.getTransaction(t.hash))!;
    rec.strays = [
      {
        hash: t.hash,
        from: other.address,
        nonce: tx.nonce,
        entry: 0,
        label: "x",
      },
    ];
    saveRecord(box.file, rec);
    expect(await accepted()).to.equal("accepted");
  });

  it("G (H12): a stray's cost line counts the value it moved", async function () {
    const [d] = await ethers.getSigners();
    const rec = await h.fresh(box.file);
    const value = ethers.parseEther("1.5");
    const t = (await (await d.sendTransaction({ to: h.AGENT, value })).wait())!;
    rec.strays = [
      {
        hash: t.hash,
        from: d.address,
        nonce: rec.startNonce,
        entry: 0,
        label: "x",
      },
    ];
    saveRecord(box.file, rec);
    const lines: string[] = [];
    const r = new Recorder(box.file, load(), 1, (m) => lines.push(m));
    await r.install();
    r.remove();
    const cost = ethers.formatEther(t.gasUsed * t.gasPrice + value);
    expect(lines.join("\n")).to.contain(`it cost ${d.address} ${cost} ETH`);
  });

  for (const id of [1, 31338]) {
    it(`I (F-1): a record edited to chain ${id} is refused by name after one eth_chainId read; nothing sent, the deployer's nonce unchanged`, async function () {
      const start = await h.nonce();
      await h.sendOne(box.file, true); // entry #0 recorded, never sent
      const rec = load();
      expect(rec.txs[0].status).to.equal("sending");
      rec.chainId = id;
      saveRecord(box.file, rec);
      const seen: string[] = [];
      const restore = h.node(async (a) => {
        seen.push(a.method);
        return undefined;
      });
      let err = "";
      try {
        err = await accepted();
      } finally {
        restore();
      }
      expect(err).to.equal(`${box.file} is for chain ${id}, not 31337`);
      expect(seen).to.deep.equal(["eth_chainId"]);
      expect(await h.nonce()).to.equal(start);
      expect(
        await network.provider.request({
          method: "eth_getTransactionCount",
          params: [rec.deployer, "pending"],
        }),
      ).to.equal(ethers.toQuantity(start));
    });
  }
});
