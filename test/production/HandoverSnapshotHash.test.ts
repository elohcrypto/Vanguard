import { expect } from "chai";
import { ethers } from "hardhat";
import { handoverFixture } from "../helpers/governanceFixture";
import { captured, cliConfig } from "../helpers/handoverCli";
import { runHandover } from "../../scripts/handover";
import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";

const COMPLETE = "\n✅ Handover complete: the deployer holds no power.";
const sha = (p: string) =>
  crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");

/**
 * Plan v2 Task 5.6b (review B-6): the full phase writes the snapshot and
 * `<snapshot>.sha256` atomically (new path, then rename) and prints the
 * digest; the accept phase hashes the file before it parses it and
 * refuses a digest that differs from the sidecar's or from
 * HANDOVER_SNAPSHOT_SHA256. A directory it cannot write stops the full
 * phase before the deployer's first transaction; a read-only snapshot
 * left by an earlier run is replaced.
 */
describe("Handover snapshot hash (B-6, Task 5.6b)", function () {
  let f: Awaited<ReturnType<typeof handoverFixture>>;
  let cfg: Record<string, any>;
  let cfgPath: string;
  let dir: string;
  let snap: string;
  const out: string[] = [];
  const run = (phase: string) =>
    captured(out, () => runHandover(cfg, phase, cfgPath));

  beforeEach(async function () {
    f = await handoverFixture();
    ({ cfg, cfgPath, dir } = await cliConfig(f));
    snap = `${cfgPath}.snapshot.json`;
    out.length = 0;
  });
  afterEach(() => {
    fs.chmodSync(dir, 0o755);
    fs.rmSync(dir, { recursive: true, force: true });
    delete process.env.HANDOVER_SNAPSHOT_SHA256;
  });

  it("records and prints the digest; accept passes an untouched snapshot", async function () {
    await run("full");
    const digest = sha(snap);
    expect(fs.readFileSync(`${snap}.sha256`, "utf8")).to.equal(
      `${digest}  ${snap}\n`,
    );
    expect(out).to.include(
      `   snapshot sha256: ${digest} (in ${snap}.sha256; record this line outside the run directory)`,
    );
    expect(fs.readdirSync(dir).sort()).to.deep.equal([
      "handover.json.snapshot.json",
      "handover.json.snapshot.json.sha256",
    ]);
    process.env.HANDOVER_SNAPSHOT_SHA256 = digest.toUpperCase();
    out.length = 0;
    await run("accept");
    expect(out).to.include(
      `   snapshot sha256: ${digest} (matches the full phase's)`,
    );
    expect(out).to.include(COMPLETE);
  });

  it("accept refuses no digest, an edited snapshot (hash mismatch) and a missing sidecar", async function () {
    await run("full");
    const digest = sha(snap);
    // Round 2: the operator's digest is required (SnapshotDigestMissing).
    const none = (await run("accept").catch((e: Error) => e)) as Error;
    expect(none.name).to.equal("SnapshotDigestMissing");
    expect(none.message).to.equal(
      `snapshot digest missing: set HANDOVER_SNAPSHOT_SHA256 to the digest the full phase printed for ${snap} ("snapshot sha256: <hex>", recorded outside the run directory); the sidecar alone cannot prove the file was not rewritten with it`,
    );
    process.env.HANDOVER_SNAPSHOT_SHA256 = digest;
    const body = JSON.parse(fs.readFileSync(snap, "utf8"));
    body.snapshot.ceremonyTxs.pop(); // launder one ceremony transaction
    fs.writeFileSync(snap, JSON.stringify(body, null, 2));
    const err = (await run("accept").catch((e: Error) => e)) as Error;
    expect(err.name).to.equal("SnapshotHashMismatch");
    expect(err.message).to.equal(
      `snapshot hash mismatch: ${snap} hashes to ${sha(snap)}, but ${snap}.sha256 records ${digest}: the file was edited after the full phase wrote it; a completion against it is a re-run, not a pass`,
    );
    // Rewriting the sidecar too passes it; the recorded digest does not.
    fs.writeFileSync(`${snap}.sha256`, `${sha(snap)}  ${snap}\n`);
    await expect(run("accept")).to.be.rejectedWith(
      `snapshot hash mismatch: ${snap} hashes to ${sha(snap)}, but HANDOVER_SNAPSHOT_SHA256 is ${digest}`,
    );
    fs.rmSync(`${snap}.sha256`);
    await expect(run("accept")).to.be.rejectedWith(
      `snapshot hash mismatch: ${snap}.sha256 is missing`,
    );
  });

  it("refuses an unwritable directory before the deployer's first transaction", async function () {
    fs.chmodSync(dir, 0o555);
    const nonce = await ethers.provider.getTransactionCount(f.deployer.address);
    await expect(run("full")).to.be.rejectedWith(/EACCES: permission denied/);
    expect(
      await ethers.provider.getTransactionCount(f.deployer.address),
    ).to.equal(nonce);
    expect(out).to.not.include("🔑 Handover: deployer powers");
  });

  it("replaces a read-only snapshot an earlier run left, and cleans up on a refusal", async function () {
    fs.writeFileSync(snap, "{}");
    fs.writeFileSync(`${snap}.sha256`, "x");
    for (const p of [snap, `${snap}.sha256`]) fs.chmodSync(p, 0o444);
    const old = sha(snap);
    // A preflight refusal (after the files are reserved) removes them:
    // a node the deployer registered and the config does not acknowledge.
    const om = f.c.oracleManager;
    await om.registerOracle(f.stranger.address, "N", "d", 500);
    await expect(run("full")).to.be.rejectedWith(
      /registered but not acknowledged in the config's "oracleNodes"/,
    );
    expect(out).to.include("🔑 Handover: deployer powers");
    expect(fs.readdirSync(dir).sort()).to.deep.equal([
      "handover.json.snapshot.json",
      "handover.json.snapshot.json.sha256",
    ]);
    await om.removeOracle(f.stranger.address, "not a node");
    out.length = 0;
    await run("full");
    expect(out).to.include(`   (replaced a snapshot with sha256 ${old})`);
    expect(out).to.include(COMPLETE);
    expect(fs.readFileSync(`${snap}.sha256`, "utf8")).to.equal(
      `${sha(snap)}  ${snap}\n`,
    );
    expect(path.basename(snap)).to.equal("handover.json.snapshot.json");
  });

  it("never follows a symlink planted at a temporary path (R-56c-7)", async function () {
    const {
      reserveSnapshotFile,
      writeSnapshotFile,
    } = require("../../demo/utils/HandoverSnapshotFile");
    const victim = path.join(dir, "victim.txt");
    const plant = () => {
      for (const t of [`${snap}.tmp`, `${snap}.sha256.tmp`]) {
        fs.rmSync(t, { force: true });
        fs.symlinkSync(victim, t);
      }
    };
    fs.writeFileSync(victim, "keep");
    plant();
    reserveSnapshotFile(snap);
    expect(fs.readFileSync(victim, "utf8")).to.equal("keep");
    for (const t of [`${snap}.tmp`, `${snap}.sha256.tmp`])
      expect(fs.lstatSync(t).isSymbolicLink()).to.equal(false);
    plant(); // swapped in during the ceremony
    const { digest } = writeSnapshotFile(snap, { x: 1 });
    expect(fs.readFileSync(victim, "utf8")).to.equal("keep");
    expect(sha(snap)).to.equal(digest);
    expect(fs.lstatSync(snap).isSymbolicLink()).to.equal(false);
    // A link that reappears between the removal and the create (a race)
    // makes the exclusive create refuse; nothing is written through it.
    const nodeFs = require("fs");
    const rm = nodeFs.rmSync;
    nodeFs.rmSync = (t: string, o: any) => {
      rm(t, o);
      if (t.endsWith(".tmp")) fs.symlinkSync(victim, t);
    };
    try {
      expect(() => reserveSnapshotFile(snap)).to.throw(/EEXIST/);
    } finally {
      nodeFs.rmSync = rm;
    }
    expect(fs.readFileSync(victim, "utf8")).to.equal("keep");
  });
});
