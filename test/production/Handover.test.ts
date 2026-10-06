import { expect } from "chai";
import { ethers } from "hardhat";
import { ageVoters } from "../helpers/governanceFixture";
import { bindEngine } from "../helpers/oracles";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import {
  KYC_DATA,
  KYC_TOPIC,
  attest,
  configureKyc,
  deployIdentity,
  issueSigned,
  signClaim,
} from "../helpers/kyc";

// Plain JS so the demo, the smoke and scripts/handover.ts share one ceremony.
const {
  ACCEPTANCE_PLAN,
  castAcceptanceVotes,
  handoverDeployerPowers,
  proposeAcceptOwnership,
  settleProposal,
} = require("../../demo/utils/Handover");

// Guard test from .omc/plans/2026-09-23-zk-kyc-ownership-cleanup.md, Task 0.3,
// green since plan v2 Task 2C.1 (.omc/plans/2026-09-25-zk-kyc-ownership-cleanup-v2.md).
// After the handover ceremony the deploying key holds no power at all,
// governance owns the core contracts, an ops multisig holds the operational
// roles, and a guardian can pause but not unpause. `handover` runs the real
// ceremony from demo/utils/Handover.js (the code behind demo options 83c/83d,
// scripts/handover.ts and the demo smoke): deployer powers, then one
// acceptOwnership() vote per contract. The two ClaimIssuer cases are plan v2
// Task 2B.4 (D8), proven step by step in the describe further down.
describe("Deployer holds no power after handover (plan Task 0.3)", function () {
  let deployer: SignerWithAddress;
  let ops: SignerWithAddress;
  let guardian: SignerWithAddress;
  let issuerAdmin: SignerWithAddress;
  let proposer: SignerWithAddress;
  let voters: SignerWithAddress[];
  let token: any;
  let governanceToken: any;
  let identityRegistry: any;
  let complianceRules: any;
  let oracleManager: any;
  let governance: any;
  let dynamicListManager: any;
  let investorTypeRegistry: any;
  let govAddr: string;
  let kycIssuer: any;
  let investor: SignerWithAddress;
  let identityAddr: string;

  async function handover(): Promise<void> {
    await handoverDeployerPowers({
      deployer,
      ops,
      guardian,
      issuerAdmin,
      governance,
      token,
      governanceToken,
      identityRegistry,
      complianceRules,
      oracleManager,
      dynamicListManager,
      investorTypeRegistry,
      issuers: [kycIssuer],
      log: () => {},
    });
    const contracts: Record<string, any> = {
      token,
      governanceToken,
      identityRegistry,
      complianceRules,
      oracleManager,
      dynamicListManager,
      investorTypeRegistry,
      governance,
    };
    for (const e of ACCEPTANCE_PLAN) {
      if (!contracts[e.key]) continue; // optional factories (2F.5) not deployed here
      const id = await proposeAcceptOwnership(
        governance,
        proposer,
        contracts[e.key],
        e.proposalType,
        e.label,
      );
      await castAcceptanceVotes(governance, id, voters);
      await settleProposal(governance, id, e.label);
    }
  }

  beforeEach(async function () {
    let alice: SignerWithAddress,
      bob: SignerWithAddress,
      carol: SignerWithAddress;
    [deployer, ops, guardian, investor, alice, bob, carol, issuerAdmin] =
      await ethers.getSigners();
    proposer = alice;
    voters = [bob, carol];

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
    await bindEngine(oracleManager); // Task 4.4

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

    // Governance bound to the real core contracts (fixture shape of
    // test/governance/IdentityRegistryProposals.test.ts) and three verified
    // VGT holders: a proposer and two voters (2 of 4 registered = 50%).
    const idRegAddr = await identityRegistry.getAddress();
    const rulesAddr = await complianceRules.getAddress();
    const vgt = await (
      await ethers.getContractFactory("GovernanceToken")
    ).deploy("VGT", "VGT", idRegAddr, rulesAddr);
    governanceToken = vgt;
    investorTypeRegistry = await (
      await ethers.getContractFactory("InvestorTypeRegistry")
    ).deploy();
    const vgtAddr = await vgt.getAddress();
    governance = await (
      await ethers.getContractFactory("VanguardGovernance")
    ).deploy(
      vgtAddr,
      idRegAddr,
      await investorTypeRegistry.getAddress(),
      rulesAddr,
      await oracleManager.getAddress(),
      await token.getAddress(),
      1440,
    );
    govAddr = await governance.getAddress();
    // Optional plan entry (demo option 84). Its governanceContract is left
    // unset: the ceremony's deployer step must set it.
    dynamicListManager = await (
      await ethers.getContractFactory("DynamicListManager")
    ).deploy(deployer.address);
    await governance.setDynamicListManager(
      await dynamicListManager.getAddress(),
    );
    await vgt.addAgent(deployer.address);
    await vgt.addAgent(govAddr);
    await complianceRules.setTokenIdentityRegistry(vgtAddr, idRegAddr);
    await complianceRules.addTrustedContract(vgtAddr, govAddr);
    for (const w of [alice, bob, carol]) {
      const id = await deployIdentity(factory, w.address);
      await identityRegistry.registerIdentity(w.address, id, 840);
      await attest(kycIssuer, deployer, id);
      await vgt.mint(w.address, ethers.parseEther("1000"));
    }
    // Voters are registered minVoterAge before the ceremony (D25).
    await ageVoters(governance);

    await handover();
  });

  it("governance owns Token, IdentityRegistry, ComplianceRules and OracleManager", async function () {
    for (const c of [token, identityRegistry, complianceRules, oracleManager]) {
      expect(await c.owner()).to.equal(govAddr);
    }
    expect(await governance.owner()).to.equal(govAddr);
  });

  it("governance owns DynamicListManager when deployed", async function () {
    expect(await dynamicListManager.owner()).to.equal(govAddr);
    expect(await dynamicListManager.governanceContract()).to.equal(govAddr);
    await expect(
      dynamicListManager
        .connect(deployer)
        .setGovernanceContract(deployer.address),
    ).to.be.revertedWithCustomError(
      dynamicListManager,
      "OwnableUnauthorizedAccount",
    );
  });

  // Plan v2 Task 2E.2: the registry is in the acceptance plan.
  it("governance owns InvestorTypeRegistry; ops is its officer, the deployer is not", async function () {
    expect(await investorTypeRegistry.owner()).to.equal(govAddr);
    expect(
      await investorTypeRegistry.isComplianceOfficer(ops.address),
    ).to.equal(true);
    expect(
      await investorTypeRegistry.isComplianceOfficer(deployer.address),
    ).to.equal(false);
  });

  it("the deployer is no longer an agent or rule administrator", async function () {
    expect(await token.isAgent(deployer.address)).to.equal(false);
    expect(await identityRegistry.isAgent(deployer.address)).to.equal(false);
    const vgtAddr = await governance.governanceToken();
    for (const t of [await token.getAddress(), vgtAddr])
      expect(
        await complianceRules.ruleAdministrators(t, deployer.address),
      ).to.equal(false);
  });

  it("the ops multisig holds the agent roles", async function () {
    expect(await token.isAgent(ops.address)).to.equal(true);
    expect(await identityRegistry.isAgent(ops.address)).to.equal(true);
  });

  // Plan v2 Task 2C.2 (D19): a paused VGT or a frozen voter blocks castVote,
  // so the deployer must hold no power over the vote token either.
  it("governance owns GovernanceToken", async function () {
    expect(await governanceToken.owner()).to.equal(govAddr);
    await expect(governanceToken.connect(deployer).pause()).to.be.reverted;
    await expect(
      governanceToken.connect(deployer).addAgent(deployer.address),
    ).to.be.revertedWithCustomError(
      governanceToken,
      "OwnableUnauthorizedAccount",
    );
  });

  it("the deployer is not a GovernanceToken agent", async function () {
    expect(await governanceToken.isAgent(deployer.address)).to.equal(false);
    await expect(
      governanceToken
        .connect(deployer)
        .freezePartialTokens(voters[0].address, 1n),
    ).to.be.reverted;
  });

  it("the ops multisig is a GovernanceToken agent", async function () {
    expect(await governanceToken.isAgent(ops.address)).to.equal(true);
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

  // 2F.5 (D25 b): the issuer goes to issuerAdmin, never to ops, the
  // registry agent: one key may not both register and attest identities.
  it("issuerAdmin can issue a claim that verifies; ops cannot", async function () {
    expect(await kycIssuer.owner()).to.equal(issuerAdmin.address);
    await expect(
      issueSigned(kycIssuer, ops, identityAddr, KYC_TOPIC, KYC_DATA),
    ).to.be.revertedWith("ClaimIssuer: Sender does not have claim signer key");
    await issueSigned(
      kycIssuer,
      issuerAdmin,
      identityAddr,
      KYC_TOPIC,
      KYC_DATA,
    );
    expect(await identityRegistry.isVerified(investor.address)).to.equal(true);
  });
});

// Plan v2 Task 2B.4 (D8), updated by 2C.3 (D18): the ClaimIssuer handover
// works with today's contract. Four transactions: deployer adds ops as
// MANAGEMENT_KEY, deployer nominates ops via transferOwnership, ops accepts
// via acceptOwnership (Ownable2Step), ops revokes the deployer's key. Phase 2C
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
    await kycIssuer.connect(ops).acceptOwnership();
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

  it("a nominated ops that has not accepted is not yet owner", async function () {
    const freshIssuer = await (
      await ethers.getContractFactory("ClaimIssuer")
    ).deploy(deployer.address, "Fresh Issuer", "Nomination-only issuer");
    await freshIssuer.connect(deployer).transferOwnership(ops.address);
    expect(await freshIssuer.pendingOwner()).to.equal(ops.address);
    expect(await freshIssuer.owner()).to.equal(deployer.address);
    await expect(
      freshIssuer
        .connect(deployer)
        .addIssuerKey(keyOf(investor.address), CLAIM_SIGNER_KEY, ECDSA_TYPE),
    ).to.not.be.reverted;
  });
});
