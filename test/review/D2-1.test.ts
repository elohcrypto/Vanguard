// D2-1: a ClaimIssuer the deployer owns, trusted by the IdentityRegistry
// for a topic that is not (yet) required, is derived from the
// TrustedIssuerAdded scan: a config that omits it is refused, and a config
// that leaves "issuers" out hands it to issuerAdmin, so it cannot decide
// that topic for the deployer once governance requires it.
import { expect } from "chai";
import { ethers, network } from "hardhat";
import { handoverFixture } from "../helpers/governanceFixture";
import { runHandover } from "../../scripts/handover";
import { AML_TOPIC, attest, deployIdentity } from "../helpers/kyc";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

async function planted() {
  const f = await handoverFixture();
  const d = f.deployer;
  const reg = f.c.identityRegistry;
  // Before the ceremony (one owner call): the deployer's own issuer is
  // trusted for AML (topic 7), which is not a required topic yet.
  const p = await (
    await ethers.getContractFactory("ClaimIssuer")
  )
    .connect(d)
    .deploy(d.address, "Planted", "AML");
  const pAddr = await p.getAddress();
  await (await reg.connect(d).addTrustedIssuer(pAddr, [AML_TOPIC])).wait();
  console.log(
    `      required topics: [${(await reg.getClaimTopics()).join(", ")}]; planted issuer trusted for ${AML_TOPIC}: ${await reg.isTrustedIssuer(pAddr, AML_TOPIC)}`,
  );
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "d2-1-"));
  const cfgPath = path.join(dir, "handover.json");
  const a = async (k: string) => f.c[k].getAddress();
  const cfg: any = {
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
    feeWallets: [f.feeWallet.address],
    ops: 1,
    guardian: 2,
    issuerAdmin: 7,
    proposer: 4,
    voters: [5, 6],
  };
  return { f, d, reg, p, pAddr, cfg, cfgPath };
}

async function ceremony(cfg: any, cfgPath: string) {
  const quiet = console.log;
  const out: string[] = [];
  console.log = (...m: any[]) => out.push(m.join(" "));
  let full = "ok";
  let audit = "ok";
  let fullOut: string[] = [];
  try {
    await runHandover(cfg, "full", cfgPath).catch(
      (e: any) => (full = e.message),
    );
    fullOut = out.splice(0);
    await runHandover(cfg, "audit", cfgPath).catch(
      (e: any) => (audit = e.message),
    );
  } finally {
    console.log = quiet;
  }
  return { full, audit, fullOut, auditOut: out };
}

describe("D2-1 trusted issuer on a non-required topic", function () {
  this.timeout(600000);
  it("a config that omits it is refused before any transaction", async function () {
    const { d, reg, p, pAddr, cfg, cfgPath } = await planted();
    const r = await ceremony(cfg, cfgPath);
    const scanned = r.fullOut.filter((l) => /TrustedIssuerAdded scan/.test(l));
    console.log(
      `      full phase: ${r.full}\n      ${scanned.join("\n      ")}\n      audit: ${r.audit}`,
    );
    expect(r.full).to.contain(
      `config "issuers" omits ${pAddr} (a trusted issuer of the IdentityRegistry)`,
    );
    expect(scanned).to.include(
      `   ℹ️  IdentityRegistry trusts Planted (${pAddr}) for topic(s) [${AML_TOPIC}] (TrustedIssuerAdded scan)`,
    );
    expect(r.audit).to.contain("the ceremony has not completed");
    expect(await reg.owner()).to.equal(d.address);
    expect(await p.owner()).to.equal(d.address);
  });

  it("left out of the config, it is handed to issuerAdmin, listed by topic, and the deployer cannot attest", async function () {
    const { f, d, reg, p, pAddr, cfg, cfgPath } = await planted();
    delete cfg.issuers;
    const r = await ceremony(cfg, cfgPath);
    const kyc = await f.args.issuers[0].getAddress();
    const lines = (out: string[]) =>
      out.filter((l) => /TrustedIssuerAdded scan/.test(l));
    console.log(
      `      full phase: ${r.full}; audit: ${r.audit}\n      ${lines(r.auditOut).join("\n      ")}`,
    );
    expect(r.full).to.equal("ok");
    expect(r.audit).to.equal("ok");
    expect(lines(r.fullOut)).to.include(
      `   ℹ️  IdentityRegistry trusts Planted (${pAddr}) for topic(s) [${AML_TOPIC}] (TrustedIssuerAdded scan)`,
    );
    expect(lines(r.auditOut)).to.include(
      `   ✅ IdentityRegistry trusts Planted (${pAddr}) for topic(s) [${AML_TOPIC}] (TrustedIssuerAdded scan)`,
    );
    expect(lines(r.auditOut)).to.include(
      `   ✅ IdentityRegistry trusts KYC Issuer (${kyc}) for topic(s) [6] (TrustedIssuerAdded scan)`,
    );
    expect(await reg.owner()).to.equal(f.govAddr);
    expect(await p.owner()).to.equal(f.issuerAdmin.address);

    // Later, governance votes to require AML (impersonated here), trusting
    // the legitimate AML issuer, owned by issuerAdmin, first.
    const legit = await (
      await ethers.getContractFactory("ClaimIssuer")
    )
      .connect(f.issuerAdmin)
      .deploy(f.issuerAdmin.address, "AML Issuer", "AML");
    await network.provider.send("hardhat_impersonateAccount", [f.govAddr]);
    await network.provider.send("hardhat_setBalance", [
      f.govAddr,
      "0x56BC75E2D63100000",
    ]);
    const gov = await ethers.getSigner(f.govAddr);
    await (
      await reg
        .connect(gov)
        .addTrustedIssuer(await legit.getAddress(), [AML_TOPIC])
    ).wait();
    await (await reg.connect(gov).addClaimTopic(AML_TOPIC)).wait();
    await network.provider.send("hardhat_stopImpersonatingAccount", [
      f.govAddr,
    ]);

    // A stranger with the KYC claim but no AML clearance from issuerAdmin.
    const s = f.stranger;
    const id = await deployIdentity(f.factory, s.address);
    await (
      await reg.connect(f.ops).registerIdentity(s.address, id, 840)
    ).wait();
    await attest(f.kycIssuer, f.issuerAdmin, id);
    const before = await reg.isVerified(s.address);
    const refused = await attest(p, d, id, AML_TOPIC).then(
      () => "attested",
      (e: any) => (e.shortMessage || e.message).split("\n")[0],
    );
    const after = await reg.isVerified(s.address);
    console.log(
      `      the deployer's AML claim through the planted issuer: ${refused}; stranger verified before: ${before}, after: ${after}`,
    );
    expect(refused).to.not.equal("attested");
    expect(before).to.equal(false);
    expect(after).to.equal(false);
  });
});
