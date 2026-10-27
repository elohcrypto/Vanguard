// Review D-2, round 9 (item F): pins for the round-8 record rules lane G's
// mutants of 688521d (g-mutate8.py) showed unpinned, ported from its
// attack-u2r8-pins.test.ts (titles kept: Pnn kills mutant Gnn), and G33:
// a second re-send must not overwrite the entry's own kept hash
// (sentHash), or a deploy older than 5000 blocks needs a scan past the
// bound again. Each passes at 688521d and fails under its mutant
// (tools/mutate-9.py).
import { expect } from "chai";
import { ethers, network } from "hardhat";
import { Recorder } from "../../scripts/production/deployRecord";
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
      await d.sendTransaction({
        to: r.txs[1].to!,
        data: await recData(r, 1),
        nonce: start + 2,
      })
    ).wait();
    await mine(3);
    r.txs[0].resendFrom = head0; // early intent: the scan starts here
    r.txs[1].resendFrom = await ethers.provider.getBlockNumber(); // later than the duplicate
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
    const a = (await (
      await d.sendTransaction({ to: d.address, nonce: start + 1 })
    ).wait())!.hash;
    await mine(5001);
    const head = await ethers.provider.getBlockNumber();
    const b = (await (
      await d.sendTransaction({ to: d.address, nonce: start + 2 })
    ).wait())!.hash;
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
      return (
        await (
          await ethers.getContractFactory("IdentityRegistry")
        ).getDeployTransaction()
      ).data as string;
    const ir = await ethers.getContractAt("IdentityRegistry", r.txs[1].to);
    return ir.interface.encodeFunctionData("addAgent", [h.AGENT]);
  }
});

