import { expect } from "chai";
import { ethers } from "hardhat";

// Thresholds are looked up by proposalType at execution, but nothing bound the
// type to the target. A TokenParameters action (30% quorum, 70% approval, 3-day
// delay) could be submitted as InvestorTypeConfig (20%/60%/2d) or EmergencyAction
// (10% quorum) with the same target and calldata, and execute under that bar.
describe("Proposal type is bound to its target", () => {
  const T = { InvestorTypeConfig: 0, ComplianceRules: 1, OracleParameters: 2,
              TokenParameters: 3, SystemParameters: 4, EmergencyAction: 5, AddToWhitelist: 6 };

  async function fixture() {
    const [owner, alice, itr, rules, oracleMgr, tokenSlot] = await ethers.getSigners();
    const ir = await (await ethers.getContractFactory("IdentityRegistry")).deploy();
    const cr = await (await ethers.getContractFactory("ComplianceRegistry")).deploy();
    const gt = await (await ethers.getContractFactory("GovernanceToken")).deploy(
      "VGT", "VGT", await ir.getAddress(), await cr.getAddress());
    // Five DISTINCT addresses in the target slots so a wrong pairing is detectable.
    const gov = await (await ethers.getContractFactory("VanguardGovernance")).deploy(
      await gt.getAddress(), await ir.getAddress(),
      itr.address, rules.address, oracleMgr.address, tokenSlot.address, 1);
    const govAddr = await gov.getAddress();
    await gt.addAgent(govAddr);
    // Governance receives the VGT deposit, so it needs an identity too.
    for (const a of [owner.address, alice.address, govAddr]) await ir.registerIdentity(a, owner.address, 840);
    await gt.transfer(alice.address, ethers.parseEther("1000"));
    await gt.connect(alice).approve(govAddr, ethers.MaxUint256);
    return { alice, itr, rules, oracleMgr, tokenSlot, gov, govAddr };
  }

  it("rejects a token-parameter action submitted under the InvestorTypeConfig tier", async () => {
    const { alice, tokenSlot, gov } = await fixture();
    await expect(gov.connect(alice).createProposal(T.InvestorTypeConfig, "t", "d", tokenSlot.address, "0x"))
      .to.be.revertedWithCustomError(gov, "TargetNotBoundToType")
      .withArgs(T.InvestorTypeConfig, tokenSlot.address);
  });

  it("rejects any target under EmergencyAction (10% quorum) — no bound target", async () => {
    const { alice, tokenSlot, gov, govAddr } = await fixture();
    for (const target of [tokenSlot.address, govAddr]) {
      await expect(gov.connect(alice).createProposal(T.EmergencyAction, "t", "d", target, "0x"))
        .to.be.revertedWithCustomError(gov, "TargetNotBoundToType");
    }
  });

  it("routes list types to createListUpdateProposal", async () => {
    const { alice, gov, govAddr } = await fixture();
    await expect(gov.connect(alice).createProposal(T.AddToWhitelist, "t", "d", govAddr, "0x"))
      .to.be.revertedWithCustomError(gov, "UseListUpdateProposal");
  });

  it("accepts every type against its own bound target", async () => {
    const { alice, itr, rules, oracleMgr, tokenSlot, gov, govAddr } = await fixture();
    const pairs: [number, string][] = [
      [T.InvestorTypeConfig, itr.address], [T.ComplianceRules, rules.address],
      [T.OracleParameters, oracleMgr.address], [T.TokenParameters, tokenSlot.address],
      [T.SystemParameters, govAddr],
    ];
    for (const [type, target] of pairs) {
      expect(await gov.boundTarget(type)).to.equal(target);
      await expect(gov.connect(alice).createProposal(type, "t", "d", target, "0x")).to.not.be.reverted;
    }
    expect(await gov.proposalCount()).to.equal(pairs.length);
  });

  it("a type whose slot was deployed as address(0) is unusable, not open", async () => {
    const [owner, alice] = await ethers.getSigners();
    const ir = await (await ethers.getContractFactory("IdentityRegistry")).deploy();
    const cr = await (await ethers.getContractFactory("ComplianceRegistry")).deploy();
    const gt = await (await ethers.getContractFactory("GovernanceToken")).deploy(
      "VGT", "VGT", await ir.getAddress(), await cr.getAddress());
    const gov = await (await ethers.getContractFactory("VanguardGovernance")).deploy(
      await gt.getAddress(), await ir.getAddress(),
      ethers.ZeroAddress, owner.address, ethers.ZeroAddress, ethers.ZeroAddress, 1);
    for (const a of [owner.address, alice.address]) await ir.registerIdentity(a, owner.address, 840);
    await gt.transfer(alice.address, ethers.parseEther("100"));
    await gt.connect(alice).approve(await gov.getAddress(), ethers.MaxUint256);
    await expect(gov.connect(alice).createProposal(T.TokenParameters, "t", "d", ethers.ZeroAddress, "0x"))
      .to.be.revertedWithCustomError(gov, "TargetNotBoundToType");
  });
});
