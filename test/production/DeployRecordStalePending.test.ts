import { expect } from "chai";
import { ethers, network } from "hardhat";
import {
  DeployRecord,
  loadRecord,
  saveRecord,
} from "../../scripts/production/deployRecordFile";
import * as h from "../helpers/deployRecordFlow";
const { installRetry } = require("../../demo/utils/RpcRetry");

/**
 * Task 5.17 slice B (deep review M-1): a lagging RPC (one backend of a
 * load balancer behind the others) answered the record's pending nonce
 * read one below the mined count. The intent was saved at a used nonce,
 * RpcRetry refused the send as stale, and every resume then refused the
 * record ("used nonce N for a transaction that is not record entry #k").
 *  - the Recorder now reads `latest` too and refuses before saving;
 *  - a record of the old shape (an intent at an EARLIER entry's mined
 *    nonce) resumes: the intent is dropped as never sent.
 */
describe("Production deploy record: a lagging RPC's pending nonce (M-1)", function () {
  const box = h.files();
  const load = () => loadRecord(box.file)!;

  /** The provider, answering the `which`-th pending count one low. */
  function lagging(which: number): () => void {
    const p: any = network.provider;
    const request = p.request.bind(p);
    const send = p.send?.bind(p);
    let n = 0;
    const lag = async (a: any) => {
      const r = await request(a);
      if (a.method === "eth_getTransactionCount" && a.params?.[1] === "pending")
        if (++n === which) return ethers.toQuantity(Number(r) - 1);
      return r;
    };
    p.request = lag;
    if (send)
      p.send = (m: string, x?: unknown[]) =>
        lag({ method: m, params: x ?? [] });
    // RpcRetry as the production CLIs install it, over the lagging node.
    const unretry = installRetry(p, { log: () => {} });
    return () => {
      unretry();
      p.request = request;
      if (send) p.send = send;
    };
  }

  it("refuses before saving the intent; nothing sent, the record resumes", async function () {
    const rec = await h.fresh(box.file);
    const before = await h.nonce();
    const restore = lagging(2); // the second send's nonce read lags
    try {
      await expect(h.run(box.file, rec, () => h.flow())).to.be.rejectedWith(
        /pending nonce \d+ below its mined nonce \d+: a lagging or inconsistent node; nothing was recorded or sent/,
      );
    } finally {
      restore();
    }
    const saved = load();
    expect(saved.txs.map((t) => t.status)).to.deep.equal(["confirmed"]);
    expect(await h.nonce()).to.equal(before + 1);
    // A synced RPC: the resume replays entry #0 and sends the other three.
    const { r } = await h.run(box.file, load(), () => h.flow());
    expect([r.reused, r.sent]).to.deep.equal([1, 3]);
    expect(load().txs.map((t) => t.nonce)).to.deep.equal([
      before,
      before + 1,
      before + 2,
      before + 3,
    ]);
  });

  it("an old record with an intent at an earlier entry's nonce resumes (the intent dropped)", async function () {
    await expect(
      h.run(box.file, await h.fresh(box.file), () => h.flow(1)),
    ).to.be.rejectedWith("killed");
    await h.settle(box.file, load());
    const rec: DeployRecord = load();
    const first = rec.txs[0];
    // What the record held after the M-1 failure: entry #1, the intent
    // read from the lagging count, at entry #0's mined nonce.
    rec.txs.push({
      from: first.from,
      to: first.contract!,
      value: "0",
      dataHash: ethers.id("addAgent"),
      nonce: first.nonce,
      block: await ethers.provider.getBlockNumber(),
      status: "sending",
      label: "addAgent",
    });
    saveRecord(box.file, rec);
    const logs: string[] = [];
    const { Recorder } = require("../../scripts/production/deployRecord");
    const r = new Recorder(box.file, load(), 1, (m: string) => logs.push(m));
    await r.install();
    r.remove();
    expect(load().txs.length).to.equal(1);
    expect(logs.join("\n")).to.match(
      /addAgent: its nonce \d+ is record entry #0's \(an intent read from a lagging RPC, never sent\); dropped from the record/,
    );
    const { r: resumed } = await h.run(box.file, load(), () => h.flow());
    expect([resumed.reused, resumed.sent]).to.deep.equal([1, 3]);
  });
});
