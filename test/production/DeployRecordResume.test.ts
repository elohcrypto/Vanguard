import { expect } from "chai";
import { ethers, network } from "hardhat";
import * as fs from "fs";
import {
  DeployRecord,
  loadRecord,
  lockRecord,
  saveRecord,
  TxEntry,
} from "../../scripts/production/deployRecordFile";
import * as h from "../helpers/deployRecordFlow";

/**
 * Plan v2 Task 5.7 (review fix round): the deploy record across a stop.
 * A sent transaction the node no longer knows is adopted from the chain,
 * dropped back to unsent, or refused with the reason (M-2); every check
 * that settles a record or replays it refuses what it exists to refuse
 * (M-3); one process at a time holds the record (L-2), written durably
 * (L-3).
 */
describe("Production deploy record: resume and refusals (Task 5.7)", function () {
  const box = h.files();
  const run = (rec: DeployRecord, f: () => Promise<any> = () => h.flow()) =>
    h.run(box.file, rec, f);
  const load = () => loadRecord(box.file)!;
  const write = (rec: DeployRecord) => saveRecord(box.file, rec);
  const signer = async (i: number) => (await ethers.getSigners())[i];

  /** The first three steps recorded and settled; the fourth not sent. */
  async function three(): Promise<DeployRecord> {
    await expect(
      run(await h.fresh(box.file), () => h.flow(3)),
    ).to.be.rejectedWith("killed");
    await h.settle(box.file, load());
    return load();
  }

  /** The fourth step (addAgent(km)) as an entry at the deployer's nonce. */
  async function fourth(rec: DeployRecord, extra: Partial<TxEntry>) {
    const ir = await ethers.getContractAt(
      "IdentityRegistry",
      rec.txs[0].contract!,
    );
    const data = ir.interface.encodeFunctionData("addAgent", [
      rec.txs[2].contract!,
    ]);
    const e: TxEntry = {
      from: (await signer(0)).address,
      to: rec.txs[0].contract!,
      value: "0",
      dataHash: ethers.keccak256(data),
      nonce: await h.nonce(),
      block: await ethers.provider.getBlockNumber(),
      status: "sent",
      hash: ethers.id("evicted"),
      label: "addAgent",
      ...extra,
    };
    write({ ...rec, txs: [...rec.txs, e] });
    return { e, data, to: e.to! };
  }

  async function pending(f: () => Promise<unknown>) {
    await network.provider.send("evm_setAutomine", [false]);
    try {
      await f();
    } finally {
      await network.provider.send("evm_setAutomine", [true]);
      await network.provider.send("evm_mine", []);
    }
  }

  describe("a sent transaction the node does not know (M-2)", function () {
    it("is adopted when the chain holds the same transaction at its nonce", async function () {
      await run(await h.fresh(box.file));
      const rec = load();
      const real = rec.txs[3].hash;
      rec.txs[3].hash = ethers.id("replaced");
      rec.txs[3].status = "sent";
      write(rec);
      const b = await run(load());
      expect(load().txs[3].hash).to.equal(real);
      expect([b.r.sent, b.r.reused]).to.deep.equal([0, 4]);
    });

    it("is dropped back to unsent when its nonce is unused and nothing is pending", async function () {
      const rec = await three();
      await fourth(rec, {});
      const before = await h.nonce();
      await h.settle(box.file, load());
      expect(load().txs).to.have.length(3);
      const b = await run(load());
      expect([b.r.sent, b.r.reused]).to.deep.equal([1, 3]);
      expect(await h.nonce()).to.equal(before + 1);
    });

    it("is refused when its nonce went to another transaction, or one is pending there", async function () {
      const rec = await three();
      const d = await signer(0);
      const { e } = await fourth(rec, {});
      await pending(async () => {
        await d.sendTransaction({ to: d.address, nonce: e.nonce });
        await expect(h.settle(box.file, load())).to.be.rejectedWith(
          `record entry #3 (addAgent): ${e.hash} is unknown to the node and ${d.address}'s nonce ${e.nonce} is pending with another transaction: wait for it to mine, then re-run`,
        );
      });
      await expect(h.settle(box.file, load())).to.be.rejectedWith(
        new RegExp(
          `record entry #3 \\(addAgent\\): ${e.hash} is unknown to the node and ${d.address}'s nonce ${e.nonce} went to 0x[0-9a-f]{64}, another transaction: refusing`,
        ),
      );
    });
  });

  // Re-review L-b: the same calldata at the nonce with another value is
  // another transaction, never the entry.
  it("refuses a mined transaction at its nonce that differs only in value", async function () {
    const pay = async () =>
      (
        await (await signer(0)).sendTransaction({ to: h.AGENT, value: 1n })
      ).wait();
    await run(await h.fresh(box.file), pay);
    const rec = load();
    Object.assign(rec.txs[0], {
      hash: ethers.id("replaced"),
      status: "sent",
      value: "2",
    });
    write(rec);
    await expect(h.settle(box.file, load())).to.be.rejectedWith(
      /record entry #0 \(.*\): 0x[0-9a-f]{64} is unknown to the node and 0x[0-9a-fA-F]{40}'s nonce \d+ went to 0x[0-9a-f]{64}, another transaction: refusing/,
    );
  });

  describe("each check refuses (M-3)", function () {
    it("a record for another chain", async function () {
      const rec = await h.fresh(box.file);
      await expect(run({ ...rec, chainId: 1 })).to.be.rejectedWith(
        `${box.file} is for chain 1, not 31337`,
      );
    });

    it("an intent whose nonce went to a different transaction", async function () {
      const rec = await three();
      const d = await signer(0);
      const { e } = await fourth(rec, { status: "sending", hash: undefined });
      await (await d.sendTransaction({ to: d.address, nonce: e.nonce })).wait();
      await expect(h.settle(box.file, load())).to.be.rejectedWith(
        `${d.address} used nonce ${e.nonce} for a transaction that is not record entry #3 (addAgent): refusing`,
      );
    });

    it("an intent whose nonce is still pending", async function () {
      const rec = await three();
      const { e, data, to } = await fourth(rec, {
        status: "sending",
        hash: undefined,
      });
      await pending(async () => {
        await (await signer(0)).sendTransaction({ to, data, nonce: e.nonce });
        await expect(h.settle(box.file, load())).to.be.rejectedWith(
          `nonce ${e.nonce} is pending (addAgent): wait for it to mine, then re-run`,
        );
      });
    });

    it("a replay that sends another value", async function () {
      const pay = (v: bigint) => async () =>
        (
          await (await signer(0)).sendTransaction({ to: h.AGENT, value: v })
        ).wait();
      await run(await h.fresh(box.file), pay(1n));
      await expect(run(load(), pay(2n))).to.be.rejectedWith(
        "the deploy diverged from its record at entry #0",
      );
    });

    it("a recorded sender the chain does not show", async function () {
      const two = async () => {
        await (await (await signer(1)).sendTransaction({ to: h.AGENT })).wait();
        await (await (await signer(0)).sendTransaction({ to: h.AGENT })).wait();
      };
      await run(await h.fresh(box.file), two);
      const rec = load();
      rec.txs[0].from = (await signer(2)).address;
      write(rec);
      await expect(h.settle(box.file, load())).to.be.rejectedWith(
        `record entry #0 (${rec.txs[0].label}): transaction ${rec.txs[0].hash} is not on chain as recorded: refusing`,
      );
    });

    it("keeps the intent on disk before the transaction leaves", async function () {
      const d = await signer(0);
      const n = await h.nonce();
      const bad = async () => {
        const ir = await (
          await ethers.getContractFactory("IdentityRegistry")
        ).deploy();
        await ir.waitForDeployment();
        // No such function: the send itself fails, after the intent.
        const to = await ir.getAddress();
        const data = "0xdeadbeef";
        await (await d.sendTransaction({ to, data, gasLimit: 100_000 })).wait();
      };
      await expect(run(await h.fresh(box.file), bad)).to.be.rejectedWith(
        "function selector was not recognized",
      );
      expect(load().txs[1]).to.include({ status: "sending", nonce: n + 1 });
      await h.settle(box.file, load());
      expect(load().txs[1].status).to.equal("reverted");
    });
  });

  describe("the record file", function () {
    it("is held by one process: a second is refused with the holder's pid (L-2)", function () {
      const release = lockRecord(box.file);
      try {
        expect(() => lockRecord(box.file)).to.throw(
          `${box.file}.lock is held by pid ${process.pid}: another deploy on this record? If none is running, remove it (rm ${box.file}.lock) and re-run`,
        );
      } finally {
        release();
      }
      lockRecord(box.file)();
      expect(fs.existsSync(`${box.file}.lock`)).to.equal(false);
    });

    it("is synced with its directory after the rename (L-3)", async function () {
      // The module object itself: the import binding is read-only.
      const nodeFs = require("fs");
      const synced: number[] = [];
      const real = nodeFs.fsyncSync;
      nodeFs.fsyncSync = (fd: number) => {
        synced.push(fd);
        return real(fd);
      };
      try {
        await h.fresh(box.file);
      } finally {
        nodeFs.fsyncSync = real;
      }
      expect(synced).to.have.length(2);
    });
  });
});
