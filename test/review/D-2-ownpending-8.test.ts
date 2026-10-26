// Review D-2, round 8 (the round-7 attacker G's GG4 and lane F's
// attack-F-r7-pendingown, inverted): a dropped stray with the deployer's
// OWN sent entry pending at its nonce, shown by hash. Round 7's equality
// rule (item G) counted that pending entry as one the node does not show
// and refused. The record's own sent entries the node shows pending are
// no hidden transactions: only the rest refuse, and a pending own entry
// is awaited as any sent entry is. A truly hidden stray still refuses.
import { expect } from "chai";
import { ethers, network } from "hardhat";
import { Recorder } from "../../scripts/production/deployRecord";
import { saveRecord } from "../../scripts/production/deployRecordFile";
import * as h from "../helpers/deployRecordFlow";
import { strays } from "../helpers/deployRecordStrays";

describe("D-2 round 8: the record's own pending entries are not hidden transactions", function () {
  this.timeout(180000);
  const s = strays();
  const mine = () => network.provider.request({ method: "evm_mine" });

  /** A resume started now: "waiting" while it waits, else its answer. */
  async function whilePending(lines: string[]) {
    const p = s.resume(lines);
    const early = await Promise.race([p, s.wait(800).then(() => "waiting")]);
    return { p, early };
  }

  it("GG4: the run died with its next entry sent and pending at the dropped stray's nonce: no refusal; the resume completes once it mines; the account balances", async function () {
    const { start, stray } = await s.pendingStray();
    await s.drop(stray);
    const r = new Recorder(s.box.file, s.load(), 1, () => {});
    await r.install();
    try {
      await (await ethers.getContractFactory("IdentityRegistry")).deploy();
      // The replay answered entry #0; entry #1 goes out and stays pending.
      await Promise.race([
        (await ethers.getContractFactory("KeyManager")).deploy(),
        s.wait(3000),
      ]);
    } finally {
      r.remove();
    }
    expect(s.load().txs.map((t) => [t.nonce, t.status])).to.deep.equal([
      [start, "confirmed"],
      [start + 1, "sent"],
    ]);
    const lines: string[] = [];
    const { p, early } = await whilePending(lines);
    expect(early, "awaits its own entry, no refusal").to.equal("waiting");
    await mine();
    expect(await p).to.equal("accepted");
    expect(lines.join("\n")).to.contain(
      `${stray}, the signer's re-send of entry #0 (new IdentityRegistry) at another nonce: dropped, not counted`,
    );
    expect(s.load().txs.map((t) => t.status)).to.deep.equal([
      "confirmed",
      "confirmed",
    ]);
    expect(await h.nonce(), "startNonce + 2 entries").to.equal(start + 2);
    expect(await h.created(start)).to.have.length(2);
    expect(await s.resume(), "a re-run").to.equal("accepted");
  });

  it("lane F: an own sent entry pending at a dropped stray's nonce (record built by hand): no refusal; it completes once mined", async function () {
    const [d] = await ethers.getSigners();
    const start = await h.nonce();
    await h.sendOne(s.box.file);
    await s.automine(false);
    const stray = await d.sendTransaction({ to: h.AGENT, value: 1 });
    await s.drop(stray.hash);
    const rec = s.load();
    rec.strays = [
      {
        hash: stray.hash,
        from: d.address,
        nonce: start + 1,
        entry: 0,
        label: rec.txs[0].label,
      },
    ];
    const data = await s.keyManager();
    const own = await d.sendTransaction({ data, nonce: start + 1 });
    rec.txs.push({
      from: d.address,
      to: null,
      value: "0",
      dataHash: ethers.keccak256(data),
      data,
      nonce: start + 1,
      block: await ethers.provider.getBlockNumber(),
      status: "sent",
      hash: own.hash,
      label: "new KeyManager",
    });
    saveRecord(s.box.file, rec);
    const { p, early } = await whilePending([]);
    expect(early, "no refusal while its own entry is pending").to.equal(
      "waiting",
    );
    await mine();
    expect(await p).to.equal("accepted");
    expect(await h.created(start)).to.have.length(2);
    expect(await h.nonce()).to.equal(start + 2);
  });

  it("a hidden stray still refuses beside an own pending entry: only the transactions the node does not show are counted", async function () {
    const [d] = await ethers.getSigners();
    // The stray with a gas limit, so the call fits the pending block too.
    const { start, stray } = await s.pendingStray("0x4c4b40");
    const own = await d.sendTransaction({
      to: d.address,
      nonce: start + 2,
      gasLimit: 21000,
    });
    const rec = s.load();
    rec.txs.push({
      from: d.address,
      to: d.address,
      value: "0",
      dataHash: ethers.keccak256("0x"),
      data: "0x",
      nonce: start + 2,
      block: await ethers.provider.getBlockNumber(),
      status: "sent",
      hash: own.hash,
      label: "a call",
    });
    saveRecord(s.box.file, rec);
    const restore = h.node(async (a) =>
      (a.method === "eth_getTransactionByHash" ||
        a.method === "eth_getTransactionReceipt") &&
      a.params[0] === stray
        ? null
        : undefined,
    );
    let err = "";
    try {
      err = await s.resume();
    } finally {
      restore();
    }
    expect(err).to.equal(
      `stray ${stray} (nonce ${start + 1}, the re-send of entry #0) is not shown by this node but the deployer has 1 pending transactions it does not show: a lagging or inconsistent RPC; wait or re-run against a synced RPC`,
    );
    await s.automine(true);
    await mine();
    expect(await s.resume(), "once both mined").to.equal("accepted");
  });

  it("an own entry outside the node's pending count (above the pending block) is not subtracted: the hidden stray still refuses", async function () {
    const [d] = await ethers.getSigners();
    // The stray takes the block's gas limit: the next entry waits a block.
    const { start, stray } = await s.pendingStray();
    const data = await s.keyManager();
    const own = await d.sendTransaction({ data, nonce: start + 2 });
    const rec = s.load();
    rec.txs.push({
      from: d.address,
      to: null,
      value: "0",
      dataHash: ethers.keccak256(data),
      data,
      nonce: start + 2,
      block: await ethers.provider.getBlockNumber(),
      status: "sent",
      hash: own.hash,
      label: "new KeyManager",
    });
    saveRecord(s.box.file, rec);
    const restore = h.node(async (a) =>
      (a.method === "eth_getTransactionByHash" ||
        a.method === "eth_getTransactionReceipt") &&
      a.params[0] === stray
        ? null
        : undefined,
    );
    let err = "";
    try {
      err = await s.resume();
    } finally {
      restore();
    }
    expect(err).to.equal(
      `stray ${stray} (nonce ${start + 1}, the re-send of entry #0) is not shown by this node but the deployer has 1 pending transactions it does not show: a lagging or inconsistent RPC; wait or re-run against a synced RPC`,
    );
    await s.automine(true);
    await mine();
    await mine();
    expect(await s.resume(), "once both mined").to.equal("accepted");
  });
});
