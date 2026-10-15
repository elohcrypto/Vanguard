import { expect } from "chai";
import { ethers, network } from "hardhat";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  DeployRecord,
  loadRecord,
  Recorder,
  saveRecord,
} from "../../scripts/production/deployRecord";

/**
 * Plan v2 Task 5.7: the production deploy's record (deployments/<chainId>
 * .json). Every transaction is recorded before the next; a re-run replays
 * the record in order with reads pinned to the original blocks, sends only
 * what is missing, and refuses a record the chain contradicts (a code
 * hash, a transaction outside it) or a flow that leaves it.
 */
describe("Production deploy record (Task 5.7)", function () {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "deploy-record-"));
  let file: string;
  let n = 0;
  const quiet = () => {};
  const AGENT = "0x000000000000000000000000000000000000a11c";

  beforeEach(function () {
    file = path.join(dir, `${++n}.json`);
  });
  after(function () {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  async function fresh(): Promise<DeployRecord> {
    const [d] = await ethers.getSigners();
    const rec: DeployRecord = {
      version: 1,
      chainId: 31337,
      configDigest: "test",
      deployer: d.address,
      fromBlock: await ethers.provider.getBlockNumber(),
      txs: [],
      contracts: {},
      complete: false,
    };
    saveRecord(file, rec);
    return rec;
  }

  /** Two deploys and two calls, one behind a read; stops after `stop` sends. */
  async function flow(stop = Infinity, agent = AGENT) {
    let sends = 0;
    const tick = () => {
      if (++sends >= stop) throw new Error("killed");
    };
    const ir = await (
      await ethers.getContractFactory("IdentityRegistry")
    ).deploy();
    await ir.waitForDeployment();
    tick();
    if (!(await ir.isAgent(agent))) {
      await (await ir.addAgent(agent)).wait();
      tick();
    }
    const km = await (await ethers.getContractFactory("KeyManager")).deploy();
    await km.waitForDeployment();
    tick();
    await (await ir.addAgent(await km.getAddress())).wait();
    tick();
    return { ir: await ir.getAddress(), km: await km.getAddress() };
  }

  async function run(rec: DeployRecord, f: () => Promise<any>) {
    const r = new Recorder(file, rec, 1, quiet);
    await r.install();
    try {
      const out = await f();
      await r.finish();
      return { r, out };
    } finally {
      r.remove();
    }
  }

  const nonce = async () =>
    ethers.provider.getTransactionCount((await ethers.getSigners())[0]);

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

  it("an intent sent but not recorded is adopted; one never sent is dropped", async function () {
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
      nonce: await nonce(),
      block: await ethers.provider.getBlockNumber(),
      status: "sending" as const,
      label: "addAgent",
    };
    // Never sent: dropped, and the resumed flow sends it itself.
    saveRecord(file, { ...rec, txs: [...rec.txs, intent] });
    const a = new Recorder(file, loadRecord(file)!, 1, quiet);
    await a.install();
    a.remove();
    expect(loadRecord(file)!.txs).to.have.length(1);
    // Sent before the stop (outside the recorder): adopted from the chain.
    saveRecord(file, { ...rec, txs: [...rec.txs, intent] });
    const tx = await d.sendTransaction({ to: intent.to, data });
    const b = await run(loadRecord(file)!, () => flow());
    expect(loadRecord(file)!.txs[1].hash).to.equal(tx.hash);
    expect([b.r.sent, b.r.reused]).to.deep.equal([2, 2]);
    expect(await nonce()).to.equal(rec.txs[0].nonce + 4);
  });

  it("refuses a tampered code hash, a lost send or one outside the record, sending nothing", async function () {
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
    // A sent transaction the node does not know: refused, not awaited.
    const lost = JSON.parse(good);
    Object.assign(lost.txs[3], { status: "sent", hash: ethers.ZeroHash });
    fs.writeFileSync(file, JSON.stringify(lost));
    await expect(run(loadRecord(file)!, () => flow())).to.be.rejectedWith(
      `transaction ${ethers.ZeroHash} is unknown to the node`,
    );
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

  it("never signs in this process, and no dev-node call off a dev chain", async function () {
    const r = new Recorder(file, await fresh(), 1, quiet);
    await r.install();
    const [d] = await ethers.getSigners();
    try {
      for (const [method, params] of [
        ["eth_sign", [d.address, "0x00"]],
        ["personal_sign", ["0x00", d.address]],
        ["eth_sendRawTransaction", ["0x00"]],
        ["eth_signTypedData_v4", [d.address, "{}"]],
      ] as const) {
        await expect(
          network.provider.request({ method, params: [...params] }),
        ).to.be.rejectedWith(
          `the deploy process never signs (${method} refused)`,
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
