// Review U2 round 2 (the swarm's surviving mutants M01, M02, M06 and the
// round-2 record rules): each case fails when its guard is removed.
import { expect } from "chai";
import { ethers, network } from "hardhat";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { Recorder } from "../../scripts/production/deployRecord";
import { EntryChain } from "../../scripts/production/deployRecordChain";
import {
  loadRecord,
  saveRecord,
} from "../../scripts/production/deployRecordFile";
import { deployOn } from "../../scripts/production/DeployProduction";
import { resolveInputs } from "../../scripts/production/deployConfig";
import * as h from "../helpers/deployRecordFlow";

const {
  attestorPublicKey,
  newAttestorKey,
} = require("../../scripts/zk/attest");

describe("U2 deploy record guards (mutants M01, M02, M06)", function () {
  this.timeout(300000);
  const box = h.files();
  const raw = (method: string, params: unknown[] = []) =>
    network.provider.request({ method, params });

  it("M01: no record is started while the deployer has a pending transaction", async function () {
    const accounts = (await ethers.getSigners()).map((s) => s.address);
    const { Ax, Ay } = await attestorPublicKey(newAttestorKey());
    const inputs = resolveInputs(
      { attestor: { Ax: Ax.toString(), Ay: Ay.toString() } } as any,
      31337,
      accounts,
    );
    const [d] = await ethers.getSigners();
    await raw("evm_setAutomine", [false]);
    try {
      await d.sendTransaction({ to: h.AGENT, value: 1n });
    } finally {
      await raw("evm_setAutomine", [true]);
    }
    try {
      await expect(
        deployOn(box.file, inputs, accounts, 31337),
      ).to.be.rejectedWith(
        /has 1 pending transaction\(s\): wait for them to mine, then run the deploy/,
      );
      expect(loadRecord(box.file)).to.equal(null);
    } finally {
      await raw("evm_mine");
    }
  });

  it("M02: a record without startNonce is refused on resume", async function () {
    const rec: any = await h.fresh(box.file);
    delete rec.startNonce;
    saveRecord(box.file, rec);
    await expect(h.settle(box.file, loadRecord(box.file)!)).to.be.rejectedWith(
      /has no startNonce \(a record made before review D-2\)/,
    );
  });

  it("M06: a receipt read while confirmations accrue is kept: a later lagging node refuses", async function () {
    let reads = 0;
    let pass = 0;
    const e: any = {
      from: "0x00000000000000000000000000000000000000aa",
      to: null,
      value: "0",
      dataHash: "0x" + "00".repeat(32),
      nonce: 5,
      block: 98,
      sentAtBlock: 98,
      status: "sent",
      hash: "0x" + "ab".repeat(32),
      label: "x",
    };
    const node = async (m: string) => {
      if (m === "eth_getTransactionReceipt")
        return pass++ === 0
          ? {
              transactionHash: e.hash,
              blockNumber: "0x64",
              status: "0x1",
              gasUsed: "0x5208",
              contractAddress: null,
            }
          : null;
      if (m === "eth_blockNumber") return ethers.toQuantity(100 + reads++);
      if (m === "eth_getTransactionCount") return "0x5";
      return null;
    };
    let saves = 0;
    const real = global.setTimeout;
    (global as any).setTimeout = (f: any) => real(f, 0);
    try {
      const c = new EntryChain(
        node,
        { chainId: 11155111, txs: [e] } as any,
        3,
        () => {},
        () => saves++,
      );
      await expect(c.receipt(e)).to.be.rejectedWith(
        /a node returned its receipt at block 100: a lagging or inconsistent RPC; kept in the record/,
      );
    } finally {
      (global as any).setTimeout = real;
    }
    expect([e.minedAt, saves]).to.deep.equal([100, 1]);
  });

  it("a nonce used at the bar by a replacement in every field is adopted, not unsent", async function () {
    const [H, H2] = ["0x" + "ab".repeat(32), "0x" + "ef".repeat(32)];
    const from = "0x00000000000000000000000000000000000000aa";
    const e: any = {
      from,
      to: null,
      value: "0",
      dataHash: ethers.keccak256("0x"),
      nonce: 5,
      block: 100,
      sentAtBlock: 100,
      status: "sent",
      hash: H,
      label: "x",
    };
    const node = async (m: string, p: any[] = []) => {
      if (m === "eth_getTransactionReceipt")
        return p[0] === H2
          ? {
              transactionHash: H2,
              blockNumber: "0x65",
              status: "0x1",
              gasUsed: "0x5208",
              contractAddress: null,
            }
          : null;
      if (m === "eth_blockNumber") return "0x67";
      // a lagging backend answers latest and pending; block 103 knows it used
      if (m === "eth_getTransactionCount")
        return /^0x/.test(p[1]) ? "0x6" : "0x5";
      if (m === "eth_getBlockByNumber")
        return {
          transactions:
            p[0] === "0x65"
              ? [
                  {
                    hash: H2,
                    from,
                    nonce: "0x5",
                    to: null,
                    value: "0x0",
                    input: "0x",
                  },
                ]
              : [],
        };
      return null;
    };
    const c = new EntryChain(
      node,
      { chainId: 11155111, txs: [e] } as any,
      1,
      () => {},
      () => {},
    );
    const r = await c.receipt(e);
    expect([r?.transactionHash, e.hash]).to.deep.equal([H2, H2]);
  });

  it("an entry made before round 2 takes its intent's block as sentAtBlock on resume", async function () {
    const r1 = new Recorder(box.file, await h.fresh(box.file), 1, () => {});
    await r1.install();
    await (await ethers.getContractFactory("IdentityRegistry")).deploy();
    r1.remove();
    const rec = loadRecord(box.file)!;
    const e = rec.txs[0];
    expect(e.sentAtBlock, "saved with the hash").to.equal(
      await ethers.provider.getBlockNumber(),
    );
    delete e.sentAtBlock;
    saveRecord(box.file, rec);
    await h.settle(box.file, loadRecord(box.file)!);
    expect(loadRecord(box.file)!.txs[0].sentAtBlock).to.equal(e.block);
  });

  it("a receipt of another hash read by the flow stamps nothing", async function () {
    const p: any = network.provider;
    const request = p.request.bind(p);
    const other = "0x" + "cd".repeat(32);
    p.request = async (a: any) => {
      const out = await request(a);
      return a.method === "eth_getTransactionReceipt" && out
        ? { ...out, transactionHash: other }
        : out;
    };
    try {
      const r = new Recorder(box.file, await h.fresh(box.file), 1, () => {});
      await r.install();
      try {
        const ir = await (
          await ethers.getContractFactory("IdentityRegistry")
        ).deploy();
        await ir.waitForDeployment();
      } finally {
        r.remove(); // killed before the next send confirms it
      }
    } finally {
      p.request = request;
    }
    expect(loadRecord(box.file)!.txs[0].minedAt).to.equal(undefined);
  });
});

