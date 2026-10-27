// Review D-2, round 9 (item F): pins for the round-8 record rules lane G's
// mutants of 688521d (g-mutate8.py) showed unpinned, ported from its
// attack-u2r8-pins.test.ts (titles kept: Pnn kills mutant Gnn), and G33:
// a second re-send must not overwrite the entry's own kept hash
// (sentHash), or a deploy older than 5000 blocks needs a scan past the
// bound again. Each passes at 688521d and fails under its mutant
// (tools/mutate-9.py).
import { expect } from "chai";
import { ethers, network } from "hardhat";
import { saveRecord } from "../../scripts/production/deployRecordFile";
import * as h from "../helpers/deployRecordFlow";
import { strays } from "../helpers/deployRecordStrays";

describe("D-2 round 9 pins: round-8 rules lane G found unpinned", function () {
  this.timeout(300000);
  const s = strays();
  afterEach(() => delete process.env.DEPLOY_FILL_HASH);
  const mine = (n: number) =>
    network.provider.request({
      method: "hardhat_mine",
      params: [ethers.toQuantity(n)],
    });
  const fake = (x: string) => ethers.keccak256(ethers.toUtf8Bytes(x));

  /** Two entries (a creation and a call), both mined and settled. */
  async function two() {
    const [d] = await ethers.getSigners();
    const start = await h.nonce();
    const rec = await h.fresh(s.box.file);
    await h.run(s.box.file, rec, () => h.flow(2)).catch(() => {});
    expect(await h.accepted(s.box.file)).to.equal("accepted");
    const r = s.load();
    expect(r.txs).to.have.length(2);
    return { d, start, r };
  }

  it("P03 (kills G03): a deployer transaction with entry #1's payload mined BEFORE entry #1's intent is not its re-send", async function () {
    const { d, start, r } = await two();
    const head0 = await ethers.provider.getBlockNumber();
    await (
      await d.sendTransaction({ to: r.txs[1].to!, data: await recData(r, 1), nonce: start + 2 })
    ).wait();
    await mine(3);
    r.txs[0].resendFrom = head0; // early intent: the scan starts here
    r.txs[1].resendFrom = (await ethers.provider.getBlockNumber()); // later than the duplicate
    saveRecord(s.box.file, r);
    const res = await s.resume();
    expect(res).to.contain(`nonce ${start + 2} is no entry's and no stray's`);
    expect(s.load().strays ?? []).to.deep.equal([]);
  });

  it("P06 (kills G06): the scan starts at the EARLIEST intent: a duplicate of entry #0 mined between the two intents is found", async function () {
    const { d, start, r } = await two();
    const head0 = await ethers.provider.getBlockNumber();
    await (
      await d.sendTransaction({ data: await recData(r, 0), nonce: start + 2 })
    ).wait();
    await mine(3);
    r.txs[0].resendFrom = head0;
    r.txs[1].resendFrom = await ethers.provider.getBlockNumber(); // later
    saveRecord(s.box.file, r);
    expect(await s.resume()).to.equal("accepted");
    expect(s.load().strays).to.have.length(1);
  });

  it("P21 (kills G21): the operator's fill is used for ITS stray only: a younger replaced stray is found by its own scan", async function () {
    const [d] = await ethers.getSigners();
    const start = await h.nonce();
    await h.sendOne(s.box.file);
    const rec = s.load();
    const row = { from: d.address, entry: 0, label: rec.txs[0].label };
    // stray A at start+1 replaced long ago; stray B at start+2 replaced now
    const a = (await (await d.sendTransaction({ to: d.address, nonce: start + 1 })).wait())!.hash;
    await mine(5001);
    const head = await ethers.provider.getBlockNumber();
    const b = (await (await d.sendTransaction({ to: d.address, nonce: start + 2 })).wait())!.hash;
    rec.strays = [
      { ...row, hash: fake("A"), nonce: start + 1 },
      { ...row, hash: fake("B"), nonce: start + 2, block: head },
    ];
    saveRecord(s.box.file, rec);
    process.env.DEPLOY_FILL_HASH = a;
    const res = await s.resume();
    expect(res).to.equal("accepted");
    expect(s.load().strays!.map((x) => x.replacedBy)).to.deep.equal([a, b]);
  });

  it("P28 (kills G28): the flag left set after the recovery is harmless: a re-run with it still set is accepted", async function () {
    const [d] = await ethers.getSigners();
    const { start, stray } = await s.pendingStray();
    await s.drop(stray);
    const fill = await d.sendTransaction({ to: d.address, nonce: start + 1 });
    await s.automine(true);
    await network.provider.request({ method: "evm_mine" });
    await mine(5001);
    process.env.DEPLOY_FILL_HASH = fill.hash;
    expect(await s.resume()).to.equal("accepted");
    expect(s.load().strays![0].replacedBy).to.equal(fill.hash);
    expect(await s.resume(), "flag still set").to.equal("accepted");
  });

  it("P13 (kills G13): another sender's pending entry is no explanation for the deployer's hidden pending transaction", async function () {
    const start0 = await h.nonce();
    const other = ethers.Wallet.createRandom().connect(ethers.provider);
    await network.provider.request({
      method: "hardhat_setBalance",
      params: [other.address, ethers.toQuantity(ethers.parseEther("1"))],
    });
    await network.provider.request({
      method: "hardhat_setNonce",
      params: [other.address, ethers.toQuantity(start0 + 1)],
    });
    const { start, stray } = await s.pendingStray(); // stray pending at start+1
    expect(start).to.equal(start0);
    const tx = await other.sendTransaction({ to: other.address }); // pending
    const rec = s.load();
    rec.txs.push({
      from: other.address,
      to: other.address,
      value: "0",
      dataHash: ethers.keccak256("0x"),
      data: "0x",
      nonce: start + 1,
      block: await ethers.provider.getBlockNumber(),
      hash: tx.hash,
      status: "sent",
      label: "a call",
    });
    saveRecord(s.box.file, rec);
    // the node hides the deployer's pending stray by hash and receipt
    const restore = h.node(async (a) =>
      (a.method === "eth_getTransactionByHash" ||
        a.method === "eth_getTransactionReceipt") &&
      a.params[0] === stray
        ? null
        : undefined,
    );
    let res = "";
    try {
      res = await s.resume();
    } finally {
      restore();
    }
    expect(res).to.contain("pending transactions it does not show");
  });

  async function recData(r: any, i: number): Promise<string> {
    // entries drop `data` once mined: rebuild it from the artifact / the call
    if (r.txs[i].data) return r.txs[i].data;
    if (i === 0)
      return (await (await ethers.getContractFactory("IdentityRegistry")).getDeployTransaction()).data as string;
    const ir = await ethers.getContractAt("IdentityRegistry", r.txs[1].to);
    return ir.interface.encodeFunctionData("addAgent", [h.AGENT]);
  }
});

