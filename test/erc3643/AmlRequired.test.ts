import { expect } from "chai";
import { ethers } from "hardhat";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import {
  ClaimIssuer,
  IdentityRegistry,
  OnchainIDFactory,
} from "../../typechain-types";
import {
  configureKyc,
  attest,
  deployIdentity,
  KYC_TOPIC,
  AML_TOPIC,
} from "../helpers/kyc";

// Plan .omc/plans/2026-09-25-zk-kyc-ownership-cleanup-v2.md, section 2.3,
// Task 1R.3: AML (topic 7) is a required claim topic with its own trusted
// issuer, gating transfers alongside KYC (topic 6). A wallet holding a KYC
// claim but no AML claim must not verify.
describe("IdentityRegistry.isVerified requires both KYC and AML claims (plan Task 1R.3)", function () {
  const AML_DATA = ethers.toUtf8Bytes("aml:cleared");

  let owner: SignerWithAddress;
  let kycProvider: SignerWithAddress;
  let amlProvider: SignerWithAddress;
  let investor: SignerWithAddress;
  let factory: OnchainIDFactory;
  let kycIssuer: ClaimIssuer;
  let amlIssuer: ClaimIssuer;
  let registry: IdentityRegistry;
  let identityAddr: string;

  function amlClaimId(): string {
    // ClaimIssuer.issueClaim: keccak256(abi.encodePacked(address(this), identity, topic, data))
    return ethers.solidityPackedKeccak256(
      ["address", "address", "uint256", "bytes"],
      [amlIssuer.target, identityAddr, AML_TOPIC, AML_DATA],
    );
  }

  beforeEach(async function () {
    [owner, kycProvider, amlProvider, investor] = await ethers.getSigners();

    factory = await (
      await ethers.getContractFactory("OnchainIDFactory")
    ).deploy(owner.address, ethers.ZeroHash);
    kycIssuer = await (
      await ethers.getContractFactory("ClaimIssuer")
    ).deploy(kycProvider.address, "KYC Issuer", "Trusted KYC attestations");
    amlIssuer = await (
      await ethers.getContractFactory("ClaimIssuer")
    ).deploy(amlProvider.address, "AML Issuer", "Trusted AML attestations");
    registry = await (
      await ethers.getContractFactory("IdentityRegistry")
    ).deploy();

    identityAddr = await deployIdentity(factory, investor.address);
    await registry.registerIdentity(investor.address, identityAddr, 344);

    await configureKyc(
      registry,
      await kycIssuer.getAddress(),
      await amlIssuer.getAddress(),
    );
  });

  it("is NOT verified with a KYC claim only", async function () {
    await attest(kycIssuer, kycProvider, identityAddr, KYC_TOPIC);

    expect(await registry.isVerified(investor.address)).to.equal(false);
  });

  it("is NOT verified with an AML claim only", async function () {
    await attest(amlIssuer, amlProvider, identityAddr, AML_TOPIC, 0, AML_DATA);

    expect(await registry.isVerified(investor.address)).to.equal(false);
  });

  it("IS verified once both KYC and AML claims are issued", async function () {
    await attest(kycIssuer, kycProvider, identityAddr, KYC_TOPIC);
    await attest(amlIssuer, amlProvider, identityAddr, AML_TOPIC, 0, AML_DATA);

    expect(await registry.isVerified(investor.address)).to.equal(true);
  });

  it("is NOT verified after the AML issuer revokes its claim", async function () {
    await attest(kycIssuer, kycProvider, identityAddr, KYC_TOPIC);
    await attest(amlIssuer, amlProvider, identityAddr, AML_TOPIC, 0, AML_DATA);
    expect(await registry.isVerified(investor.address)).to.equal(true);

    await amlIssuer.connect(amlProvider).revokeClaim(amlClaimId());

    expect(await registry.isVerified(investor.address)).to.equal(false);
  });
});