describe("D-2 round 9 pins: item J's match (kills G04, G07, G08)", function () {
  this.timeout(300000);
  const s = strays();
  async function intentOnly(start: number, hide: string) {
    // an intent for entry #0 (resendFrom set) whose send never reached the
    // node and whose reply never came (round 10, item D: a send the node
    // refuses leaves no intent of its own)
    let sent = false;
    const restore = h.node(async (a) => {
      if (a.method === "eth_sendTransaction") {
        sent = true;
        return new Promise(() => {});
      }
      if (a.method === "eth_getTransactionCount")
        return ethers.toQuantity(start);
      const hides =
        a.method === "eth_getTransactionByHash" ||
        a.method === "eth_getTransactionReceipt";
      return hides && a.params[0] === hide ? null : undefined;
    });
    const r = new Recorder(s.box.file, s.load(), 1, () => {});
    void r.install().catch(() => {});
    try {
      for (let i = 0; !sent && i < 500; i++) await s.wait(10);
    } finally {
      r.remove();
      restore();
    }
  }
  it("P04: the same calldata to ANOTHER target is not the re-send (kills G04)", async function () {
    const [d] = await ethers.getSigners();
    const start = await h.nonce();
    await h.sendOne(s.box.file);
    await intentOnly(start, s.load().txs[0].hash!);
    await (
      await d.sendTransaction({
        to: d.address,
        data: s.load().txs[0].data!,
        nonce: start + 1,
      })
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
    await (
      await d.sendTransaction({ data: s.load().txs[0].data!, nonce: start + 1 })
    ).wait();
    await (await d.sendTransaction({ to: d.address, nonce: start + 2 })).wait();
    const res = await s.resume();
    expect(res).to.contain(
      `(nonce ${start + 2} is no entry's and no stray's: find that transaction and record it by hand)`,
    );
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
    expect(await s.resume(), "adopted by its kept hash").to.equal("accepted");
    expect(s.load().txs[0].hash).to.equal(own);
  });
});

describe("D-2 round 9 pins: a listed stray's replacement is never found again (kills W02)", function () {
  this.timeout(300000);
  const s = strays();

  it("P-W02: the stray's fee bump (its payload, its nonce) mined as its replacement, its receipt lagging: one row; the healthy resume completes", async function () {
    const [d] = await ethers.getSigners();
    const { start, stray } = await s.pendingStray();
    const data = s.load().txs[0].data!;
    await s.drop(stray);
    // the entry's recorded gas less one (another hash than the dropped
    // stray's, which had none; it fits under coverage too, as GG1's)
    const bump = await d.sendTransaction({
      data,
      nonce: start + 1,
      gasLimit: BigInt(s.load().txs[0].gas!) - 1n,
    });
    expect(bump.hash).to.not.equal(stray);
    await s.automine(true);
    await network.provider.request({ method: "evm_mine" });
    const restore = h.node(async (a) =>
      a.method === "eth_getTransactionReceipt" && a.params[0] === bump.hash
        ? null
        : undefined,
    );
    try {
      // round 10 (item B): the listed stray's nonce reads as lagging
      const res = await s.resume();
      expect(res, "the lagging resume").to.contain(
        `stray ${stray} is listed but not shown mined on this node: a lagging RPC`,
      );
      expect(res).to.not.contain("by hand");
    } finally {
      restore();
    }
    expect(s.load().strays, "one row").to.have.length(1);
    expect(s.load().strays![0].replacedBy).to.equal(bump.hash);
    expect(await s.resume(), "the node caught up").to.equal("accepted");
    expect(s.load().strays, "still one row").to.have.length(1);
  });
});

describe("D-2 round 9 pins: the fill for an unrecorded re-send (kills W11, W17), the hidden count (G15), the deployer's intents (G05, V27)", function () {
  this.timeout(300000);
  const s = strays();
  afterEach(() => delete process.env.DEPLOY_FILL_HASH);
  const mine = (n: number) =>
    network.provider.request({
      method: "hardhat_mine",
      params: [ethers.toQuantity(n)],
    });

  /** A run killed while its re-send's reply is awaited (D-2-unrecorded-8). */
  async function killedResend(start: number, forward: boolean, hide: string) {
    let sent: string | null = null;
    const restore = h.node(async (a, request) => {
      if (a.method === "eth_sendTransaction") {
        const { nonce, ...rest } = a.params[0];
        sent = forward
          ? await request({ method: a.method, params: [rest] })
          : "0x";
        return new Promise(() => {});
      }
      if (a.method === "eth_getTransactionCount")
        return ethers.toQuantity(start);
      const hides =
        a.method === "eth_getTransactionByHash" ||
        a.method === "eth_getTransactionReceipt";
      return hides && a.params[0] === hide ? null : undefined;
    });
    const r = new Recorder(s.box.file, s.load(), 1, () => {});
    void r.install().catch(() => {});
    try {
      for (let i = 0; !sent && i < 500; i++) await s.wait(10);
      expect(sent, "the re-send went out").to.not.equal(null);
    } finally {
      r.remove();
      restore();
    }
    return sent!;
  }

  it("P-W11: a re-send's payload at another entry's nonce is no fill: refused by fill() by name", async function () {
    const [d] = await ethers.getSigners();
    const start = await h.nonce();
    await h.sendOne(s.box.file);
    const hide = s.load().txs[0].hash!;
    await killedResend(start, false, hide); // entry #0's intent, nothing sent
    const rec = s.load();
    rec.txs.push({
      from: d.address,
      to: d.address,
      value: "0",
      dataHash: ethers.keccak256("0x"),
      data: "0x",
      nonce: start + 1,
      block: await ethers.provider.getBlockNumber(),
      status: "sending",
      label: "a call",
    });
    saveRecord(s.box.file, rec);
    const t = await d.sendTransaction({
      data: rec.txs[0].data!,
      nonce: start + 1,
    });
    await t.wait();
    process.env.DEPLOY_FILL_HASH = t.hash;
    expect(await s.resume()).to.equal(
      `DEPLOY_FILL_HASH ${t.hash} is ${d.address}'s transaction at nonce ${start + 1}, not at a recorded stray's sender and nonce, nor an entry's re-send at a free nonce of the deployer: refusing; unset DEPLOY_FILL_HASH after the resume completes`,
    );
  });

  it("P-W17: two unrecorded re-sends past the bound are named one by one, each at its own nonce", async function () {
    const start = await h.nonce();
    await h.sendOne(s.box.file);
    const hide = s.load().txs[0].hash!;
    await killedResend(start, false, hide); // the intent only, then its re-sends past its 5000 blocks:
    await mine(5001);
    const first = (await (await (await ethers.getSigners())[0].sendTransaction({ data: s.load().txs[0].data, nonce: start + 1 })).wait())!.hash;
    const second = (await (await (await ethers.getSigners())[0].sendTransaction({ data: s.load().txs[0].data, nonce: start + 2 })).wait())!.hash;
    process.env.DEPLOY_FILL_HASH = second;
    expect(await s.resume(), "the lower nonce first").to.contain(
      `nonce ${start + 1}: the chain head (block ${await ethers.provider.getBlockNumber()}) is more than 5000 blocks past entry #0 (${s.load().txs[0].label})'s intent (block ${s.load().txs[0].resendFrom}), the earliest the record keeps, and those 5000 blocks hold no transaction of ${s.load().deployer} at nonce ${start + 1}`,
    );
    expect(s.load().strays ?? [], "nothing recorded").to.deep.equal([]);
    process.env.DEPLOY_FILL_HASH = first;
    expect(await s.resume()).to.contain(`nonce ${start + 2}: `);
    expect(s.load().strays!.map((x) => [x.nonce, x.hash])).to.deep.equal([
      [start + 1, first],
    ]);
    process.env.DEPLOY_FILL_HASH = second;
    expect(await s.resume()).to.equal("accepted");
    expect(s.load().strays!.map((x) => [x.nonce, x.hash])).to.deep.equal([
      [start + 1, first],
      [start + 2, second],
    ]);
  });

  it("P-G15: an own sent entry the node does not show is no explanation: both hidden transactions are counted", async function () {
    const [d] = await ethers.getSigners();
    const { start, stray } = await s.pendingStray();
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
      hash: own.hash,
      status: "sent",
      label: "a call",
    });
    saveRecord(s.box.file, rec);
    const restore = h.node(async (a) =>
      (a.method === "eth_getTransactionByHash" ||
        a.method === "eth_getTransactionReceipt") &&
      (a.params[0] === stray || a.params[0] === own.hash)
        ? null
        : undefined,
    );
    let res = "";
    try {
      res = await s.resume();
    } finally {
      restore();
    }
    expect(res).to.contain(
      "the deployer has 2 pending transactions it does not show",
    );
  });

  it("P-G05: a role key's older re-send intent does not move the deployer's scan: the deployer's unrecorded re-send is found inside the bound", async function () {
    const [, role] = await ethers.getSigners();
    const t0 = await role.sendTransaction({ to: role.address });
    const r0 = (await t0.wait())!;
    await mine(5001);
    const start = await h.nonce();
    await h.sendOne(s.box.file);
    const first = await killedResend(start, true, s.load().txs[0].hash!);
    const rec = s.load();
    rec.txs.push({
      from: role.address,
      to: role.address,
      value: "0",
      dataHash: ethers.keccak256("0x"),
      nonce: t0.nonce,
      block: r0.blockNumber,
      hash: t0.hash,
      resendFrom: r0.blockNumber,
      status: "confirmed",
      gasUsed: r0.gasUsed.toString(),
      label: "a role key's call",
    });
    saveRecord(s.box.file, rec);
    expect(await s.resume()).to.equal("accepted");
    expect(s.load().strays!.map((x) => x.hash)).to.deep.equal([first]);
  });
});
