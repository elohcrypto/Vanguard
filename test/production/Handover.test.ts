import { expect } from "chai";
import { ethers } from "hardhat";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import {
  KYC_DATA,
  KYC_TOPIC,
  configureKyc,
  deployIdentity,
  issueSigned,
  signClaim,
} from "../helpers/kyc";

// Guard test from .omc/plans/2026-09-23-zk-kyc-ownership-cleanup.md, Task 0.3.
// After the handover ceremony (Phase 2, Task 2.4) the deploying key must hold
// no power at all, governance must own the core contracts, an ops multisig
// must hold the operational roles, and a guardian must be able to pause but
// not unpause. Today the deployer keeps everything, so this fails.
//
// Phase 2 replaces the `handover` stub below with `scripts/handover.ts`.
// PENDING until Phase 2: observed RED on 2026-09-23 (4 of 4 fail: deployer owns
// everything, guardian cannot pause). Change `describe.skip` to `describe` in Task 2.4.
// The two ClaimIssuer cases (deployer cannot issue, ops can) are plan v2 Task
// 2B.4 (D8); they describe the target state and go green in Phase 2C, when
// `handover` runs the issuer ceremony proven by the live describe below.
describe.skip("Deployer holds no power after handover (plan Task 0.3)", function () {
  let deployer: SignerWithAddress;
  let governance: SignerWithAddress; // stands in for VanguardGovernance until Task 2.4
  let ops: SignerWithAddress;
  let guardian: SignerWithAddress;
  let token: any;
  let identityRegistry: any;
  let complianceRules: any;
  let oracleManager: any;
  let kycIssuer: any;
  let investor: SignerWithAddress;
  let identityAddr: string;

  async function handover(): Promise<void> {
    // Task 2.4 wires the real ceremony here. Intentionally empty so the
    // assertions below describe the target state, not today's state.
  }

  beforeEach(async function () {
    [deployer, governance, ops, guardian, investor] = await ethers.getSigners();

    identityRegistry = await (
      await ethers.getContractFactory("IdentityRegistry")
    ).deploy();
    complianceRules = await (
      await ethers.getContractFactory("ComplianceRules")
    ).deploy(deployer.address, [840, 344], []);
    token = await (
      await ethers.getContractFactory("Token")
    ).deploy(
      "Vanguard StableCoin",
      "VSC",
      await identityRegistry.getAddress(),
      await complianceRules.getAddress(),
    );
    oracleManager = await (
      await ethers.getContractFactory("OracleManager")
    ).deploy();

    // KYC issuer owned by the deployer, trusted by the registry for topic 6,
    // plus one registered investor identity with no claim yet.
    kycIssuer = await (
      await ethers.getContractFactory("ClaimIssuer")
    ).deploy(deployer.address, "KYC Issuer", "Trusted KYC attestations");
    await configureKyc(identityRegistry, await kycIssuer.getAddress());
    const factory = await (
      await ethers.getContractFactory("OnchainIDFactory")
    ).deploy(deployer.address);
    identityAddr = await deployIdentity(factory, investor.address);
    await identityRegistry.registerIdentity(
      investor.address,
      identityAddr,
      344,
    );

    await handover();
  });

  it("governance owns Token, IdentityRegistry, ComplianceRules and OracleManager", async function () {
    for (const c of [token, identityRegistry, complianceRules, oracleManager]) {
      expect(await c.owner()).to.equal(governance.address);
    }
  });

  it("the deployer is no longer an agent or rule administrator", async function () {
    expect(await token.isAgent(deployer.address)).to.equal(false);
    expect(await identityRegistry.isAgent(deployer.address)).to.equal(false);
    expect(await complianceRules.ruleAdministrators(deployer.address)).to.equal(
      false,
    );
  });

  it("the ops multisig holds the agent roles", async function () {
    expect(await token.isAgent(ops.address)).to.equal(true);
    expect(await identityRegistry.isAgent(ops.address)).to.equal(true);
  });

  it("the guardian can pause the token but cannot unpause it", async function () {
    await token.connect(guardian).pause();
    expect(await token.paused()).to.equal(true);
    await expect(token.connect(guardian).unpause()).to.be.reverted;
  });

  it("the deployer can no longer issue a claim", async function () {
    await expect(
      issueSigned(kycIssuer, deployer, identityAddr, KYC_TOPIC, KYC_DATA),
    ).to.be.revertedWith("ClaimIssuer: Sender does not have claim signer key");
  });

  it("the ops multisig can issue a claim that verifies", async function () {
    await issueSigned(kycIssuer, ops, identityAddr, KYC_TOPIC, KYC_DATA);
    expect(await identityRegistry.isVerified(investor.address)).to.equal(true);
  });
});

