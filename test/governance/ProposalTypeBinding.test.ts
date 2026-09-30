import { expect } from "chai";
import { ethers } from "hardhat";
import { ageVoters } from "../helpers/governanceFixture";
import { attest, configureKyc } from "../helpers/kyc";

// owner(): a harmless call. createProposal refuses calldata under 4 bytes
// (plan 2F.1 selector check), so "0x" is no longer a valid no-op.
const NOOP = "0x8da5cb5b";

// Thresholds are looked up by proposalType at execution, but nothing bound the
// type to the target. A TokenParameters action (30% quorum, 70% approval, 3-day
// delay) could be submitted as InvestorTypeConfig (20%/60%/2d) or EmergencyAction
// (10% quorum) with the same target and calldata, and execute under that bar.
describe("Proposal type is bound to its target", () => {
  const T = {
    InvestorTypeConfig: 0,
    ComplianceRules: 1,
    OracleParameters: 2,
    TokenParameters: 3,
    SystemParameters: 4,
    EmergencyAction: 5,
    ListUpdate: 6,
  };

  async function fixture() {
    const [owner, alice, itr, rules, oracleMgr, tokenSlot] =
      await ethers.getSigners();
    const ir = await (
      await ethers.getContractFactory("IdentityRegistry")
    ).deploy();
    const cr = await (
      await ethers.getContractFactory("ComplianceRegistry")
    ).deploy();
    const gt = await (
      await ethers.getContractFactory("GovernanceToken")
    ).deploy("VGT", "VGT", await ir.getAddress(), await cr.getAddress());
    // Five DISTINCT addresses in the target slots so a wrong pairing is detectable.
    const gov = await (
      await ethers.getContractFactory("VanguardGovernance")
    ).deploy(
      await gt.getAddress(),
      await ir.getAddress(),
      itr.address,
      rules.address,
      oracleMgr.address,
      tokenSlot.address,
      1,
    );
    const govAddr = await gov.getAddress();
    await gt.addAgent(govAddr);

    const kycIssuer = await (
      await ethers.getContractFactory("ClaimIssuer")
    ).deploy(owner.address, "KYC Issuer", "Trusted KYC attestations");
    await configureKyc(ir, await kycIssuer.getAddress());

    const OID = await ethers.getContractFactory("OnchainID");
    // Governance receives the VGT deposit, so it needs an identity too.
    for (const a of [owner.address, alice.address, govAddr]) {
      const id = await OID.deploy(a);
      await ir.registerIdentity(a, await id.getAddress(), 840);
      await attest(kycIssuer, owner, await id.getAddress());
    }
    await gt.transfer(alice.address, ethers.parseEther("1000"));
    await gt.connect(alice).approve(govAddr, ethers.MaxUint256);
    // Voters must be older than minVoterAge before they propose (D25).
    await ageVoters(gov);
    return { alice, itr, rules, oracleMgr, tokenSlot, gov, govAddr };
  }

  it("rejects a token-parameter action submitted under the InvestorTypeConfig tier", async () => {
    const { alice, tokenSlot, gov } = await fixture();
    await expect(
      gov
        .connect(alice)
        .createProposal(
          T.InvestorTypeConfig,
          "t",
          "d",
          tokenSlot.address,
          "0x",
        ),
    )
      .to.be.revertedWithCustomError(gov, "TargetNotBoundToType")
      .withArgs(T.InvestorTypeConfig, tokenSlot.address);
  });

  it("rejects any target under EmergencyAction (10% quorum) — no bound target", async () => {
    const { alice, tokenSlot, gov, govAddr } = await fixture();
    for (const target of [tokenSlot.address, govAddr]) {
      await expect(
        gov
          .connect(alice)
          .createProposal(T.EmergencyAction, "t", "d", target, "0x"),
      ).to.be.revertedWithCustomError(gov, "TargetNotBoundToType");
    }
  });

  it("ListUpdate is unproposable until a DynamicListManager is set", async () => {
    const { alice, gov, govAddr } = await fixture();
    expect(await gov.boundTarget(T.ListUpdate)).to.equal(ethers.ZeroAddress);
    for (const target of [ethers.ZeroAddress, govAddr]) {
      await expect(
        gov.connect(alice).createProposal(T.ListUpdate, "t", "d", target, "0x"),
      )
        .to.be.revertedWithCustomError(gov, "TargetNotBoundToType")
        .withArgs(T.ListUpdate, target);
    }
  });

  it("a ListUpdate proposal targeting governance reverts; the manager is accepted", async () => {
    const { alice, gov, govAddr } = await fixture();
    const [, , , , , , manager] = await ethers.getSigners();
    await gov.setDynamicListManager(manager.address);
    expect(await gov.boundTarget(T.ListUpdate)).to.equal(manager.address);
    // ListUpdate may only call a list write (plan 2F.1).
    const addWl = (
      await ethers.getContractFactory("DynamicListManager")
    ).interface.encodeFunctionData("addToWhitelist", [
      alice.address,
      0,
      1,
      86400,
      "r",
    ]);
    await expect(
      gov.connect(alice).createProposal(T.ListUpdate, "t", "d", govAddr, "0x"),
    )
      .to.be.revertedWithCustomError(gov, "TargetNotBoundToType")
      .withArgs(T.ListUpdate, govAddr);
    await expect(
      gov
        .connect(alice)
        .createProposal(T.ListUpdate, "t", "d", manager.address, addWl),
    ).to.not.be.reverted;
  });

  it("accepts every type against its own bound target", async () => {
    const { alice, itr, rules, oracleMgr, tokenSlot, gov, govAddr } =
      await fixture();
    const pairs: [number, string][] = [
      [T.InvestorTypeConfig, itr.address],
      [T.ComplianceRules, rules.address],
      [T.OracleParameters, oracleMgr.address],
      [T.TokenParameters, tokenSlot.address],
      [T.SystemParameters, govAddr],
    ];
    for (const [type, target] of pairs) {
      expect(await gov.boundTarget(type)).to.equal(target);
      await expect(
        gov.connect(alice).createProposal(type, "t", "d", target, NOOP),
      ).to.not.be.reverted;
    }
    expect(await gov.proposalCount()).to.equal(pairs.length);
  });

  it("a type whose slot was deployed as address(0) is unusable, not open", async () => {
    const [owner, alice] = await ethers.getSigners();
    const ir = await (
      await ethers.getContractFactory("IdentityRegistry")
    ).deploy();
    const cr = await (
      await ethers.getContractFactory("ComplianceRegistry")
    ).deploy();
    const gt = await (
      await ethers.getContractFactory("GovernanceToken")
    ).deploy("VGT", "VGT", await ir.getAddress(), await cr.getAddress());
    const gov = await (
      await ethers.getContractFactory("VanguardGovernance")
    ).deploy(
      await gt.getAddress(),
      await ir.getAddress(),
      ethers.ZeroAddress,
      owner.address,
      ethers.ZeroAddress,
      ethers.ZeroAddress,
      1,
    );

    const kycIssuer2 = await (
      await ethers.getContractFactory("ClaimIssuer")
    ).deploy(owner.address, "KYC Issuer", "Trusted KYC attestations");
    await configureKyc(ir, await kycIssuer2.getAddress());

    const OID2 = await ethers.getContractFactory("OnchainID");
    for (const a of [owner.address, alice.address]) {
      const id = await OID2.deploy(a);
      await ir.registerIdentity(a, await id.getAddress(), 840);
      await attest(kycIssuer2, owner, await id.getAddress());
    }
    await gt.transfer(alice.address, ethers.parseEther("100"));
    await gt.connect(alice).approve(await gov.getAddress(), ethers.MaxUint256);
    // Voters must be older than minVoterAge before they propose (D25).
    await ageVoters(gov);
    await expect(
      gov
        .connect(alice)
        .createProposal(T.TokenParameters, "t", "d", ethers.ZeroAddress, "0x"),
    ).to.be.revertedWithCustomError(gov, "TargetNotBoundToType");
  });
});
