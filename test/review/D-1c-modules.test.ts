// D-1c (round 3, A1/A2): every page of a role Safe's module list is read
// (to 100 entries), so the deployer enabled first and pushed to the 11th
// place is still refused, on a v1.4.1 Safe's paging and on v1.3.0's
// (whose `next` is the entry a page started at it skips); past 100 the
// list is unread and the role line fails. A contract that reads as a
// Safe but whose module list cannot be read fails it too: a module
// executes without the owners. Top level and nested, in every phase.
import { expect } from "chai";
import { ethers } from "hardhat";
import { handoverFixture } from "../helpers/governanceFixture";
import * as h from "./D-1b-common";
import * as c from "./D-1c-common";

const unreadList = (where: string) =>
  `${where} reads as a Safe but its module list cannot be read: a module executes without the owners`;

describe("D-1c role Safe module lists", function () {
  this.timeout(600000);

  it("the deployer as the 11th module, of the guardian or of an owner Safe, is refused in every phase", async function () {
    const f = await handoverFixture();
    const d = f.deployer.address;
    const s = await ethers.getSigners();
    const keys = [s[15].address, s[16].address];
    const top = await c.lookalike(keys, 2, [...c.strangers(10), d]);
    const r = await c.vetAndPreflight(f, top.at);
    console.log(`      11th module of the guardian: ${r.words}`);
    expect(r.words).to.equal(
      `guardian ${top.at} has the deployer ${d} as an enabled module: a module executes without the owners`,
    );
    expect(r.pre.verdict).to.equal(`Handover: ${r.words}`);
    const old = await c.lookalike(keys, 2, [...c.strangers(10), d]);
    await (await old.x.pageAsV130()).wait();
    expect((await c.vet(old.at, d)).words).to.equal(
      `guardian ${old.at} has the deployer ${d} as an enabled module: a module executes without the owners`,
    );
    const inner = await c.lookalike([s[16].address], 1, [
      ...c.strangers(10),
      d,
    ]);
    const outer = await c.multisig([inner.at, s[15].address]);
    const n = await c.vetAndPreflight(f, outer);
    console.log(`      11th module of an owner Safe: ${n.words}`);
    expect(n.words).to.equal(
      `guardian ${outer}: owner ${inner.at} has the deployer ${d} as an enabled module: a module executes without the owners`,
    );
    expect(n.pre.verdict).to.equal(`Handover: ${n.words}`);
    const done = await h.ceremonyThenGuardian(f, top.at);
    const audit = await h.auditAs(done.cfg, done.cfgPath, top.at);
    expect(audit.verdict).to.contain("audit failed");
    expect(audit.out).to.include(`   ❌ ${r.words}`);
    expect(audit.out.join("\n")).to.not.contain(`✅ guardian ${top.at}`);
    done.done();
  });

  it("a module list past 100 entries is unread and fails the role line; 100 stranger modules warn", async function () {
    const f = await handoverFixture();
    const d = f.deployer.address;
    const s = await ethers.getSigners();
    const keys = [s[15].address, s[16].address];
    const many = await c.lookalike(keys, 2, c.strangers(101));
    const r = await c.vetAndPreflight(f, many.at);
    console.log(`      101 modules: ${r.words}`);
    expect(r.words).to.equal(
      `guardian ${many.at} has its module list unread past 100: a module executes without the owners`,
    );
    expect(r.pre.verdict).to.equal(`Handover: ${r.words}`);
    const mods = c.strangers(100);
    const full = await c.lookalike(keys, 2, mods);
    const ok = await c.vet(full.at, d);
    expect(ok.words).to.equal("accepted");
    expect(ok.logs).to.include(
      `⚠️  guardian ${full.at} has module(s) enabled (${mods.join(", ")}): a module executes without the owners`,
    );
  });

  for (const [name, mode] of [
    ["an empty revert", c.EMPTY_REVERT],
    ["no data", c.NO_DATA],
  ] as const) {
    it(`a getModulesPaginated() answering ${name} fails the role line, top level and nested`, async function () {
      const f = await handoverFixture();
      const d = f.deployer.address;
      const s = await ethers.getSigners();
      const modes: [number, number, number] = [c.OK, c.OK, mode];
      const top = await c.lookalike(
        [s[15].address, s[16].address],
        2,
        [d],
        modes,
      );
      const r = await c.vetAndPreflight(f, top.at);
      console.log(`      top: ${r.words}`);
      expect(r.words).to.equal(unreadList(`guardian ${top.at}`));
      expect(r.pre.verdict).to.equal(`Handover: ${r.words}`);
      const inner = await c.lookalike([s[16].address], 1, [d], modes);
      const outer = await c.multisig([inner.at, s[15].address]);
      const n = await c.vetAndPreflight(f, outer);
      console.log(`      nested: ${n.words}`);
      expect(n.words).to.equal(
        unreadList(`guardian ${outer}: owner ${inner.at}`),
      );
      expect(n.pre.verdict).to.equal(`Handover: ${n.words}`);
      if (mode !== c.EMPTY_REVERT) return;
      const done = await h.ceremonyThenGuardian(f, top.at);
      const audit = await h.auditAs(done.cfg, done.cfgPath, top.at);
      expect(audit.verdict).to.contain("audit failed");
      expect(audit.out).to.include(`   ❌ ${r.words}`);
      done.done();
    });
  }

  it("a getModulesPaginated() reverting with data fails the run with that revert", async function () {
    const f = await handoverFixture();
    const s = await ethers.getSigners();
    const top = await c.lookalike(
      [s[15].address, s[16].address],
      2,
      [f.deployer.address],
      [c.OK, c.OK, c.CUSTOM_ERROR],
    );
    const r = await c.vetAndPreflight(f, top.at);
    console.log(`      custom error: ${r.words}`);
    expect(r.words).to.contain("Weird(7)");
    expect(r.pre.verdict).to.contain("Weird(7)");
  });
});