describe("U2 a lagging node and an intent sent before the stop", function () {
  const box = h.files();
  it("K=3: an intent mined before the stop is adopted, not dropped and sent again", async function () {
    const rec = await h.fresh(box.file);
    const [d] = await ethers.getSigners();
    const nonce = await h.nonce();
    const f = await ethers.getContractFactory("IdentityRegistry");
    const data = (await f.getDeployTransaction()).data;
    rec.txs.push({
      from: d.address,
      to: null,
      value: "0",
      dataHash: ethers.keccak256(data),
      nonce,
      block: await ethers.provider.getBlockNumber(),
      status: "sending",
      label: "new IdentityRegistry",
    });
    saveRecord(box.file, rec);
    await (await d.sendTransaction({ data, nonce })).wait(); // its reply lost
    const p: any = network.provider;
    const request = p.request.bind(p);
    const K = 3;
    p.request = async (a: any) => {
      const seen = Number(await request({ method: "eth_blockNumber" })) - K;
      if (a.method === "eth_blockNumber") return ethers.toQuantity(seen);
      if (a.method === "eth_getTransactionCount")
        return request({
          method: a.method,
          params: [a.params[0], ethers.toQuantity(seen)],
        });
      return request(a);
    };
    try {
      await h.settle(box.file, loadRecord(box.file)!);
    } finally {
      p.request = request;
    }
    expect(loadRecord(box.file)!.txs.map((t) => t.status)).to.deep.equal([
      "confirmed",
    ]);
  });
});

describe("U2 keystore record writes", function () {
  it("forget writes through an exclusive temporary file too", function () {
    const { forget } = require("../../scripts/production/signerState");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "u2-forget-"));
    try {
      const file = path.join(dir, "signed-nonces");
      fs.writeFileSync(file, JSON.stringify({ "1:0xaa:7": {} }), {
        mode: 0o600,
      });
      fs.writeFileSync(`${file}.tmp-${process.pid}`, "planted");
      expect(() => forget(file, "0xaa", 7)).to.throw(
        /exists: refusing to write the signed-nonce record through it/,
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