describe("D-2 round 9 pins: item J's match (kills G04, G07, G08)", function () {
  this.timeout(300000);
  const s = strays();
  async function intentOnly(start: number, hide: string) {
    // an intent for entry #0 (resendFrom set) whose send the node refused
    const restore = h.node(async (a) => {
      if (a.method === "eth_sendTransaction") throw new Error("refused");
      if (a.method === "eth_getTransactionCount") return ethers.toQuantity(start);
      const hides =
        a.method === "eth_getTransactionByHash" ||
        a.method === "eth_getTransactionReceipt";
      return hides && a.params[0] === hide ? null : undefined;
    });
    try {
      await h.accepted(s.box.file);
    } finally {
      restore();
    }
  }
  it("P04: the same calldata to ANOTHER target is not the re-send (kills G04)", async function () {
    const [d] = await ethers.getSigners();
    const start = await h.nonce();
    await h.sendOne(s.box.file);
    await intentOnly(start, s.load().txs[0].hash!);
    await (
      await d.sendTransaction({ to: d.address, data: s.load().txs[0].data!, nonce: start + 1 })
    ).wait();
    const res = await s.resume();
    expect(res).to.contain(`nonce ${start + 1} is no entry's and no stray's`);
    expect(s.load().strays ?? []).to.deep.equal([]);
  });
  it("P07/P08: a partial recovery names only the unrecovered nonce, and the stray row carries the intent's block (kills G07, G08)", async function () {
    const [d] = await ethers.getSigners();
    const start = await h.nonce();
    await h.sendOne(s.box.file);
    await intentOnly(start, s.load().txs[0].hash!);
    const from = s.load().txs[0].resendFrom!;
    // nonce start+1: the entry's payload (a duplicate by hand); start+2: unrelated
    await (await d.sendTransaction({ data: s.load().txs[0].data!, nonce: start + 1 })).wait();
    await (await d.sendTransaction({ to: d.address, nonce: start + 2 })).wait();
    const res = await s.resume();
    expect(res).to.contain(`(nonce ${start + 2} is no entry's and no stray's: find that transaction and record it by hand)`);
    expect(res).to.not.contain(`nonces ${start + 1}`);
    expect(s.load().strays![0].block, "the intent's block").to.equal(from);
  });
});


