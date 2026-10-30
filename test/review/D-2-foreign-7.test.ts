// Review D-2, round 7 (lane C c1, pre-existing since round 4, inverted): a
// hash becomes the entry's only when its transaction is the entry. A
// re-send (or a send) answered with ANOTHER sender's mined transaction is
// refused by name, the hash cleared and nothing recorded as a stray, so
// the next healthy resume finds or sends the entry at its own nonce and
// completes; the foreign transaction is never adopted.
import { expect } from "chai";
import { ethers } from "hardhat";
import {
  loadRecord,
  saveRecord,
} from "../../scripts/production/deployRecordFile";
import * as h from "../helpers/deployRecordFlow";

describe("D-2 round 7: another sender's transaction is never an entry's", function () {
  this.timeout(120000);
  const box = h.files();
  const load = () => loadRecord(box.file)!;
  let realST: any;
  beforeEach(() => {
    realST = global.setTimeout;
    (global as any).setTimeout = (f: any, ms: any, ...a: any[]) =>
      realST(f, Math.min(ms ?? 0, 2), ...a);
  });
  afterEach(() => {
    (global as any).setTimeout = realST;
  });
  /** Another signer's mined transaction. */
  async function theirs() {
    const [, other] = await ethers.getSigners();
    const r = (await (await other.sendTransaction({ to: h.AGENT })).wait())!;
    const t = (await ethers.provider.getTransaction(r.hash))!;
    return { hash: r.hash, from: other.address, nonce: t.nonce };
  }
  const refusal = (x: { hash: string; from: string; nonce: number }) =>
    `record entry #0 (new IdentityRegistry): ${x.hash} mined at nonce ${x.nonce} from ${x.from}, another sender's transaction, not the entry's and not the deployer's stray: nothing recorded; the entry's own transaction is looked up at its nonce on the next run: fix the signer, then resume against a synced RPC; kept in the record, nothing more is sent`;

  /** The record completes once healthy: one contract, the foreign hash nowhere. */
  async function completes(start: number, foreign: string) {
    expect(await h.accepted(box.file), "the healthy resume").to.equal(
      "accepted",
    );
    const e0 = load().txs[0];
    expect(e0.status).to.equal("confirmed");
    expect(e0.hash).to.not.equal(foreign);
    expect((await ethers.provider.getTransaction(e0.hash!))!.nonce).to.equal(
      start,
    );
    expect(await h.created(start)).to.have.length(1);
    expect(await h.nonce()).to.equal(start + 1);
    expect((load() as any).strays, "no stray").to.equal(undefined);
    expect(await h.accepted(box.file), "a second resume").to.equal("accepted");
    expect(await h.nonce(), "sends nothing").to.equal(start + 1);
  }

  it("c1: a re-send answered with another sender's mined hash is refused, the hash cleared; the next healthy resume completes", async function () {
    const start = await h.nonce();
    await h.sendOne(box.file, true); // the signer refused: an intent, no hash
    const x = await theirs();
    let answered = 0;
    const restore = h.node(async (a) =>
      a.method === "eth_sendTransaction" ? (answered++, x.hash) : undefined,
    );
    let err = "";
    try {
      err = await h.accepted(box.file);
    } finally {
      restore();
    }
    expect(answered).to.equal(1);
    expect(err).to.equal(refusal(x));
    const e0: any = load().txs[0];
    expect([e0.hash, e0.status, e0.resent]).to.deep.equal([
      undefined,
      "sending",
      undefined,
    ]);
    expect((load() as any).strays, "no stray").to.equal(undefined);
    expect(await h.nonce(), "nothing mined for the deployer").to.equal(start);
    await completes(start, x.hash);
  });

  it("c1 (isTheEntry): a sent entry whose hash is another sender's mined transaction is refused the same way; the next healthy resume completes", async function () {
    const start = await h.nonce();
    await h.sendOne(box.file, true);
    const x = await theirs();
    const rec = load();
    Object.assign(rec.txs[0], { hash: x.hash, status: "sent" });
    saveRecord(box.file, rec);
    expect(await h.accepted(box.file)).to.equal(refusal(x));
    const e0 = load().txs[0];
    expect([e0.hash, e0.status]).to.deep.equal([undefined, "sending"]);
    await completes(start, x.hash);
  });
});
