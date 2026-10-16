import { expect } from "chai";
import { ethers, network } from "hardhat";
import { handoverFixture } from "../helpers/governanceFixture";

const {
  acceptAllByVote,
  assertHandoverComplete,
  auditHandover,
  handoverDeployerPowers,
} = require("../../demo/utils/Handover");
const { deployerListOracles } = require("../../demo/utils/HandoverOracles");

/**
 * Task 5.14: a list oracle the deployer holds is handed to ops whether or
 * not ComplianceRules binds it. The fixture's whitelist oracle is unbound
 * (as the production deploy leaves it, D47) and deployer-owned.
 */
describe("Handover: list oracles the deployer holds (Task 5.14)", function () {
  let f: Awaited<ReturnType<typeof handoverFixture>>;
  let wl: string;
  const NEEDLE = "the deployer owns no list oracle serving OracleManager";

  beforeEach(async function () {
    f = await handoverFixture();
    wl = await f.args.oracles[0].getAddress();
  });

  async function ceremony(args = f.args, log: (m: string) => void = () => {}) {
    const report = await handoverDeployerPowers({ ...args, log });
    await acceptAllByVote({
      governance: f.c.governance,
      contracts: f.c,
      proposer: f.proposer,
      voters: f.voters,
      registryProposals: report.registryProposals,
      log: () => {},
    });
  }

  const newOracle = async (from: any, name = "WhitelistOracle") =>
    (await ethers.getContractFactory(name, from)).deploy(
      await f.c.oracleManager.getAddress(),
      "extra",
      "",
    ) as any;

  it("refuses a config whose oracles omit an unbound one the deployer owns", async function () {
    const nonce = await ethers.provider.getTransactionCount(f.deployer.address);
    await expect(
      handoverDeployerPowers({ ...f.args, oracles: [] }),
    ).to.be.rejectedWith(
      new RegExp(
        `config "oracles" omits ${wl} \\(a list oracle serving the plan's OracleManager that the deployer owns or has pending\\)`,
      ),
    );
    expect(
      await ethers.provider.getTransactionCount(f.deployer.address),
    ).to.equal(nonce);
  });

  it("named: handed to ops with the unbound wording; completion and audit pass", async function () {
    const lines: string[] = [];
    await ceremony(f.args, (m) => lines.push(m));
    expect(lines).to.include(
      `   ⚠️  oracle ${wl} is not bound on chain; handed over anyway`,
    );
    expect(await f.args.oracles[0].owner()).to.equal(f.ops.address);
    const { ok, checks } = await assertHandoverComplete(f.args);
    expect(ok).to.equal(true);
    const labels = checks.map((c: any) => c.label);
    expect(labels.filter((l: string) => l.startsWith(NEEDLE))).to.have.length(
      1,
    );
    await auditHandover(f.args, () => {});
  });

  it("not named and no list: derived from the scan and handed to ops", async function () {
    const extra = await newOracle(f.deployer, "BlacklistOracle");
    const args = { ...f.args };
    delete args.oracles;
    await ceremony(args);
    expect(await extra.owner()).to.equal(f.ops.address);
    expect(await f.args.oracles[0].owner()).to.equal(f.ops.address);
    expect((await assertHandoverComplete(args)).ok).to.equal(true);
  });

  it("completion and the audit refuse a list oracle the deployer owns after the ceremony", async function () {
    await ceremony();
    const extra = await (await newOracle(f.deployer)).getAddress();
    const { ok, failures } = await assertHandoverComplete(f.args);
    expect(ok).to.equal(false);
    const om = await f.c.oracleManager.getAddress();
    expect(failures).to.include(
      `the deployer still owns (or has pending by its own nomination) list oracle(s) ${extra} serving OracleManager ${om}`,
    );
    expect(failures).to.include(`oracle ${extra} owned by ops`);
    const out: string[] = [];
    await expect(
      auditHandover(f.args, (m: string) => out.push(m)),
    ).to.be.rejectedWith(/audit failed/);
    expect(out.some((l) => l.includes(`❌ the deployer still owns`))).to.equal(
      true,
    );
  });

  it("a pending deployer by its own nomination is held; by a stranger's, a warning", async function () {
    // Own: a 1-of-1 multisig of the deployer owns it and nominates it.
    const ms = await (
      await ethers.getContractFactory("TestMultisig")
    ).deploy([f.deployer.address], 1);
    const own = await newOracle(f.deployer);
    await own.transferOwnership(await ms.getAddress());
    const run = async (to: string, data: string) => {
      const calls = [{ to, value: 0, data }];
      await ms.approve(await ms.hashOf(calls));
      await ms.execute(calls);
    };
    const oa = await own.getAddress();
    await run(oa, own.interface.encodeFunctionData("acceptOwnership"));
    await run(
      oa,
      own.interface.encodeFunctionData("transferOwnership", [
        f.deployer.address,
      ]),
    );
    // A stranger's compiled oracle nominating the deployer.
    const theirs = await newOracle(f.stranger);
    await theirs.transferOwnership(f.deployer.address);
    const d = await deployerListOracles(f.args);
    expect(d.held).to.include(oa);
    expect(d.nominated).to.deep.equal([
      { oracle: await theirs.getAddress(), by: f.stranger.address },
    ]);
  });

  it("a stranger's nomination does not stop the ceremony; completion warns", async function () {
    const theirs = await newOracle(f.stranger);
    await theirs.transferOwnership(f.deployer.address);
    const lines: string[] = [];
    await ceremony(f.args, (m) => lines.push(m));
    const ta = await theirs.getAddress();
    expect(
      lines.some((l) => l.includes(`list oracle ${ta} names the deployer`)),
    ).to.equal(true);
    const { ok, warnings } = await assertHandoverComplete(f.args);
    expect(ok).to.equal(true);
    expect(
      warnings.some((w: string) =>
        w.startsWith(
          `list oracle ${ta} names the deployer as pending owner, nominated by ${f.stranger.address}`,
        ),
      ),
    ).to.equal(true);
  });

  it("ignores a look-alike: the deployer as owner without the compiled code", async function () {
    const fake = await newOracle(f.stranger);
    const fa = await fake.getAddress();
    await fake.transferOwnership(f.deployer.address); // the event names it
    // Slot of Ownable._owner: the stranger's address, found by value.
    let slot = "";
    for (let i = 0; i < 16 && !slot; i++) {
      const v = await ethers.provider.getStorage(fa, i);
      if (v.toLowerCase().endsWith(f.stranger.address.slice(2).toLowerCase()))
        slot = ethers.toBeHex(i, 32);
    }
    await network.provider.send("hardhat_setStorageAt", [
      fa,
      slot,
      ethers.zeroPadValue(f.deployer.address, 32),
    ]);
    const code = await ethers.provider.getCode(fa);
    await network.provider.send("hardhat_setCode", [fa, code + "00"]);
    expect(await fake.owner()).to.equal(f.deployer.address);
    const d = await deployerListOracles(f.args);
    expect(d.held).to.not.include(fa);
    await ceremony(); // the config's list need not name it
  });

  it("refuses a scan that misses a deployer-owned oracle it must see (R-413-6)", async function () {
    const late = (await ethers.provider.getBlockNumber()) + 1;
    await expect(
      deployerListOracles({ ...f.args, fromBlock: late }, [wl]),
    ).to.be.rejectedWith(
      new RegExp(`event scan found none of the holders it must see \\(${wl}`),
    );
  });
});