describe("D-2 round 9 pins: a stale DEPLOY_FILL_HASH without strays (kills G29)", function () {
  this.timeout(300000);
  const s = strays();
  afterEach(() => delete process.env.DEPLOY_FILL_HASH);
  it("P29: refused by name", async function () {
    const [d] = await ethers.getSigners();
    await h.sendOne(s.box.file);
    const t = await (await d.sendTransaction({ to: d.address })).wait();
    process.env.DEPLOY_FILL_HASH = t!.hash;
    expect(await s.resume()).to.contain(
      `DEPLOY_FILL_HASH ${t!.hash} is ${d.address}'s transaction at nonce`,
    );
  });
});

describe("D-2 round 9 pins: the kept hash survives a second re-send (kills G33)", function () {
  this.timeout(300000);
  const s = strays();
  const fake = (x: string) => ethers.keccak256(ethers.toUtf8Bytes(x));

  /** A resume whose signer answers `hash` without sending; counts lag. */
  async function resentAs(start: number, hide: string[], hash: string) {
    const restore = h.node(async (a) => {
      if (a.method === "eth_sendTransaction") return hash;
      if (a.method === "eth_getTransactionCount")
        return ethers.toQuantity(start);
      const hides =
        a.method === "eth_getTransactionByHash" ||
        a.method === "eth_getTransactionReceipt";
      return hides && hide.includes(a.params[0]) ? null : undefined;
    });
    try {
      return await h.accepted(s.box.file);
    } finally {
      restore();
    }
  }

  it("P33: two re-sends whose hashes never mine, then 5000 blocks: the entry is adopted by its own first hash, no scan", async function () {
    const start = await h.nonce();
    await h.sendOne(s.box.file);
    const own = s.load().txs[0].hash!;
    const [h1, h2] = [fake("re-send 1"), fake("re-send 2")];
    expect(await resentAs(start, [own], h1)).to.contain("is unused after");
    expect(s.load().txs[0].sentHash).to.equal(own);
    expect(await resentAs(start, [own], h2)).to.contain("is unused after");
    expect(s.load().txs[0].hash).to.equal(h2);
    expect(s.load().txs[0].sentHash, "the first send's hash").to.equal(own);
    await network.provider.request({
      method: "hardhat_mine",
      params: [ethers.toQuantity(5001)],
    });
    expect(await s.resume(), "adopted by its kept hash").to.equal(
      "accepted",
    );
    expect(s.load().txs[0].hash).to.equal(own);
  });
});
