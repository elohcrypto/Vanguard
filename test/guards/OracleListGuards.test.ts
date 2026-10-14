import { expect } from "chai";
import { ethers } from "hardhat";
import { bindEngine } from "../helpers/oracles";

// Plan v2 Task 5.3: oracle, list-manager and verifier guards no test
// reached before (4.17 had filed most "defensive"), each reachable by
// its caller and asserted by its reason.
describe("Oracle, list-manager and verifier guards (Task 5.3)", function () {
  const Z = ethers.ZeroAddress;
  const deployC = async (name: string, ...a: unknown[]): Promise<any> =>
    (await ethers.getContractFactory(name)).deploy(...a);

  async function oracles() {
    const [owner, node, stranger] = await ethers.getSigners();
    const om = await deployC("OracleManager");
    await bindEngine(om);
    await om.registerOracle(node.address, "n", "", 500);
    const wo = await deployC("WhitelistOracle", om.target, "WL", "");
    const bo = await deployC("BlacklistOracle", om.target, "BL", "");
    return { owner, node, stranger, om, wo, bo };
  }

  it("both list oracles' constructors refuse a zero or codeless manager", async function () {
    const { stranger } = await oracles();
    for (const [name, zero, eoa] of [
      [
        "WhitelistOracle",
        "WhitelistOracle: Invalid oracle manager",
        "WhitelistOracle: Oracle manager is not a contract",
      ],
      [
        "BlacklistOracle",
        "BlacklistOracle: Invalid oracle manager",
        "BlacklistOracle: Oracle manager is not a contract",
      ],
    ]) {
      const F = await ethers.getContractFactory(name);
      await expect(F.deploy(Z, "n", "")).to.be.revertedWith(zero);
      await expect(F.deploy(stranger.address, "n", "")).to.be.revertedWith(eoa);
    }
  });

  it("provideAttestation refuses the zero subject, and a caller that is not an active node", async function () {
    const { node, stranger, wo, bo } = await oracles();
    const q = ethers.id("q");
    await expect(
      wo.connect(node).provideAttestation(Z, q, true, "0x", "0x"),
    ).to.be.revertedWith("WhitelistOracle: Invalid subject");
    await expect(
      bo.connect(node).provideAttestation(Z, q, true, "0x", "0x"),
    ).to.be.revertedWith("BlacklistOracle: Invalid subject");
    await expect(
      bo
        .connect(stranger)
        .provideAttestation(stranger.address, q, true, "0x", "0x"),
    ).to.be.revertedWith("BlacklistOracle: Not an active oracle");
  });

  it("the blacklist's direct entries refuse the zero subject and an unlisted removal", async function () {
    const { stranger, bo } = await oracles();
    const BAD = "BlacklistOracle: Invalid subject";
    await expect(bo.addToBlacklist(Z, 1, 3600, "r")).to.be.revertedWith(BAD);
    await expect(
      bo.batchAddToBlacklist([Z], [1], 3600, "r"),
    ).to.be.revertedWith(BAD);
    await expect(bo.removeFromBlacklist(Z, "r")).to.be.revertedWith(BAD);
    await expect(
      bo.removeFromBlacklist(stranger.address, "r"),
    ).to.be.revertedWith("BlacklistOracle: Not blacklisted");
  });

  it("OracleManager refuses a zero subject and a vote on an unknown query", async function () {
    const { node, om } = await oracles();
    await expect(om.submitQuery(Z, 2, "0x")).to.be.revertedWith(
      "OracleManager: Invalid subject",
    );
    await expect(
      om.connect(node).submitResponse(ethers.id("unknown"), true),
    ).to.be.revertedWith("OracleManager: Query does not exist");
  });

  it("DynamicListManager refuses the zero governance and the zero user on every list call", async function () {
    const [owner] = await ethers.getSigners();
    const dlm = await deployC("DynamicListManager", owner.address);
    await expect(dlm.setGovernanceContract(Z)).to.be.revertedWith(
      "Invalid governance address",
    );
    const BAD = "Invalid user address";
    await expect(dlm.addToWhitelist(Z, 0, 1, 3600, "r")).to.be.revertedWith(
      BAD,
    );
    await expect(dlm.addToBlacklist(Z, 0, 1, 3600, "r")).to.be.revertedWith(
      BAD,
    );
    await expect(dlm.removeFromBlacklist(Z, 0, "r")).to.be.revertedWith(BAD);
    await expect(dlm.removeFromWhitelist(Z, 0, "r")).to.be.revertedWith(BAD);
  });

  it("verifyBatchWhitelistMembership refuses mismatched and empty batches", async function () {
    const zk = await deployC("ZKVerifierIntegrated", false);
    const proof = Array(24).fill(0n);
    await expect(
      zk.verifyBatchWhitelistMembership([proof], []),
    ).to.be.revertedWith("Array length mismatch");
    await expect(zk.verifyBatchWhitelistMembership([], [])).to.be.revertedWith(
      "Invalid batch size",
    );
  });
});
