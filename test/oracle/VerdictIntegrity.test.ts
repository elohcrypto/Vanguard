import { expect } from "chai";
import { ethers, network } from "hardhat";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";

// Plan 2F.3 (review H3, L4). A resolved OracleManager verdict is applied by
// BlacklistOracle / WhitelistOracle at most once, only while fresh, never
// over a newer list write, with the severity fixed when the query was raised.
// Scenarios (a)-(c) are the reviewer's probe-b3 replays.

const BLACKLIST = 2;
const WHITELIST = 1;
const DAY = 86400;
const LOW = 0;
const MEDIUM = 1;
const HIGH = 2;
const CRITICAL = 3;
const coder = ethers.AbiCoder.defaultAbiCoder();
const sev = (s: number) => coder.encode(["uint8"], [s]);

async function inc(seconds: number) {
  await network.provider.send("evm_increaseTime", [seconds]);
  await network.provider.send("evm_mine");
}
async function now() {
  return BigInt((await ethers.provider.getBlock("latest"))!.timestamp);
}

describe("Oracle verdict integrity (2F.3)", function () {
  let owner: SignerWithAddress, n1: SignerWithAddress, n2: SignerWithAddress;
  let n3: SignerWithAddress, n4: SignerWithAddress, victim: SignerWithAddress;
  let sanctioned: SignerWithAddress, stranger: SignerWithAddress;
  let OM: any, BO: any, WO: any, DLM: any;
  let chainId: bigint;

  beforeEach(async function () {
    [owner, n1, n2, n3, n4, victim, sanctioned, stranger] =
      await ethers.getSigners();
    OM = await (await ethers.getContractFactory("OracleManager")).deploy();
    const om = await OM.getAddress();
    for (const n of [n1, n2, n3, n4]) {
      await OM["registerOracle(address,string,string,uint256)"](
        n.address,
        "node",
        "",
        500,
      );
    }
    BO = await (
      await ethers.getContractFactory("BlacklistOracle")
    ).deploy(om, "BL", "");
    WO = await (
      await ethers.getContractFactory("WhitelistOracle")
    ).deploy(om, "WL", "");
    DLM = await (
      await ethers.getContractFactory("DynamicListManager")
    ).deploy(owner.address);
    await DLM.setOracles(await WO.getAddress(), await BO.getAddress());
    await BO.setListManager(await DLM.getAddress());
    await WO.setListManager(await DLM.getAddress());
    chainId = (await ethers.provider.getNetwork()).chainId;
  });

  const sign = (w: SignerWithAddress, subj: string, q: string, r: boolean) =>
    w.signMessage(
      ethers.getBytes(
        ethers.solidityPackedKeccak256(
          ["address", "bytes32", "bool", "uint256"],
          [subj, q, r, chainId],
        ),
      ),
    );

  // Raise a query (by node n1 unless `by`) and, when `verdict` is given,
  // resolve it 3-of-4.
  async function query(
    subj: string,
    type: number,
    verdict: boolean | null,
    data = "0x",
    by?: SignerWithAddress,
  ): Promise<string> {
    const raiser = by ?? n1;
    const tx = await OM.connect(raiser).submitQuery(subj, type, data);
    const blk = await ethers.provider.getBlock((await tx.wait()).blockNumber);
    const q = ethers.solidityPackedKeccak256(
      ["address", "uint8", "bytes", "uint256", "address"],
      [subj, type, data, blk!.timestamp, raiser.address],
    );
    if (verdict !== null) {
      for (const n of [n1, n2, n3]) {
        await OM.connect(n).submitResponse(q, verdict);
      }
    }
    return q;
  }

  const attest = async (
    oracle: any,
    by: SignerWithAddress,
    subj: string,
    q: string,
    r: boolean,
    data = "0x",
  ) =>
    oracle
      .connect(by)
      .provideAttestation(subj, q, r, await sign(by, subj, q, r), data);

  describe("probe-b3 replays are refused", function () {
    it("(a) a governance NO_EXPIRY sanction survives a replayed old clear verdict", async function () {
      const qClear = await query(sanctioned.address, BLACKLIST, false);
      await inc(90 * DAY);
      await DLM.addToBlacklist(
        sanctioned.address,
        1,
        CRITICAL,
        ethers.MaxUint256,
        "sanctions vote",
      );
      await expect(
        attest(BO, n1, sanctioned.address, qClear, false),
      ).to.be.revertedWithCustomError(BO, "VerdictSuperseded");
      expect(await BO.isBlacklisted(sanctioned.address)).to.equal(true);
    });

    it("(a') the same holds for a fresh clear verdict resolved before the sanction", async function () {
      const qClear = await query(sanctioned.address, BLACKLIST, false);
      await DLM.addToBlacklist(
        sanctioned.address,
        1,
        CRITICAL,
        ethers.MaxUint256,
        "sanctions vote",
      );
      await expect(
        attest(BO, n1, sanctioned.address, qClear, false),
      ).to.be.revertedWithCustomError(BO, "VerdictSuperseded");
      expect(await BO.isBlacklisted(sanctioned.address)).to.equal(true);
    });

    it("(b) severity comes from the query; a cleared holder is not re-listed", async function () {
      const qFlag = await query(victim.address, BLACKLIST, true, sev(LOW));
      // The relayer asks for CRITICAL; the query says LOW (7 days).
      await attest(BO, n1, victim.address, qFlag, true, sev(CRITICAL));
      const e = await BO.blacklistEntries(victim.address);
      expect(e.severity).to.equal(LOW);
      expect(e.expiryTime - (await now())).to.equal(BigInt(7 * DAY));

      await DLM.removeFromBlacklist(victim.address, 7, "governance cleared");
      await inc(200 * DAY);
      await expect(
        attest(BO, n2, victim.address, qFlag, true, sev(CRITICAL)),
      ).to.be.revertedWithCustomError(BO, "VerdictAlreadyApplied");
      expect(await BO.isBlacklisted(victim.address)).to.equal(false);
    });

    it("(c) a whitelist removal survives a replayed approval", async function () {
      const qW = await query(victim.address, WHITELIST, true);
      await attest(WO, n1, victim.address, qW, true);
      expect(await WO.isWhitelisted(victim.address)).to.equal(true);
      await DLM.removeFromWhitelist(victim.address, 7, "KYC withdrawn");
      await expect(
        attest(WO, n3, victim.address, qW, true),
      ).to.be.revertedWithCustomError(WO, "VerdictAlreadyApplied");
      expect(await WO.isWhitelisted(victim.address)).to.equal(false);
    });
  });

  describe("single use, ordering, freshness", function () {
    it("a fresh verdict applies once; a second oracle's attestation is refused", async function () {
      const q = await query(victim.address, BLACKLIST, true);
      expect(await BO.verdictApplied(q)).to.equal(false);
      await attest(BO, n1, victim.address, q, true);
      expect(await BO.verdictApplied(q)).to.equal(true);
      const e = await BO.blacklistEntries(victim.address);
      expect(e.severity).to.equal(MEDIUM); // query carried no severity
      await expect(
        attest(BO, n2, victim.address, q, true),
      ).to.be.revertedWithCustomError(BO, "VerdictAlreadyApplied");
    });

    it("a verdict that changes nothing is still consumed", async function () {
      const q = await query(victim.address, BLACKLIST, false); // not listed
      await attest(BO, n1, victim.address, q, false);
      expect(await BO.verdictApplied(q)).to.equal(true);
      await BO.addToBlacklist(victim.address, LOW, DAY, "owner");
      await expect(
        attest(BO, n2, victim.address, q, false),
      ).to.be.revertedWithCustomError(BO, "VerdictAlreadyApplied");
      expect(await BO.isBlacklisted(victim.address)).to.equal(true);
    });

    it("a removal is a newer write: an older flag verdict cannot undo it", async function () {
      await BO.addToBlacklist(victim.address, LOW, 30 * DAY, "owner");
      await inc(60);
      const q = await query(victim.address, BLACKLIST, true); // resolved, not applied
      await inc(60);
      await DLM.removeFromBlacklist(victim.address, 7, "governance cleared");
      await expect(
        attest(BO, n1, victim.address, q, true),
      ).to.be.revertedWithCustomError(BO, "VerdictSuperseded");
      expect(await BO.isBlacklisted(victim.address)).to.equal(false);
    });

    it("an emergency listing is never undone by an older clear verdict", async function () {
      await BO.setEmergencyOracle(n4.address, true);
      const q = await query(victim.address, BLACKLIST, false);
      await inc(60);
      await BO.connect(n4).emergencyBlacklist(victim.address, CRITICAL, "e");
      await expect(
        attest(BO, n1, victim.address, q, false),
      ).to.be.revertedWithCustomError(BO, "VerdictSuperseded");
      expect(await BO.isBlacklisted(victim.address)).to.equal(true);
    });

    it("whitelist: a governance approval outranks an older rejection", async function () {
      const q = await query(victim.address, WHITELIST, false);
      await inc(60);
      await DLM.addToWhitelist(victim.address, 7, 3, 30 * DAY, "KYC ok");
      await expect(
        attest(WO, n1, victim.address, q, false),
      ).to.be.revertedWithCustomError(WO, "VerdictSuperseded");
      expect(await WO.isWhitelisted(victim.address)).to.equal(true);
    });

    it("a verdict older than maxVerdictAge is refused on both oracles", async function () {
      expect(await BO.maxVerdictAge()).to.equal(DAY);
      expect(await WO.maxVerdictAge()).to.equal(DAY);
      const qb = await query(victim.address, BLACKLIST, true);
      const qw = await query(victim.address, WHITELIST, true);
      await inc(DAY + 10);
      await expect(
        attest(BO, n1, victim.address, qb, true),
      ).to.be.revertedWithCustomError(BO, "VerdictExpired");
      await expect(
        attest(WO, n1, victim.address, qw, true),
      ).to.be.revertedWithCustomError(WO, "VerdictExpired");
      // The owner may widen the window; the same verdicts then apply.
      await BO.setMaxVerdictAge(2 * DAY);
      await WO.setMaxVerdictAge(2 * DAY);
      await attest(BO, n1, victim.address, qb, true);
      await attest(WO, n1, victim.address, qw, true);
      expect(await BO.isBlacklisted(victim.address)).to.equal(true);
      expect(await WO.isWhitelisted(victim.address)).to.equal(true);
    });

    it("maxVerdictAge is owner-only and bounded to [1 hour, 30 days]", async function () {
      for (const o of [BO, WO]) {
        await expect(
          o.setMaxVerdictAge(3600 - 1),
        ).to.be.revertedWithCustomError(o, "InvalidVerdictAge");
        await expect(
          o.setMaxVerdictAge(30 * DAY + 1),
        ).to.be.revertedWithCustomError(o, "InvalidVerdictAge");
        await expect(o.connect(stranger).setMaxVerdictAge(3600)).to.be.reverted;
        await expect(o.setMaxVerdictAge(3600))
          .to.emit(o, "MaxVerdictAgeUpdated")
          .withArgs(DAY, 3600);
        await o.setMaxVerdictAge(30 * DAY);
        expect(await o.maxVerdictAge()).to.equal(30 * DAY);
      }
    });

    it("attestations before resolution are kept per oracle and apply nothing", async function () {
      const q = await query(victim.address, BLACKLIST, null);
      await OM.connect(n1).submitResponse(q, true);
      await attest(BO, n1, victim.address, q, true);
      await attest(BO, n2, victim.address, q, true, "0x1234");
      expect(await BO.verdictApplied(q)).to.equal(false);
      expect(await BO.isBlacklisted(victim.address)).to.equal(false);
      const a1 = await BO.attestations(q, n1.address);
      const a2 = await BO.attestations(q, n2.address);
      expect(a1.isValid && a2.isValid).to.equal(true);
      const [, , oracle] = await BO.getAttestation(victim.address, q);
      expect(oracle).to.equal(n2.address);
      // Resolution, then the next attestation applies it once.
      await OM.connect(n2).submitResponse(q, true);
      await OM.connect(n3).submitResponse(q, true);
      await attest(BO, n3, victim.address, q, true);
      expect(await BO.isBlacklisted(victim.address)).to.equal(true);
    });
  });

  describe("ordering by resolution time (2F.3 review MEDIUM-1)", function () {
    // Two contrary verdicts: the first resolves, an hour later the second.
    async function pair(type: number, first: boolean) {
      const older = await query(victim.address, type, first);
      await inc(3600);
      const newer = await query(victim.address, type, !first);
      return { older, newer };
    }

    it("P1: an older flag applied first is overridden by the newer clear", async function () {
      const { older, newer } = await pair(BLACKLIST, true);
      await inc(600);
      // Nothing on-chain knows of the unapplied newer verdict yet.
      await attest(BO, n1, victim.address, older, true);
      expect(await BO.isBlacklisted(victim.address)).to.equal(true);
      const [, , tOlder] = await OM.getQueryResolution(older);
      expect(await BO.lastWriteAt(victim.address)).to.equal(tOlder);
      await attest(BO, n2, victim.address, newer, false);
      expect(await BO.isBlacklisted(victim.address)).to.equal(false);
    });

    it("P1b: a newer clear consumed as a no-op still refuses the older flag", async function () {
      const { older, newer } = await pair(BLACKLIST, true);
      await attest(BO, n2, victim.address, newer, false);
      const [, , tNewer] = await OM.getQueryResolution(newer);
      expect(await BO.lastWriteAt(victim.address)).to.equal(tNewer);
      await expect(
        attest(BO, n1, victim.address, older, true),
      ).to.be.revertedWithCustomError(BO, "VerdictSuperseded");
      expect(await BO.isBlacklisted(victim.address)).to.equal(false);
    });

    it("P1w: whitelist, a newer rejection beats an older approval either way", async function () {
      let { older, newer } = await pair(WHITELIST, true);
      await attest(WO, n1, victim.address, older, true);
      await attest(WO, n2, victim.address, newer, false);
      expect(await WO.isWhitelisted(victim.address)).to.equal(false);
      ({ older, newer } = await pair(WHITELIST, true));
      await attest(WO, n2, victim.address, newer, false); // no-op, consumed
      await expect(
        attest(WO, n1, victim.address, older, true),
      ).to.be.revertedWithCustomError(WO, "VerdictSuperseded");
      expect(await WO.isWhitelisted(victim.address)).to.equal(false);
    });

    it("M11: an older flag after a consensus clear is superseded", async function () {
      await BO.addToBlacklist(victim.address, LOW, 30 * DAY, "owner");
      await inc(60);
      const { older, newer } = await pair(BLACKLIST, true);
      await attest(BO, n2, victim.address, newer, false); // clears
      expect(await BO.isBlacklisted(victim.address)).to.equal(false);
      await expect(
        attest(BO, n1, victim.address, older, true),
      ).to.be.revertedWithCustomError(BO, "VerdictSuperseded");
    });

    it("M12: an older approval after a consensus rejection is superseded", async function () {
      await WO.addToWhitelist(victim.address, 3, 30 * DAY, "owner");
      await inc(60);
      const { older, newer } = await pair(WHITELIST, true);
      await attest(WO, n2, victim.address, newer, false); // rejects
      expect(await WO.isWhitelisted(victim.address)).to.equal(false);
      await expect(
        attest(WO, n1, victim.address, older, true),
      ).to.be.revertedWithCustomError(WO, "VerdictSuperseded");
    });

    it("M16: a governance whitelist removal supersedes an older approval", async function () {
      await DLM.addToWhitelist(victim.address, 7, 3, 30 * DAY, "KYC ok");
      await inc(60);
      const q = await query(victim.address, WHITELIST, true); // not applied
      await inc(60);
      await DLM.removeFromWhitelist(victim.address, 7, "KYC withdrawn");
      await expect(
        attest(WO, n1, victim.address, q, true),
      ).to.be.revertedWithCustomError(WO, "VerdictSuperseded");
      expect(await WO.isWhitelisted(victim.address)).to.equal(false);
    });

    it("M2/M14: a verdict resolved in the same block as an owner write is refused", async function () {
      const raw = async (from: string, to: string, data: string) =>
        network.provider.send("eth_sendTransaction", [
          { from, to, data, gas: "0x7a1200" },
        ]);
      for (const [O, type, write] of [
        [
          BO,
          BLACKLIST,
          BO.interface.encodeFunctionData("addToBlacklist", [
            victim.address,
            LOW,
            DAY,
            "owner",
          ]),
        ],
        [
          WO,
          WHITELIST,
          WO.interface.encodeFunctionData("addToWhitelist", [
            victim.address,
            3,
            DAY,
            "owner",
          ]),
        ],
      ] as [any, number, string][]) {
        const q = await query(victim.address, type, null);
        await OM.connect(n1).submitResponse(q, true);
        await OM.connect(n2).submitResponse(q, true);
        await network.provider.send("evm_setAutomine", [false]);
        try {
          const resolve = OM.interface.encodeFunctionData("submitResponse", [
            q,
            true,
          ]);
          await raw(n3.address, await OM.getAddress(), resolve);
          await raw(owner.address, await O.getAddress(), write);
          await network.provider.send("evm_mine");
        } finally {
          await network.provider.send("evm_setAutomine", [true]);
        }
        const [has, , at] = await OM.getQueryResolution(q);
        expect(has).to.equal(true);
        expect(await O.lastWriteAt(victim.address)).to.equal(at);
        await expect(
          attest(O, n1, victim.address, q, true),
        ).to.be.revertedWithCustomError(O, "VerdictSuperseded");
      }
    });
  });

  describe("OracleManager: who raises queries, resolution is final", function () {
    it("only the owner or an active oracle may raise a query", async function () {
      await expect(
        OM.connect(stranger).submitQuery(victim.address, BLACKLIST, "0x"),
      ).to.be.revertedWithCustomError(OM, "UnauthorizedQueryCreator");
      await OM.connect(owner).submitQuery(victim.address, BLACKLIST, "0x");
      await OM.connect(n2).submitQuery(victim.address, WHITELIST, "0x99");
      await OM.deactivateOracle(n2.address);
      await expect(
        OM.connect(n2).submitQuery(victim.address, BLACKLIST, "0x"),
      ).to.be.revertedWithCustomError(OM, "UnauthorizedQueryCreator");
    });

    it("a blacklist query carries no severity or one well-formed severity", async function () {
      await expect(
        OM.connect(n1).submitQuery(victim.address, BLACKLIST, sev(4)),
      ).to.be.revertedWithCustomError(OM, "InvalidSeverity");
      await expect(
        OM.connect(n1).submitQuery(victim.address, BLACKLIST, "0x01"),
      ).to.be.revertedWithCustomError(OM, "InvalidSeverity");
      const q = await query(victim.address, BLACKLIST, null, sev(HIGH));
      expect(await OM.getQueryData(q)).to.equal(sev(HIGH));
    });

    it("LOW-1: only the owner raises a CRITICAL blacklist query", async function () {
      await expect(
        OM.connect(n1).submitQuery(victim.address, BLACKLIST, sev(CRITICAL)),
      ).to.be.revertedWithCustomError(OM, "SeverityRequiresOwner");
      for (const s of [LOW, MEDIUM, HIGH]) {
        await OM.connect(n1).submitQuery(victim.address, BLACKLIST, sev(s));
      }
      // P4: owner-raised CRITICAL plus a threshold "yes" lists for 365 days.
      const q = await query(
        victim.address,
        BLACKLIST,
        true,
        sev(CRITICAL),
        owner,
      );
      await attest(BO, n1, victim.address, q, true);
      const e = await BO.blacklistEntries(victim.address);
      expect(e.severity).to.equal(CRITICAL);
      expect(e.expiryTime - e.timestamp).to.equal(BigInt(365 * DAY));
    });

    it("resolvedAt is set once, when the verdict first resolves", async function () {
      const q = await query(victim.address, BLACKLIST, null);
      await OM.connect(n1).submitResponse(q, true);
      await OM.connect(n2).submitResponse(q, true);
      let [has, , at] = await OM.getQueryResolution(q);
      expect(has).to.equal(false);
      expect(at).to.equal(0);
      await OM.connect(n3).submitResponse(q, true);
      const t = await now();
      [has, , at] = await OM.getQueryResolution(q);
      expect(has).to.equal(true);
      expect(at).to.equal(t);
      await inc(100);
      await OM.emergencyOverride(n1.address, q, false, "owner flip");
      const [, res, at2] = await OM.getQueryResolution(q);
      expect(res).to.equal(false);
      expect(at2).to.equal(t);
    });

    it("submitResponse is refused once the query resolved", async function () {
      const q = await query(victim.address, BLACKLIST, true);
      await expect(
        OM.connect(n4).submitResponse(q, false),
      ).to.be.revertedWithCustomError(OM, "QueryAlreadyResolved");
      expect((await OM.checkConsensus(q)).toString()).to.equal("true,true");
    });
  });
});
