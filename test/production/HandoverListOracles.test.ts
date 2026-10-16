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

  /** A contract `from` deploys whose constructor emits OwnershipTransferred(0, deployer) and whose runtime is `runtime` (hex, at most 32 bytes). */
  async function emitter(from: any, runtime: string) {
    const sig = ethers.id("OwnershipTransferred(address,address)").slice(2);
    const d = ethers.zeroPadValue(f.deployer.address, 32).slice(2);
    const n = runtime.length / 2;
    const init =
      "0x7f" +
      d +
      "6000" +
      "7f" +
      sig +
      "60006000a3" +
      ethers.toBeHex(0x5f + n, 1).slice(2) +
      runtime +
      "600052" +
      ethers.toBeHex(n, 1).slice(2).padStart(2, "0").replace(/^/, "60") +
      ethers
        .toBeHex(32 - n, 1)
        .slice(2)
        .replace(/^/, "60") +
      "f3";
    const tx = await from.sendTransaction({ data: init });
    const rc = await tx.wait();
    expect(await ethers.provider.getCode(rc!.contractAddress!)).to.equal(
      "0x" + runtime,
    );
    return rc!.contractAddress!;
  }

  it("H-1: a gas-burning or invalid-opcode emitter is ignored; the ceremony completes", async function () {
    const burner = await emitter(f.stranger, "5b600056"); // JUMPDEST; JUMP(0)
    const invalid = await emitter(f.stranger, "fe");
    const d = await deployerListOracles(f.args);
    expect(d.held).to.not.include(burner);
    expect(d.held).to.not.include(invalid);
    await ceremony();
    expect((await assertHandoverComplete(f.args)).ok).to.equal(true);
  });

  /** ethers.provider.getLogs refusing every address-less query (a flood past the provider's cap). */
  async function flooded<T>(fn: () => Promise<T>): Promise<T> {
    const p: any = ethers.provider;
    const real = p.getLogs;
    p.getLogs = async (flt: any) => {
      if (!flt.address)
        throw new Error("query returned more than 10000 results");
      return real.call(p, flt);
    };
    try {
      return await fn();
    } finally {
      p.getLogs = real;
    }
  }

  it("M-1: a flooded scan warns and does not refuse; the ceremony completes", async function () {
    const lines: string[] = [];
    const res = await flooded(async () => {
      await ceremony(f.args, (m) => lines.push(m));
      return assertHandoverComplete(f.args);
    });
    expect(res.ok).to.equal(true);
    const re =
      /scan for other list oracles naming the deployer was capped at block \d+.*: not checked/;
    expect(lines.some((l) => re.test(l))).to.equal(true);
    expect(res.warnings.some((w: string) => re.test(w))).to.equal(true);
    expect(await f.args.oracles[0].owner()).to.equal(f.ops.address);
  });

  it("M-1: with the scan capped, an omitted deployer-created oracle is still refused", async function () {
    await flooded(async () => {
      await expect(
        handoverDeployerPowers({ ...f.args, oracles: [], log: () => {} }),
      ).to.be.rejectedWith(new RegExp(`config "oracles" omits ${wl}`));
    });
  });

  it("L-1: a nomination is attributed to the oracle's owner, not the transaction", async function () {
    const theirs = await newOracle(f.stranger);
    await theirs.transferOwnership(f.deployer.address);
    const p: any = ethers.provider;
    const real = p.getTransaction;
    p.getTransaction = async () => null;
    try {
      const d = await deployerListOracles(f.args);
      expect(d.held).to.not.include(await theirs.getAddress());
      expect(d.nominated).to.deep.equal([
        { oracle: await theirs.getAddress(), by: f.stranger.address },
      ]);
    } finally {
      p.getTransaction = real;
    }
  });

  it("L-2: a deployer-created oracle that keeps the deployer as listManager fails", async function () {
    const kept = await newOracle(f.deployer);
    await kept.setListManager(f.deployer.address);
    await kept.transferOwnership(f.stranger.address);
    await kept.connect(f.stranger).acceptOwnership();
    const ka = await kept.getAddress();
    await expect(
      handoverDeployerPowers({ ...f.args, log: () => {} }),
    ).to.be.rejectedWith(
      new RegExp(`list oracle ${ka} keeps the deployer as listManager`),
    );
    const { failures } = await assertHandoverComplete(f.args);
    expect(
      failures.some(
        (l: string) =>
          l.includes(`list oracle(s) ${ka}`) && l.includes("listManager"),
      ),
    ).to.equal(true);
  });

  it("I-3: a nomination by the deployer's own multisig is refused: accept or cancel", async function () {
    // 2-of-2 of the deployer and the stranger; the stranger executes.
    const ms = await (
      await ethers.getContractFactory("TestMultisig")
    ).deploy([f.deployer.address, f.stranger.address], 2);
    const own = await newOracle(f.deployer);
    const oa = await own.getAddress();
    await own.transferOwnership(await ms.getAddress());
    const run = async (data: string) => {
      const calls = [{ to: oa, value: 0, data }];
      const h = await ms.hashOf(calls);
      await ms.approve(h);
      await ms.connect(f.stranger).approve(h);
      await ms.connect(f.stranger).execute(calls);
    };
    await run(own.interface.encodeFunctionData("acceptOwnership"));
    await run(
      own.interface.encodeFunctionData("transferOwnership", [
        f.deployer.address,
      ]),
    );
    const nonce = await ethers.provider.getTransactionCount(f.deployer.address);
    await expect(
      handoverDeployerPowers({ ...f.args, log: () => {} }),
    ).to.be.rejectedWith(
      new RegExp(
        `list oracle ${oa} names the deployer as pending owner, nominated by its owner ${await ms.getAddress()} \\(created by the deployer.*acceptOwnership.*transferOwnership\\(0x0{40}\\)`,
      ),
    );
    expect(
      await ethers.provider.getTransactionCount(f.deployer.address),
    ).to.equal(nonce);
  });

  /** getLogs refusing any result over `cap` entries, as a provider does. */
  async function capped<T>(cap: number, fn: () => Promise<T>): Promise<T> {
    const p: any = ethers.provider;
    const real = p.getLogs;
    p.getLogs = async (flt: any) => {
      const out = await real.call(p, flt);
      if (out.length > cap)
        throw new Error(`query returned more than ${cap} results`);
      return out;
    };
    try {
      return await fn();
    } finally {
      p.getLogs = real;
    }
  }

  it("M-2: 350 stranger nominations in one block do not stop the ceremony", async function () {
    const theirs = await newOracle(f.stranger);
    const ta = await theirs.getAddress();
    // One nomination the scan sees, then a flood in one block past the cap.
    await theirs.transferOwnership(f.deployer.address);
    await network.provider.send("evm_setAutomine", [false]);
    try {
      for (let i = 0; i < 350; i++)
        await theirs.transferOwnership(f.deployer.address, { gasLimit: 80000 });
      await network.provider.send("evm_mine", []);
    } finally {
      await network.provider.send("evm_setAutomine", [true]);
    }
    const lines: string[] = [];
    const res = await capped(300, async () => {
      await ceremony(f.args, (m) => lines.push(m));
      return assertHandoverComplete(f.args);
    });
    expect(res.failures).to.deep.equal([]);
    expect(lines.some((l) => /capped at block \d+/.test(l))).to.equal(true);
    expect(
      res.warnings.some((w: string) =>
        w.startsWith(
          `list oracle ${ta} names the deployer as pending owner, nominated by ${f.stranger.address}`,
        ),
      ),
    ).to.equal(true);
  });

  it("LOW-2: any error of the address-less scan at one block warns, never refuses", async function () {
    const p: any = ethers.provider;
    const real = p.getLogs;
    p.getLogs = async (flt: any) => {
      if (!flt.address) throw new Error("upstream said no");
      return real.call(p, flt);
    };
    const lines: string[] = [];
    try {
      await ceremony(f.args, (m) => lines.push(m));
    } finally {
      p.getLogs = real;
    }
    expect(
      lines.some((l) =>
        /scan for other list oracles naming the deployer was capped at block \d+/.test(
          l,
        ),
      ),
    ).to.equal(true);
  });
});
