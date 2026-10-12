import { expect } from "chai";
import { ethers } from "hardhat";
import { handoverFixture } from "../helpers/governanceFixture";

const { onboard } = require("../../demo/utils/Onboard");

/**
 * Task 4.16 (L-6): the demo's one onboarding path. A wallet gets a
 * factory-made OnchainID (pinned to the factory's KeyManager), the registry
 * entry with its country, both claims and the cache; a second call changes
 * nothing; an existing identity or entry is kept; the claims can be left
 * for the caller (option 11) and a blocked country refuses before any
 * claim is issued.
 */
describe("Onboard.onboard (Task 4.16)", function () {
  let f: Awaited<ReturnType<typeof handoverFixture>>;
  let state: any, stranger: any;

  beforeEach(async function () {
    f = await handoverFixture();
    stranger = f.stranger;
    const byName: Record<string, any> = {
      onchainIDFactory: f.factory,
      identityRegistry: f.c.identityRegistry,
      complianceRules: f.c.complianceRules,
      digitalToken: f.c.token,
      kycIssuer: f.kycIssuer,
      amlIssuer: f.kycIssuer, // the fixture's one issuer serves both topics
    };
    state = {
      signers: await ethers.getSigners(),
      getContract: (n: string) => byName[n],
    };
  });

  it("creates, registers, attests and caches once; a second call does nothing", async function () {
    const r = await onboard(state, stranger.address, { label: "t" });
    expect(r).to.include({
      created: true,
      registered: true,
      attested: true,
      verified: true,
    });
    expect(Object.keys(r.receipts)).to.include.members([
      "deploy",
      "register",
      "kyc",
      "aml",
    ]);
    const id = await ethers.getContractAt("OnchainID", r.identity);
    expect(await id.owner()).to.equal(stranger.address);
    // The factory pinned its KeyManager (Task 4.11) on the new identity.
    expect(await id.recoveryManager()).to.equal(
      await f.keyManager.getAddress(),
    );
    expect(await f.c.identityRegistry.identity(stranger.address)).to.equal(
      r.identity,
    );
    const again = await onboard(state, stranger.address, {
      label: "t",
      attest: false,
    });
    expect(again).to.include({ created: false, registered: false });
    expect(again.identity).to.equal(r.identity);
  });

  it("uses the token's first allowed country by default and the given one otherwise", async function () {
    await onboard(state, stranger.address, { attest: false, cache: false });
    expect(
      await f.c.identityRegistry.investorCountry(stranger.address),
    ).to.equal(840n);
    const other = f.feeWallet;
    await onboard(state, other.address, {
      country: 344,
      attest: false,
      cache: false,
    });
    expect(await f.c.identityRegistry.investorCountry(other.address)).to.equal(
      344n,
    );
  });

  it("a blocked country refuses the entry before any claim is issued", async function () {
    await expect(
      onboard(state, stranger.address, { country: 643, label: "blocked" }),
    ).to.be.rejectedWith(/Country/);
    expect(await f.c.identityRegistry.identity(stranger.address)).to.equal(
      ethers.ZeroAddress,
    );
    const id = await f.factory.getIdentityByOwner(stranger.address);
    expect(id).to.not.equal(ethers.ZeroAddress); // the identity exists
    const oid = await ethers.getContractAt("OnchainID", id);
    expect(await oid.getClaimIdsByTopic(6)).to.deep.equal([]);
  });
});
