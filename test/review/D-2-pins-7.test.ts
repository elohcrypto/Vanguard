// Review D-2, round 7 (the round-6 attacker G's survivors G08, G09, G12,
// G13, pinned): the pending refusal applies to ANY recorded stray, the
// deployer's or another sender's (fail-closed, as the code behaves); and
// an unsent intent at a stray's nonce is dropped only when the read made
// for it shows the stray mined, from its sender, at that nonce. A node
// that answers that read otherwise (a load-balanced RPC) keeps the intent
// and the resume refuses by name.
import { expect } from "chai";
import { ethers, network } from "hardhat";
import {
  loadRecord,
  saveRecord,
} from "../../scripts/production/deployRecordFile";
import * as h from "../helpers/deployRecordFlow";

describe("D-2 round 7: the pending refusal and the stale-intent read, pinned", function () {
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

  it("G08: another sender's recorded stray still pending refuses the resume by name (any recorded stray, not only the deployer's)", async function () {
    const [, other] = await ethers.getSigners();
    await h.sendOne(box.file);
    expect(await h.accepted(box.file)).to.equal("accepted");
    await automine(false);
    const t = await other.sendTransaction({ to: h.AGENT });
    const rec = load();
    rec.strays = [
      {
        hash: t.hash,
        from: other.address,
        nonce: t.nonce,
        entry: 0,
        label: "x",
      },
    ];
    saveRecord(box.file, rec);
    expect(await h.accepted(box.file)).to.equal(
      `stray ${t.hash} (nonce ${t.nonce}, the re-send of entry #0) is pending on this node: wait for it to mine or drop, then re-run`,
    );
  });

  /**
   * Entry #0 mined at `start`, the deployer's stray mined at start + 1,
   * and an unsent intent planted at start + 1 (a lagging count, G3).
   */
  async function heldIntent() {
    const [d] = await ethers.getSigners();
    const start = await h.nonce();
    await h.sendOne(box.file);
    expect(await h.accepted(box.file)).to.equal("accepted");
    const s = (await (await d.sendTransaction({ to: h.AGENT })).wait())!;
    const rec = load();
    rec.strays = [
      { hash: s.hash, from: d.address, nonce: start + 1, entry: 0, label: "x" },
    ];
    const { data } = await (
      await ethers.getContractFactory("KeyManager")
    ).getDeployTransaction();
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
    return { d, start, stray: s.hash };
  }

  /** The resume with the stray's second read (the stale-intent one) edited. */
  async function secondRead(stray: string, edit: (t: any) => any) {
    let reads = 0;
    const restore = h.node(async (a, request) => {
      if (a.method !== "eth_getTransactionByHash" || a.params[0] !== stray)
        return undefined;
      const t = await request(a);
      return ++reads === 2 ? edit(t) : t;
    });
    try {
      return { err: await h.accepted(box.file), reads };
    } finally {
      restore();
    }
  }

  it("control: the intent at the mined stray's nonce is dropped and the resume completes", async function () {
    const { start } = await heldIntent();
    expect(await h.accepted(box.file)).to.equal("accepted");
    expect(load().txs.map((t) => t.nonce)).to.deep.equal([start]);
  });

  for (const [id, what, edit] of [
    ["G09", "pending", (t: any) => ({ ...t, blockNumber: null })],
    [
      "G12",
      "from another sender",
      (t: any) => ({
        ...t,
        from: "0x000000000000000000000000000000000000bEEF",
      }),
    ],
    ["G13", "at another nonce", (t: any) => ({ ...t, nonce: "0x0" })],
  ] as const) {
    it(`${id}: a node showing the stray ${what} on the stale-intent read keeps the intent: refused by name, nothing dropped`, async function () {
      const { d, start } = await heldIntent();
      const { stray } = { stray: load().strays![0].hash };
      const { err, reads } = await secondRead(stray, edit);
      expect(reads, "the stale-intent read").to.be.greaterThanOrEqual(2);
      expect(err).to.equal(
        `${d.address} used nonce ${start + 1} for a transaction that is not record entry #1 (new KeyManager): refusing`,
      );
      expect(load().txs.map((t) => [t.nonce, t.status])).to.deep.equal([
        [start, "confirmed"],
        [start + 1, "sending"],
      ]);
    });
  }
});
