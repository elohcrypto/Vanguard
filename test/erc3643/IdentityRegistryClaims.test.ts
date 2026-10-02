import { expect } from "chai";
import { ethers } from "hardhat";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import {
  ClaimIssuer,
  IdentityRegistry,
  OnchainIDFactory,
} from "../../typechain-types";
import { issueSigned } from "../helpers/kyc";

// Guard tests from .omc/plans/2026-09-23-zk-kyc-ownership-cleanup.md, Task 0.2.
// "Verified" must mean "holds a live claim from a trusted issuer on every
// required topic", not "an agent called registerIdentity". They fail today and
// are made to pass in Phase 1 (Tasks 1.1-1.4).
// Observed RED on 2026-09-23 (4 of 5 failed: registration alone verified);
// made GREEN by Phase 1 (claim-checking isVerified).
describe("IdentityRegistry.isVerified requires trusted-issuer claims (plan Task 0.2)", function () {
  const KYC_TOPIC = 6;
  const KYC_DATA = ethers.toUtf8Bytes("kyc:passed");

  let owner: SignerWithAddress;
  let kycProvider: SignerWithAddress;
  let investor: SignerWithAddress;
  let factory: OnchainIDFactory;
  let kycIssuer: ClaimIssuer;
  let registry: IdentityRegistry;
  let identityAddr: string;

  function issuerClaimId(): string {
    // ClaimIssuer.issueClaim: keccak256(abi.encodePacked(address(this), identity, topic, data))
    return ethers.solidityPackedKeccak256(
      ["address", "address", "uint256", "bytes"],
      [kycIssuer.target, identityAddr, KYC_TOPIC, KYC_DATA],
    );
  }

  beforeEach(async function () {
    [owner, kycProvider, investor] = await ethers.getSigners();

    factory = await (
      await ethers.getContractFactory("OnchainIDFactory")
    ).deploy(owner.address);
    kycIssuer = await (
      await ethers.getContractFactory("ClaimIssuer")
    ).deploy(kycProvider.address, "KYC Issuer", "Trusted KYC attestations");
    registry = await (
      await ethers.getContractFactory("IdentityRegistry")
    ).deploy();

    await factory.deployOnchainID(investor.address, ethers.randomBytes(32));
    identityAddr = await factory.getIdentityByOwner(investor.address);

    // The agent binds wallet, identity and country. That alone must not verify.
    await registry.registerIdentity(investor.address, identityAddr, 344);

    // The registry owner names the required topic and who may attest to it.
    await registry.addTrustedIssuer(await kycIssuer.getAddress(), [KYC_TOPIC]);
    await registry.addClaimTopic(KYC_TOPIC);
  });

  it("is NOT verified when the wallet is registered but holds no claim", async function () {
    expect(await registry.isVerified(investor.address)).to.equal(false);
  });

  it("is NOT verified by a self-added claim naming the trusted issuer with an empty signature", async function () {
    const identity = await ethers.getContractAt("OnchainID", identityAddr);
    await identity
      .connect(investor)
      .addClaim(KYC_TOPIC, 1, kycIssuer.target, "0x", KYC_DATA, "");

    expect(await registry.isVerified(investor.address)).to.equal(false);
  });

  it("IS verified once the trusted issuer has issued the claim", async function () {
    await issueSigned(
      kycIssuer,
      kycProvider,
      identityAddr,
      KYC_TOPIC,
      KYC_DATA,
      "",
      0,
    );

    expect(await registry.isVerified(investor.address)).to.equal(true);
  });

  it("is NOT verified after the issuer revokes the claim", async function () {
    await issueSigned(
      kycIssuer,
      kycProvider,
      identityAddr,
      KYC_TOPIC,
      KYC_DATA,
      "",
      0,
    );
    await kycIssuer.connect(kycProvider).revokeClaim(issuerClaimId());

    expect(await registry.isVerified(investor.address)).to.equal(false);
  });

  it("is NOT verified once the claim has expired", async function () {
    const now = (await ethers.provider.getBlock("latest"))!.timestamp;
    await issueSigned(
      kycIssuer,
      kycProvider,
      identityAddr,
      KYC_TOPIC,
      KYC_DATA,
      "",
      now + 100,
    );

    await ethers.provider.send("evm_increaseTime", [200]);
    await ethers.provider.send("evm_mine", []);

    expect(await registry.isVerified(investor.address)).to.equal(false);
  });

  // Plan 2026-09-25-zk-kyc-ownership-cleanup-v2, section 2.3, Task 1R.1: a
  // registry with zero required topics must fail closed, not verify by
  // registration alone.
  it("is NOT verified when the registry has no required topics", async function () {
    const freshRegistry = await (
      await ethers.getContractFactory("IdentityRegistry")
    ).deploy();

    // No addClaimTopic call: this registry requires nothing.
    await freshRegistry.registerIdentity(investor.address, identityAddr, 344);

    expect(await freshRegistry.isVerified(investor.address)).to.equal(false);
  });

  // Plan section 2.3, Task 1R.8 / D16 bounded the registry's scan of the
  // identity's claim list at 8, which let junk claims bury a valid one (and,
  // per the 2026-09-30 review H2, anyone could add them). Since 2F.2 the
  // registry asks the trusted issuer and never reads that list, so junk
  // claims naming the trusted issuer change nothing.
  it("junk self-claims naming the trusted issuer do not bury a valid claim (2F.2)", async function () {
    const identity = await ethers.getContractAt("OnchainID", identityAddr);
    const kycIssuerAddr = await kycIssuer.getAddress();

    for (let i = 0; i < 8; i++) {
      const junkData = ethers.toUtf8Bytes(`junk-claim-${i}`);
      await identity
        .connect(investor)
        .addClaim(KYC_TOPIC, 1, kycIssuerAddr, "0x", junkData, "");
    }
    expect(await registry.isVerified(investor.address)).to.equal(false);

    await issueSigned(
      kycIssuer,
      kycProvider,
      identityAddr,
      KYC_TOPIC,
      KYC_DATA,
      "",
      0,
    );

    expect(await registry.isVerified(investor.address)).to.equal(true);
  });

  // Plan section 2.3, Task 1R.8: a claim issued by an issuer the registry
  // does not trust for the topic must not verify the wallet, regardless of
  // whether the claim itself is otherwise valid.
  it("a claim from an untrusted issuer does not verify", async function () {
    const untrustedIssuer = await (
      await ethers.getContractFactory("ClaimIssuer")
    ).deploy(
      kycProvider.address,
      "Untrusted Issuer",
      "Not trusted by this registry",
    );

    // Deliberately never call registry.addTrustedIssuer for this issuer.
    await issueSigned(
      untrustedIssuer,
      kycProvider,
      identityAddr,
      KYC_TOPIC,
      KYC_DATA,
      "",
      0,
    );

    expect(await registry.isVerified(investor.address)).to.equal(false);
  });
});
