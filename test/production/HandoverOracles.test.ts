import { expect } from "chai";
import { ethers, network } from "hardhat";
import { handoverFixture } from "../helpers/governanceFixture";

const {
  acceptAllByVote,
  assertHandoverComplete,
  handoverDeployerPowers,
} = require("../../demo/utils/Handover");
const { preflightOracles } = require("../../demo/utils/HandoverOracles");

/**
 * Plan v2 Task 4.4: the ceremony proves OracleManager binds the compiled
 * ConsensusOracle engine built for it (the engine has no owner, nothing is
 * handed over) and makes ops the manager's operator. The preflight refuses,
 * before any transaction, a manager with no engine, an engine without code,
 * with foreign code or serving another manager, and an operator other than
 * ops once the deployer no longer owns the manager.
 */
describe("Handover: oracle engine and operator (Task 4.4)", function () {
  let f: Awaited<ReturnType<typeof handoverFixture>>;
  let om: any;
  const quiet = () => {};

  beforeEach(async function () {
    f = await handoverFixture();
    om = f.c.oracleManager;
  });

  async function refused(re: RegExp) {
    const nonce = await ethers.provider.getTransactionCount(f.deployer.address);
    await expect(handoverDeployerPowers(f.args)).to.be.rejectedWith(re);
    expect(
      await ethers.provider.getTransactionCount(f.deployer.address),
    ).to.equal(nonce);
  }

  /** The storage slot holding consensusEngine (found, not hard-coded). */
  async function engineSlot(): Promise<string> {
    const engine = (await om.consensusEngine()).toLowerCase().slice(2);
    for (let i = 0; i < 32; i++) {
      const slot = ethers.toBeHex(i, 32);
      const v = await ethers.provider.getStorage(await om.getAddress(), slot);
      if (v.endsWith(engine)) return slot;
    }
    throw new Error("consensusEngine slot not found");
  }

  it("ceremony: ops becomes the operator; the engine lines pass", async function () {
    expect(await om.operator()).to.equal(ethers.ZeroAddress);
    const report = await handoverDeployerPowers(f.args);
    await acceptAllByVote({
      governance: f.c.governance,
      contracts: f.c,
      proposer: f.proposer,
      voters: f.voters,
      registryProposals: report.registryProposals,
      log: quiet,
    });
    expect(await om.operator()).to.equal(f.ops.address);
    expect(report.steps).to.include(
      `OracleManager operator: ops ${f.ops.address}`,
    );
    const { ok, checks } = await assertHandoverComplete(f.args);
    expect(ok).to.equal(true);
    const labels = checks.map((c: any) => c.label);
    expect(labels).to.include(
      `OracleManager ${await om.getAddress()} consensus engine ${await om.consensusEngine()} is the compiled ConsensusOracle and serves this manager`,
    );
    expect(labels).to.include(
      `OracleManager operator (pause, unpause, emergency designation) is ops ${f.ops.address}, not the deployer`,
    );
    // After the handover only ops (and governance) pause; the deployer cannot.
    const node = f.stranger.address;
    await expect(
      om.connect(f.deployer).pauseOracle(node),
    ).to.be.revertedWithCustomError(om, "NotOwnerOrOperator");
  });

  it("refuses a manager with no engine", async function () {
    await network.provider.send("hardhat_setStorageAt", [
      await om.getAddress(),
      await engineSlot(),
      ethers.ZeroHash,
    ]);
    await refused(/OracleManager .* has no consensus engine/);
  });

  it("refuses an engine without code", async function () {
    await network.provider.send("hardhat_setCode", [
      await om.consensusEngine(),
      "0x",
    ]);
    await refused(/consensus engine 0x[0-9a-fA-F]{40} has no code/);
  });

  it("refuses an engine whose code is not the compiled ConsensusOracle", async function () {
    // A BlacklistOracle answers oracleManager() with this manager.
    const look = await (
      await ethers.getContractFactory("BlacklistOracle")
    ).deploy(await om.getAddress(), "look-alike", "");
    await om.setConsensusEngine(await look.getAddress());
    await refused(
      /runtime code hash 0x[0-9a-f]{64} is not the compiled ConsensusOracle/,
    );
  });

  it("refuses an engine that serves another manager", async function () {
    const engine = await om.consensusEngine();
    await network.provider.send("hardhat_setStorageAt", [
      engine,
      ethers.ZeroHash, // ConsensusOracle slot 0: oracleManager
      ethers.zeroPadValue(f.stranger.address, 32),
    ]);
    await refused(/does not serve OracleManager/);
  });

  it("refuses an operator other than ops once the deployer no longer owns the manager", async function () {
    // Seen from a key that is not the manager's owner (as after step 3).
    const o = { ...f.args, deployer: f.stranger };
    await expect(preflightOracles(o)).to.be.rejectedWith(
      /OracleManager operator is 0x0{40}, not ops .*OracleParameters vote/,
    );
    await om.setOperator(f.stranger.address);
    await expect(preflightOracles(o)).to.be.rejectedWith(
      /operator is the deployer .*setOperator\(ops\)/,
    );
    await om.setOperator(f.ops.address);
    await preflightOracles(o);
  });
});
