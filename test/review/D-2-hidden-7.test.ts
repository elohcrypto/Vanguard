// Review D-2, round 7 (lane C cp, inverted): a stray the node does not
// SHOW is not thereby dropped. While its sender's pending count exceeds
// its mined count, something pending is hidden: the resume is refused by
// name, nothing planned, nothing sent. Lane C's end state (the stray and
// the entry sent behind it both dropped, the entry's nonce above a gap)
// recovers by the operator's fill at the stray's nonce, counted as its
// replacement; the entry is sent again at its nonce and the deploy
// completes with one contract per entry.
import { expect } from "chai";
import { ethers, network } from "hardhat";
import { Recorder } from "../../scripts/production/deployRecord";
import {
  loadRecord,
  saveRecord,
} from "../../scripts/production/deployRecordFile";
import * as h from "../helpers/deployRecordFlow";

describe("D-2 round 7: a stray the node hides is not dropped while its sender has hidden pending transactions", function () {
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
    await network.provider.request({ method: "evm_mine" });
  });
  const automine = (on: boolean) =>
    network.provider.request({ method: "evm_setAutomine", params: [on] });
  const count = async (a: string, tag: string) =>
    Number(
      await network.provider.request({
        method: "eth_getTransactionCount",
        params: [a, tag],
      }),
    );
  const drop = (hash: string) =>
    network.provider.request({
      method: "hardhat_dropTransaction",
      params: [hash],
    });

  /** Entry #0 mined at `start`, the stray at start + 1 pending (as GB). */
  async function pendingStray() {
    const start = await h.nonce();
    await h.sendOne(box.file);
    await automine(false);
    const hide = load().txs[0].hash;
    const restore = h.node(async (a, request) => {
      if (a.method === "eth_sendTransaction") {
        const { nonce, ...rest } = a.params[0];
        return request({ method: a.method, params: [rest] });
      }
      if (a.method === "eth_getTransactionCount")
        return ethers.toQuantity(start);
      const hides =
        a.method === "eth_getTransactionByHash" ||
        a.method === "eth_getTransactionReceipt";
      return hides && a.params[0] === hide ? null : undefined;
    });
    try {
      expect(await h.accepted(box.file)).to.contain("outside the record");
    } finally {
      restore();
    }
    return { start, stray: load().strays![0].hash };
  }

  it("cp: a backend hiding the pending stray by hash and receipt but counting it is refused by name; nothing planned or sent", async function () {
    const [d] = await ethers.getSigners();
    const { start, stray } = await pendingStray();
    const restore = h.node(async (a) =>
      (a.method === "eth_getTransactionByHash" ||
        a.method === "eth_getTransactionReceipt") &&
      a.params[0] === stray
        ? null
        : undefined,
    );
    const before = JSON.stringify(load());
    let err = "";
    let planned = "";
    const r = new Recorder(box.file, load(), 1, () => {});
    try {
      await r.install();
      await (
        await ethers.getContractFactory("IdentityRegistry")
      )
        .deploy()
        .catch((e: Error) => (planned = e.message));
    } catch (e: any) {
      err = e.message;
    } finally {
      r.remove();
      restore();
    }
    expect(planned, "no flow ran").to.equal("");
    expect(err).to.equal(
      `stray ${stray} (nonce ${start + 1}, the re-send of entry #0) is not shown by this node but the deployer has 1 pending transactions it does not show: a lagging or inconsistent RPC; wait or re-run against a synced RPC`,
    );
    expect(JSON.stringify(load()), "nothing planned").to.equal(before);
    expect(await count(d.address, "pending"), "nothing sent").to.equal(
      start + 2,
    );
    await automine(true);
    await network.provider.request({ method: "evm_mine" });
    expect(await h.accepted(box.file), "once it mined").to.equal("accepted");
  });

  it("cp end state: the stray and the entry sent behind it both dropped; refused by name until the operator fills the stray's nonce, then the entry is sent again at its nonce and the deploy completes", async function () {
    const [d] = await ethers.getSigners();
    const { start, stray } = await pendingStray();
    // Lane C: entry #1 went out at start + 2 behind the stray (the round-6
    // code planned it there), then the node dropped both.
    const { data } = await (
      await ethers.getContractFactory("KeyManager")
    ).getDeployTransaction();
    const sent = (await network.provider.request({
      method: "eth_sendTransaction",
      params: [{ from: d.address, data, nonce: ethers.toQuantity(start + 2) }],
    })) as string;
    const rec = load();
    rec.txs.push({
      from: d.address,
      to: null,
      value: "0",
      dataHash: ethers.keccak256(data!),
      data,
      nonce: start + 2,
      block: await ethers.provider.getBlockNumber(),
      hash: sent,
      status: "sent",
      label: "new KeyManager",
    });
    saveRecord(box.file, rec);
    await drop(stray);
    await drop(sent);
    await automine(true);
    await network.provider.request({ method: "evm_mine" });
    expect(await count(d.address, "pending")).to.equal(start + 1);
    expect(await h.accepted(box.file)).to.equal(
      `stray ${stray} (nonce ${start + 1}, the re-send of entry #0) is dropped and its nonce is unfilled below record entry #1's nonce ${start + 2}: fill nonce ${start + 1} from the deployer (a cancel to self), then resume; if this node lags, re-run against a synced RPC`,
    );
    expect(await count(d.address, "pending"), "nothing sent").to.equal(
      start + 1,
    );
    const fill = await (
      await d.sendTransaction({ to: d.address, nonce: start + 1 })
    ).wait();
    const lines: string[] = [];
    const r = new Recorder(box.file, load(), 1, (m) => lines.push(m));
    await r.install();
    r.remove();
    expect(lines.join("\n")).to.contain(
      `nonce ${start + 1}: stray ${stray} replaced by ${fill!.hash}, outside the record, never adopted`,
    );
    expect(lines.join("\n")).to.contain(
      `#1 new KeyManager: sent again at its nonce ${start + 2}`,
    );
    expect(load().txs.map((t) => [t.nonce, t.status])).to.deep.equal([
      [start, "confirmed"],
      [start + 2, "confirmed"],
    ]);
    expect(await h.created(start), "one contract per entry").to.have.length(2);
    expect(await h.accepted(box.file), "a re-run").to.equal("accepted");
    expect(await h.nonce()).to.equal(start + 3);
  });
});
