// Review D-2, round 8 (lane C's cX, pre-existing since round 5, as a
// test): the process is killed after the node accepted a nonce-dropped
// re-send but before stray() recorded it. The unrecorded stray mines and
// every later resume refused "the deployer's nonce is N but the record
// accounts for N-1", with no way out. The re-send's intent (the entry,
// its sender and the head block) is saved before the send goes out; a
// resume that finds the deployer's mined transaction at a nonce the
// record does not account for, with that entry's payload, records it as
// the entry's stray and continues. Anything else keeps the refusal.
import { expect } from "chai";
import { ethers } from "hardhat";
import { Recorder } from "../../scripts/production/deployRecord";
import * as h from "../helpers/deployRecordFlow";
import { strays } from "../helpers/deployRecordStrays";

describe("D-2 round 8: a re-send the run did not live to record is found by its intent", function () {
  this.timeout(180000);
  const s = strays();

  /**
   * Entry #0 sent at `start` (mined); a resume behind a backend hiding it,
   * whose signer drops the nonce (`forward`: the node gets the send) and
   * never answers: the run is killed while it waits for the reply.
   */
  async function killedResend(forward: boolean) {
    const start = await h.nonce();
    await h.sendOne(s.box.file);
    const hide = s.load().txs[0].hash!;
    let sent = false;
    const restore = h.node(async (a, request) => {
      if (a.method === "eth_sendTransaction") {
        const { nonce, ...rest } = a.params[0];
        if (forward) await request({ method: a.method, params: [rest] });
        sent = true;
        return new Promise(() => {}); // the reply never comes
      }
      if (a.method === "eth_getTransactionCount")
        return ethers.toQuantity(start);
      const hides =
        a.method === "eth_getTransactionByHash" ||
        a.method === "eth_getTransactionReceipt";
      return hides && a.params[0] === hide ? null : undefined;
    });
    const r = new Recorder(s.box.file, s.load(), 1, () => {});
    void r.install().catch(() => {}); // never settles: the run is killed
    try {
      for (let i = 0; !sent && i < 500; i++) await s.wait(10);
      expect(sent, "the re-send went out").to.equal(true);
    } finally {
      r.remove(); // the kill: nothing more from that run
      restore();
    }
    return { start, hide };
  }

  it("cX: killed between the node's accept and the stray's record; the healthy resume records the re-send as the entry's stray, counts it once and completes", async function () {
    const [d] = await ethers.getSigners();
    const { start } = await killedResend(true);
    expect(s.load().strays ?? [], "unrecorded").to.deep.equal([]);
    expect(await h.nonce(), "the re-send mined at start + 1").to.equal(
      start + 2,
    );
    const lines: string[] = [];
    expect(await s.resume(lines), "recovered").to.equal("accepted");
    const [row] = s.load().strays!;
    const t = await ethers.provider.getTransaction(row.hash);
    expect([row.from, row.nonce, row.entry, t!.from, t!.nonce]).to.deep.equal([
      d.address,
      start + 1,
      0,
      d.address,
      start + 1,
    ]);
    expect(lines.join("\n")).to.contain(
      `nonce ${start + 1}: ${row.hash}, the signer's re-send of entry #0 (new IdentityRegistry) at another nonce, found on chain from its recorded intent (the run that sent it stopped before recording it): recorded as a stray`,
    );
    const again: string[] = [];
    expect(await s.resume(again), "a re-run").to.equal("accepted");
    expect(
      again.filter((l) => l.includes(`${row.hash}, the signer's re-send`)),
      "printed and counted once",
    ).to.have.length(1);
    expect(again.join("\n")).to.contain("outside the record, never adopted");
    expect(s.load().strays).to.have.length(1);
    expect(await h.nonce()).to.equal(start + 2);
  });

  it("a transaction at the unaccounted nonce that is not the re-send (another calldata) still refuses", async function () {
    const [d] = await ethers.getSigners();
    const { start } = await killedResend(false);
    await (await d.sendTransaction({ to: d.address, nonce: start + 1 })).wait();
    expect(await s.resume()).to.contain(
      `the deployer's nonce is ${start + 2} but the record accounts for ${start + 1}: a transaction outside the record; refusing to resume`,
    );
    expect(s.load().strays ?? [], "nothing recorded").to.deep.equal([]);
  });

  it("the account refusal names every nonce no entry and no stray holds (lead ruling R8-C3)", async function () {
    const [d] = await ethers.getSigners();
    const start = await h.nonce();
    await h.sendOne(s.box.file);
    await (await d.sendTransaction({ to: d.address })).wait();
    const why = (n: string) =>
      `the deployer's nonce is ${start + 1 + n.split(",").length} but the record accounts for ${start + 1}: a transaction outside the record; refusing to resume`;
    expect(await s.resume()).to.equal(
      `${why("1")} (nonce ${start + 1} is no entry's and no stray's: find that transaction and record it by hand)`,
    );
    await (await d.sendTransaction({ to: d.address })).wait();
    expect(await s.resume()).to.equal(
      `${why("1,2")} (nonces ${start + 1}, ${start + 2} are no entry's and no stray's: find those transactions and record them by hand)`,
    );
  });
});
