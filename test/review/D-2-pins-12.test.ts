// Review D-2, round 12 (item D, lane G's GPIN11-1): the round-11 record
// rules lane G's g-mutate11.py mutated without a shipped test failing,
// one pin each (swarm-11/G/attack-u2r11-recpins.test.ts, kill-check
// out/g-kill-rec-11.txt): the entry the bound's text names (S01-S04: the
// earliest by block, its own index, the lowest index on a tie), a thrown
// null from the send (R04), the hash check's anchors (R09, R10).
import { expect } from "chai";
import { ethers, network } from "hardhat";
import { saveRecord } from "../../scripts/production/deployRecordFile";
import * as h from "../helpers/deployRecordFlow";
import { strays } from "../helpers/deployRecordStrays";

describe("D-2 round 12 pins: lane G's round-11 survivors", function () {
  this.timeout(600000);
  const s = strays();
  const mine = (n: number) =>
    network.provider.request({ method: "hardhat_mine", params: [ethers.toQuantity(n)] });

  /** Entry #0 mined and hidden; a resume whose re-send answers `reply`. */
  async function resumeWith(reply: (hash: string) => any) {
    const start = await h.nonce();
    await h.sendOne(s.box.file);
    const hide = s.load().txs[0].hash!;
    const restore = h.node(async (a, request) => {
      if (a.method === "eth_sendTransaction") {
        const { nonce, ...rest } = a.params[0];
        return reply(await request({ method: a.method, params: [rest] }));
      }
      if (a.method === "eth_getTransactionCount") return ethers.toQuantity(start);
      const hides = a.method === "eth_getTransactionByHash" || a.method === "eth_getTransactionReceipt";
      return hides && a.params[0] === hide ? null : undefined;
    });
    try {
      return { res: await h.accepted(s.box.file), hide };
    } finally {
      restore();
    }
  }

  it("P-R04 (kills R04): a thrown null from the send does not crash the catch; the intent stays", async function () {
    const { res } = await resumeWith(() => {
      throw null;
    });
    expect(res).to.contain("; the node answered: null");
    expect(s.load().txs[0].resendFrom).to.be.a("number");
  });

  it("P-R05 (kills G11-R05): a refusal with a positive code (3, execution reverted) drops the intent it set", async function () {
    const start = await h.nonce();
    await h.sendOne(s.box.file);
    const hide = s.load().txs[0].hash!;
    const restore = h.node(async (a) => {
      if (a.method === "eth_sendTransaction") throw Object.assign(new Error("execution reverted"), { code: 3 });
      if (a.method === "eth_getTransactionCount") return ethers.toQuantity(start);
      const hides = a.method === "eth_getTransactionByHash" || a.method === "eth_getTransactionReceipt";
      return hides && a.params[0] === hide ? null : undefined;
    });
    try {
      expect(await h.accepted(s.box.file)).to.contain("; the node answered: execution reverted");
    } finally {
      restore();
    }
    expect(s.load().txs[0], "a refusal leaves no intent").to.not.have.property("resendFrom");
  });

  for (const [id, mk] of [
    ["P-R09 (kills R09)", (x: string) => `${x}zz`],
    ["P-R10 (kills R10)", (x: string) => `zz${x}`],
  ] as [string, (x: string) => string][])
    it(`${id}: a reply that only contains a hash is no hash: the entry keeps its own`, async function () {
      const { res, hide } = await resumeWith(mk);
      expect(res).to.contain("; the node answered: no transaction hash (");
      expect(s.load().txs[0].hash, "the entry's own hash stays").to.equal(hide);
      expect(s.load().txs[0].resent, "no re-send recorded").to.equal(undefined);
    });

  /** Two entries mined; then `set` gives them intents; a foreign send past the window. */
  async function bound(set: (r: any) => Promise<void>) {
    const [d] = await ethers.getSigners();
    const start = await h.nonce();
    await h.run(s.box.file, await h.fresh(s.box.file), () => h.flow(2)).catch(() => {});
    expect(await h.accepted(s.box.file)).to.equal("accepted");
    const r = s.load();
    await set(r);
    saveRecord(s.box.file, r);
    await mine(5100);
    await (await d.sendTransaction({ to: d.address, nonce: start + 2 })).wait();
    return { r, res: await s.resume() };
  }
  const named = (k: number, r: any) => `past entry #${k} (${r.txs[k].label})'s intent (block ${r.txs[k].resendFrom}), the earliest`;

  it("P-S01, P-S04 (kill S01, S04): entry #1 re-sent on day 1, entry #0 on day 3: the earliest BY BLOCK is named", async function () {
    const { r, res } = await bound(async (r) => {
      r.txs[1].resendFrom = await ethers.provider.getBlockNumber();
      await mine(6000);
      r.txs[0].resendFrom = await ethers.provider.getBlockNumber();
    });
    expect(res).to.contain(named(1, r));
  });

  it("P-S03 (kills S03): two intents in one block: the lowest entry is named", async function () {
    const { r, res } = await bound(async (r) => {
      r.txs[0].resendFrom = r.txs[1].resendFrom = await ethers.provider.getBlockNumber();
    });
    expect(res).to.contain(named(0, r));
  });

  it("P-S02 (kills S02): only entry #1 has an intent: it is named by its record index", async function () {
    const { r, res } = await bound(async (r) => {
      r.txs[1].resendFrom = await ethers.provider.getBlockNumber();
    });
    expect(res).to.contain(named(1, r));
  });
  // Round 12's own record rules the round-12 lever found unpinned.
  it("P-G42n (kills G10-G42n, G11-S11n): exactly 5000 blocks past the intent with nothing at the nonce there, the window refusal is not given", async function () {
    const [d] = await ethers.getSigners();
    const start = await h.nonce();
    const rec = await h.fresh(s.box.file);
    await h.run(s.box.file, rec, () => h.flow(2)).catch(() => {});
    expect(await h.accepted(s.box.file)).to.equal("accepted");
    const r = s.load();
    const ir = await ethers.getContractAt("IdentityRegistry", r.txs[1].to!);
    const data = r.txs[1].data ?? ir.interface.encodeFunctionData("addAgent", [h.AGENT]);
    // entry #1's payload at the next free nonce, mined one block BEFORE the intent
    const at = (await (await d.sendTransaction({ to: r.txs[1].to!, data, nonce: start + 2 })).wait())!.blockNumber;
    r.txs[1].resendFrom = at + 1;
    saveRecord(s.box.file, r);
    await mine(5000);
    expect(await ethers.provider.getBlockNumber()).to.equal(at + 5000);
    await mine(1);
    const res = await s.resume();
    expect(res).to.not.contain("is more than 5000 blocks past");
    expect(res).to.contain(`(nonce ${start + 2} is no entry's and no stray's: find that transaction and record it by hand)`);
  });
  it("P-S08 (kills G11-S08): past the bound, the stray scan's refusal shows the stray's block, not the head", async function () {
    const [d] = await ethers.getSigners();
    const { start, stray } = await s.pendingStray();
    await s.drop(stray);
    await d.sendTransaction({ to: d.address, nonce: start + 1 });
    await s.automine(true);
    await network.provider.request({ method: "evm_mine" });
    await mine(5001);
    const row = s.load().strays![0];
    expect(await s.resume()).to.contain(
      `${d.address} used nonce ${start + 1} more than 5000 blocks after the intent (block ${row.block}); `,
    );
  });
});
