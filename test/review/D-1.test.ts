// D-1: a guardian multisig the deployer owns is refused by the deploy's
// role vet, the ceremony and the day-2 audit, so the deployer cannot keep
// the power to pause VSC through it.
import { expect } from "chai";
import { ethers, network } from "hardhat";
import { handoverFixture } from "../helpers/governanceFixture";
import { runHandover } from "../../scripts/handover";
import { handoverArgs } from "../../scripts/handoverConfig";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const { vetRole, externalRole } = require("../../demo/utils/RoleCalls");
const { auditHandover } = require("../../demo/utils/Handover");

async function setup() {
  const f = await handoverFixture();
  const d = f.deployer;
  const MS = await ethers.getContractFactory("TestMultisig");
  const gSafe = await MS.connect(d).deploy([d.address], 1);
  const gAddr = await gSafe.getAddress();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "d3-"));
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
    guardian: gAddr, // a multisig: external
    issuerAdmin: 7,
    proposer: 4,
    voters: [5, 6],
  };
  return { f, d, gSafe, gAddr, cfg, cfgPath };
}

async function run(cfg: any, phase: string, cfgPath: string) {
  const quiet = console.log;
  const out: string[] = [];
  console.log = (...m: any[]) => out.push(m.join(" "));
  let verdict = "ok";
  try {
    await runHandover(cfg, phase, cfgPath).catch(
      (e: any) => (verdict = e.message),
    );
  } finally {
    console.log = quiet;
  }
  return { verdict, out };
}

describe("D-1 guardian Safe owned by the deployer", function () {
  this.timeout(600000);
  it("vet, ceremony and audit refuse it; the deployer cannot pause VSC", async function () {
    const { f, d, gSafe, gAddr, cfg, cfgPath } = await setup();
    await expect(
      vetRole(externalRole(gAddr, "ops"), d.address, () => {}),
    ).to.be.rejectedWith(/lists the deployer/);
    await expect(
      vetRole(externalRole(gAddr, "guardian"), d.address, () => {}),
    ).to.be.rejectedWith(
      `guardian ${gAddr} lists the deployer ${d.address} as an owner`,
    );
    const full = await run(cfg, "full", cfgPath);
    const audit = await run(cfg, "audit", cfgPath);
    console.log(`      full phase: ${full.verdict}`);
    console.log(`      audit: ${audit.verdict}`);
    expect(full.verdict).to.contain(
      `guardian ${gAddr} lists the deployer ${d.address} as an owner`,
    );
    expect(audit.verdict).to.contain(
      `guardian ${gAddr} lists the deployer ${d.address} as an owner`,
    );
    expect(await f.c.token.owner()).to.equal(d.address);
    expect(await f.c.token.guardian()).to.not.equal(gAddr);
    const calls = [
      {
        to: cfg.token,
        value: 0,
        data: f.c.token.interface.encodeFunctionData("pause"),
      },
    ];
    await (await gSafe.connect(d).approve(await gSafe.hashOf(calls))).wait();
    await gSafe
      .connect(d)
      .execute(calls)
      .catch(() => null);
    console.log(
      `      VSC paused by the deployer's Safe: ${await f.c.token.paused()}`,
    );
    expect(await f.c.token.paused()).to.equal(false);
  });

  it("completion and the audit read the guardian as a Safe and fail on the deployer as owner", async function () {
    const { f, d, gAddr, cfg, cfgPath } = await setup();
    const honest = { ...cfg, guardian: 2 };
    const full = await run(honest, "full", cfgPath);
    expect(full.verdict).to.equal("ok");
    expect(full.out.join("\n")).to.match(
      /✅ guardian 0x[0-9a-fA-F]{40} is a key \(no code\), not the deployer/,
    );
    // Governance later names the deployer's Safe guardian (the vote impersonated).
    await network.provider.send("hardhat_impersonateAccount", [f.govAddr]);
    await network.provider.send("hardhat_setBalance", [
      f.govAddr,
      "0x56BC75E2D63100000",
    ]);
    await (
      await f.c.token
        .connect(await ethers.getSigner(f.govAddr))
        .setGuardian(gAddr)
    ).wait();
    await network.provider.send("hardhat_stopImpersonatingAccount", [
      f.govAddr,
    ]);
    const { args } = await handoverArgs(honest, "audit", cfgPath);
    const lines: string[] = [];
    let verdict = "ok";
    await auditHandover(
      { ...args, guardian: externalRole(gAddr, "guardian") },
      (m: string) => lines.push(m),
    ).catch((e: any) => (verdict = e.message));
    const named = lines.filter((l) => l.includes(gAddr));
    console.log(`      audit: ${verdict}\n      ${named.join("\n      ")}`);
    expect(verdict).to.contain("audit failed");
    expect(lines).to.include(
      `   ❌ guardian ${gAddr} lists the deployer ${d.address} as an owner: the deployer holds its power`,
    );
  });
});
