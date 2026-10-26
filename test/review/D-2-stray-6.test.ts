// Review D-2, round 6 (the round-5 attacker G's T1-T4, inverted): a stray
// is a transaction the record does not otherwise account for. A re-send
// answered with another entry's or an older transaction is refused by name
// and never listed (C); a stray still pending stops the resume until it
// mines or drops, and a dropped one frees its nonce (D); an unsent intent
// at a mined stray's nonce is stale, dropped and planned again (E).
import { expect } from "chai";
import { ethers, network } from "hardhat";
import { Recorder } from "../../scripts/production/deployRecord";
import {
  loadRecord,
  saveRecord,
} from "../../scripts/production/deployRecordFile";
import * as h from "../helpers/deployRecordFlow";

describe("D-2 round 6: a stray is a transaction the record does not otherwise account for", function () {
  this.timeout(120000);
  const box = h.files();
  const load = () => loadRecord(box.file)!;
  let realST: any;
  beforeEach(() => {
    realST = global.setTimeout;
    (global as any).setTimeout = (f: any, ms: any, ...a: any[]) =>
      realST(f, Math.min(ms ?? 0, 2), ...a);
  });
  afterEach(async () => {
    (global as any).setTimeout = realST;
    await automine(true);
    await network.provider.request({ method: "evm_mine" }); // nothing held
  });
  const { node, created } = h;
  const accepted = () => h.accepted(box.file);
  const automine = (on: boolean) =>
    network.provider.request({ method: "evm_setAutomine", params: [on] });
  const deploy = async (name: string) =>
    (
      await (await ethers.getContractFactory(name)).deploy()
    ).waitForDeployment();

  /** Two entries mined and recorded (#0 confirmed, #1 sent). */
  async function two() {
    const start = await h.nonce();
    await h
      .run(box.file, await h.fresh(box.file), () => h.flow(2))
      .catch((e: Error) => expect(e.message).to.equal("killed"));
    expect(load().txs.length).to.equal(2);
    return start;
  }

  /**
   * A resume behind a backend that hides entry #`i` (its transaction, its
   * receipt, the deployer's counts at `count`) until the first send, which
   * the signer answers with `answer(request, a)`.
   */
  async function lagging(
    i: number,
    count: number,
    answer: (request: any, a: any) => Promise<any>,
  ) {
    const hide = load().txs[i].hash;
    const st = { lie: true, sends: 0 };
    const restore = node(async (a, request) => {
      if (a.method === "eth_sendTransaction") {
        st.sends++;
        st.lie = false;
        return answer(request, a);
      }
      if (!st.lie) return undefined;
      if (a.method === "eth_getTransactionCount")
        return ethers.toQuantity(count);
      const hides =
        a.method === "eth_getTransactionByHash" ||
        a.method === "eth_getTransactionReceipt";
      return hides && a.params[0] === hide ? null : undefined;
    });
    try {
      return { err: await accepted(), sends: st.sends };
    } finally {
      restore();
    }
  }
  /** A signer that drops the nonce field: its send takes the next nonce. */
  const dropNonce = (request: any, a: any) => {
    const { nonce, ...rest } = a.params[0];
    return request({ method: a.method, params: [rest] });
  };

  describe("C (G1): another entry's or an older transaction is no stray", function () {
    it("T1: a re-send answered with another entry's hash is refused by name, never listed; the next healthy resume completes", async function () {
      const start = await two();
      const own0 = load().txs[0].hash!;
      const r = await lagging(1, start + 1, async () => own0);
      expect(r.sends).to.equal(1);
      expect(r.err).to.contain(
        `record entry #1 (${load().txs[1].label}): the signer answered its re-send with ${own0}, record entry #0's transaction, not a new one`,
      );
      const rec: any = load();
      expect(rec.strays ?? [], "nothing listed").to.deep.equal([]);
      expect([rec.txs[1].status, rec.txs[1].hash]).to.deep.equal([
        "sending",
        undefined,
      ]);
      expect(await accepted()).to.equal("accepted");
      expect(load().txs.map((t) => t.status)).to.deep.equal([
        "confirmed",
        "confirmed",
      ]);
      expect(await created(start), "one contract per entry").to.have.length(1);
      expect(await h.nonce()).to.equal(start + 2);
    });

    it("T3: a re-send answered with a transaction from before the record's start is refused by name, never listed; the next healthy resume completes", async function () {
      const [d] = await ethers.getSigners();
      const old = (await (await d.sendTransaction({ to: h.AGENT })).wait())!;
      const start = await two();
      const r = await lagging(1, start + 1, async () => old.hash);
      expect(r.err).to.contain(
        `the signer answered its re-send with ${old.hash}, an older transaction (nonce ${start - 1}, before the record's startNonce ${start}), not a new one`,
      );
      expect((load() as any).strays ?? []).to.deep.equal([]);
      expect(await accepted()).to.equal("accepted");
      expect(await created(start)).to.have.length(1);
      expect(await h.nonce()).to.equal(start + 2);
    });

    it("a listed stray whose hash is an entry's is refused by name (an inconsistent list)", async function () {
      const start = await two();
      const rec: any = load();
      const [d] = await ethers.getSigners();
      const hash = rec.txs[0].hash;
      rec.strays = [
        { hash, from: d.address, nonce: start, entry: 1, label: "x" },
      ];
      saveRecord(box.file, rec);
      expect(await accepted()).to.equal(
        `stray ${hash} (nonce ${start}, the re-send of entry #1) is record entry #0's transaction: the record's strays list is inconsistent (a stray is a transaction the record does not otherwise account for); remove it from strays, then re-run`,
      );
    });

    it("a listed stray of the deployer below the record's start is refused by name (an inconsistent list)", async function () {
      const [d] = await ethers.getSigners();
      const old = (await (await d.sendTransaction({ to: h.AGENT })).wait())!;
      const start = await two();
      const rec: any = load();
      rec.strays = [
        {
          hash: old.hash,
          from: d.address,
          nonce: start - 1,
          entry: 1,
          label: "x",
        },
      ];
      saveRecord(box.file, rec);
      expect(await accepted()).to.equal(
        `stray ${old.hash} (nonce ${start - 1}, the re-send of entry #1) is below the record's startNonce ${start}: the record's strays list is inconsistent (a stray is a transaction the record does not otherwise account for); remove it from strays, then re-run`,
      );
    });
  });

  describe("D (G2): no entry is planned behind a pending stray", function () {
    it("T2: a resume with the stray pending is refused by name; once the node drops it, the next entry takes its nonce and the deploy completes", async function () {
      const start = await h.nonce();
      await h.sendOne(box.file);
      await automine(false); // the node holds the stray pending
      const first = await lagging(0, start, dropNonce);
      expect(first.err).to.contain("outside the record");
      const stray = (load() as any).strays[0].hash;
      expect(await accepted()).to.equal(
        `stray ${stray} (nonce ${start + 1}, the re-send of entry #0) is pending on this node: wait for it to mine or drop, then re-run`,
      );
      await network.provider.request({
        method: "hardhat_dropTransaction",
        params: [stray],
      });
      await automine(true);
      const lines: string[] = [];
      const r = new Recorder(box.file, load(), 1, (m) => lines.push(m));
      await r.install();
      try {
        await deploy("IdentityRegistry");
        await deploy("KeyManager");
        await r.finish();
      } finally {
        r.remove();
      }
      expect(lines.join("\n")).to.contain(
        `nonce ${start + 1}: ${stray}, the signer's re-send of entry #0 (new IdentityRegistry) at another nonce: dropped, not counted`,
      );
      expect(load().txs.map((t) => [t.nonce, t.status])).to.deep.equal([
        [start, "confirmed"],
        [start + 1, "confirmed"],
      ]);
      expect(await created(start)).to.have.length(2);
      expect(await accepted(), "a re-run").to.equal("accepted");
    });
  });

  describe("E (G3): an unsent intent at a mined stray's nonce is stale", function () {
    it("a sent entry at a mined stray's nonce is never dropped: refused by name as today (lead condition a)", async function () {
      const [d] = await ethers.getSigners();
      const start = await h.nonce();
      await h.sendOne(box.file);
      const block = await ethers.provider.getBlockNumber();
      expect((await lagging(0, start, dropNonce)).err).to.contain(
        "outside the record",
      );
      expect(await accepted(), "the healthy resume").to.equal("accepted");
      const rec = load();
      const stray = rec.strays![0].hash;
      const data = (
        await (
          await ethers.getContractFactory("KeyManager")
        ).getDeployTransaction()
      ).data;
      const hash = ethers.keccak256("0x5e47"); // a send no node knows
      rec.txs.push({
        from: d.address,
        to: null,
        value: "0",
        dataHash: ethers.keccak256(data),
        data,
        nonce: start + 1,
        block,
        hash,
        status: "sent",
        label: "new KeyManager",
      });
      saveRecord(box.file, rec);
      const want = `record entry #1 (new KeyManager): ${hash} is unknown to the node and ${d.address}'s nonce ${start + 1} went to ${stray}, another transaction: refusing`;
      expect(await accepted()).to.equal(want);
      expect(await accepted(), "every resume").to.equal(want);
      expect(load().txs.map((t) => [t.nonce, t.status])).to.deep.equal([
        [start, "confirmed"],
        [start + 1, "sent"],
      ]);
    });

    it("T4: a lagging count plants the next intent at the stray's nonce; the healthy resume drops it and the deploy completes, the stray listed once with its cost", async function () {
      const [d] = await ethers.getSigners();
      const start = await h.nonce();
      await h.sendOne(box.file);
      const first = await lagging(0, start, dropNonce);
      expect(first.err).to.contain("outside the record");
      expect(load().strays).to.have.length(1);
      // the flow continues live behind a backend whose counts lag at start + 1
      let on = false;
      const lag = node(async (a) =>
        on &&
        a.method === "eth_getTransactionCount" &&
        String(a.params[0]).toLowerCase() === d.address.toLowerCase()
          ? ethers.toQuantity(start + 1)
          : undefined,
      );
      const r = new Recorder(box.file, load(), 1, () => {});
      let sendErr = "";
      try {
        await r.install();
        on = true;
        await deploy("IdentityRegistry");
        await deploy("KeyManager");
      } catch (e: any) {
        sendErr = e.message;
      } finally {
        on = false;
        r.remove(); // before the shim it captured
        lag();
      }
      expect(sendErr).to.contain("Nonce too low");
      expect(load().txs.map((t) => [t.nonce, t.status])).to.deep.equal([
        [start, "confirmed"],
        [start + 1, "sending"],
      ]);
      const lines: string[] = [];
      const r2 = new Recorder(box.file, load(), 1, (m) => lines.push(m));
      await r2.install();
      try {
        await deploy("IdentityRegistry");
        await deploy("KeyManager");
        await r2.finish();
      } finally {
        r2.remove();
      }
      const stray = load().strays![0].hash;
      expect(lines.join("\n")).to.contain(
        `new KeyManager: its nonce ${start + 1} is stray ${stray}'s (an intent read from a lagging RPC, never sent); dropped from the record`,
      );
      expect(load().txs.map((t) => [t.nonce, t.status])).to.deep.equal([
        [start, "confirmed"],
        [start + 2, "confirmed"],
      ]);
      expect(load().strays).to.have.length(1);
      const costs = lines.filter((l) => l.includes(`${stray}, the signer's`));
      expect(costs).to.have.length(1);
      expect(costs[0]).to.match(/outside the record, never adopted; it cost/);
      const own = load().txs.map((t) => t.contract);
      const all = await created(start);
      expect(all, "two entry contracts and the stray's").to.have.length(3);
      expect(own.every((c) => all.includes(c!))).to.equal(true);
      expect(await accepted(), "a re-run").to.equal("accepted");
    });
  });
});
