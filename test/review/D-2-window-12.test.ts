// Review D-2, round 12 (item C, lane C C-1, LOW; R12-C2 option 2, R12-C7):
// findMined refused the unrecorded scan when the chain HEAD was more than
// 5000 blocks past the earliest intent, before scanning, with a text
// saying the nonce was used more than 5000 blocks after the intent. A
// re-send mined one block after its intent, resumed once the head passed
// intent + 5001 (lane C's natural-head5001), was refused, and the text
// was false for it. Now the 5000 blocks from the intent are scanned
// whatever the head: what is mined there is found at any later time, and
// only a use past them is refused, with a text that says what is true.
// Narrow: the window applies to the unrecorded scan only (R12-C7).
import { expect } from "chai";
import { ethers, network } from "hardhat";
import { Recorder } from "../../scripts/production/deployRecord";
import * as h from "../helpers/deployRecordFlow";
import { strays } from "../helpers/deployRecordStrays";

describe("D-2 round 12: the intent's 5000 blocks are scanned whatever the head", function () {
  this.timeout(600000);
  const s = strays();
  afterEach(() => delete process.env.DEPLOY_FILL_HASH);
  const mine = (n: number) =>
    network.provider.request({
      method: "hardhat_mine",
      params: [ethers.toQuantity(n)],
    });

  /** Entry #0 mined and hidden; a re-send killed before its record, forwarded (nonce dropped) or not. */
  async function killedResend(forward: boolean) {
    const start = await h.nonce();
    await h.sendOne(s.box.file);
    const hide = s.load().txs[0].hash!;
    let sent: string | null = null;
    const restore = h.node(async (a, request) => {
      if (a.method === "eth_sendTransaction") {
        const { nonce, ...rest } = a.params[0];
        sent = forward ? await request({ method: a.method, params: [rest] }) : "0x";
        return new Promise(() => {});
      }
      if (a.method === "eth_getTransactionCount") return ethers.toQuantity(start);
      const hides = a.method === "eth_getTransactionByHash" || a.method === "eth_getTransactionReceipt";
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
    return { start, stray: sent! };
  }

  it("natural-head5001 (lane C): a re-send mined next to its intent, the head at intent + 5001: found and recorded, no fill", async function () {
    const { start, stray } = await killedResend(true);
    const from = s.load().txs[0].resendFrom!;
    const at = (await ethers.provider.getTransaction(stray))!.blockNumber!;
    expect(at - from, "mined within a block of the intent").to.be.lessThanOrEqual(1);
    await mine(from + 5001 - (await ethers.provider.getBlockNumber()));
    expect(await ethers.provider.getBlockNumber()).to.equal(from + 5001);
    expect(await s.resume()).to.equal("accepted");
    expect(s.load().strays!.map((x) => [x.nonce, x.hash, x.block])).to.deep.equal([[start + 1, stray, from]]);
    expect(await h.nonce()).to.equal(start + 2);
    expect(await s.resume(), "a further resume").to.equal("accepted");
  });

  it("a re-send mined past the intent's 5000 blocks: refused with the window's text; the fill completes", async function () {
    const [d] = await ethers.getSigners();
    const { start } = await killedResend(false); // the intent only
    const r = s.load();
    await mine(5001);
    const t = await (await d.sendTransaction({ data: r.txs[0].data, nonce: start + 1 })).wait();
    const head = await ethers.provider.getBlockNumber();
    expect(await s.resume()).to.equal(
      `nonce ${start + 1}: the chain head (block ${head}) is more than 5000 blocks past entry #0 (${r.txs[0].label})'s intent (block ${r.txs[0].resendFrom}), the earliest the record keeps, and those 5000 blocks hold no transaction of ${d.address} at nonce ${start + 1}; if nonce ${start + 1} is an entry's re-send, pass its hash as DEPLOY_FILL_HASH=<hash>, then resume; otherwise record it by hand; unset DEPLOY_FILL_HASH after the resume completes`,
    );
    expect(s.load().strays ?? [], "nothing recorded").to.deep.equal([]);
    process.env.DEPLOY_FILL_HASH = t!.hash;
    expect(await s.resume()).to.equal("accepted");
    expect(s.load().strays!.map((x) => x.hash)).to.deep.equal([t!.hash]);
  });
});
