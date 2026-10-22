// D-1b (round 2, A4): the Safe reader treats only "no such function" (a
// revert or undecodable data) as "reads as no Safe"; a timeout or a rate
// limit on getOwners() or getModulesPaginated() fails the run like every
// other read. The attack lane's timeout turned a deployer-owned guardian
// Safe into "unchecked, pass" in the ceremony and the audit.
import { expect } from "chai";
import { ethers } from "hardhat";
import { handoverFixture } from "../helpers/governanceFixture";
import { cliConfig } from "../helpers/handoverCli";
import * as h from "./D-1b-common";

/** `fn` with every eth_call of `sel` to `to` timing out; returns the hits too. */
async function timingOut(to: string, sel: string, fn: () => Promise<any>) {
  const prov: any = ethers.provider;
  const orig = prov.call.bind(prov);
  let hits = 0;
  prov.call = async (tx: any) => {
    if (sameTo(tx.to, to) && String(tx.data).startsWith(sel)) {
      hits++;
      throw new Error("request timeout (ETIMEDOUT)");
    }
    return orig(tx);
  };
  try {
    return { ...(await fn()), hits };
  } finally {
    prov.call = orig;
  }
}
const sameTo = (a: any, b: string) =>
  String(a).toLowerCase() === b.toLowerCase();

describe("D-1b RPC errors in the role Safe reader", function () {
  this.timeout(600000);
  for (const fn of ["getOwners", "getModulesPaginated"] as const) {
    it(`a ${fn}() timeout on a deployer-held guardian Safe fails the ceremony and the audit`, async function () {
      const f = await handoverFixture();
      const d = f.deployer;
      const s = await ethers.getSigners();
      const MS = await ethers.getContractFactory("TestMultisig");
      // getOwners: the deployer an owner; getModulesPaginated: its module.
      const R =
        fn === "getOwners"
          ? await MS.deploy([d.address], 1)
          : await MS.deploy([s[15].address, s[16].address], 2);
      if (fn !== "getOwners") await (await R.setModule(d.address)).wait();
      const rAddr = await R.getAddress();
      const sel = R.interface.getFunction(fn)!.selector;
      const { cfg, cfgPath } = await cliConfig(f);
      const run = { ...cfg, guardian: rAddr };
      const n = await ethers.provider.getTransactionCount(d.address);
      const faulty = await timingOut(rAddr, sel, async () => ({
        full: (await h.phase(run, "full", cfgPath)).verdict,
        audit: (await h.phase(run, "audit", cfgPath)).verdict,
      }));
      console.log(
        `      ${fn} timed out ${faulty.hits}x; full: ${faulty.full}; audit: ${faulty.audit}`,
      );
      expect(faulty.hits).to.be.greaterThan(0);
      expect(faulty.full).to.contain("ETIMEDOUT");
      expect(faulty.audit).to.contain("ETIMEDOUT");
      expect(await ethers.provider.getTransactionCount(d.address)).to.equal(n);
      // Control: with the RPC answering, the same Safe is refused by name.
      const clean = await h.phase(run, "full", cfgPath);
      console.log(`      without the fault: ${clean.verdict}`);
      expect(clean.verdict).to.match(
        new RegExp(`^guardian ${rAddr} (lists|has) the deployer ${d.address}`),
      );
    });
  }
});
