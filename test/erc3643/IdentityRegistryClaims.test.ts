import { expect } from "chai";
import { ethers } from "hardhat";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import {
  ClaimIssuer,
  IdentityRegistry,
  OnchainIDFactory,
} from "../../typechain-types";

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
    await registry.addClaimTopic(KYC_TOPIC);
    await registry.addTrustedIssuer(await kycIssuer.getAddress(), [KYC_TOPIC]);
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
    await kycIssuer
      .connect(kycProvider)
      .issueClaim(identityAddr, KYC_TOPIC, 1, KYC_DATA, "", 0);

    expect(await registry.isVerified(investor.address)).to.equal(true);
  });

  it("is NOT verified after the issuer revokes the claim", async function () {
    await kycIssuer
      .connect(kycProvider)
      .issueClaim(identityAddr, KYC_TOPIC, 1, KYC_DATA, "", 0);
    await kycIssuer.connect(kycProvider).revokeClaim(issuerClaimId());

    expect(await registry.isVerified(investor.address)).to.equal(false);
  });

  it("is NOT verified once the claim has expired", async function () {
    const now = (await ethers.provider.getBlock("latest"))!.timestamp;
    await kycIssuer
      .connect(kycProvider)
      .issueClaim(identityAddr, KYC_TOPIC, 1, KYC_DATA, "", now + 100);

    await ethers.provider.send("evm_increaseTime", [200]);
    await ethers.provider.send("evm_mine", []);

    expect(await registry.isVerified(investor.address)).to.equal(false);
  });
});
