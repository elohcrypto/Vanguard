import { expect } from "chai";
import { ethers, network } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import {
  attest,
  configureKyc,
  AML_TOPIC,
  KYC_DATA,
  KYC_TOPIC,
} from "../helpers/kyc";

// Task 4.9 (D17 = a): IdentityRegistry caches a passing claim walk per
// identity. refreshVerified / refreshIdentity are permissionless and
// truth-only; an entry lives until the earlier of refresh + 24h and the
// accepted claims' validTo; addClaimTopic and removeTrustedIssuer void
// every entry. IdentityRegistryClaims.test.ts covers the walk itself.
describe("IdentityRegistry verification cache (Task 4.9)", function () {
  const TTL = 24 * 60 * 60;
  const HOUR = 60 * 60;

  async function deploy() {
    const s = await ethers.getSigners();
    const [owner, kycSigner, amlSigner, alice, bob, carol, stranger] = s;
    const ClaimIssuer = await ethers.getContractFactory("ClaimIssuer");
    const kyc = await ClaimIssuer.deploy(kycSigner.address, "KYC", "KYC");
    const aml = await ClaimIssuer.deploy(amlSigner.address, "AML", "AML");
    const registry = await (
      await ethers.getContractFactory("IdentityRegistry")
    ).deploy();
    await configureKyc(registry, kyc.target as string, aml.target as string);

    const OnchainID = await ethers.getContractFactory("OnchainID");
    const ids: Record<string, string> = {};
    for (const w of [alice, bob, carol]) {
      const id = await OnchainID.deploy(w.address);
      ids[w.address] = id.target as string;
      await registry.registerIdentity(w.address, id.target, 840);
    }
    // alice and bob hold both claims; carol holds none.
    for (const w of [alice, bob]) {
      await attest(kyc, kycSigner, ids[w.address]);
      await attest(aml, amlSigner, ids[w.address], AML_TOPIC);
    }
    const claimId = (issuer: any, id: string, topic: number, data = KYC_DATA) =>
      ethers.solidityPackedKeccak256(
        ["address", "address", "uint256", "bytes"],
        [issuer.target, id, topic, data],
      );
    return {
      ...{ owner, kycSigner, amlSigner, alice, bob, carol, stranger },
      ...{ kyc, aml, registry, ids, claimId, OnchainID },
    };
  }

  const cached = async (registry: any, id: string) =>
    (await registry.verifiedUntil(id))[1];

  it("a fresh entry answers without the walk (estimate at least halves)", async function () {
    const { registry, alice, ids } = await deploy();
    const walk = await registry.isVerified.estimateGas(alice.address);
    expect(await cached(registry, ids[alice.address])).to.equal(0n);

    const gen = await registry.verificationGeneration();
    const tx = await registry.refreshVerified(alice.address);
    const at = BigInt(await time.latest());
    await expect(tx)
      .to.emit(registry, "VerificationRefreshed")
      .withArgs(ids[alice.address], gen, at + BigInt(TTL));
    expect((await registry.verifiedUntil(ids[alice.address]))[0]).to.equal(gen);
    expect(await cached(registry, ids[alice.address])).to.equal(
      at + BigInt(TTL),
    );

    const fast = await registry.isVerified.estimateGas(alice.address);
    expect(fast * 2n).to.be.lte(walk);
    expect(await registry.isVerified(alice.address)).to.equal(true);
  });

  it("the entry lapses after VERIFIED_TTL (time travel)", async function () {
    const { registry, alice, ids } = await deploy();
    expect(await registry.VERIFIED_TTL()).to.equal(BigInt(TTL));
    await registry.refreshVerified(alice.address);
    const until = await cached(registry, ids[alice.address]);

    await time.increaseTo(until - 1n);
    expect(await cached(registry, ids[alice.address])).to.equal(until);
    await time.increaseTo(until);
    expect(await cached(registry, ids[alice.address])).to.equal(0n);
    // Claims never expire here, so the walk still verifies.
    expect(await registry.isVerified(alice.address)).to.equal(true);
  });

  it("the entry is capped at the earliest accepted claim validTo", async function () {
    const { registry, kyc, kycSigner, carol, aml, amlSigner, ids } =
      await deploy();
    const id = ids[carol.address];
    const expiry = (await time.latest()) + HOUR;
    await attest(kyc, kycSigner, id, KYC_TOPIC, expiry);
    await attest(aml, amlSigner, id, AML_TOPIC, expiry + HOUR);

    await registry.refreshIdentity(id);
    expect(await cached(registry, id)).to.equal(BigInt(expiry));

    await time.increaseTo(expiry - 1);
    expect(await registry.isVerified(carol.address)).to.equal(true);
    await time.increaseTo(expiry);
    expect(await cached(registry, id)).to.equal(0n);
    expect(await registry.isVerified(carol.address)).to.equal(false);
  });

  it("revoke then refresh in the same block: unverified at once", async function () {
    const { registry, kyc, kycSigner, alice, stranger, ids, claimId } =
      await deploy();
    const id = ids[alice.address];
    await registry.refreshVerified(alice.address);

    // Both transactions in one block: fixed gas, no estimate against a
    // pending state, receipts read after the block is mined.
    const gasLimit = 500_000n;
    await network.provider.send("evm_setAutomine", [false]);
    let hashes: string[];
    try {
      const revoke = await kyc
        .connect(kycSigner)
        .revokeClaim(claimId(kyc, id, KYC_TOPIC), { gasLimit });
      const refresh = await registry
        .connect(stranger)
        .refreshVerified(alice.address, { gasLimit });
      hashes = [revoke.hash, refresh.hash];
      await network.provider.send("evm_mine");
    } finally {
      await network.provider.send("evm_setAutomine", [true]);
    }
    const [r1, r2] = await Promise.all(
      hashes.map((h) => ethers.provider.getTransactionReceipt(h)),
    );
    expect(r1!.status).to.equal(1);
    expect(r2!.status).to.equal(1);
    expect(r1!.blockNumber).to.equal(r2!.blockNumber);
    const cleared = r2!.logs
      .map((l) => registry.interface.parseLog(l))
      .find((e) => e?.name === "VerificationCleared");
    expect(cleared?.args[0]).to.equal(id);
    expect(await cached(registry, id)).to.equal(0n);
    expect(await registry.isVerified(alice.address)).to.equal(false);
  });

  it("revoke without refresh: verified until the TTL, not after", async function () {
    const { registry, kyc, kycSigner, alice, ids, claimId } = await deploy();
    const id = ids[alice.address];
    await registry.refreshVerified(alice.address);
    const until = await cached(registry, id);
    await kyc.connect(kycSigner).revokeClaim(claimId(kyc, id, KYC_TOPIC));

    expect(await registry.isVerified(alice.address)).to.equal(true);
    await time.increaseTo(until - 1n);
    expect(await registry.isVerified(alice.address)).to.equal(true);
    await time.increaseTo(until);
    expect(await registry.isVerified(alice.address)).to.equal(false);
  });

  it("revoke without refresh: verified until the claim validTo when earlier", async function () {
    const { registry, kyc, kycSigner, carol, aml, amlSigner, ids, claimId } =
      await deploy();
    const id = ids[carol.address];
    const expiry = (await time.latest()) + HOUR;
    await attest(kyc, kycSigner, id, KYC_TOPIC, expiry);
    await attest(aml, amlSigner, id, AML_TOPIC);
    await registry.refreshVerified(carol.address);
    await kyc.connect(kycSigner).revokeClaim(claimId(kyc, id, KYC_TOPIC));

    await time.increaseTo(expiry - 1);
    expect(await registry.isVerified(carol.address)).to.equal(true);
    await time.increaseTo(expiry);
    expect(await registry.isVerified(carol.address)).to.equal(false);
  });

  it("a stranger's refresh cannot cache an unverified identity, and clears a stale one", async function () {
    const f = await deploy();
    const { registry, kyc, kycSigner, alice, carol, stranger, ids } = f;
    const r = registry.connect(stranger);
    expect(await r.refreshVerified.staticCall(carol.address)).to.equal(false);
    await expect(r.refreshVerified(carol.address)).to.not.emit(
      registry,
      "VerificationRefreshed",
    );
    expect(await cached(registry, ids[carol.address])).to.equal(0n);
    expect(await r.refreshVerified.staticCall(stranger.address)).to.equal(
      false,
    );

    await r.refreshVerified(alice.address);
    await kyc
      .connect(kycSigner)
      .revokeClaim(f.claimId(kyc, ids[alice.address], KYC_TOPIC));
    await expect(r.refreshIdentity(ids[alice.address]))
      .to.emit(registry, "VerificationCleared")
      .withArgs(ids[alice.address]);
    expect(await registry.isVerified(alice.address)).to.equal(false);
  });

  it("addClaimTopic voids every entry at once", async function () {
    const { registry, alice, bob, ids } = await deploy();
    const extra = await (
      await ethers.getContractFactory("ClaimIssuer")
    ).deploy(alice.address, "X", "X");
    await registry.refreshVerified(alice.address);
    await registry.refreshVerified(bob.address);
    await registry.addTrustedIssuer(extra.target, [9]);
    const gen = await registry.verificationGeneration();

    await expect(registry.addClaimTopic(9))
      .to.emit(registry, "VerificationCacheVoided")
      .withArgs(gen + 1n);
    for (const w of [alice, bob]) {
      expect(await cached(registry, ids[w.address])).to.equal(0n);
      expect(await registry.isVerified(w.address)).to.equal(false);
    }
  });

  it("removeTrustedIssuer voids every entry: a removed issuer stops counting", async function () {
    const { registry, kycSigner, alice, bob, ids } = await deploy();
    // A second KYC issuer, the only one that attested alice and bob anew.
    const rogue = await (
      await ethers.getContractFactory("ClaimIssuer")
    ).deploy(kycSigner.address, "Rogue", "Rogue");
    await registry.addTrustedIssuer(rogue.target, [KYC_TOPIC]);
    const kycList = await registry.getTrustedIssuersForClaimTopic(KYC_TOPIC);
    const kyc = await ethers.getContractAt("ClaimIssuer", kycList[0]);
    for (const w of [alice, bob]) {
      await attest(rogue, kycSigner, ids[w.address]);
      const cid = ethers.solidityPackedKeccak256(
        ["address", "address", "uint256", "bytes"],
        [kyc.target, ids[w.address], KYC_TOPIC, KYC_DATA],
      );
      await kyc.connect(kycSigner).revokeClaim(cid);
      await registry.refreshVerified(w.address);
      expect(await cached(registry, ids[w.address])).to.not.equal(0n);
    }

    const gen = await registry.verificationGeneration();
    await registry.removeTrustedIssuer(rogue.target);
    expect(await registry.verificationGeneration()).to.equal(gen + 1n);
    for (const w of [alice, bob]) {
      expect(await cached(registry, ids[w.address])).to.equal(0n);
      expect(await registry.isVerified(w.address)).to.equal(false);
    }
  });

  it("deleteIdentity, moveIdentity and updateIdentity leave no wallet verified by a dead entry", async function () {
    const f = await deploy();
    const { registry, alice, bob, carol, stranger, ids } = f;
    for (const w of [alice, bob, carol])
      await registry.refreshVerified(w.address);

    await registry.deleteIdentity(alice.address);
    expect(await registry.isVerified(alice.address)).to.equal(false);

    // Recovery: the same person's identity, entry and all, follows the move.
    await registry.moveIdentity(bob.address, stranger.address);
    expect(await registry.isVerified(bob.address)).to.equal(false);
    expect(await registry.isVerified(stranger.address)).to.equal(true);

    // A new identity is judged on its own claims, not the old entry.
    const fresh = await f.OnchainID.deploy(stranger.address);
    await registry.updateIdentity(stranger.address, fresh.target);
    expect(await registry.isVerified(stranger.address)).to.equal(false);
  });

  it("the trusted path (ComplianceRules) reads the same answer", async function () {
    const f = await deploy();
    const { owner, registry, kyc, kycSigner, alice, carol, ids } = f;
    const rules = await (
      await ethers.getContractFactory("ComplianceRules")
    ).deploy(owner.address, [840], []);
    const token = await (
      await ethers.getContractFactory("Token")
    ).deploy("VSC", "VSC", registry.target, rules.target);
    await rules.setTokenIdentityRegistry(token.target, registry.target);
    const escrow = await (
      await ethers.getContractFactory("MockTarget")
    ).deploy();
    await rules.addTrustedContract(token.target, escrow.target);
    // ComplianceRules reads its per-token config for msg.sender.
    const asToken = await ethers.getImpersonatedSigner(token.target as string);
    const human = (w: string) =>
      rules.connect(asToken).canTransfer.staticCall(w, escrow.target, 1n);

    expect(await human(alice.address)).to.equal(true); // walk
    expect(await human(carol.address)).to.equal(false); // walk
    await registry.refreshVerified(alice.address);
    expect(await human(alice.address)).to.equal(true); // cache
    await kyc
      .connect(kycSigner)
      .revokeClaim(f.claimId(kyc, ids[alice.address], KYC_TOPIC));
    await registry.refreshVerified(alice.address);
    expect(await human(alice.address)).to.equal(false); // cleared
  });

  it("a transfer between two refreshed identities, two topics, costs at most A + 40,000", async function () {
    const { owner, registry, alice, bob } = await deploy();
    const amount = ethers.parseEther("10");
    const measure = async (reg: any) => {
      const rules = await (
        await ethers.getContractFactory("ComplianceRules")
      ).deploy(owner.address, [], []);
      const token = await (
        await ethers.getContractFactory("Token")
      ).deploy("G", "G", reg.target, rules.target);
      await rules.setTokenIdentityRegistry(token.target, reg.target);
      await token.mint(alice.address, ethers.parseEther("100"));
      await token.connect(alice).transfer(bob.address, amount); // warm-up
      const tx = await token.connect(alice).transfer(bob.address, amount);
      return (await tx.wait())!.gasUsed;
    };
    const mock = await (
      await ethers.getContractFactory("MockIdentityRegistry")
    ).deploy();
    await mock.registerIdentity(alice.address, alice.address, 0);
    await mock.registerIdentity(bob.address, bob.address, 0);
    const a = await measure(mock);

    await registry.refreshVerified(alice.address);
    await registry.refreshVerified(bob.address);
    const d = await measure(registry);
    expect(d - a).to.be.lte(40000n);
  });

  // Task 4.10: the same refreshed transfer with an authorized investor-type
  // registry on the token, measured after the sender's cooldown so the
  // clock write overwrites (the first transfer pays the zero-to-nonzero
  // write). Base build ec505cb, same scenario (scripts/gas-analysis.ts E):
  // 133,947 with the registry (caps only), 105,849 without (D), 96,503 A.
  it("Task 4.10: with the registry a refreshed transfer still costs at most A + 40,000", async function () {
    const { owner, registry, alice, bob } = await deploy();
    const amount = ethers.parseEther("10");
    await registry.refreshVerified(alice.address);
    await registry.refreshVerified(bob.address);
    const measure = async (reg: any, withTypes: boolean) => {
      const rules = await (
        await ethers.getContractFactory("ComplianceRules")
      ).deploy(owner.address, [], []);
      const token = await (
        await ethers.getContractFactory("Token")
      ).deploy("G", "G", reg.target, rules.target);
      await rules.setTokenIdentityRegistry(token.target, reg.target);
      if (withTypes) {
        const types = await (
          await ethers.getContractFactory("InvestorTypeRegistry")
        ).deploy();
        await token.setInvestorTypeRegistry(types.target);
        await types.authorizeToken(token.target, true);
      }
      await token.mint(alice.address, ethers.parseEther("100"));
      const first = await token.connect(alice).transfer(bob.address, amount);
      await time.increase(HOUR);
      const tx = await token.connect(alice).transfer(bob.address, amount);
      return [(await tx.wait())!.gasUsed, (await first.wait())!.gasUsed];
    };
    const mock = await (
      await ethers.getContractFactory("MockIdentityRegistry")
    ).deploy();
    await mock.registerIdentity(alice.address, alice.address, 0);
    await mock.registerIdentity(bob.address, bob.address, 0);
    const [a] = await measure(mock, false);
    const [d, dFirst] = await measure(registry, false);
    const [e, eFirst] = await measure(registry, true);
    console.log(
      `      gas: A ${a}; refreshed transfer ${d} without, ${e} with the ` +
        `registry (+${e - d}, A +${e - a}); first transfer ${dFirst} / ` +
        `${eFirst} (+${eFirst - dFirst})`,
    );
    // D17 budget after the sender's first transfer; the registry side
    // (caps, cooldown, clock) measured 29,292 over D after the gas round.
    expect(e - a).to.be.lte(40000n);
    expect(e - d).to.be.lte(30000n);
  });

  it("only positives are cached: a failing refresh does not stop a later attestation verifying", async function () {
    const { registry, kyc, kycSigner, aml, amlSigner, carol, ids } =
      await deploy();
    const id = ids[carol.address];
    expect(await registry.refreshVerified.staticCall(carol.address)).to.equal(
      false,
    );
    await registry.refreshVerified(carol.address);
    const [gen, until] = await registry.verifiedUntil(id);
    expect([gen, until]).to.deep.equal([0n, 0n]);

    await attest(kyc, kycSigner, id);
    await attest(aml, amlSigner, id, AML_TOPIC);
    expect(await registry.isVerified(carol.address)).to.equal(true);
    expect(await cached(registry, id)).to.equal(0n);
  });

  it("an issuer whose claimValidTo reverts (as a missing function does) is never cached and clears", async function () {
    const f = await deploy();
    const { registry, kyc, kycSigner, aml, amlSigner, carol, ids } = f;
    const id = ids[carol.address];
    const noExpiry = await (
      await ethers.getContractFactory("MockClaimIssuer")
    ).deploy();
    await noExpiry.setNoExpiryView(true);
    await registry.addTrustedIssuer(noExpiry.target, [KYC_TOPIC]);
    await attest(aml, amlSigner, id, AML_TOPIC);

    // Cached through the real KYC issuer (first in the topic's list).
    await attest(kyc, kycSigner, id);
    await registry.refreshVerified(carol.address);
    expect(await cached(registry, id)).to.not.equal(0n);

    // The real claim is revoked; only the mock now accepts the topic.
    await kyc.connect(kycSigner).revokeClaim(f.claimId(kyc, id, KYC_TOPIC));
    expect(await registry.refreshVerified.staticCall(carol.address)).to.equal(
      true,
    );
    await expect(registry.refreshVerified(carol.address))
      .to.emit(registry, "VerificationCleared")
      .withArgs(id)
      .and.not.to.emit(registry, "VerificationRefreshed");
    expect(await cached(registry, id)).to.equal(0n);
    expect(await registry.isVerified(carol.address)).to.equal(true); // walk
  });

  it("claimValidTo 0 caches for the full TTL; a past one is not cached", async function () {
    const { registry, aml, amlSigner, carol, ids } = await deploy();
    const id = ids[carol.address];
    const mock = await (
      await ethers.getContractFactory("MockClaimIssuer")
    ).deploy();
    await registry.addTrustedIssuer(mock.target, [KYC_TOPIC]);
    await attest(aml, amlSigner, id, AML_TOPIC);

    await registry.refreshVerified(carol.address);
    const at = BigInt(await time.latest());
    expect(await cached(registry, id)).to.equal(at + BigInt(TTL));

    await mock.setValidTo((await time.latest()) - 1);
    await expect(registry.refreshVerified(carol.address))
      .to.emit(registry, "VerificationCleared")
      .withArgs(id);
    expect(await cached(registry, id)).to.equal(0n);
  });
});
