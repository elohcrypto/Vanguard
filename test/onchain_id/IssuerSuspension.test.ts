import { expect } from "chai";
import { ethers } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import { attest, configureKyc, KYC_TOPIC } from "../helpers/kyc";

// Task 4.17 slice C (D43 a): an inactive issuer's claims stop counting,
// reversibly. A wallet whose verification the registry cached (D17)
// keeps it until the cache's TTL lapses; an uncached one is unverified
// at once.
describe("Issuer suspension (D43 a)", function () {
  async function deploy() {
    const [owner, alice, bob] = await ethers.getSigners();
    const D = async (n: string, ...a: unknown[]) =>
      (await ethers.getContractFactory(n)).deploy(...a) as Promise<any>;
    const registry = await D("IdentityRegistry");
    const issuer = await D("ClaimIssuer", owner.address, "KYC", "d");
    await configureKyc(registry, await issuer.getAddress());
    const ids: string[] = [];
    for (const w of [alice, bob]) {
      const id = await D("OnchainID", w.address);
      await registry.registerIdentity(w.address, id.target, 840);
      await attest(issuer, owner, id.target as string);
      ids.push(id.target as string);
    }
    return { owner, alice, bob, registry, issuer, ids };
  }

  it("setActive(false) voids every claim; setActive(true) restores them", async function () {
    const { alice, registry, issuer, ids } = await deploy();
    expect(await issuer.hasValidClaim(ids[0], KYC_TOPIC)).to.equal(true);
    await issuer.setActive(false);
    expect(await issuer.hasValidClaim(ids[0], KYC_TOPIC)).to.equal(false);
    expect(await registry.isVerified(alice.address)).to.equal(false);
    await issuer.setActive(true);
    expect(await issuer.hasValidClaim(ids[0], KYC_TOPIC)).to.equal(true);
    expect(await registry.isVerified(alice.address)).to.equal(true);
  });

  it("a cached verification lasts until its TTL (D17), then the suspension holds", async function () {
    const { alice, bob, registry, issuer, ids } = await deploy();
    await registry.refreshVerified(alice.address);
    const [, until] = await registry.verifiedUntil(ids[0]);
    await issuer.setActive(false);
    expect(await registry.isVerified(alice.address)).to.equal(true);
    expect(await registry.isVerified(bob.address)).to.equal(false);
    await time.increaseTo(until + 1n);
    expect(await registry.isVerified(alice.address)).to.equal(false);
    await expect(registry.refreshVerified(alice.address)).to.not.emit(
      registry,
      "VerificationRefreshed",
    );
  });
});
