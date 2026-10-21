// D-1c (round 3, A3/A5/A6, C): a working getOwners() makes a role
// contract Safe-shaped. Its owners are vetted (the deployer listed is
// the deployer line, nested owners are walked) and a threshold it cannot
// read fails the line; only a failing getOwners() reads as no Safe (a
// ⚠️ at the top, unread below it). A degenerate multisig (no owner, a
// threshold of 0 or above its owners) is refused. Every Safe read is an
// eth_call from the zero address, so a lookalike keyed on the caller
// cannot answer the deployer differently.
import { expect } from "chai";
import { ethers } from "hardhat";
import { handoverFixture } from "../helpers/governanceFixture";
import * as h from "./D-1b-common";
import * as c from "./D-1c-common";

const noSafe = (where: string) =>
  `${where} has code but no readable getOwners()/getThreshold(): the deployer's ownership of it is unchecked (runbook section 2)`;

describe("D-1c role contracts that read as part of a Safe", function () {
  this.timeout(600000);

  it("a getThreshold() that cannot be read: the listed deployer and the threshold fail the line, top level and nested", async function () {
    const f = await handoverFixture();
    const d = f.deployer.address;
    const s = await ethers.getSigners();
    const noThr: [number, number, number] = [c.OK, c.EMPTY_REVERT, c.OK];
    const top = await c.lookalike([d, s[15].address], 1, [], noThr);
    const listed = `guardian ${top.at} lists the deployer ${d} as an owner: the deployer holds its power`;
    const partial = `guardian ${top.at} reads as a Safe but its threshold cannot be read: it cannot be vetted as a multisig`;
    const r = await c.vetAndPreflight(f, top.at);
    console.log(`      deployer listed, threshold unread: ${r.words}`);
    expect(r.words).to.equal(listed);
    expect(r.pre.verdict).to.equal(`Handover: ${listed}`);
    const keys = await c.lookalike(
      [s[15].address, s[16].address],
      2,
      [],
      noThr,
    );
    expect((await c.vet(keys.at, d)).words).to.equal(
      `guardian ${keys.at} reads as a Safe but its threshold cannot be read: it cannot be vetted as a multisig`,
    );
    const inner = await c.lookalike([d], 1, [], noThr);
    const outer = await c.multisig([inner.at, s[15].address]);
    const n = await c.vetAndPreflight(f, outer);
    console.log(`      nested: ${n.words}`);
    expect(n.words).to.equal(
      `guardian ${outer} lists the deployer ${d} as an owner (through ${inner.at}): the deployer holds its power`,
    );
    expect(n.pre.verdict).to.equal(`Handover: ${n.words}`);
    const done = await h.ceremonyThenGuardian(f, top.at);
    const audit = await h.auditAs(done.cfg, done.cfgPath, top.at);
    expect(audit.verdict).to.contain("audit failed");
    expect(audit.out).to.include.members([
      `   ❌ ${listed}`,
      `   ❌ ${partial}`,
    ]);
    expect(audit.out.join("\n")).to.not.contain(noSafe(`guardian ${top.at}`));
    done.done();
  });

  it("only a getOwners() that cannot be read is no Safe: a ⚠️ at the top (an empty revert or no data), unread below it", async function () {
    const f = await handoverFixture();
    const d = f.deployer.address;
    const s = await ethers.getSigners();
    for (const mode of [c.EMPTY_REVERT, c.NO_DATA]) {
      const top = await c.lookalike([d], 1, [], [mode, c.OK, c.OK]);
      const r = await c.vet(top.at, d);
      expect(r.words).to.equal("accepted");
      expect(r.logs).to.include(`⚠️  ${noSafe(`guardian ${top.at}`)}`);
      const outer = await c.multisig([top.at, s[15].address]);
      expect((await c.vet(outer, d)).words).to.equal(
        `guardian ${outer}: owner ${top.at} is unread (code but no readable getOwners()): the deployer's ownership of it cannot be vetted`,
      );
    }
  });

  for (const [owners, thr] of [
    [0, 0],
    [1, 0],
    [1, 5],
  ] as const) {
    it(`a degenerate ${thr}-of-${owners} multisig is refused, top level and nested`, async function () {
      const f = await handoverFixture();
      const s = await ethers.getSigners();
      const keys = [s[15].address].slice(0, owners);
      const top = await c.lookalike(keys, thr);
      const r = await c.vetAndPreflight(f, top.at);
      console.log(`      ${thr}-of-${owners}: ${r.words}`);
      const why = `is a degenerate multisig (${thr}-of-${owners}): it needs an owner and a threshold from 1 to its owner count`;
      expect(r.words).to.equal(`guardian ${top.at} ${why}`);
      expect(r.pre.verdict).to.equal(`Handover: ${r.words}`);
      const outer = await c.multisig([top.at, s[16].address]);
      expect((await c.vet(outer, f.deployer.address)).words).to.equal(
        `guardian ${outer}: owner ${top.at} ${why}`,
      );
    });
  }

  it("a lookalike that shows a zero-address caller the deployer as its owner is refused", async function () {
    const f = await handoverFixture();
    const d = f.deployer.address;
    const s = await ethers.getSigners();
    const top = await c.lookalike([s[15].address], 1);
    await (await top.x.showToZero([d])).wait();
    expect(await top.x.getOwners()).to.deep.equal([s[15].address]);
    const r = await c.vetAndPreflight(f, top.at);
    console.log(`      owners by caller: ${r.words}`);
    expect(r.words).to.equal(
      `guardian ${top.at} lists the deployer ${d} as an owner: the deployer holds its power`,
    );
    expect(r.pre.verdict).to.equal(`Handover: ${r.words}`);
  });
});
