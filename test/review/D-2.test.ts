// Review D-2 (ported from the reviewer's D-2.test.ts, inverted): one
// lagging read (a load-balanced backend that has not imported the block
// and never saw the transaction) must not drop a mined transaction from
// the deploy record, and the deployer's nonce is checked against the
// record's start nonce on every resume, an empty record included.
import { expect } from "chai";
import { ethers, network } from "hardhat";
import { Recorder } from "../../scripts/production/deployRecord";
import {
  DeployRecord,
  loadRecord,
  saveRecord,
} from "../../scripts/production/deployRecordFile";
import * as h from "../helpers/deployRecordFlow";
const { installRetry } = require("../../demo/utils/RpcRetry");

describe("D-2 a lagging receipt read keeps a mined deploy transaction", function () {
  const box = h.files();
  const load = () => loadRecord(box.file)!;

  /** Reads of `lag.hash` and the nonce counts answer as a lagging node `left` times. */
  function laggingNode() {
    const p: any = network.provider;
    const request = p.request.bind(p);
    const send = p.send?.bind(p);
    const lag: { hash: string | null; left: number } = { hash: null, left: 0 };
    const shim = async (a: any) => {
      const r = await request(a);
      if (lag.left <= 0) return r;
      const m = a.method;
      if (
        lag.hash &&
        (m === "eth_getTransactionReceipt" ||
          m === "eth_getTransactionByHash") &&
        String(a.params?.[0]).toLowerCase() === lag.hash
      ) {
        lag.left--;
        return null;
      }
      if (m === "eth_getTransactionCount") {
        lag.left--;
        return ethers.toQuantity(Number(r) - 1);
      }
      return r;
    };
    p.request = shim;
    if (send)
      p.send = (m: string, x?: unknown[]) =>
        shim({ method: m, params: x ?? [] });
    const unretry = installRetry(p, { log: () => {} });
    return {
      lag,
      restore: () => {
        unretry();
        p.request = request;
        if (send) p.send = send;
      },
    };
  }

  /** `f` under a Recorder whose log lines land in `lines`. */
  async function logged(
    rec: DeployRecord,
    f: () => Promise<any>,
    lines: string[],
  ) {
    const r = new Recorder(box.file, rec, 1, (m) => lines.push(m));
    await r.install();
    try {
      const out = await f();
      await r.finish();
      return { r, out };
    } finally {
      r.remove();
    }
  }

  /** IdentityRegistry contracts the deployer created from nonce `start` on. */
  async function registries(start: number) {
    const [d] = await ethers.getSigners();
    const out: string[] = [];
    for (let n = start; n < (await h.nonce()); n++) {
      const a = ethers.getCreateAddress({ from: d.address, nonce: n });
      if ((await ethers.provider.getCode(a)) === "0x") continue;
      const ir = await ethers.getContractAt("IdentityRegistry", a);
      if ((await ir.owner().catch(() => null)) === d.address) out.push(a);
    }
    return out;
  }

  it("the first entry, mined, survives one lagging window; the re-run sends nothing", async function () {
    const start = await h.nonce();
    const node = laggingNode();
    const lines: string[] = [];
    const flow = async () => {
      const ir = await (
        await ethers.getContractFactory("IdentityRegistry")
      ).deploy();
      await ir.waitForDeployment();
      // The next send's confirmLast reads entry #0 from a lagging backend.
      node.lag.hash = ir.deploymentTransaction()!.hash.toLowerCase();
      node.lag.left = 4; // receipt, byHash, latest count, pending count
      if (!(await ir.isAgent(h.AGENT)))
        await (await ir.addAgent(h.AGENT)).wait();
      return ir.getAddress();
    };
    let first = "";
    try {
      first = (await logged(await h.fresh(box.file), flow, lines)).out;
    } finally {
      node.restore();
    }
    expect(lines.join("\n")).to.contain(
      "entry #0 unknown to this node; re-checking",
    );
    expect(load().txs.map((t) => t.status)).to.deep.equal([
      "confirmed",
      "confirmed",
    ]);
    expect(load().txs[0].contract).to.equal(first);
    const again = await logged(load(), flow, []);
    expect([again.r.sent, again.r.reused]).to.deep.equal([0, 2]);
    expect(again.out).to.equal(first);
    expect(await registries(start)).to.deep.equal([first]);
  });

  it("a later entry, mined, survives one lagging window; the resume settles", async function () {
    const node = laggingNode();
    try {
      await logged(
        await h.fresh(box.file),
        async () => {
          const ir = await (
            await ethers.getContractFactory("IdentityRegistry")
          ).deploy();
          await ir.waitForDeployment();
          const tx = await ir.addAgent(h.AGENT);
          await tx.wait();
          node.lag.hash = tx.hash.toLowerCase();
          node.lag.left = 4;
          await (
            await ir.addAgent(ethers.Wallet.createRandom().address)
          ).wait();
        },
        [],
      );
    } finally {
      node.restore();
    }
    expect(load().txs).to.have.length(3);
    await h.settle(box.file, load());
    expect(load().txs.map((t) => t.status)).to.deep.equal(
      Array(3).fill("confirmed"),
    );
  });

  it("a lag that outlasts the re-check refuses and keeps the entry; a synced re-run adopts it", async function () {
    const start = await h.nonce();
    const node = laggingNode();
    const flow = async () => {
      const ir = await (
        await ethers.getContractFactory("IdentityRegistry")
      ).deploy();
      await ir.waitForDeployment();
      node.lag.hash = ir.deploymentTransaction()!.hash.toLowerCase();
      node.lag.left = 1000;
      if (!(await ir.isAgent(h.AGENT)))
        await (await ir.addAgent(h.AGENT)).wait();
      return ir.getAddress();
    };
    try {
      await expect(
        logged(await h.fresh(box.file), flow, []),
      ).to.be.rejectedWith(
        /record entry #0 \(new IdentityRegistry\): .* unknown to the node .* kept in the record/,
      );
    } finally {
      node.lag.left = 0;
      node.restore();
    }
    expect(load().txs).to.have.length(1);
    expect(load().txs[0].status).to.equal("sent");
    const b = await logged(
      load(),
      async () => {
        const ir = await (
          await ethers.getContractFactory("IdentityRegistry")
        ).deploy();
        await ir.waitForDeployment();
        if (!(await ir.isAgent(h.AGENT)))
          await (await ir.addAgent(h.AGENT)).wait();
        return ir.getAddress();
      },
      [],
    );
    expect([b.r.sent, b.r.reused]).to.deep.equal([1, 1]);
    expect(await registries(start)).to.deep.equal([b.out]);
  });

  it("a sent intent is not dropped on one lagging nonce count", async function () {
    const rec = await h.fresh(box.file);
    await expect(h.run(box.file, rec, () => h.flow(3))).to.be.rejectedWith(
      "killed",
    );
    await h.settle(box.file, load());
    const mid = load();
    const ir = await ethers.getContractAt(
      "IdentityRegistry",
      mid.txs[0].contract!,
    );
    const data = ir.interface.encodeFunctionData("addAgent", [
      mid.txs[2].contract!,
    ]);
    const [d] = await ethers.getSigners();
    const nonce = await h.nonce();
    mid.txs.push({
      from: d.address,
      to: mid.txs[0].contract!,
      value: "0",
      dataHash: ethers.keccak256(data),
      nonce,
      block: await ethers.provider.getBlockNumber(),
      status: "sending",
      label: "addAgent",
    });
    saveRecord(box.file, mid);
    // Sent before the stop (its reply lost): mined at the intent's nonce.
    await (
      await d.sendTransaction({ to: mid.txs[0].contract!, data, nonce })
    ).wait();
    const node = laggingNode();
    node.lag.left = 2; // latest and pending counts one behind
    try {
      await h.settle(box.file, load());
    } finally {
      node.restore();
    }
    expect(load().txs).to.have.length(4);
    expect(load().txs[3].status).to.equal("confirmed");
    const b = await h.run(box.file, load(), () => h.flow());
    expect([b.r.sent, b.r.reused]).to.deep.equal([0, 4]);
  });

  it("an empty record still checks the deployer's nonce against its start", async function () {
    const rec = await h.fresh(box.file);
    Object.assign(rec, { startNonce: await h.nonce() });
    saveRecord(box.file, rec);
    const [d] = await ethers.getSigners();
    await (await d.sendTransaction({ to: h.AGENT })).wait();
    await expect(h.settle(box.file, load())).to.be.rejectedWith(
      /the deployer's nonce is \d+ but the record accounts for \d+: a transaction outside the record; refusing to resume/,
    );
  });
});
