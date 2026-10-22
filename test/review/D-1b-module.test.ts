// D-1b (round 2, A2/A3): a module executes without the owners, so the
// deployer as an enabled module of the role Safe or of an owner Safe
// fails the role line; any other module, and a role contract that reads
// as no Safe (the Task 5.13 honest scope), is a ⚠️ line that completion
// and the audit print too, never a ✅ (round 3: the preflight too).
import { expect } from "chai";
import * as fs from "fs";
import { ethers } from "hardhat";
import { handoverFixture } from "../helpers/governanceFixture";
import { cliConfig } from "../helpers/handoverCli";
import * as h from "./D-1b-common";

const { vetRole, externalRole } = require("../../demo/utils/RoleCalls");

const vet = (a: string, d: string, log: (m: string) => void = () => {}) =>
  vetRole(externalRole(a, "guardian"), d, log).then(
    () => "accepted",
    (e: any) => e.message,
  );
/** The lines a phase printed from its verify (or audit) header on. */
const after = (out: string[], re: RegExp) =>
  out.slice(out.findIndex((l) => re.test(l)));

describe("D-1b role Safe modules and role contracts that read as no Safe", function () {
  this.timeout(600000);

  it("the deployer as an enabled module of the guardian Safe or of an owner Safe is refused", async function () {
    const f = await handoverFixture();
    const d = f.deployer.address;
    const s = await ethers.getSigners();
    const MS = await ethers.getContractFactory("TestMultisig");
    const R = await MS.deploy([s[15].address, s[16].address], 2);
    await (await R.setModule(d)).wait();
    const rAddr = await R.getAddress();
    const words = await vet(rAddr, d);
    console.log(`      vet, module on the guardian: ${words}`);
    expect(words).to.contain(
      `guardian ${rAddr} has the deployer ${d} as an enabled module`,
    );
    const { cfg, cfgPath } = await cliConfig(f);
    expect((await h.preflightAs(cfg, cfgPath, rAddr)).verdict).to.equal(
      `Handover: ${words}`,
    );
    const inner = await MS.deploy([s[15].address], 1);
    await (await inner.setModule(d)).wait();
    const innerAddr = await inner.getAddress();
    const R2 = await MS.deploy([innerAddr, s[16].address], 1);
    const r2 = await R2.getAddress();
    const deep = await vet(r2, d);
    console.log(`      vet, module on an owner Safe: ${deep}`);
    expect(deep).to.contain(
      `guardian ${r2}: owner ${innerAddr} has the deployer ${d} as an enabled module`,
    );
    const done = await h.ceremonyThenGuardian(f, rAddr);
    const audit = await h.auditAs(done.cfg, done.cfgPath, rAddr);
    expect(audit.verdict).to.contain("audit failed");
    expect(audit.out).to.include(`   ❌ ${words}`);
    expect(audit.out.join("\n")).to.not.contain(`✅ guardian ${rAddr}`);
    done.done();
  });

  it("any other module is a ⚠️ line in the vet, completion and the audit", async function () {
    const f = await handoverFixture();
    const s = await ethers.getSigners();
    const MS = await ethers.getContractFactory("TestMultisig");
    const R = await MS.deploy([s[15].address, s[16].address], 1);
    await (await R.setModule(s[17].address)).wait();
    const rAddr = await R.getAddress();
    const warn = `⚠️  guardian ${rAddr} has module(s) enabled (${s[17].address}): a module executes without the owners`;
    const logged: string[] = [];
    expect(
      await vet(rAddr, f.deployer.address, (m) => logged.push(m)),
    ).to.equal("accepted");
    expect(logged).to.include(warn);
    const { cfg, cfgPath, dir } = await cliConfig(f);
    // Round 3 (A8): the preflight prints it too, with no config vet (83c).
    const pre = await h.preflightAs(cfg, cfgPath, rAddr);
    expect(pre.verdict).to.equal("ok");
    expect(pre.out).to.include(`   ${warn}`);
    const full = await h.phase({ ...cfg, guardian: rAddr }, "full", cfgPath);
    console.log(`      full phase: ${full.verdict}`);
    expect(full.verdict).to.equal("ok");
    const verify = after(full.out, /Handover: verify/);
    expect(verify).to.include(`   ${warn}`);
    expect(verify).to.include(
      `   ✅ guardian ${rAddr} is a 1-of-2 multisig; the deployer is no listed owner`,
    );
    expect(verify).to.include(
      "\n⚠️  Handover complete with warnings: see above.",
    );
    const audit = await h.phase({ ...cfg, guardian: rAddr }, "audit", cfgPath);
    expect(audit.verdict).to.equal("ok");
    expect(after(audit.out, /Handover audit/)).to.include(`   ${warn}`);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("a role contract with no readable getOwners() passes unchecked: a ⚠️ line in completion and the audit, never a ✅", async function () {
    const f = await handoverFixture();
    const x = await (
      await ethers.getContractFactory("AttackForwarder")
    )
      .connect(f.deployer)
      .deploy();
    const xAddr = await x.getAddress();
    const warn = `   ⚠️  guardian ${xAddr} has code but no readable getOwners()/getThreshold(): the deployer's ownership of it is unchecked (runbook section 2)`;
    const { cfg, cfgPath, dir } = await cliConfig(f);
    const pre = await h.preflightAs(cfg, cfgPath, xAddr);
    expect(pre.verdict).to.equal("ok");
    expect(pre.out).to.include(warn);
    const full = await h.phase({ ...cfg, guardian: xAddr }, "full", cfgPath);
    console.log(
      `      full phase, guardian a deployer-owned forwarder: ${full.verdict}`,
    );
    expect(full.verdict).to.equal("ok");
    expect(after(full.out, /Handover: verify/)).to.include(warn);
    expect(full.out.join("\n")).to.not.match(
      new RegExp(`✅ guardian ${xAddr}`),
    );
    expect(full.out).to.include(
      "\n⚠️  Handover complete with warnings: see above.",
    );
    const audit = await h.phase({ ...cfg, guardian: xAddr }, "audit", cfgPath);
    expect(audit.verdict).to.equal("ok");
    expect(after(audit.out, /Handover audit/)).to.include(warn);
    expect(audit.out.join("\n")).to.not.match(
      new RegExp(`✅ guardian ${xAddr}`),
    );
    expect(audit.out).to.include(
      "\n⚠️  Audit passed with warnings: see above.",
    );
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
