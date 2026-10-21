// D-1b (round 2, A1/A5/A6): a role Safe owner the vet cannot read (code
// past two nested levels, a cycle, or a contract with no readable
// getOwners()) fails the role line in the vet, the preflight and the
// audit with the same words; the attack lane's deployer three Safes deep
// got a ✅ and paused VSC. Controls: stranger-owned Safes still pass.
import { expect } from "chai";
import * as fs from "fs";
import { ethers } from "hardhat";
import { handoverFixture } from "../helpers/governanceFixture";
import { cliConfig } from "../helpers/handoverCli";
import * as h from "./D-1b-common";

const { vetRole, externalRole } = require("../../demo/utils/RoleCalls");

const vet = (a: string, d: string) =>
  vetRole(externalRole(a, "guardian"), d, () => {}).then(
    () => "accepted",
    (e: any) => e.message,
  );

describe("D-1b role Safe owners the vet cannot read", function () {
  this.timeout(600000);

  for (const depth of [3, 4]) {
    it(`the deployer ${depth} Safes below the guardian: vet, preflight and audit refuse it`, async function () {
      const f = await handoverFixture();
      const d = f.deployer.address;
      const { R, rAddr, safes } = await h.nested(d, depth);
      const [a, b, x] = [depth - 1, depth - 2, depth - 3].map((i) =>
        safes[i].getAddress(),
      );
      const words = await vet(rAddr, d);
      console.log(`      vet: ${words}`);
      expect(words).to.contain(
        `guardian ${rAddr}: owner ${await x} (through ${await a}, ${await b}) is unread`,
      );
      expect(words).to.contain(
        "the deployer's ownership of it cannot be vetted",
      );
      const { cfg, cfgPath } = await cliConfig(f);
      const full = await h.phase({ ...cfg, guardian: rAddr }, "full", cfgPath);
      expect(full.verdict).to.equal(words);
      const pre = await h.preflightAs(cfg, cfgPath, rAddr);
      expect(pre.verdict).to.equal(`Handover: ${words}`);
      expect(pre.out.join("\n")).to.not.contain("Preflight passed");
      expect(await f.c.token.owner()).to.equal(d);
      if (depth !== 3) return;
      // After the ceremony governance names R guardian: the audit refuses
      // it, and R is the deployer's: it pauses VSC through the three Safes.
      const done = await h.ceremonyThenGuardian(f, rAddr);
      const audit = await h.auditAs(done.cfg, done.cfgPath, rAddr);
      expect(audit.verdict).to.contain("audit failed");
      expect(audit.out).to.include(`   ❌ ${words}`);
      expect(audit.out.join("\n")).to.not.contain(`✅ guardian ${rAddr}`);
      const pause = [
        {
          to: await f.c.token.getAddress(),
          value: 0,
          data: f.c.token.interface.encodeFunctionData("pause"),
        },
      ];
      let calls = await h.through(R, pause);
      for (const s of [safes[2], safes[1]]) calls = await h.through(s, calls);
      await (await safes[0].approve(await safes[0].hashOf(calls))).wait();
      await (await safes[0].execute(calls)).wait();
      console.log(
        `      VSC paused by the deployer through R: ${await f.c.token.paused()}`,
      );
      expect(await f.c.token.paused()).to.equal(true);
      done.done();
    });
  }

  it("a cycle of Safes hits the depth cap and is refused the same way", async function () {
    const f = await handoverFixture();
    const d = f.deployer;
    const s = await ethers.getSigners();
    const MS = await ethers.getContractFactory("TestMultisig");
    const n = await ethers.provider.getTransactionCount(d.address);
    const [aAddr, bAddr] = [n, n + 1].map((nonce) =>
      ethers.getCreateAddress({ from: d.address, nonce }),
    );
    await MS.connect(d).deploy([bAddr, s[15].address], 1);
    await MS.connect(d).deploy([aAddr, s[16].address], 1);
    const t0 = Date.now();
    const words = await vet(aAddr, d.address);
    console.log(`      vet (${Date.now() - t0} ms): ${words}`);
    expect(words).to.contain(
      `guardian ${aAddr}: owner ${bAddr} (through ${bAddr}, ${aAddr}) is unread`,
    );
    const { cfg, cfgPath } = await cliConfig(f);
    expect((await h.preflightAs(cfg, cfgPath, aAddr)).verdict).to.equal(
      `Handover: ${words}`,
    );
  });

  it("a guardian Safe whose contract owner reads as no Safe is refused, and that owner is the deployer's", async function () {
    const f = await handoverFixture();
    const d = f.deployer;
    const s = await ethers.getSigners();
    const x = await (
      await ethers.getContractFactory("AttackForwarder")
    )
      .connect(d)
      .deploy();
    const xAddr = await x.getAddress();
    const MS = await ethers.getContractFactory("TestMultisig");
    const R = await MS.deploy([xAddr, s[15].address], 1);
    const rAddr = await R.getAddress();
    const words = await vet(rAddr, d.address);
    console.log(`      vet: ${words}`);
    expect(words).to.contain(`guardian ${rAddr}: owner ${xAddr} is unread`);
    const { cfg, cfgPath } = await cliConfig(f);
    expect((await h.preflightAs(cfg, cfgPath, rAddr)).verdict).to.equal(
      `Handover: ${words}`,
    );
    const done = await h.ceremonyThenGuardian(f, rAddr);
    const audit = await h.auditAs(done.cfg, done.cfgPath, rAddr);
    expect(audit.verdict).to.contain("audit failed");
    expect(audit.out).to.include(`   ❌ ${words}`);
    const pause = f.c.token.interface.encodeFunctionData("pause");
    const tokenAddr = await f.c.token.getAddress();
    for (const c of await h.through(R, [
      { to: tokenAddr, value: 0, data: pause },
    ]))
      await (await x.connect(d).exec(c.to, c.data)).wait();
    console.log(
      `      VSC paused by the deployer through its forwarder: ${await f.c.token.paused()}`,
    );
    expect(await f.c.token.paused()).to.equal(true);
    done.done();
  });

  it("D-8: a node key three Safes below the guardian is refused (the guardian's unread owner)", async function () {
    const f = await handoverFixture();
    const k = (await ethers.getSigners())[17];
    const { rAddr } = await h.nested(k.address, 3);
    await (
      await f.c.oracleManager
        .connect(f.deployer)
        .registerOracle(k.address, "NODE_KEY", "x", 500)
    ).wait();
    const { cfg, cfgPath } = await cliConfig(f);
    const run = { ...cfg, guardian: rAddr, oracleNodes: [k.address] };
    const pre = await h.phase(run, "preflight", cfgPath);
    console.log(`      preflight: ${pre.verdict}`);
    expect(pre.verdict).to.contain(`guardian ${rAddr}: owner 0x`);
    expect(pre.verdict).to.contain("is unread");
  });

  it("controls: a stranger-owned guardian Safe and a clean Safe two levels deep pass every phase", async function () {
    const f = await handoverFixture();
    const s = await ethers.getSigners();
    const MS = await ethers.getContractFactory("TestMultisig");
    const flat = await (
      await MS.deploy([s[15].address, s[16].address], 1)
    ).getAddress();
    const { rAddr: deep } = await h.nested(s[17].address, 2);
    const ok = (g: string) =>
      `   ✅ guardian ${g} is a 1-of-2 multisig; the deployer is no listed owner`;
    for (const g of [flat, deep]) {
      expect(await vet(g, f.deployer.address)).to.equal("accepted");
      const { cfg, cfgPath } = await cliConfig(f);
      expect((await h.preflightAs(cfg, cfgPath, g)).verdict).to.equal("ok");
    }
    const { cfg, cfgPath, dir } = await cliConfig(f);
    const full = await h.phase({ ...cfg, guardian: flat }, "full", cfgPath);
    console.log(`      full phase, stranger-owned guardian: ${full.verdict}`);
    expect(full.verdict).to.equal("ok");
    expect(full.out).to.include(ok(flat));
    const audit = await h.phase({ ...cfg, guardian: flat }, "audit", cfgPath);
    expect(audit.verdict).to.equal("ok");
    expect(audit.out).to.include(ok(flat));
    await h.governanceSetsGuardian(f, deep);
    const a2 = await h.auditAs(cfg, cfgPath, deep);
    console.log(
      `      audit, guardian a clean Safe two levels deep: ${a2.verdict}`,
    );
    expect(a2.verdict).to.equal("ok");
    expect(a2.out).to.include(ok(deep));
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