// Plan v2 Task 2B.4 (D8): the ClaimIssuer handover works with today's contract.
// Three transactions: deployer adds ops as MANAGEMENT_KEY, deployer transfers
// ownership to ops (one-step Ownable), ops revokes the deployer's key. Phase 2C
// puts these into the ceremony script; this block proves the mechanism.
describe("ClaimIssuer key handover (plan 2B.4)", function () {
  const MANAGEMENT_KEY = 1;
  const CLAIM_SIGNER_KEY = 3;
  const ECDSA_TYPE = 1;

  let deployer: SignerWithAddress;
  let ops: SignerWithAddress;
  let investor: SignerWithAddress;
  let kycIssuer: any;
  let registry: any;
  let identityAddr: string;

  const keyOf = (a: string) =>
    ethers.keccak256(ethers.solidityPacked(["address"], [a]));

  beforeEach(async function () {
    [deployer, ops, investor] = await ethers.getSigners();

    kycIssuer = await (
      await ethers.getContractFactory("ClaimIssuer")
    ).deploy(deployer.address, "KYC Issuer", "Trusted KYC attestations");
    registry = await (
      await ethers.getContractFactory("IdentityRegistry")
    ).deploy();
    await configureKyc(registry, await kycIssuer.getAddress());
    const factory = await (
      await ethers.getContractFactory("OnchainIDFactory")
    ).deploy(deployer.address);
    identityAddr = await deployIdentity(factory, investor.address);
    await registry.registerIdentity(investor.address, identityAddr, 344);

    // The ceremony.
    await kycIssuer
      .connect(deployer)
      .addIssuerKey(keyOf(ops.address), MANAGEMENT_KEY, ECDSA_TYPE);
    await kycIssuer.connect(deployer).transferOwnership(ops.address);
    await kycIssuer.connect(ops).revokeIssuerKey(keyOf(deployer.address));
  });

  it("ops is owner and holds a live MANAGEMENT_KEY; the deployer's key is revoked", async function () {
    expect(await kycIssuer.owner()).to.equal(ops.address);
    expect(await kycIssuer.getKeysByPurpose(MANAGEMENT_KEY)).to.include(
      keyOf(ops.address),
    );
    expect((await kycIssuer.issuerKeys(keyOf(ops.address))).revoked).to.equal(
      false,
    );
    expect(
      (await kycIssuer.issuerKeys(keyOf(deployer.address))).revoked,
    ).to.equal(true);
  });

  it("the deployer cannot submit a claim", async function () {
    await expect(
      issueSigned(kycIssuer, deployer, identityAddr, KYC_TOPIC, KYC_DATA),
    ).to.be.revertedWith("ClaimIssuer: Sender does not have claim signer key");
  });

  it("a deployer-signed claim submitted by ops is rejected", async function () {
    const sig = await signClaim(deployer, identityAddr, KYC_TOPIC, KYC_DATA);
    await expect(
      kycIssuer
        .connect(ops)
        .issueClaim(identityAddr, KYC_TOPIC, 1, KYC_DATA, "", 0, sig),
    ).to.be.revertedWith("ClaimIssuer: Signer does not have claim signer key");
  });

  it("an ops-signed, ops-submitted claim succeeds and verifies the wallet", async function () {
    expect(await registry.isVerified(investor.address)).to.equal(false);
    await issueSigned(kycIssuer, ops, identityAddr, KYC_TOPIC, KYC_DATA);
    expect(await registry.isVerified(investor.address)).to.equal(true);
  });

  it("the deployer cannot revoke a claim ops issued", async function () {
    await issueSigned(kycIssuer, ops, identityAddr, KYC_TOPIC, KYC_DATA);
    const claimId = ethers.solidityPackedKeccak256(
      ["address", "address", "uint256", "bytes"],
      [kycIssuer.target, identityAddr, KYC_TOPIC, KYC_DATA],
    );
    await expect(
      kycIssuer.connect(deployer).revokeClaim(claimId),
    ).to.be.revertedWith("ClaimIssuer: Sender does not have claim signer key");
    expect(await registry.isVerified(investor.address)).to.equal(true);
  });

  it("the deployer has no key-management or ownership power left", async function () {
    await expect(
      kycIssuer.connect(deployer).revokeIssuerKey(keyOf(ops.address)),
    ).to.be.revertedWith("ClaimIssuer: Sender does not have management key");
    await expect(
      kycIssuer
        .connect(deployer)
        .addIssuerKey(keyOf(deployer.address), CLAIM_SIGNER_KEY, ECDSA_TYPE),
    ).to.be.revertedWith("ClaimIssuer: Sender does not have management key");
    await expect(
      kycIssuer.connect(deployer).transferOwnership(deployer.address),
    )
      .to.be.revertedWithCustomError(kycIssuer, "OwnableUnauthorizedAccount")
      .withArgs(deployer.address);
  });
});
