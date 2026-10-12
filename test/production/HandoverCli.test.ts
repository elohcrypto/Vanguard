import { expect } from "chai";
import { ethers } from "hardhat";
import { ageVoters, handoverFixture } from "../helpers/governanceFixture";
import { attest } from "../helpers/kyc";
import { runHandover } from "../../scripts/handover";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

// M-1: the full phase writes `<config>.snapshot.json`; keep it in a tempdir.
const cfgPath = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), "hcli-")),
  "handover.json",
);
const snapPath = `${cfgPath}.snapshot.json`;

const {
  castAcceptanceVotes,
  handoverDeployerPowers,
  proposeAcceptOwnership,
  settleProposal,
} = require("../../demo/utils/Handover");
const { planFor } = require("../../demo/utils/HandoverChecks");
const {
  codeHashChecks,
  codeHashRefusal,
} = require("../../demo/utils/HandoverCodeHash");

// Review M5: scripts/handover.ts resumes after a partial run
// (HANDOVER_PHASE=accept) and checks the proposer and voters before step 1.
describe("Handover CLI (scripts/handover.ts)", function () {
  let f: Awaited<ReturnType<typeof handoverFixture>>;
  let cfg: Record<string, any>;
  let quiet: typeof console.log;

  beforeEach(async function () {
    f = await handoverFixture();
    const a = async (k: string) => f.c[k].getAddress();
    cfg = {
      token: await a("token"),
      governanceToken: await a("governanceToken"),
      identityRegistry: await a("identityRegistry"),
      complianceRules: await a("complianceRules"),
      oracleManager: await a("oracleManager"),
      governance: f.govAddr,
      investorTypeRegistry: await a("investorTypeRegistry"),
      dynamicListManager: await a("dynamicListManager"),
      escrowWalletFactory: await a("escrowWalletFactory"),
      onchainIDFactory: await a("onchainIDFactory"),
      privacyManager: await a("privacyManager"),
      zkVerifier: await a("zkVerifier"),
      oracles: [await f.args.oracles[0].getAddress()],
      issuers: [await f.args.issuers[0].getAddress()],
      fromBlock: f.args.fromBlock,
      logChunk: 100,
      // Signer order from handoverFixture.
      ops: 1,
      guardian: 2,
      issuerAdmin: 7,
      proposer: 4,
      voters: [5, 6],
    };
    quiet = console.log;
    console.log = () => {};
  });
  afterEach(function () {
    console.log = quiet;
    fs.rmSync(snapPath, { force: true });
  });

  it("the full phase completes and writes the preflight snapshot", async function () {
    // Review M-3: the scans start at the IdentityRegistry deploy block.
    cfg.fromBlock = (
      await f.c.identityRegistry.deploymentTransaction().wait()
    ).blockNumber;
    await runHandover(cfg, "full", cfgPath);
    const snap = JSON.parse(fs.readFileSync(snapPath, "utf8"));
    expect(snap.governance).to.equal(f.govAddr);
    expect(Object.keys(snap.snapshot.sets)).to.include("Token agents");
    expect(await f.c.token.owner()).to.equal(f.govAddr);
    // 2F.5: both factories and the issuer moved; ops never got the issuer.
    expect(await f.c.escrowWalletFactory.owner()).to.equal(f.govAddr);
    expect(await f.c.onchainIDFactory.owner()).to.equal(f.govAddr);
    expect(await f.kycIssuer.owner()).to.equal(f.issuerAdmin.address);
    // 3.3: both privacy contracts are governance's, ops publishes roots.
    expect(await f.c.privacyManager.owner()).to.equal(f.govAddr);
    expect(await f.c.zkVerifier.owner()).to.equal(f.govAddr);
    expect(await f.c.privacyManager.listOperator()).to.equal(f.ops.address);
  });

  // Review B-L3: the closing line follows the deployer-era warnings.
  it("closes with warnings while a deployer-trusted issuer key vouches", async function () {
    const out: string[] = [];
    console.log = (m: string) => out.push(m);
    await runHandover(cfg, "full", cfgPath);
    expect(out).to.include(
      "\n✅ Handover complete: the deployer holds no power.",
    );
    const g = await handoverFixture();
    const {
      attestorPublicKey,
      newAttestorKey,
    } = require("../../scripts/zk/attest");
    const { Ax, Ay } = await attestorPublicKey(newAttestorKey());
    await g.c.privacyManager.setTrustedAttestor(
      ethers.id("JURISDICTION_PROOF"),
      Ax,
      Ay,
      true,
    );
    const a = async (k: string) => g.c[k].getAddress();
    for (const k of Object.keys(g.c)) {
      if (k in cfg && k !== "governance") cfg[k] = await a(k);
    }
    cfg.governance = g.govAddr;
    cfg.oracles = [await g.args.oracles[0].getAddress()];
    cfg.issuers = [await g.args.issuers[0].getAddress()];
    cfg.attestors = [Ax.toString()]; // Task 4.13: acknowledged, so warned
    out.length = 0;
    await runHandover(cfg, "full", cfgPath);
    expect(out).to.include("\n⚠️  Handover complete with warnings: see above.");
    expect(out.join("\n")).to.not.include("holds no power");
    expect(out.join("\n")).to.include("was trusted by the deployer");
  });

  it("the full phase completes with oracles and issuers read from chain", async function () {
    const wl = f.args.oracles[0];
    await f.c.complianceRules.setWhitelistOracle(
      await f.c.token.getAddress(),
      await wl.getAddress(),
    );
    delete cfg.oracles;
    delete cfg.issuers;
    await runHandover(cfg, "full", cfgPath);
    expect(await wl.owner()).to.equal(f.ops.address);
    expect(await f.kycIssuer.owner()).to.equal(f.issuerAdmin.address);
  });

  // 2F.5 (M4, probe P7): a config that omits a bound oracle is refused.
  it("refuses a config that omits an oracle bound on chain", async function () {
    const bl = await (
      await ethers.getContractFactory("BlacklistOracle")
    ).deploy(await f.c.oracleManager.getAddress(), "BL", "d");
    const blAddr = await bl.getAddress();
    await f.c.complianceRules.setBlacklistOracle(
      await f.c.token.getAddress(),
      blAddr,
    );
    await refusedWithNoTx(
      "full",
      new RegExp(
        `config "oracles" omits ${blAddr} \\(an oracle ComplianceRules binds`,
      ),
    );
  });

  it("refuses a fromBlock after the IdentityRegistry deploy (review M-3)", async function () {
    cfg.fromBlock = await ethers.provider.getBlockNumber();
    await refusedWithNoTx(
      "full",
      new RegExp(
        `fromBlock ${cfg.fromBlock} is after the IdentityRegistry deploy`,
      ),
    );
  });

  it("refuses a config without the factory keys or with a bad issuerAdmin", async function () {
    delete cfg.onchainIDFactory;
    await refusedWithNoTx(
      "full",
      /missing "onchainIDFactory" \(an address, or null/,
    );
    cfg.onchainIDFactory = null;
    for (const k of ["privacyManager", "zkVerifier"]) {
      const keep = cfg[k];
      delete cfg[k];
      await refusedWithNoTx(
        "full",
        new RegExp(`missing "${k}" \\(an address, or null`),
      );
      cfg[k] = keep;
    }
    cfg.issuerAdmin = "9";
    await refusedWithNoTx("full", /"issuerAdmin" must be a wallet index/);
    delete cfg.issuerAdmin;
    await refusedWithNoTx("full", /issuerAdmin is required: 1 trusted issuer/);
  });

  // Review 3.3 MEDIUM-1: the code-hash refusal reaches the CLI unchanged.
  it("surfaces the code-hash refusal unchanged", async function () {
    const at = await (
      await ethers.getContractFactory("AlwaysTrueVerifier")
    ).deploy();
    await f.c.zkVerifier.updateVerifier("whitelist", await at.getAddress());
    const bad = (await codeHashChecks(null, [f.c.zkVerifier])).filter(
      (x: any) => !x.ok,
    );
    expect(bad).to.have.length(1);
    const nonce = await ethers.provider.getTransactionCount(f.deployer.address);
    const err = await runHandover(cfg, "full", cfgPath).catch((e: Error) => e);
    expect((err as Error).message).to.equal(
      `Handover: ${codeHashRefusal(bad[0])}`,
    );
    expect(
      await ethers.provider.getTransactionCount(f.deployer.address),
    ).to.equal(nonce);
  });

  it("the accept phase finishes a partial run, registry calls included", async function () {
    const { c, govAddr, proposer, voters } = f;
    // Option 83b gave governance the registry, so step 1 queues its calls
    // as proposals; the queue is then lost (a new process).
    const reg = c.investorTypeRegistry;
    await reg.transferOwnership(govAddr);
    const rid = await proposeAcceptOwnership(
      c.governance,
      proposer,
      reg,
      0,
      "R",
    );
    await castAcceptanceVotes(c.governance, rid, voters);
    await settleProposal(c.governance, rid, "R");
    const report = await handoverDeployerPowers(f.args);
    expect(report.registryProposals).to.have.length(2);
    // Every acceptance but OracleManager's is voted.
    for (const e of planFor(c)) {
      if (e.key === "oracleManager" || e.key === "investorTypeRegistry")
        continue;
      const id = await proposeAcceptOwnership(
        c.governance,
        proposer,
        c[e.key],
        e.proposalType,
        e.label,
      );
      await castAcceptanceVotes(c.governance, id, voters);
      await settleProposal(c.governance, id, e.label);
    }
    expect(await c.oracleManager.owner()).to.equal(f.deployer.address);
    // A full re-run is refused: governance already owns Token.
    await expect(runHandover(cfg, "full", cfgPath)).to.be.rejectedWith(
      /does not own Token/,
    );
    // M-1: without the full phase's snapshot file the accept phase refuses;
    // the operator keeps the one the full phase wrote before it stopped.
    await expect(runHandover(cfg, "accept", cfgPath)).to.be.rejectedWith(
      /no preflight snapshot from the full phase/,
    );
    fs.writeFileSync(
      snapPath,
      JSON.stringify({
        governance: govAddr,
        chainId: 31337,
        block: report.preflightBlock,
        snapshot: report.snapshot,
      }),
    );
    await runHandover(cfg, "accept", cfgPath);
    expect(await c.oracleManager.owner()).to.equal(govAddr);
    expect(await reg.isComplianceOfficer(f.ops.address)).to.equal(true);
    expect(await reg.isComplianceOfficer(f.deployer.address)).to.equal(false);
  });

  it("refuses an unverified voter before any transaction", async function () {
    cfg.voters = [5, 3]; // 3 is the unverified stranger
    const nonce = await ethers.provider.getTransactionCount(f.deployer.address);
    await expect(runHandover(cfg, "full", cfgPath)).to.be.rejectedWith(
      /voter 0x[0-9a-fA-F]+ is not verified/,
    );
    expect(
      await ethers.provider.getTransactionCount(f.deployer.address),
    ).to.equal(nonce);
  });

  it("refuses a voter without VGT for every vote", async function () {
    const bob = f.voters[0];
    const vgt = f.c.governanceToken;
    await vgt
      .connect(bob)
      .transfer(f.proposer.address, (await vgt.balanceOf(bob.address)) - 1n);
    await expect(runHandover(cfg, "full", cfgPath)).to.be.rejectedWith(
      // Twelve plan contracts, votingCost 10 VGT each.
      /voter .* holds 0\.0+1 free VGT; 12 proposal\(s\) need 120\.0/,
    );
  });

  /** runHandover(cfg, phase, cfgPath) rejects with `msg`; the deployer sends nothing. */
  async function refusedWithNoTx(phase: string, msg: RegExp) {
    const nonce = await ethers.provider.getTransactionCount(f.deployer.address);
    await expect(runHandover(cfg, phase, cfgPath)).to.be.rejectedWith(msg);
    expect(
      await ethers.provider.getTransactionCount(f.deployer.address),
    ).to.equal(nonce);
  }

  /** M-1: the accept phase needs the full phase's snapshot file first. */
  const snapshotFile = () =>
    fs.writeFileSync(
      snapPath,
      JSON.stringify({
        governance: f.govAddr,
        chainId: 31337,
        block: 0,
        snapshot: null,
      }),
    );

  it("refuses the accept phase when step 1 never ran (L-A)", async function () {
    snapshotFile();
    // L-13: with no step 1 on chain the preflight cannot be placed.
    await refusedWithNoTx(
      "accept",
      /step 1's first transaction \(AgentAdded\(ops\) on VSC\) not found/,
    );
  });

  it("refuses the accept phase naming the contracts not nominated", async function () {
    snapshotFile();
    await f.c.token.transferOwnership(f.govAddr);
    await refusedWithNoTx(
      "accept",
      /step 1's first transaction \(AgentAdded\(ops\) on VSC\) not found/,
    );
  });

  it("refuses a duplicate voter (L-B)", async function () {
    cfg.voters = [5, 6, 5];
    await refusedWithNoTx("full", /voter 0x[0-9a-fA-F]+ is listed twice/);
  });

  it("refuses too few voters for the highest quorum in the plan (L-B)", async function () {
    // Four registered identities: one vote is 25%, under TokenParameters' 30%.
    const id = await (
      await ethers.getContractFactory("OnchainID")
    ).deploy(f.stranger.address);
    await f.c.identityRegistry.registerIdentity(
      f.stranger.address,
      await id.getAddress(),
      840,
    );
    // Quorum counts identities at least minVoterAge old (D25).
    await ageVoters(f.c.governance);
    cfg.voters = [5];
    await refusedWithNoTx(
      "full",
      /1 voter\(s\) cannot reach the TokenParameters quorum \(30% of 4 registered identities old enough to vote\)/,
    );
  });

  it("refuses a voter whose identity is younger than minVoterAge (D25)", async function () {
    // The stranger is verified and funded, but registered just now.
    const id = await (
      await ethers.getContractFactory("OnchainID")
    ).deploy(f.stranger.address);
    await f.c.identityRegistry.registerIdentity(
      f.stranger.address,
      await id.getAddress(),
      840,
    );
    await attest(f.kycIssuer, f.deployer, await id.getAddress());
    await f.c.governanceToken.mint(
      f.stranger.address,
      ethers.parseEther("1000"),
    );
    cfg.voters = [5, 6, 3];
    await refusedWithNoTx(
      "full",
      /voter 0x[0-9a-fA-F]+ has an identity younger than minVoterAge .*register voters at least 7 days/,
    );
  });

  it("refuses a voter whose wallet does not control its identity (review L-2)", async function () {
    // Verified, funded and aged, but the OnchainID is the deployer's and the
    // stranger holds no key on it: castVote would revert mid-ceremony.
    // Bound with control (an ACTION key, D41), which the identity's owner
    // then removes: the registry keeps the binding (binding-time rule,
    // R-414-11) and the ceremony's own check must catch the voter.
    const OID = await ethers.getContractFactory("OnchainID");
    const id = await OID.deploy(f.deployer.address);
    const strangerKey = ethers.solidityPackedKeccak256(
      ["address"],
      [f.stranger.address],
    );
    await id.connect(f.deployer).addKey(strangerKey, 2, 1);
    await f.c.identityRegistry.registerIdentity(
      f.stranger.address,
      await id.getAddress(),
      840,
    );
    await id.connect(f.deployer).removeKey(strangerKey, 2);
    await attest(f.kycIssuer, f.deployer, await id.getAddress());
    await f.c.governanceToken.mint(
      f.stranger.address,
      ethers.parseEther("1000"),
    );
    await ageVoters(f.c.governance);
    cfg.voters = [5, 6, 3];
    await refusedWithNoTx(
      "full",
      /voter 0x[0-9a-fA-F]+ does not control its identity .*"Wallet does not control its identity"\): the identity's owner must addKey/,
    );
  });

  // R-413-12 through the JSON config (N-1): null must reach the ceremony.
  it("refuses a null key the chain derives; an underivable null is never green", async function () {
    await f.c.complianceRules.setPrivacyManager(
      await f.c.token.getAddress(),
      await f.c.privacyManager.getAddress(),
    );
    await f.c.complianceRules.setWhitelistMode(await f.c.token.getAddress(), 2);
    cfg.zkVerifier = null;
    await refusedWithNoTx(
      "full",
      /config "zkVerifier" is null \(asserts none\), but PrivacyManager .* zkVerifier\(\) is/,
    );
    cfg.zkVerifier = await f.c.zkVerifier.getAddress();
    cfg.privacyManager = null;
    await refusedWithNoTx(
      "full",
      /config "privacyManager" is null \(asserts none\), but ComplianceRules.privacyManager\(VSC\) is/,
    );
    // Unwired on a fresh fixture: both null complete, with the warning.
    const g = await handoverFixture();
    const b = async (k: string) => g.c[k].getAddress();
    for (const k of Object.keys(g.c))
      if (k in cfg && k !== "governance") cfg[k] = await b(k);
    cfg.governance = g.govAddr;
    cfg.oracles = [await g.args.oracles[0].getAddress()];
    cfg.issuers = [await g.args.issuers[0].getAddress()];
    cfg.privacyManager = null;
    cfg.zkVerifier = null;
    const out: string[] = [];
    console.log = (m: string) => out.push(m);
    await runHandover(cfg, "full", cfgPath);
    expect(out).to.include("\n⚠️  Handover complete with warnings: see above.");
    expect(out.join("\n")).to.not.include("holds no power");
    expect(out.join("\n")).to.include(
      'config "privacyManager" is null and governance derives none',
    );
  });

  // L-9: the snapshot file names the chain and the preflight block.
  it("the accept phase refuses a snapshot from another chain or after step 1", async function () {
    const report = await handoverDeployerPowers(f.args);
    const write = (o: object) =>
      fs.writeFileSync(
        snapPath,
        JSON.stringify({
          governance: f.govAddr,
          snapshot: report.snapshot,
          ...o,
        }),
      );
    const chainId = Number((await ethers.provider.getNetwork()).chainId);
    write({ chainId: chainId + 1, block: report.preflightBlock });
    await expect(runHandover(cfg, "accept", cfgPath)).to.be.rejectedWith(
      /was taken on chain/,
    );
    write({ chainId, block: await ethers.provider.getBlockNumber() });
    await expect(runHandover(cfg, "accept", cfgPath)).to.be.rejectedWith(
      /after step 1 began at block/,
    );
    // L-13: no NaN passes; a missing step-1 event cannot place it.
    for (const bad of [{ chainId }, { chainId, block: "abc" }, { block: 1 }]) {
      write(bad);
      await expect(runHandover(cfg, "accept", cfgPath)).to.be.rejectedWith(
        /"chainId" and "block" must be integers/,
      );
    }
  });
});
