import { expect } from "chai";
import { ethers } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import { anyUint } from "@nomicfoundation/hardhat-chai-matchers/withArgs";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import { bindEngine } from "../helpers/oracles";

// Task 4.12 fix round. R-412-7: a consensus approval of (wallet, T) means
// "qualifies for at least T": it lists, or raises a live entry below T,
// and never lowers (lowering is the owner's or list manager's). L-1: a
// raise caps the expiry at a fresh listing's. R-412-8: verdicts stay
// ordered by resolution time, not by when the query was raised. L-2: the
// oracle re-checks the tier it reads back from the manager.
describe("Whitelist consensus raises only (Task 4.12, R-412-7/8)", function () {
  const WHITELIST = 1;
  const YEAR = 365n * 86400n;
  const NO_EXPIRY = ethers.MaxUint256;
  const coder = ethers.AbiCoder.defaultAbiCoder();
  const tierData = (t: number) => coder.encode(["uint8"], [t]);

  let owner: SignerWithAddress, lm: SignerWithAddress, who: string;
  let n1: SignerWithAddress, n2: SignerWithAddress, n3: SignerWithAddress;
  let OM: any, CO: any, WO: any;

  beforeEach(async function () {
    let w: SignerWithAddress;
    [owner, n1, n2, n3, lm, w] = await ethers.getSigners();
    who = w.address;
    OM = await (await ethers.getContractFactory("OracleManager")).deploy();
    CO = await bindEngine(OM);
    for (const n of [n1, n2, n3]) {
      await OM.registerOracle(n.address, "node", "", 500);
      await OM.setOracleWeight(n.address, 100);
    }
    WO = await (
      await ethers.getContractFactory("WhitelistOracle")
    ).deploy(await OM.getAddress(), "WL", "d");
    await WO.setListManager(lm.address);
  });

  /** Raise (who, tier) by `by`; the engine's query id. */
  async function raise(tier: number, by: SignerWithAddress = n1) {
    const rc = await (
      await OM.connect(by).submitQuery(who, WHITELIST, tierData(tier))
    ).wait();
    return rc.logs
      .map((l: any) => {
        try {
          return CO.interface.parseLog(l);
        } catch {
          return null;
        }
      })
      .find((e: any) => e?.name === "ConsensusQueryCreated").args[0];
  }
  const resolve = async (q: string, v: boolean) => {
    await OM.connect(n1).submitResponse(q, v);
    await OM.connect(n2).submitResponse(q, v);
  };
  async function resolved(tier: number, v: boolean, by = n1) {
    const q = await raise(tier, by);
    await resolve(q, v);
    return q;
  }
  async function apply(q: string, r: boolean, oracle: any = WO) {
    const { chainId } = await ethers.provider.getNetwork();
    const sig = await n3.signMessage(
      ethers.getBytes(
        ethers.solidityPackedKeccak256(
          ["address", "bytes32", "bool", "uint256"],
          [who, q, r, chainId],
        ),
      ),
    );
    return oracle.connect(n3).provideAttestation(who, q, r, sig, "0x");
  }
  const info = () => WO.getWhitelistInfo(who);
  const tierOf = async () => Number((await info())[3]);

  describe("R-412-7: an approval never lowers", function () {
    for (const held of [4, 5]) {
      it(`a tier-1 approval on a tier-${held} entry is a consumed no-op`, async function () {
        await WO.connect(lm).addToWhitelist(who, held, 0, "list manager");
        const before = await info();
        await time.increase(60);
        const q = await resolved(1, true);
        await expect(apply(q, true)).to.not.emit(WO, "WhitelistUpdated");
        expect(await info()).to.deep.equal(before);
        expect(await WO.verdictApplied(q)).to.equal(true);
      });
    }

    it("a tier-5 owner-raised approval raises a tier-4 entry", async function () {
      await WO.addToWhitelist(who, 4, 30 * 86400, "owner");
      await time.increase(60);
      const q = await resolved(5, true, owner);
      await expect(apply(q, true))
        .to.emit(WO, "WhitelistUpdated")
        .withArgs(who, true, 5, anyUint, "Oracle consensus tier raise");
      expect(await tierOf()).to.equal(5);
    });

    it("a tier-1 rejection on a tier-4 entry delists (not even tier 1)", async function () {
      await WO.addToWhitelist(who, 4, 0, "owner");
      await time.increase(60);
      const q = await resolved(1, false);
      await apply(q, false);
      expect(await WO.isWhitelisted(who)).to.equal(false);
    });

    it("lowering stays with the list manager", async function () {
      await WO.addToWhitelist(who, 5, 0, "owner");
      await WO.connect(lm).addToWhitelist(who, 2, 0, "restricted");
      expect(await tierOf()).to.equal(2);
    });
  });

  describe("L-1: a raise caps the expiry at a fresh listing's", function () {
    it("a no-expiry tier-1 entry raised to 4 lasts DEFAULT_WHITELIST_DURATION", async function () {
      await WO.connect(lm).addToWhitelist(who, 1, NO_EXPIRY, "restricted");
      expect((await info())[2]).to.equal(0n);
      await time.increase(60);
      const q = await resolved(4, true);
      await apply(q, true);
      const i = await info();
      expect([i[0], Number(i[3])]).to.deep.equal([true, 4]);
      expect(i[2]).to.equal(i[1] + YEAR); // set in the raising block
    });

    it("a sooner expiry is kept", async function () {
      await WO.addToWhitelist(who, 1, 30 * 86400, "owner");
      const expiry = (await info())[2];
      await time.increase(60);
      await apply(await resolved(3, true), true);
      expect([await tierOf(), (await info())[2]]).to.deep.equal([3, expiry]);
    });
  });

  describe("probe d and R-412-8: ordered by resolution, not raise", function () {
    it("a tier-1 approval raised before a tier-5 write, resolved after: no-op", async function () {
      await WO.addToWhitelist(who, 4, 0, "owner");
      await time.increase(60);
      const q = await raise(1); // asked before the write
      await WO.connect(lm).addToWhitelist(who, 5, 0, "governance vote");
      await time.increase(60);
      await resolve(q, true);
      await expect(apply(q, true)).to.not.emit(WO, "WhitelistUpdated");
      expect(await tierOf()).to.equal(5);
    });

    it("a verdict resolved after a write applies though raised before it", async function () {
      // A rejection asked before the list manager's write, decided after
      // it: the network's judgment as of resolution applies (the same
      // majority could raise the question afresh).
      const q = await raise(3);
      await time.increase(60);
      await WO.connect(lm).addToWhitelist(who, 3, 0, "list manager");
      await time.increase(60);
      await resolve(q, false);
      await apply(q, false);
      expect(await WO.isWhitelisted(who)).to.equal(false);
    });

    it("overlapping queries: the later resolution wins, whatever the raise order", async function () {
      const qReject = await raise(3); // raised first
      await time.increase(60);
      const qApprove = await raise(3); // raised second
      await resolve(qApprove, true); // resolved first
      await time.increase(60);
      await resolve(qReject, false); // resolved last
      await apply(qApprove, true);
      expect(await WO.isWhitelisted(who)).to.equal(true);
      // Keyed on raise time this newest verdict would be refused.
      await apply(qReject, false);
      expect(await WO.isWhitelisted(who)).to.equal(false);
    });

    it("a verdict resolved at or before a write stays refused (2F.3)", async function () {
      const q = await resolved(4, true);
      await time.increase(60);
      await WO.connect(lm).addToWhitelist(who, 1, 0, "list manager");
      await expect(apply(q, true)).to.be.revertedWithCustomError(
        WO,
        "VerdictSuperseded",
      );
      expect(await tierOf()).to.equal(1);
    });
  });

  describe("L-2: the oracle re-checks the tier it reads back", function () {
    it("empty data, tier 0 and tier 6 from the manager are refused", async function () {
      const mock = await (
        await ethers.getContractFactory("MockQueryManager")
      ).deploy();
      const wo = await (
        await ethers.getContractFactory("WhitelistOracle")
      ).deploy(await mock.getAddress(), "WL", "d");
      for (const [i, bad] of ["0x", tierData(0), tierData(6)].entries()) {
        await mock.setQuery(who, WHITELIST, bad);
        await expect(
          apply(ethers.id(`q${i}`), true, wo),
        ).to.be.revertedWithCustomError(wo, "InvalidQueryTier");
      }
      await mock.setQuery(who, WHITELIST, tierData(2));
      await apply(ethers.id("ok"), true, wo);
      expect((await wo.getWhitelistInfo(who))[3]).to.equal(2n);
    });
  });
});
