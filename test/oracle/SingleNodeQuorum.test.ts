import { expect } from "chai";
import { ethers } from "hardhat";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import { bindEngine } from "../helpers/oracles";

// Plan v2 Task 5.1. A1F-4: MIN_NODES counted nodes, not weight, so after
// a re-weight one node resolved every query alone (review probe P3); now
// the engine refuses to open a query when the heaviest node alone reaches
// the bar. N11 (Q8 = wire it): a list oracle refuses a verdict fewer than
// minimumConsensusOracles distinct nodes voted for.

const WHITELIST = 1;
const BLACKLIST = 2;
const TIER3 = ethers.AbiCoder.defaultAbiCoder().encode(["uint8"], [3]);

describe("Task 5.1: no single node resolves; the list-oracle voter floor", function () {
  let owner: SignerWithAddress, n1: SignerWithAddress, n2: SignerWithAddress;
  let n3: SignerWithAddress, subject: SignerWithAddress;
  let OM: any, CO: any, WO: any, BO: any;

  beforeEach(async function () {
    [owner, n1, n2, n3, subject] = await ethers.getSigners();
    OM = await (await ethers.getContractFactory("OracleManager")).deploy();
    CO = await bindEngine(OM);
    for (const n of [n1, n2, n3])
      await OM.registerOracle(n.address, "n", "", 500);
    const om = await OM.getAddress();
    WO = await (
      await ethers.getContractFactory("WhitelistOracle")
    ).deploy(om, "WL", "");
    BO = await (
      await ethers.getContractFactory("BlacklistOracle")
    ).deploy(om, "BL", "");
  });

  async function raise(type = WHITELIST, data = TIER3): Promise<string> {
    const rc = await (await OM.submitQuery(subject.address, type, data)).wait();
    return rc.logs
      .map((l: any) => CO.interface.parseLog(l))
      .find((e: any) => e?.name === "ConsensusQueryCreated").args[0];
  }
  const vote = (n: SignerWithAddress, q: string, v: boolean) =>
    OM.connect(n).submitResponse(q, v);
  async function attest(
    oracle: any,
    n: SignerWithAddress,
    q: string,
    v: boolean,
  ) {
    const chainId = (await ethers.provider.getNetwork()).chainId;
    const h = ethers.solidityPackedKeccak256(
      ["address", "bytes32", "bool", "uint256"],
      [subject.address, q, v, chainId],
    );
    const sig = await n.signMessage(ethers.getBytes(h));
    return oracle
      .connect(n)
      .provideAttestation(subject.address, q, v, sig, "0x");
  }

  describe("A1F-4: the heaviest node alone never reaches the bar", function () {
    it("P3 regression: a node re-weighted far above the rest cannot open a query", async function () {
      await OM.setOracleWeight(n1.address, 1000);
      await OM.setOracleWeight(n2.address, 1);
      await OM.setOracleWeight(n3.address, 1);
      await expect(
        OM.connect(n1).submitQuery(subject.address, WHITELIST, TIER3),
      )
        .to.be.revertedWithCustomError(CO, "SingleNodeQuorum")
        .withArgs(n1.address, 1000, 1002);
    });

    it("a 70% node cannot open or resolve; two default nodes can", async function () {
      await OM.setOracleWeight(n1.address, 700);
      await OM.setOracleWeight(n2.address, 150);
      await OM.setOracleWeight(n3.address, 150);
      await expect(raise()).to.be.revertedWithCustomError(
        CO,
        "SingleNodeQuorum",
      );
      for (const n of [n1, n2, n3]) await OM.setOracleWeight(n.address, 100);
      const q = await raise();
      await vote(n1, q, true);
      expect((await OM.getQueryResolution(q))[0]).to.equal(false);
      await vote(n2, q, true);
      expect((await OM.getQueryResolution(q)).slice(0, 2)).to.deep.equal([
        true,
        true,
      ]);
    });

    it("the bar is inclusive: a node at exactly the bar is refused, one unit below opens", async function () {
      // 660 of 1000 at 66%: 66,000 >= 66,000.
      await OM.setOracleWeight(n1.address, 660);
      await OM.setOracleWeight(n2.address, 170);
      await OM.setOracleWeight(n3.address, 170);
      await expect(raise())
        .to.be.revertedWithCustomError(CO, "SingleNodeQuorum")
        .withArgs(n1.address, 660, 1000);
      await OM.setOracleWeight(n3.address, 171); // 660 of 1001: below the bar
      const q = await raise();
      await vote(n1, q, true);
      expect((await OM.getQueryResolution(q))[0]).to.equal(false);
    });

    it("names the heaviest node wherever it sits in the list", async function () {
      await OM.setOracleWeight(n3.address, 900);
      await expect(raise())
        .to.be.revertedWithCustomError(CO, "SingleNodeQuorum")
        .withArgs(n3.address, 900, 1100);
    });

    it("a threshold change can make a node too heavy as well", async function () {
      await OM.setOracleWeight(n1.address, 300); // 300 of 500 = 60%
      await raise();
      await OM.setConsensusThreshold(60);
      await expect(raise()).to.be.revertedWithCustomError(
        CO,
        "SingleNodeQuorum",
      );
    });
  });

  describe("N11: minimumConsensusOracles is enforced on the verdict's side", function () {
    it("both list oracles default to 2", async function () {
      expect(await WO.minimumConsensusOracles()).to.equal(2);
      expect(await BO.minimumConsensusOracles()).to.equal(2);
    });

    it("support is 0 while open and counts the voters of the verdict", async function () {
      const q = await raise();
      await vote(n1, q, true);
      expect(await OM.getQuerySupport(q)).to.equal(0);
      await vote(n2, q, true);
      expect(await OM.getQuerySupport(q)).to.equal(2);
      expect(await CO.votersFor(q, true)).to.equal(2);
      expect(await CO.votersFor(q, false)).to.equal(0);
    });

    it("a two-voter verdict applies at the default floor", async function () {
      const q = await raise();
      await vote(n1, q, true);
      await vote(n2, q, true);
      await expect(attest(WO, n1, q, true)).to.emit(WO, "WhitelistUpdated");
      expect(await WO.isWhitelisted(subject.address)).to.equal(true);
    });

    it("a verdict with fewer voters than the floor is refused", async function () {
      await WO.setMinimumConsensusOracles(3);
      const q = await raise();
      await vote(n1, q, true);
      await vote(n2, q, true);
      await expect(attest(WO, n1, q, true))
        .to.be.revertedWithCustomError(WO, "TooFewVoters")
        .withArgs(2, 3);
      expect(await WO.verdictApplied(q)).to.equal(false);
    });

    it("dissenters do not count toward the floor", async function () {
      await BO.setMinimumConsensusOracles(3);
      const q = await raise(BLACKLIST, "0x");
      await vote(n1, q, true);
      await vote(n2, q, false);
      await vote(n3, q, false); // NO resolves with two of three voters
      expect(await OM.getQuerySupport(q)).to.equal(2);
      await expect(attest(BO, n1, q, false))
        .to.be.revertedWithCustomError(BO, "TooFewVoters")
        .withArgs(2, 3);
    });

    it("an emergency override nobody voted for is refused by the list oracle", async function () {
      const q = await raise(BLACKLIST, "0x");
      await OM.emergencyOverride(n1.address, q, true, "owner");
      expect((await OM.getQueryResolution(q))[0]).to.equal(true);
      expect(await OM.getQuerySupport(q)).to.equal(0);
      await expect(attest(BO, n1, q, true))
        .to.be.revertedWithCustomError(BO, "TooFewVoters")
        .withArgs(0, 2);
      expect(await BO.isBlacklisted(subject.address)).to.equal(false);
    });

    it("an override counts only the nodes that voted its way", async function () {
      const q = await raise(BLACKLIST, "0x");
      await vote(n1, q, true);
      await vote(n2, q, true);
      await OM.emergencyOverride(n1.address, q, false, "owner flip");
      expect(await OM.getQuerySupport(q)).to.equal(0);
      await expect(attest(BO, n1, q, false)).to.be.revertedWithCustomError(
        BO,
        "TooFewVoters",
      );
    });

    // Task 5.1 review L4: support is recorded at resolve, not read from
    // whichever engine is bound when the oracle applies the verdict.
    it("a verdict resolved before an engine rebind still applies", async function () {
      const q = await raise();
      await vote(n1, q, true);
      await vote(n2, q, true);
      await bindEngine(OM);
      expect(await OM.getQuerySupport(q)).to.equal(2);
      await expect(attest(WO, n1, q, true)).to.emit(WO, "WhitelistUpdated");
    });

    it("an override after a rebind counts no voter", async function () {
      const q = await raise(BLACKLIST, "0x");
      await vote(n1, q, true);
      await bindEngine(OM);
      await OM.emergencyOverride(n1.address, q, true, "owner");
      expect(await OM.getQuerySupport(q)).to.equal(0);
    });
  });
});
