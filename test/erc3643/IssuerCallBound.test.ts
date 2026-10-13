import { expect } from "chai";
import { ethers } from "hardhat";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import { KYC_TOPIC, attest } from "../helpers/kyc";
const { underCoverage } = require("../helpers/zkProofs") as {
  underCoverage: () => boolean;
};

// Plan v2 Task 5.1, A2F-5: the claim walk staticcalled each trusted issuer
// with all the gas left and copied the whole return data, so an issuer
// that burns gas or returns a megabyte reverted isVerified for every
// uncached identity (review A2 probe Q11). Each call now gets
// ISSUER_CALL_GAS and reads one word (BoundedStaticCall); a failed call is
// "no claim" and the next issuer is asked.

const BURN = 1;
const BOMB = 2;
const BURN_VALID_TO = 3;
const BOMB_VALID_TO = 4;
const WIDE = 5; // "yes" plus 64 KB, within the stipend

describe("Task 5.1: bounded trusted-issuer calls", function () {
  let owner: SignerWithAddress, user: SignerWithAddress;
  let good: any, idA: string, probe: any;

  beforeEach(async function () {
    [owner, user] = await ethers.getSigners();
    good = await (
      await ethers.getContractFactory("ClaimIssuer")
    ).deploy(owner.address, "g", "g");
    const id = await (
      await ethers.getContractFactory("OnchainID")
    ).deploy(user.address);
    idA = await id.getAddress();
    await attest(good, owner, idA, KYC_TOPIC, 2_000_000_000);
    probe = await (await ethers.getContractFactory("IssuerCallProbe")).deploy();
  });

  async function registry(hostileModes: number[]) {
    const r = await (
      await ethers.getContractFactory("IdentityRegistry")
    ).deploy();
    await r.registerIdentity(user.address, idA, 840);
    for (const m of hostileModes) {
      const bad = await (
        await ethers.getContractFactory("HostileIssuer")
      ).deploy(m);
      await r.addTrustedIssuer(await bad.getAddress(), [KYC_TOPIC]);
    }
    await r.addTrustedIssuer(await good.getAddress(), [KYC_TOPIC]);
    await r.addClaimTopic(KYC_TOPIC);
    return r;
  }
  const hasValid = (id: string) =>
    good.interface.encodeFunctionData("hasValidClaim", [id, KYC_TOPIC]);

  it("ISSUER_CALL_GAS covers the honest ClaimIssuer path at least 2x over", async function () {
    const stipend = await (await registry([])).ISSUER_CALL_GAS();
    // Deepest honest path: a live claim, every check read (cold slots).
    const [used, ok] = await probe.cost(await good.getAddress(), hasValid(idA));
    const vt = good.interface.encodeFunctionData("claimValidTo", [
      idA,
      KYC_TOPIC,
    ]);
    const [usedVt] = await probe.cost(await good.getAddress(), vt);
    console.log(
      `      hasValidClaim ${used} gas, claimValidTo ${usedVt} gas, stipend ${stipend}`,
    );
    expect(ok).to.equal(true);
    // Instrumented (coverage) ClaimIssuer costs more: measured, and it must
    // still fit the stipend, but the 3x bound is the plain build's.
    const factor = underCoverage() ? 1n : 3n;
    expect(stipend).to.be.gte(used * factor);
    expect(stipend).to.be.gte(usedVt * factor);
  });

  for (const [mode, what] of [
    [BURN, "burns all the gas it gets"],
    [BOMB, "returns 1 MB"],
  ] as const) {
    it(`an issuer that ${what} ahead of an honest one leaves isVerified true`, async function () {
      const r = await registry([mode]);
      expect(await r.isVerified(user.address)).to.equal(true);
      const gas = await r.isVerified.estimateGas(user.address);
      console.log(`      hostile mode ${mode}: isVerified ${gas} gas`);
      // One stipend wasted, then the honest walk.
      expect(gas).to.be.lt(200_000n);
      for (const limit of [300_000, 3_000_000, 16_000_000]) {
        expect(
          await r.isVerified.staticCall(user.address, { gasLimit: limit }),
        ).to.equal(true);
      }
    });
  }

  it("eight hostile issuers on one topic still verify within a bounded cost", async function () {
    const r = await registry([BURN, BOMB, BURN, BOMB, BURN, BOMB, BURN]);
    expect(await r.isVerified(user.address)).to.equal(true);
    const gas = await r.isVerified.estimateGas(user.address);
    const stipend = await r.ISSUER_CALL_GAS();
    console.log(`      7 hostile + 1 honest: isVerified ${gas} gas`);
    // At most one stipend plus call overhead per issuer, MAX 8 per topic.
    expect(gas).to.be.lt(8n * (stipend + 15_000n) + 50_000n);
  });

  it("an issuer whose only claim view is the hostile one is no claim", async function () {
    const r = await (
      await ethers.getContractFactory("IdentityRegistry")
    ).deploy();
    await r.registerIdentity(user.address, idA, 840);
    const bad = await (
      await ethers.getContractFactory("HostileIssuer")
    ).deploy(BOMB);
    await r.addTrustedIssuer(await bad.getAddress(), [KYC_TOPIC]);
    await r.addClaimTopic(KYC_TOPIC);
    expect(await r.isVerified(user.address)).to.equal(false);
  });

  for (const [mode, what] of [
    [BURN_VALID_TO, "burns gas"],
    [BOMB_VALID_TO, "returns 1 MB"],
  ] as const) {
    it(`a refresh through an issuer whose claimValidTo ${what} verifies and does not cache`, async function () {
      const r = await (
        await ethers.getContractFactory("IdentityRegistry")
      ).deploy();
      await r.registerIdentity(user.address, idA, 840);
      const bad = await (
        await ethers.getContractFactory("HostileIssuer")
      ).deploy(mode);
      await r.addTrustedIssuer(await bad.getAddress(), [KYC_TOPIC]);
      await r.addClaimTopic(KYC_TOPIC);
      expect(await r.refreshVerified.staticCall(user.address)).to.equal(true);
      await r.refreshVerified(user.address);
      expect((await r.verifiedUntil(idA)).until).to.equal(0);
    });
  }

  describe("BoundedStaticCall.word", function () {
    it("returns the first word of an honest answer", async function () {
      const [ok, w] = await probe.word(
        await good.getAddress(),
        hasValid(idA),
        30_000,
      );
      expect([ok, w]).to.deep.equal([true, 1n]);
    });

    it("short return data is not a word", async function () {
      // An EOA returns nothing; a call to it succeeds.
      const [ok, w] = await probe.word(user.address, hasValid(idA), 30_000);
      expect([ok, w]).to.deep.equal([false, 0n]);
    });

    it("reads one word of a 64 KB answer: the caller pays for none of the rest", async function () {
      const wide = await (
        await ethers.getContractFactory("HostileIssuer")
      ).deploy(WIDE);
      const [ok, w, used] = await probe.wordCost(
        await wide.getAddress(),
        hasValid(idA),
        45_000,
      );
      expect([ok, w]).to.deep.equal([true, 1n]);
      // The callee's own 64 KB (2,048 words) costs it 3n + n^2/512 =
      // 14,336 gas. Copying it to the caller would cost that again plus
      // 3 gas a word (20,480): the bound sits between the two.
      const words = 2048n;
      const expand = 3n * words + (words * words) / 512n;
      expect(used).to.be.gt(expand);
      expect(used).to.be.lt(expand + 10_000n);
    });

    it("refuses to run with less gas than the stipend needs", async function () {
      const data = hasValid(idA);
      const target = await good.getAddress();
      await expect(
        probe.word.staticCall(target, data, 1_000_000, { gasLimit: 900_000 }),
      ).to.be.revertedWithCustomError(probe, "StipendUnavailable");
      const [ok] = await probe.word.staticCall(target, data, 1_000_000, {
        gasLimit: 1_200_000,
      });
      expect(ok).to.equal(true);
    });

    it("a refresh starved below the stipend reverts, never answers false", async function () {
      const r = await registry([]);
      await r.refreshVerified(user.address);
      // At every gas limit the refresh either reverts or verifies: a starved
      // issuer call must not read as "no claim" and clear the entry.
      let reverted = 0;
      for (let limit = 30_000; limit <= 110_000; limit += 500) {
        try {
          const res = await r.refreshVerified.staticCall(user.address, {
            gasLimit: limit,
          });
          expect(res, `gas limit ${limit}`).to.equal(true);
        } catch (e: any) {
          if (e.name === "AssertionError") throw e;
          reverted++;
        }
      }
      expect(reverted).to.be.gt(0);
      expect((await r.verifiedUntil(idA)).until).to.not.equal(0);
    });
  });
});
