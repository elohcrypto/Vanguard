import { expect } from "chai";
import { ethers, network } from "hardhat";
import * as fs from "fs";
import { Recorder } from "../../scripts/production/deployRecord";
import {
  loadRecord,
  saveRecord,
} from "../../scripts/production/deployRecordFile";
import * as h from "../helpers/deployRecordFlow";

/**
 * Plan v2 Task 5.7: the production deploy's record (deployments/<chainId>
 * .json). Every transaction is recorded before the next; a re-run replays
 * the record in order with reads pinned to the original blocks, sends only
 * what is missing, and refuses a record the chain contradicts (a code
 * hash, a transaction outside it) or a flow that leaves it. Resume edge
 * cases: DeployRecordResume.test.ts.
 */
describe("Production deploy record (Task 5.7)", function () {
  const box = h.files();
  const quiet = () => {};
  const AGENT = h.AGENT;
  const fresh = () => h.fresh(box.file);
  const flow = h.flow;
  const run = (rec: any, f: () => Promise<any>) => h.run(box.file, rec, f);
  const nonce = () => h.nonce();
  let file = "";
  beforeEach(function () {
    file = box.file;
  });

  it("records every transaction; a complete re-run sends nothing", async function () {
    const a = await run(await fresh(), () => flow());
    expect(a.r.sent).to.equal(4);
    const rec = loadRecord(file)!;
    expect(rec.txs.map((t) => t.status)).to.deep.equal(
      Array(4).fill("confirmed"),
    );
    expect(rec.txs.map((t) => t.label)).to.deep.equal([
      "new IdentityRegistry",
      `${a.out.ir.slice(0, 10)}….addAgent`,
      "new KeyManager",
      `${a.out.ir.slice(0, 10)}….addAgent`,
    ]);
    expect([rec.txs[0].contract, rec.txs[2].contract]).to.deep.equal([
      a.out.ir,
      a.out.km,
    ]);
    const code = await ethers.provider.getCode(a.out.km);
    expect(rec.txs[2].codeHash).to.equal(ethers.keccak256(code));
    const before = await nonce();
    expect(before).to.equal(rec.txs[0].nonce + 4);
    const b = await run(loadRecord(file)!, () => flow());
    expect([b.r.sent, b.r.reused]).to.deep.equal([0, 4]);
    expect(b.out).to.deep.equal(a.out);
    expect(await nonce()).to.equal(before);
  });

  it("a killed deploy resumes where it stopped, the same branches taken", async function () {
    await expect(run(await fresh(), () => flow(2))).to.be.rejectedWith(
      "killed",
    );
    const half = loadRecord(file)!;
    expect(half.txs).to.have.length(2);
    // The read before the first addAgent is replayed at its original block,
    // so the resumed flow sends it again (answered from the record).
    const b = await run(half, () => flow());
    expect([b.r.sent, b.r.reused]).to.deep.equal([2, 2]);
    expect(b.out.ir).to.equal(half.txs[0].contract);
    const rec = loadRecord(file)!;
    expect(await nonce()).to.equal(rec.txs[0].nonce + 4);
  });

  /** A killed run's first step settled, and the next step's intent after it. */
  async function intentAfterFirst() {
    const [d] = await ethers.getSigners();
    await expect(run(await fresh(), () => flow(1))).to.be.rejectedWith(
      "killed",
    );
    // Settle the killed run's last send (its receipt into the record).
    const settle = new Recorder(file, loadRecord(file)!, 1, quiet);
    await settle.install();
    settle.remove();
    const rec = loadRecord(file)!;
    const ir = await ethers.getContractAt(
      "IdentityRegistry",
      rec.txs[0].contract!,
    );
    const data = ir.interface.encodeFunctionData("addAgent", [AGENT]);
    const intent = {
      from: d.address,
      to: rec.txs[0].contract!,
      value: "0",
      dataHash: ethers.keccak256(data),
      data,
      nonce: await nonce(),
      block: await ethers.provider.getBlockNumber(),
      status: "sending" as const,
      label: "addAgent",
    };
    saveRecord(file, { ...rec, txs: [...rec.txs, intent] });
    return { d, rec, intent, data };
  }

  it("an intent never sent is sent again at its nonce, never dropped", async function () {
    const { rec, intent } = await intentAfterFirst();
    const a = new Recorder(file, loadRecord(file)!, 1, quiet);
    await a.install();
    a.remove();
    expect(loadRecord(file)!.txs.map((t) => [t.nonce, t.status])).to.deep.equal(
      [
        [rec.txs[0].nonce, "confirmed"],
        [intent.nonce, "confirmed"],
      ],
    );
    const b = await run(loadRecord(file)!, () => flow());
    expect([b.r.sent, b.r.reused]).to.deep.equal([2, 2]);
    expect(await nonce()).to.equal(rec.txs[0].nonce + 4);
  });

  it("an intent sent but not recorded is adopted", async function () {
    const { d, rec, intent, data } = await intentAfterFirst();
    // Sent before the stop (outside the recorder): adopted from the chain.
    const tx = await d.sendTransaction({ to: intent.to, data });
    const b = await run(loadRecord(file)!, () => flow());
    expect(loadRecord(file)!.txs[1].hash).to.equal(tx.hash);
    expect([b.r.sent, b.r.reused]).to.deep.equal([2, 2]);
    expect(await nonce()).to.equal(rec.txs[0].nonce + 4);
  });

  it("refuses a tampered code hash or a send outside the record, sending nothing", async function () {
    await run(await fresh(), () => flow());
    const good = fs.readFileSync(file, "utf8");
    const rec = JSON.parse(good);
    rec.txs[2].codeHash = ethers.ZeroHash;
    fs.writeFileSync(file, JSON.stringify(rec));
    const before = await nonce();
    await expect(run(loadRecord(file)!, () => flow())).to.be.rejectedWith(
      /record entry #2 \(new KeyManager\) says 0x[0-9a-fA-F]{40} has code hash 0x0{64}; the chain has 0x[0-9a-f]{64}: refusing \(never deploys over a recorded contract\)/,
    );
    expect(await nonce()).to.equal(before);
    fs.writeFileSync(file, good);
    const [d] = await ethers.getSigners();
    await (await d.sendTransaction({ to: d.address })).wait();
    await expect(run(loadRecord(file)!, () => flow())).to.be.rejectedWith(
      /the deployer's nonce is \d+ but the record accounts for \d+: a transaction outside the record/,
    );
  });

  it("refuses a flow that leaves its record, or one that stops short of it", async function () {
    await run(await fresh(), () => flow());
    const before = await nonce();
    await expect(
      run(loadRecord(file)!, () => flow(Infinity, ethers.ZeroAddress)),
    ).to.be.rejectedWith(
      /the deploy diverged from its record at entry #1 \(0x[0-9a-fA-F]{8}….addAgent from 0x[0-9a-fA-F]{40}\)/,
    );
    expect(await nonce()).to.equal(before);
    // Stops after three of four: the fourth entry is never met.
    const short = async () => {
      const ir = await (
        await ethers.getContractFactory("IdentityRegistry")
      ).deploy();
      await (await ir.addAgent(AGENT)).wait();
      await (await ethers.getContractFactory("KeyManager")).deploy();
    };
    await expect(run(loadRecord(file)!, short)).to.be.rejectedWith(
      /record entry #3 \(.*addAgent\) was never replayed/,
    );
    expect(await nonce()).to.equal(before);
  });

  it("sends no transaction around the record, and no dev-node call off a dev chain", async function () {
    const r = new Recorder(file, await fresh(), 1, quiet);
    await r.install();
    const [d] = await ethers.getSigners();
    try {
      for (const [method, params] of [
        ["eth_signTransaction", [{ from: d.address }]],
        ["eth_sendRawTransaction", ["0x00"]],
      ] as const) {
        await expect(
          network.provider.request({ method, params: [...params] }),
        ).to.be.rejectedWith(
          `the deploy sends only through its record and the external signer (${method} refused)`,
        );
      }
    } finally {
      r.remove();
    }
    const main = new Recorder(file, { ...(await fresh()), chainId: 1 }, 1);
    await expect(
      (main as any).handle("evm_increaseTime", [1]),
    ).to.be.rejectedWith("evm_increaseTime refused on chain 1");
  });
});
