// D-1c (round 3, A7): roleOf, the "no node holds a role key" check,
// swallowed every error of its role reads, so an RPC timeout on one made
// a node key pass. Only "no such function" reads as no role now; a
// timeout fails the preflight, the full phase and the audit with the
// error, before the deployer sends anything.
import { expect } from "chai";
import * as fs from "fs";
import { ethers } from "hardhat";
import { handoverFixture } from "../helpers/governanceFixture";
import { cliConfig } from "../helpers/handoverCli";
import * as h from "./D-1b-common";

const { roleOf } = require("../../demo/utils/HandoverNodeKeys");

/** `fn` with every eth_call of `data` to `to` timing out; returns the hits too. */
async function timingOut(to: string, data: string, fn: () => Promise<any>) {
  const prov: any = ethers.provider;
  const call = prov.call.bind(prov);
  let hits = 0;
  prov.call = async (tx: any) => {
    const same = String(tx.to).toLowerCase() === to.toLowerCase();
    if (same && String(tx.data).toLowerCase() === data.toLowerCase()) {
      hits++;
      throw new Error("request timeout (ETIMEDOUT)");
    }
    return call(tx);
  };
  try {
    return { ...(await fn()), hits };
  } finally {
    prov.call = call;
  }
}

describe("D-1c roleOf read errors", function () {
  this.timeout(600000);
  for (const [read, key, fn] of [
    ["VSC isAgent(node)", "token", "isAgent"],
    [
      "InvestorTypeRegistry isGovernor(node)",
      "investorTypeRegistry",
      "isGovernor",
    ],
  ] as const) {
    it(`a ${read} timeout fails the preflight, the full phase and the audit`, async function () {
      const f = await handoverFixture();
      const d = f.deployer.address;
      const s = await ethers.getSigners();
      const nodes = [s[12], s[13], s[14]].map((x) => x.address);
      for (const [i, a] of nodes.entries())
        await (
          await f.c.oracleManager.registerOracle(a, `N${i}`, "", 500)
        ).wait();
      const { cfg, cfgPath, dir } = await cliConfig(f);
      cfg.oracleNodes = nodes;
      const c = f.c[key];
      const data = c.interface.encodeFunctionData(fn, [nodes[0]]);
      const run = (phase: string) => h.phase(cfg, phase, cfgPath);
      const n = await ethers.provider.getTransactionCount(d);
      const before = await timingOut(await c.getAddress(), data, async () => ({
        pre: (await run("preflight")).verdict,
        full: (await run("full")).verdict,
      }));
      console.log(
        `      ${read} timed out ${before.hits}x; preflight: ${before.pre}; full: ${before.full}`,
      );
      expect(before.hits).to.be.greaterThan(0);
      expect(before.pre).to.contain("ETIMEDOUT");
      expect(before.full).to.contain("ETIMEDOUT");
      expect(await ethers.provider.getTransactionCount(d)).to.equal(n);
      expect((await run("full")).verdict).to.equal("ok");
      const audit = await timingOut(await c.getAddress(), data, async () => ({
        verdict: (await run("audit")).verdict,
      }));
      console.log(`      audit: ${audit.verdict}`);
      expect(audit.hits).to.be.greaterThan(0);
      expect(audit.verdict).to.contain("ETIMEDOUT");
      expect((await run("audit")).verdict).to.equal("ok");
      fs.rmSync(dir, { recursive: true, force: true });
    });
  }
});

// Round 4 (G3 LOW): a missing operator() or owner() read as null, which
// roleOf compared as an address and threw on; it is "not that role".
describe("D-1c roleOf on a contract without the role function", function () {
  this.timeout(600000);
  it("an OracleManager or ClaimIssuer without operator()/owner() is no role, and the walk goes on", async function () {
    const f = await handoverFixture();
    const MT = await ethers.getContractFactory("MockTarget");
    const at = await (await MT.deploy()).getAddress();
    const om = await ethers.getContractAt("OracleManager", at);
    const a = ethers.Wallet.createRandom().address;
    expect(await roleOf({ oracleManager: om }, a)).to.equal(null);
    expect(await roleOf({ issuers: [at] }, a)).to.equal(null);
    const iss = f.kycIssuer;
    expect(
      await roleOf(
        { oracleManager: om, issuers: [at, iss] },
        await iss.owner(),
      ),
    ).to.equal(`the owner of ClaimIssuer ${await iss.getAddress()}`);
  });
});
