import { expect } from "chai";
import { ethers } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import { anyUint } from "@nomicfoundation/hardhat-chai-matchers/withArgs";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import { attest, configureKyc } from "../helpers/kyc";
import { bindEngine } from "../helpers/oracles";

// Task 4.12: a whitelist query names (wallet, tier); the nodes vote on that
// one question and the verdict lists at exactly that tier, never a constant.
// The manager refuses a tier outside 1..5 (or any other payload shape) at
// submit, and only the owner raises tier 5 (R-412-1, R-412-2). Re-listing
// and rejection follow R-412-4 and R-412-5.
describe("Whitelist consensus tier (Task 4.12)", function () {
  const WHITELIST = 1;
  const BLACKLIST = 2;
  const COMPLIANCE = 4;
  const T = { Accredited: 2, Institutional: 3 };
  const YEAR = 365 * 86400;
  const coder = ethers.AbiCoder.defaultAbiCoder();
  const tierData = (t: number) => coder.encode(["uint8"], [t]);

  let owner: SignerWithAddress, stranger: SignerWithAddress;
  let n1: SignerWithAddress, n2: SignerWithAddress, n3: SignerWithAddress;
  let OM: any, CO: any, WO: any;

  beforeEach(async function () {
    [owner, n1, n2, n3, stranger] = await ethers.getSigners();
    OM = await (await ethers.getContractFactory("OracleManager")).deploy();
    CO = await bindEngine(OM);
    for (const n of [n1, n2, n3]) {
      await OM.registerOracle(n.address, "node", "", 500);
      await OM.setOracleWeight(n.address, 100);
    }
    WO = await (
      await ethers.getContractFactory("WhitelistOracle")
    ).deploy(await OM.getAddress(), "WL", "d");
  });

  async function raise(
    subject: string,
    data: string,
    by: SignerWithAddress = n1,
    type = WHITELIST,
  ): Promise<string> {
    const rc = await (
      await OM.connect(by).submitQuery(subject, type, data)
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

  /** Raise (subject, tier), resolve it `verdict` two of three. */
  async function resolved(
    subject: string,
    tier: number,
    verdict: boolean,
    by: SignerWithAddress = n1,
  ) {
    const q = await raise(subject, tierData(tier), by);
    await OM.connect(n1).submitResponse(q, verdict);
    await OM.connect(n2).submitResponse(q, verdict);
    expect((await OM.getQueryResolution(q)).slice(0, 2)).to.deep.equal([
      true,
      verdict,
    ]);
    return q;
  }

  /** Node `by` applies the verdict; `meta` is the relayer's free bytes. */
  async function apply(
    subject: string,
    q: string,
    r: boolean,
    by: SignerWithAddress = n3,
    meta = "0x",
  ) {
    const { chainId } = await ethers.provider.getNetwork();
    const sig = await by.signMessage(
      ethers.getBytes(
        ethers.solidityPackedKeccak256(
          ["address", "bytes32", "bool", "uint256"],
          [subject, q, r, chainId],
        ),
      ),
    );
    return WO.connect(by).provideAttestation(subject, q, r, sig, meta);
  }

  const entry = async (who: string) => {
    const i = await WO.getWhitelistInfo(who);
    return {
      live: i[0],
      at: i[1],
      expiry: i[2],
      tier: Number(i[3]),
      reason: i[4] as string,
    };
  };

  describe("submit: the tier is validated when the query opens", function () {
    it("a tier outside 1..5 or any other payload shape is refused", async function () {
      const who = stranger.address;
      for (const bad of [
        "0x", // old shape: no tier
        tierData(0),
        tierData(6),
        coder.encode(["uint256"], [ethers.MaxUint256]),
        "0x03",
        coder.encode(["uint8", "uint8"], [3, 3]),
        coder.encode(["string"], ["KYC_APPROVED"]),
      ]) {
        for (const by of [owner, n1]) {
          await expect(
            OM.connect(by).submitQuery(who, WHITELIST, bad),
          ).to.be.revertedWithCustomError(OM, "InvalidTier");
        }
      }
    });

    it("tiers 1..4 by an active node; tier 5 by the owner only", async function () {
      for (const t of [1, 2, 3, 4]) {
        const q = await raise(stranger.address, tierData(t), n1);
        expect(await OM.getQueryData(q)).to.equal(tierData(t));
      }
      await expect(
        OM.connect(n1).submitQuery(stranger.address, WHITELIST, tierData(5)),
      ).to.be.revertedWithCustomError(OM, "TierRequiresOwner");
      const q = await raise(stranger.address, tierData(5), owner);
      expect(await OM.getQueryData(q)).to.equal(tierData(5));
      // A stranger is refused before the payload is read.
      await expect(
        OM.connect(stranger).submitQuery(n1.address, WHITELIST, tierData(3)),
      ).to.be.revertedWithCustomError(OM, "UnauthorizedQueryCreator");
    });

    it("the tier rule is the whitelist's: other types keep their payloads", async function () {
      await raise(stranger.address, "0x", n1, BLACKLIST);
      await raise(stranger.address, "0x", n1, COMPLIANCE);
      await raise(stranger.address, coder.encode(["string"], ["x"]), n1, 3);
    });
  });

  describe("apply: the verdict lists at the voted tier", function () {
    for (const t of [1, 2, 3, 4, 5]) {
      it(`an approval of (wallet, ${t}) lists at tier ${t}`, async function () {
        const who = ethers.Wallet.createRandom().address;
        const q = await resolved(who, t, true, t === 5 ? owner : n1);
        await expect(apply(who, q, true))
          .to.emit(WO, "WhitelistUpdated")
          .withArgs(who, true, t, anyUint, "Oracle consensus approval");
        const e = await entry(who);
        expect([e.live, e.tier, e.expiry]).to.deep.equal([
          true,
          t,
          e.at + BigInt(YEAR),
        ]);
      });
    }

    it("the relayer cannot name another tier: its bytes are metadata", async function () {
      const who = stranger.address;
      const q = await resolved(who, 2, true);
      await apply(who, q, true, n3, tierData(5));
      expect((await entry(who)).tier).to.equal(2);
    });
  });

  describe("re-listing and rejection (R-412-4, R-412-5)", function () {
    it("an approval at another tier raises or lowers a live entry, keeping its expiry", async function () {
      const who = stranger.address;
      await WO.addToWhitelist(who, 2, ethers.MaxUint256, "owner, no expiry");
      await time.increase(60);
      let q = await resolved(who, 4, true);
      await expect(apply(who, q, true))
        .to.emit(WO, "WhitelistUpdated")
        .withArgs(who, true, 4, 0, "Oracle consensus tier change");
      expect(await entry(who)).to.deep.include({ live: true, tier: 4 });
      expect((await entry(who)).expiry).to.equal(0n);
      q = await resolved(who, 1, true);
      await apply(who, q, true);
      expect(await entry(who)).to.deep.include({ live: true, tier: 1 });
    });

    it("an approval at the same tier changes nothing and is consumed", async function () {
      const who = stranger.address;
      await WO.addToWhitelist(who, 3, 30 * 86400, "owner");
      const before = await WO.getWhitelistInfo(who);
      await time.increase(60);
      const q = await resolved(who, 3, true);
      await expect(apply(who, q, true)).to.not.emit(WO, "WhitelistUpdated");
      expect(await WO.getWhitelistInfo(who)).to.deep.equal(before);
      expect(await WO.verdictApplied(q)).to.equal(true);
    });

    it("a rejection of (wallet, T) delists an entry at T or above, not below", async function () {
      const who = stranger.address;
      await WO.addToWhitelist(who, 3, 0, "owner");
      await time.increase(60);
      // "Not a tier-4 party" does not contradict a tier-3 listing.
      let q = await resolved(who, 4, false);
      await expect(apply(who, q, false)).to.not.emit(WO, "WhitelistUpdated");
      expect(await entry(who)).to.deep.include({ live: true, tier: 3 });
      // "Not even tier 2" removes the tier-3 listing.
      q = await resolved(who, 2, false);
      await expect(apply(who, q, false))
        .to.emit(WO, "WhitelistUpdated")
        .withArgs(who, false, 0, 0, "Oracle consensus rejection");
      expect((await entry(who)).live).to.equal(false);
    });

    it("a lapsed entry re-lists at the voted tier (review B N-d)", async function () {
      const who = stranger.address;
      await WO.addToWhitelist(who, 1, 60, "short");
      await time.increase(120);
      expect(await WO.isWhitelisted(who)).to.equal(false);
      const q = await resolved(who, 4, true);
      await apply(who, q, true);
      const e = await entry(who);
      expect([e.live, e.tier, e.reason]).to.deep.equal([
        true,
        4,
        "Oracle consensus approval",
      ]);
    });

    it("a blacklist verdict is not a whitelist verdict and leaves the tier", async function () {
      const who = stranger.address;
      await WO.addToWhitelist(who, 4, 0, "owner");
      await time.increase(60);
      const q = await raise(who, "0x", n1, BLACKLIST);
      await OM.connect(n1).submitResponse(q, true);
      await OM.connect(n2).submitResponse(q, true);
      await expect(apply(who, q, true)).to.be.revertedWithCustomError(
        WO,
        "QuerySubjectMismatch",
      );
      expect(await entry(who)).to.deep.include({ live: true, tier: 4 });
    });
  });

  describe("the Task 4.10 tier rule on an OracleOnly token", function () {
    it("Institutional (tier 4+): a consensus listing at 4 passes, at 2 is refused", async function () {
      const [, , , , , treasury, inst, other] = await ethers.getSigners();
      const deployC = async (name: string, ...a: unknown[]) =>
        (await ethers.getContractFactory(name)).deploy(...a) as Promise<any>;
      const registry = await deployC("IdentityRegistry");
      const issuer = await deployC("ClaimIssuer", owner.address, "KYC", "d");
      await configureKyc(registry, await issuer.getAddress());
      const OnchainID = await ethers.getContractFactory("OnchainID");
      for (const w of [treasury, inst, other]) {
        const id = await OnchainID.deploy(w.address);
        await registry.registerIdentity(w.address, id.target, 840);
        await attest(issuer, owner, id.target as string);
      }
      const rules = await deployC("ComplianceRules", owner.address, [840], []);
      const token = await deployC(
        "Token",
        "VSC",
        "VSC",
        registry.target,
        rules.target,
      );
      await rules.setTokenIdentityRegistry(token.target, registry.target);
      const types = await deployC("InvestorTypeRegistry");
      await token.setInvestorTypeRegistry(types.target);
      await types.authorizeToken(token.target, true);
      await rules.setWhitelistOracle(token.target, WO.target);
      await types.setInvestorLimitExempt(treasury.address, true);
      expect(await rules.whitelistMode(token.target)).to.equal(0); // OracleOnly
      await types.assignInvestorType(inst.address, T.Institutional);
      expect(await types.getRequiredWhitelistTier(inst.address)).to.equal(4);
      for (const w of [treasury, other]) {
        await WO.addToWhitelist(w.address, 5, 0, "kyc");
      }
      await token.mint(treasury.address, ethers.parseEther("10"));

      // Consensus lists the Institutional party at tier 2: refused.
      let q = await resolved(inst.address, 2, true);
      await apply(inst.address, q, true);
      expect(await WO.isWhitelisted(inst.address)).to.equal(true);
      expect(await rules.whitelistTierAllows(token.target, inst.address)).to.be
        .false;
      expect(await token.canTransfer(treasury.address, inst.address, 1n)).to.be
        .false;
      await expect(
        token.connect(treasury).transfer(inst.address, 1n),
      ).to.be.revertedWith("Compliance check failed");

      // A later verdict at tier 4: the party passes and receives.
      await time.increase(60);
      q = await resolved(inst.address, 4, true);
      await apply(inst.address, q, true);
      expect((await entry(inst.address)).tier).to.equal(4);
      expect(await rules.whitelistTierAllows(token.target, inst.address)).to.be
        .true;
      await token.connect(treasury).transfer(inst.address, 1n);
      expect(await token.balanceOf(inst.address)).to.equal(1n);
    });
  });
});
