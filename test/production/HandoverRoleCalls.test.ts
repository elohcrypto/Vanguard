import { expect } from "chai";
import { ethers } from "hardhat";
import { handoverFixture } from "../helpers/governanceFixture";
import { runHandover } from "../../scripts/handover";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const {
  batchProblems,
  checksumOf,
  resolveRole,
} = require("../../demo/utils/RoleCalls");
const { keyOf } = require("../../demo/utils/HandoverChecks");
const { handoverDeployerPowers } = require("../../demo/utils/Handover");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hroles-"));
const cfgPath = path.join(dir, "handover.json");
const snapPath = `${cfgPath}.snapshot.json`;
const opsFile = `${cfgPath}.ops-transactions.json`;
const adminFile = `${cfgPath}.issuer-admin-transactions.json`;
const read = (f: string) => JSON.parse(fs.readFileSync(f, "utf8"));
type Call = { to: string; value: string; data: string };

/**
 * Plan v2 Task 5.13 (Q11 = B): ops and the issuer admin as 2-of-2
 * TestMultisig contracts. The full phase exports their calls as Safe
 * batches and stops before any vote; the accept phase proves every
 * effect on chain first. Unexecuted, altered and extra executions refuse.
 */
describe("Handover with a multisig ops and issuer admin (Task 5.13)", function () {
  let f: Awaited<ReturnType<typeof handoverFixture>>;
  let cfg: Record<string, any>;
  let ms: Record<string, any>;
  let out: string[];
  let quiet: typeof console.log;

  /** Both owners approve `calls`, the first executes them. */
  async function exec(m: any, calls: Call[]) {
    const s = await ethers.getSigners();
    const owners = m === ms.ops ? [s[10], s[11]] : [s[12], s[13]];
    const c = calls.map((x) => ({ to: x.to, value: x.value, data: x.data }));
    const h = await m.hashOf(c);
    for (const o of owners) await (await m.connect(o).approve(h)).wait();
    await (await m.connect(owners[0]).execute(c)).wait();
  }
  const batch = (file: string): Call[] => read(file).transactions;
  const pending = (p: Promise<unknown>) =>
    expect(p)
      .to.be.rejectedWith("awaiting")
      .then((e: any) => {
        expect(e.name).to.equal("RoleCallsPending");
        return e;
      });

  beforeEach(async function () {
    const s = await ethers.getSigners();
    const make = async (a: any, b: any) =>
      (await ethers.getContractFactory("TestMultisig")).deploy(
        [a.address, b.address],
        2,
      );
    ms = { ops: await make(s[10], s[11]), admin: await make(s[12], s[13]) };
    const opsMs = await ms.ops.getAddress();
    // Custody's bank is ops, immutable: the ops multisig from the start.
    f = await handoverFixture({
      bank: {
        address: opsMs,
        accept: async (m: any) =>
          exec(ms.ops, [
            {
              to: await m.getAddress(),
              value: "0",
              data: m.interface.encodeFunctionData("acceptOwnership"),
            },
          ]),
      },
    });
    const a = async (k: string) => f.c[k].getAddress();
    cfg = {
      governance: f.govAddr,
      escrowWalletFactory: await a("escrowWalletFactory"),
      onchainIDFactory: await a("onchainIDFactory"),
      privacyManager: await a("privacyManager"),
      zkVerifier: await a("zkVerifier"),
      oracles: [await f.args.oracles[0].getAddress()],
      issuers: [await f.args.issuers[0].getAddress()],
      fromBlock: f.args.fromBlock,
      logChunk: 100,
      feeWallets: [f.feeWallet.address],
      ops: opsMs,
      guardian: 2,
      issuerAdmin: await ms.admin.getAddress(),
      proposer: 4,
      voters: [5, 6],
    };
    out = [];
    quiet = console.log;
    console.log = (m: string) => void out.push(String(m));
  });
  afterEach(function () {
    console.log = quiet;
    for (const p of fs.readdirSync(dir)) fs.rmSync(path.join(dir, p));
    delete process.env.HANDOVER_SNAPSHOT_SHA256;
  });

  /** The full phase up to its pause; the digest for the accept phase. */
  async function pause() {
    const e = await pending(runHandover(cfg, "full", cfgPath));
    process.env.HANDOVER_SNAPSHOT_SHA256 = fs
      .readFileSync(`${snapPath}.sha256`, "utf8")
      .trim()
      .split(/\s+/)[0];
    return e;
  }

  it("exports Safe batches and stops before any vote; resumes once executed", async function () {
    const e = await pause();
    expect(e.lines).to.include(`⏸️  awaiting 1 ops transaction: ${opsFile}`);
    expect(e.lines).to.include(
      `⏸️  awaiting 2 issuerAdmin transactions: ${adminFile}`,
    );
    for (const file of [opsFile, adminFile])
      expect(batchProblems(read(file))).to.deep.equal([]);
    const meta = read(adminFile).meta;
    expect(meta.createdFromSafeAddress).to.equal(cfg.issuerAdmin);
    expect(meta.description).to.match(
      /1\. \[handover\.issuer\.accept\] ClaimIssuer 0x[0-9a-fA-F]{40}\.acceptOwnership\(\): /,
    );
    expect(meta.description).to.include(
      `revokeIssuerKey(${keyOf(f.deployer.address)})`,
    );
    expect(read(opsFile).meta.description).to.include("WhitelistOracle");
    // Nominated, not accepted; no vote was run.
    const oracle = f.args.oracles[0];
    expect(await oracle.pendingOwner()).to.equal(cfg.ops);
    expect(await f.kycIssuer.pendingOwner()).to.equal(cfg.issuerAdmin);
    expect(await f.c.token.pendingOwner()).to.equal(f.govAddr);
    expect(await f.c.token.owner()).to.equal(f.deployer.address);
    // The accept phase before execution: refused, nothing sent.
    const block = await ethers.provider.getBlockNumber();
    const again = await pending(runHandover(cfg, "accept", cfgPath));
    expect(again.lines).to.include(
      `⏸️  awaiting 1 ops transaction: ${opsFile}`,
    );
    expect(out.join("\n")).to.include(
      "❌ not executed: [handover.oracle.accept]",
    );
    expect(await ethers.provider.getBlockNumber()).to.equal(block);
    // A full re-run before execution: refused before any send.
    await expect(runHandover(cfg, "full", cfgPath)).to.be.rejectedWith(
      "a full re-run would send them again",
    );
    expect(await ethers.provider.getBlockNumber()).to.equal(block);
    await exec(ms.ops, batch(opsFile));
    await exec(ms.admin, batch(adminFile));
    out.length = 0;
    await runHandover(cfg, "accept", cfgPath);
    const text = out.join("\n");
    expect(text).to.include("✅ 3 role transaction effect(s) hold on chain");
    expect(text).to.match(/Handover complete/);
    expect(text).to.not.include("❌");
    expect(await f.c.token.owner()).to.equal(f.govAddr);
    expect(await oracle.owner()).to.equal(cfg.ops);
    expect(await f.kycIssuer.owner()).to.equal(cfg.issuerAdmin);
  });

  it("re-exports only the calls whose effect does not hold", async function () {
    await pause();
    await exec(ms.ops, batch(opsFile));
    await exec(ms.admin, batch(adminFile).slice(0, 1)); // accept, no revoke
    const e = await pending(runHandover(cfg, "accept", cfgPath));
    expect(e.lines).to.include(
      `⏸️  awaiting 1 issuerAdmin transaction: ${adminFile}`,
    );
    expect(e.files).to.deep.equal([adminFile]);
    const left = read(adminFile);
    expect(left.transactions).to.have.length(1);
    expect(left.meta.description).to.include("handover.issuer.revoke");
    expect(batchProblems(left)).to.deep.equal([]);
  });

  it("refuses an execution with another effect, naming the call", async function () {
    await pause();
    const oracle = f.args.oracles[0];
    const moveOn = oracle.interface.encodeFunctionData("transferOwnership", [
      f.stranger.address,
    ]);
    // ops accepts, then nominates a stranger: the oracle is moving on.
    await exec(ms.ops, [
      ...batch(opsFile),
      { to: cfg.oracles[0], value: "0", data: moveOn },
    ]);
    // The admin revokes its own key instead of the deployer's.
    const [acceptCall] = batch(adminFile);
    const wrong = f.kycIssuer.interface.encodeFunctionData("revokeIssuerKey", [
      keyOf(cfg.issuerAdmin),
    ]);
    await exec(ms.admin, [
      acceptCall,
      { to: cfg.issuers[0], value: "0", data: wrong },
    ]);
    const block = await ethers.provider.getBlockNumber();
    await expect(runHandover(cfg, "accept", cfgPath)).to.be.rejectedWith(
      /another effect than exported[\s\S]*handover\.issuer\.revoke\][^\n]*MANAGEMENT_KEY is not live[\s\S]*handover\.oracle\.accept\][^\n]*ownership is moving on/,
    );
    expect(await ethers.provider.getBlockNumber()).to.equal(block);
  });

  it("a call executed on the wrong contract is not executed", async function () {
    await pause();
    // ops sends the acceptance to the issuer instead of the oracle: not
    // its nominee, so the multisig batch reverts and the oracle waits.
    const [call] = batch(opsFile);
    await exec(ms.admin, batch(adminFile));
    await expect(
      exec(ms.ops, [{ ...call, to: cfg.issuers[0] }]),
    ).to.be.revertedWithCustomError(ms.ops, "CallFailed");
    const e = await pending(runHandover(cfg, "accept", cfgPath));
    expect(e.lines.join("\n")).to.include("[handover.oracle.accept]");
  });

  it("completion refuses an extra issuer key the admin multisig added", async function () {
    await pause();
    await exec(ms.ops, batch(opsFile));
    const extra = f.kycIssuer.interface.encodeFunctionData("addIssuerKey", [
      keyOf(f.stranger.address),
      3,
      1,
    ]);
    await exec(ms.admin, [
      ...batch(adminFile),
      { to: cfg.issuers[0], value: "0", data: extra },
    ]);
    await expect(runHandover(cfg, "accept", cfgPath)).to.be.rejectedWith(
      "handover incomplete",
    );
    expect(out.join("\n")).to.match(/❌ .*IssuerKeyAdded/);
  });

  it("preflight passes with an external issuer admin; a non-signer admin still fails", async function () {
    await runHandover(cfg, "preflight", cfgPath);
    expect(out.join("\n")).to.include("✅ Preflight passed");
    expect(out.join("\n")).to.include(
      `ℹ️  issuerAdmin ${cfg.issuerAdmin} is external`,
    );
    // Not marked external (a bare address, as before 5.13): refused.
    await expect(
      handoverDeployerPowers({ ...f.args, issuerAdmin: cfg.issuerAdmin }),
    ).to.be.rejectedWith("issuerAdmin must be a signer to accept ownership");
  });

  it("a contract ops is no stray officer; a stray officer contract still is", async function () {
    const {
      custodyOwnerLines,
    } = require("../../demo/utils/HandoverRegistrars");
    const { trustLines } = require("../../demo/utils/HandoverTrust");
    const { withDerivedContracts } = require("../../demo/utils/HandoverDerive");
    const { withBoundRegistry } = require("../../demo/utils/HandoverChecks");
    const { externalRole } = require("../../demo/utils/RoleCalls");
    const s = await ethers.getSigners();
    const stray = await (
      await ethers.getContractFactory("TestMultisig")
    ).deploy([s[14].address], 1);
    const reg = f.c.investorTypeRegistry;
    for (const a of [cfg.ops, await stray.getAddress()])
      await (await reg.setComplianceOfficer(a, true)).wait();
    const o = await withBoundRegistry(
      await withDerivedContracts({
        ...f.args,
        ops: externalRole(cfg.ops, "ops"),
      }),
    );
    const lines = async () => [
      ...(await custodyOwnerLines(o, f.deployer.address, cfg.ops, f.govAddr)),
      ...(await trustLines(o)),
    ];
    const bad = (await lines()).filter(([, ok]) => !ok).map(([l]) => l);
    expect(bad.join("\n")).to.include(await stray.getAddress());
    expect(bad.join("\n")).to.not.include(cfg.ops);
    await (
      await reg.setComplianceOfficer(await stray.getAddress(), false)
    ).wait();
    // (The escrow factory is the deployer's until step 3: not judged here.)
    const after = (await lines()).filter(([, ok]) => !ok).map(([l]) => l);
    expect(after.join("\n")).to.not.include(await stray.getAddress());
    expect(after.join("\n")).to.not.include(cfg.ops);
  });

  it("a signer is external only when its address holds code", async function () {
    const s = await ethers.getSigners();
    expect(await resolveRole(s[15], "ops")).to.equal(s[15]);
    await ethers.provider.send("hardhat_setCode", [s[15].address, "0x00"]);
    const r = await resolveRole(s[15], "ops");
    expect(r).to.deep.equal({
      address: s[15].address,
      external: true,
      label: "ops",
    });
    // A wallet with code cannot send (EIP-3607): leave it as found.
    await ethers.provider.send("hardhat_setCode", [s[15].address, "0x"]);
  });

  it("the batch file is checked like Safe's import", async function () {
    await pause();
    const b = read(adminFile);
    expect(b.version).to.equal("1.0");
    expect(b.chainId).to.equal("31337");
    expect(b.meta.checksum).to.equal(checksumOf(b));
    const edited = { ...b, transactions: [{ ...b.transactions[0], value: 0 }] };
    expect(batchProblems(edited)).to.include.members([
      "transactions[0].value is not a string",
      "meta.checksum does not match the file",
    ]);
    expect(batchProblems({ ...b, extra: 1 })).to.include(
      'file: unknown key "extra"',
    );
  });
});
