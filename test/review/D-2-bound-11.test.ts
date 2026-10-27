// Review D-2, round 11 (item C, lane G GA10-1, LOW; R11-C2 option 1):
// the scan for an unrecorded re-send runs from the EARLIEST intent the
// record keeps (round 9), and round 10 keeps an intent for the life of
// the record. Entry #0 re-sent on day 1 and entry #1's re-send killed on
// day 3: findMined refuses the day-3 free nonce as "more than 5000
// blocks after the intent (block <day 1>)" and the operator needs
// DEPLOY_FILL_HASH (GA-old-fill: the escape works). The owner's call is
// option 1, text and runbook only: the refusal names the entry and the
// block that set the bound, and says the fill is for an entry's re-send
// (GA-foreign-old: a foreign hand-sent transaction there is recorded by
// hand; the fill refuses it, correctly).
import { expect } from "chai";
import { ethers, network } from "hardhat";
import { saveRecord } from "../../scripts/production/deployRecordFile";
import * as h from "../helpers/deployRecordFlow";
import { strays } from "../helpers/deployRecordStrays";

const UNSET = "; unset DEPLOY_FILL_HASH after the resume completes";

describe("D-2 round 11: the bound names the intent that set it", function () {
  this.timeout(600000);
  const s = strays();
  afterEach(() => delete process.env.DEPLOY_FILL_HASH);
  const mine = (n: number) =>
    network.provider.request({
      method: "hardhat_mine",
      params: [ethers.toQuantity(n)],
    });

  /** Two entries mined; entry #0 given a day-1 intent, kept for life. */
  async function two() {
    const [d] = await ethers.getSigners();
    const start = await h.nonce();
    const rec = await h.fresh(s.box.file);
    await h.run(s.box.file, rec, () => h.flow(2)).catch(() => {});
    expect(await h.accepted(s.box.file)).to.equal("accepted");
    const r = s.load();
    expect(r.txs).to.have.length(2);
    const day1 = await ethers.provider.getBlockNumber();
    r.txs[0].resendFrom = day1;
    saveRecord(s.box.file, r);
    return { d, start, r, day1 };
  }

  /** The text past the bound, naming entry #0's day-1 intent. */
  const bound = (n: number, d: string, day1: number, label: string) =>
    `nonce ${n}: ${d} used nonce ${n} more than 5000 blocks after the intent (block ${day1}); the bound is entry #0 (${label})'s intent, the earliest the record keeps; if it is an entry's re-send, pass its hash as DEPLOY_FILL_HASH=<hash>, then resume; otherwise record it by hand${UNSET}`;

  /** Day 3: entry #1's re-send killed after it left; it mines. */
  async function day3(d: any, start: number, r: any) {
    await mine(6000);
    r.txs[1].resendFrom = await ethers.provider.getBlockNumber();
    saveRecord(s.box.file, r);
    const ir = await ethers.getContractAt("IdentityRegistry", r.txs[1].to);
    const data =
      r.txs[1].data ?? ir.interface.encodeFunctionData("addAgent", [h.AGENT]);
    const tx = await d.sendTransaction({ to: r.txs[1].to, data, nonce: start + 2 });
    await tx.wait();
    return tx.hash;
  }

  it("GA-old: entry #1's day-3 re-send past entry #0's day-1 intent: the refusal names entry #0 and its block", async function () {
    const { d, start, r, day1 } = await two();
    await day3(d, start, r);
    expect(await s.resume()).to.equal(
      bound(start + 2, d.address, day1, r.txs[0].label),
    );
    expect(s.load().strays ?? [], "nothing recorded").to.deep.equal([]);
  });

  it("GA-old-fill: the same, then DEPLOY_FILL_HASH (the expected path) completes, counted once", async function () {
    const { d, start, r } = await two();
    process.env.DEPLOY_FILL_HASH = await day3(d, start, r);
    expect(await s.resume()).to.equal("accepted");
    expect(s.load().strays).to.have.length(1);
    delete process.env.DEPLOY_FILL_HASH;
    expect(await s.resume(), "a further resume after unset").to.equal(
      "accepted",
    );
  });

  it("GA-foreign-old: a foreign hand-sent deployer transaction past the bound: the fill is offered only for an entry's re-send, and refuses this one", async function () {
    const { d, start, r, day1 } = await two();
    await mine(5100);
    const t = await d.sendTransaction({ to: d.address, nonce: start + 2 });
    await t.wait();
    expect(await s.resume()).to.equal(
      bound(start + 2, d.address, day1, r.txs[0].label),
    );
    process.env.DEPLOY_FILL_HASH = t.hash;
    expect(await s.resume()).to.equal(
      `DEPLOY_FILL_HASH ${t.hash} is ${d.address}'s transaction at nonce ${start + 2}, not at a recorded stray's sender and nonce, nor an entry's re-send at a free nonce of the deployer: refusing${UNSET}`,
    );
  });
});
