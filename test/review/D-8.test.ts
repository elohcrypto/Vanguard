// D-8: roleOf and the "no node holds a role key" check read each role
// Safe's owners, so a node that is an owner key of the ops Safe is caught
// like a node that is the guardian EOA.
import { expect } from "chai";
import * as fs from "fs";
import { ethers } from "hardhat";
import { handoverFixture } from "../helpers/governanceFixture";
import { cliConfig } from "../helpers/handoverCli";
import { handoverArgs } from "../../scripts/handoverConfig";

const { withDerivedContracts } = require("../../demo/utils/HandoverDerive");
const { nodeChecks, roleOf } = require("../../demo/utils/HandoverNodes");

describe("D-8 roleOf and Safe owner keys", function () {
  this.timeout(300000);
  it("a node key that owns the ops Safe fails the role check, like the guardian EOA as node", async function () {
    const s = await ethers.getSigners();
    const make = (a: any, b: any) =>
      ethers
        .getContractFactory("TestMultisig")
        .then((F) => F.deploy([a.address, b.address], 2));
    const opsSafe: any = await make(s[10], s[11]);
    const opsAddr = await opsSafe.getAddress();
    const exec = async (calls: any[]) => {
      const c = calls.map((x) => ({ to: x.to, value: x.value, data: x.data }));
      const h = await opsSafe.hashOf(c);
      for (const o of [s[10], s[11]])
        await (await opsSafe.connect(o).approve(h)).wait();
      await (await opsSafe.connect(s[10]).execute(c)).wait();
    };
    const f = await handoverFixture({
      bank: {
        address: opsAddr,
        accept: async (m: any) =>
          exec([
            {
              to: await m.getAddress(),
              value: "0",
              data: m.interface.encodeFunctionData("acceptOwnership"),
            },
          ]),
      },
    });
    const { cfg, cfgPath, dir } = await cliConfig(f);
    cfg.ops = opsAddr; // ops is a Safe (a contract); owners s10 and s11
    // the deployer registers s10 -- an OWNER key of the ops Safe -- as an OracleManager node
    await (
      await f.c.oracleManager
        .connect(f.deployer)
        .registerOracle(s[10].address, "SAFE_OWNER", "x", 500)
    ).wait();
    cfg.oracleNodes = [s[10].address];
    const derive = async () => {
      const { args } = await handoverArgs(cfg, "audit", cfgPath);
      return withDerivedContracts(args);
    };
    let o = await derive();
    const role = await roleOf(o, s[10].address);
    const line = (cs: any[]) =>
      cs.find((c) => c.label.startsWith("no OracleManager node is ops"));
    let l = line(await nodeChecks(o));
    console.log(`      roleOf(ops-Safe owner) = ${role}; check ok = ${l.ok}`);
    expect(role).to.equal(`an owner key of ops (multisig ${opsAddr})`);
    expect(l.ok).to.equal(false);
    expect(l.fix).to.contain(s[10].address);
    // control: the same check fires for a role ADDRESS (the guardian EOA, s2)
    await (
      await f.c.oracleManager
        .connect(f.deployer)
        .registerOracle(s[2].address, "GUARDIAN_AS_NODE", "x", 500)
    ).wait();
    o = await derive();
    const ctl = await roleOf(o, s[2].address);
    l = line(await nodeChecks(o));
    console.log(
      `      control: roleOf(guardian EOA) = ${ctl}; the check ok = ${l.ok}`,
    );
    expect(ctl).to.equal("the guardian");
    expect(l.ok).to.equal(false);
    expect(l.fix).to.contain(s[2].address);
    expect(l.fix).to.contain(s[10].address);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
