// Review D-2, round 7 (the round-6 attacker G's GA, inverted): an empty
// code answer for a creation with a receipt is the node's lag, never the
// entry's code hash. The settle refuses by name before it sets anything;
// the next run reads the code again and completes.
import { expect } from "chai";
import { ethers, network } from "hardhat";
import { Recorder } from "../../scripts/production/deployRecord";
import { loadRecord } from "../../scripts/production/deployRecordFile";
import * as h from "../helpers/deployRecordFlow";

describe("D-2 round 7: a receipt without code on the node is a lag, never a code hash", function () {
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
  const deploy = async (name: string) =>
    (await ethers.getContractFactory(name)).deploy();
  /** A node that answers eth_getCode at `addr()` with "0x" `times` times. */
  function lagging(addr: () => string, times = 1) {
    const st = { left: times };
    const restore = h.node(async (a) => {
      const hit =
        a.method === "eth_getCode" &&
        st.left > 0 &&
        String(a.params[0]).toLowerCase() === addr().toLowerCase();
      return hit ? (st.left--, "0x") : undefined;
    });
    return { st, restore };
  }
  const refusal = (at: string) =>
    `record entry #0 (new IdentityRegistry): ${at} has a receipt but no code on this node: a lagging RPC; kept, re-run against a synced RPC`;

  it("GA: the flow's settle refuses by name, pins nothing; the healthy resume completes with the right code hash", async function () {
    const [d] = await ethers.getSigners();
    const start = await h.nonce();
    const at = ethers.getCreateAddress({ from: d.address, nonce: start });
    const r = new Recorder(box.file, await h.fresh(box.file), 1, () => {});
    let addr = "";
    const { st, restore } = lagging(() => addr);
    let err = "";
    try {
      await r.install();
      await (await deploy("IdentityRegistry")).deploymentTransaction()!.wait();
      addr = at; // the node behind the load balancer lags on its code once
      await deploy("KeyManager").catch((e: Error) => (err = e.message));
    } finally {
      r.remove();
      restore();
    }
    expect(st.left, "the lie was read").to.equal(0);
    expect(err).to.equal(refusal(at));
    const e0 = load().txs[0];
    expect([e0.status, e0.contract, e0.codeHash]).to.deep.equal([
      "sent",
      undefined,
      undefined,
    ]);
    expect(load().txs, "nothing planned after the refusal").to.have.length(1);
    expect(await h.accepted(box.file), "healthy resume").to.equal("accepted");
    const code = await ethers.provider.getCode(at);
    expect(load().txs[0].codeHash).to.equal(ethers.keccak256(code));
    expect(load().txs[0].codeHash).to.not.equal(ethers.keccak256("0x"));
    expect(await h.nonce(), "nothing more sent").to.equal(start + 1);
  });

  it("GA at a resume: the settle refuses by name with the record unchanged; the next resume completes", async function () {
    const [d] = await ethers.getSigners();
    const start = await h.nonce();
    await h.sendOne(box.file); // entry #0 sent, its receipt not yet read
    const at = ethers.getCreateAddress({ from: d.address, nonce: start });
    const before = JSON.stringify(load());
    const { st, restore } = lagging(() => at);
    let err = "";
    try {
      err = await h.accepted(box.file);
    } finally {
      restore();
    }
    expect(st.left).to.equal(0);
    expect(err).to.equal(refusal(at));
    expect(JSON.stringify(load()), "the record as it was").to.equal(before);
    expect(await h.accepted(box.file)).to.equal("accepted");
    expect(load().txs[0].codeHash).to.equal(
      ethers.keccak256(await ethers.provider.getCode(at)),
    );
    await network.provider.request({ method: "evm_mine" });
    expect(await h.nonce()).to.equal(start + 1);
  });
});
