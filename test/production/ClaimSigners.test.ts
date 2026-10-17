import { expect } from "chai";
import { ethers } from "hardhat";
import * as fs from "fs";
import { handoverFixture } from "../helpers/governanceFixture";
import { captured, cliConfig } from "../helpers/handoverCli";
import { runHandover } from "../../scripts/handover";
import { handoverArgs } from "../../scripts/handoverConfig";
import {
  claimSignerSteps,
  parseSigners,
  probeSignature,
} from "../../scripts/production/claimSigners";

const { attestKyc } = require("../../demo/utils/Kyc");
const { claimSignerFacts } = require("../../demo/utils/HandoverClaimSigners");

/**
 * Task 5.15 (owner Q17 = A, readiness review M-2): after the ceremony the
 * issuer admin adds separate KYC and AML EOA claim signers
 * (scripts/production/claimSigners.ts); a claim they sign passes; the
 * day-2 audit accepts them only when listed in "claimSigners" and added
 * after the deployer's key was revoked; the completion accepts none.
 */
describe("Claim signers after the ceremony (Q17 = A)", function () {
  this.timeout(600_000);
  let f: Awaited<ReturnType<typeof handoverFixture>>;
  let cfg: Record<string, any>;
  let cfgPath: string;
  let dir: string;
  const out: string[] = [];
  const run = (phase: string) =>
    captured(out, () => runHandover(cfg, phase, cfgPath));
  const PASSED = "\n✅ Audit passed: the deployer holds no power.";
  let kyc: any;
  let aml: any;
  let rec: any;

  beforeEach(async function () {
    f = await handoverFixture();
    ({ cfg, cfgPath, dir } = await cliConfig(f));
    out.length = 0;
    const s = await ethers.getSigners();
    [kyc, aml] = [s[14], s[15]];
    rec = {
      contracts: {
        kycIssuer: await f.kycIssuer.getAddress(),
        // The fixture trusts one issuer: both signers go on it here.
        amlIssuer: await f.kycIssuer.getAddress(),
      },
    };
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  const steps = async (signers = { kyc: kyc.address, aml: aml.address }) => {
    const { args, wallet } = await handoverArgs(cfg, "audit", cfgPath);
    const voters = [cfg.proposer, ...cfg.voters].map(wallet);
    return claimSignerSteps(args, rec, signers, voters);
  };
  const execute = async (ss: any[]) => {
    for (const s of ss)
      await (await s.contract.connect(f.issuerAdmin)[s.fn](...s.args)).wait();
  };

  it("refuses before the ceremony, one key for both, and a voter's or node's key", async function () {
    await expect(steps()).to.be.rejectedWith(/finish the ceremony first/);
    expect(() =>
      parseSigners(`kyc:${ethers.ZeroAddress},aml:${ethers.ZeroAddress}`),
    ).to.throw(/separate keys/);
    expect(() => parseSigners("kyc:0x1")).to.throw(/not kyc:<address>/);
    await captured(out, () => runHandover(cfg, "full", cfgPath));
    const voter = (await ethers.getSigners())[cfg.voters[0]].address;
    await expect(steps({ kyc: voter, aml: aml.address })).to.be.rejectedWith(
      /a claim signer is a key of its own/,
    );
    await expect(
      steps({ kyc: kyc.address, aml: f.ops.address }),
    ).to.be.rejectedWith(/a claim signer is a key of its own/);
  });

  it("the admin's keys sign passing claims; the audit accepts them only when listed", async function () {
    await captured(out, () => runHandover(cfg, "full", cfgPath));
    const ss = await steps();
    expect(ss.map((s: any) => s.fn)).to.deep.equal([
      "addIssuerKey",
      "addIssuerKey",
    ]);
    expect(await Promise.all(ss.map((s: any) => s.status()))).to.deep.equal([
      "pending",
      "pending",
    ]);
    await execute(ss);
    expect(await Promise.all(ss.map((s: any) => s.status()))).to.deep.equal([
      "done",
      "done",
    ]);
    // The issuer accepts the new key's signature (the CLI's probe) and no
    // stranger's.
    const probeId = await f.c.identityRegistry.identity(f.voters[0].address);
    expect(await probeSignature(f.kycIssuer, kyc, probeId)).to.equal(true);
    expect(
      await probeSignature(
        f.kycIssuer,
        (await ethers.getSigners())[18],
        probeId,
      ),
    ).to.equal(false);
    // A claim the new KYC key signs is issued and live.
    const id = await f.c.identityRegistry.identity(f.voters[0].address);
    await attestKyc(f.kycIssuer, kyc, id, "renewed by the claim signer");
    expect(await f.kycIssuer.hasValidClaim(id, 6)).to.equal(true);
    const stranger = (await ethers.getSigners())[17];
    await expect(attestKyc(f.kycIssuer, stranger, id, "no key")).to.be.rejected;
    // Unlisted: the audit fails on both keys.
    out.length = 0;
    await expect(run("audit")).to.be.rejectedWith(/audit failed/);
    expect(out.join("\n")).to.match(/❌ .*every live key is issuerAdmin's/);
    // Listed: it passes, naming each.
    cfg.claimSigners = [kyc.address, aml.address];
    out.length = 0;
    await run("audit");
    expect(out).to.include(PASSED);
    expect(out.join("\n")).to.include(
      `claimSigners ${kyc.address}: a CLAIM_SIGNER key the issuer admin added after the ceremony`,
    );
    // A listed address no issuer holds is a stale acknowledgement.
    cfg.claimSigners.push((await ethers.getSigners())[16].address);
    out.length = 0;
    await expect(run("audit")).to.be.rejectedWith(/audit failed/);
    expect(out.join("\n")).to.match(
      /❌ claimSigners lists 0x[0-9a-fA-F]{40}, which no trusted issuer holds/,
    );
  });

  it("the ceremony's own completion accepts no claim signer", async function () {
    cfg.claimSigners = [kyc.address];
    // The deployer's era: a CLAIM_SIGNER key the deployer adds is a stray
    // the ceremony refuses, listed or not.
    await f.kycIssuer
      .connect(f.deployer)
      .addIssuerKey(
        ethers.solidityPackedKeccak256(["address"], [kyc.address]),
        3,
        1,
      );
    const err: any = await captured(out, () =>
      runHandover(cfg, "full", cfgPath),
    ).catch((e) => e);
    expect(err?.message).to.match(/CLAIM_SIGNER key 0x[0-9a-f]{64}/);
  });

  it("an acknowledged key added before the deployer's key was revoked is refused", async function () {
    const key = ethers.solidityPackedKeccak256(["address"], [kyc.address]);
    const dKey = ethers.solidityPackedKeccak256(
      ["address"],
      [f.deployer.address],
    );
    const ev = (block: number, index: number) => ({
      blockNumber: block,
      index,
    });
    const issuer = {
      filters: {
        IssuerKeyAdded: (k: string) => ({ kind: "added", k }),
        IssuerKeyRevoked: (k: string) => ({ kind: "revoked", k }),
      },
      queryFilter: async (q: any) =>
        q.kind === "added" && q.k === key
          ? [ev(5, 0)]
          : q.kind === "revoked" && q.k === dKey
            ? [ev(9, 0)]
            : [],
      getAddress: async () => ethers.ZeroAddress,
    };
    const facts = {
      dAddr: f.deployer.address,
      issuers: [{ issuer, label: "KYC", keys: [{ hash: key, purpose: 3 }] }],
    };
    const o = {
      audit: true,
      claimSigners: [kyc.address],
      voterWallets: [],
      fromBlock: 0,
      toBlock: 10,
    };
    const before = await claimSignerFacts(o, facts);
    expect(before.lines[0][1]).to.equal(false);
    // Added after the revocation: accepted.
    issuer.queryFilter = async (q: any) =>
      q.kind === "added" ? [ev(9, 1)] : q.kind === "revoked" ? [ev(9, 0)] : [];
    const after = await claimSignerFacts(o, facts);
    expect(after.lines[0][1]).to.equal(true);
    // A voter's key, or a MANAGEMENT key, is never accepted.
    const voter = await claimSignerFacts({ ...o, voterWallets: [kyc] }, facts);
    expect(voter.lines[0][1]).to.equal(false);
    expect(voter.lines[0][0]).to.contain("(it is a voter)");
    const mgmt = await claimSignerFacts(o, {
      ...facts,
      issuers: [{ ...facts.issuers[0], keys: [{ hash: key, purpose: 1 }] }],
    });
    expect(mgmt.lines[0][1]).to.equal(false);
    // Outside the audit nothing is accepted.
    expect(
      (await claimSignerFacts({ ...o, audit: false }, facts)).lines,
    ).to.deep.equal([]);
  });
});
