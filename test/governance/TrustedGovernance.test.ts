import { expect } from "chai";
import { ethers } from "hardhat";
import { attest, configureKyc } from "../helpers/kyc";

/**
 * D21: governance holds VGT fees as a TRUSTED CONTRACT with no identity of
 * its own. Fees move in (createProposal, castVote), refunds move out
 * (claimRefund) and passed fees are burned, all without governance ever
 * being registered, so it never counts in the quorum denominator. The
 * human counterparty is still checked, so voter eligibility is unchanged.
 */
describe("Governance as a trusted contract (D21)", function () {
  const FEE = ethers.parseEther("10");
  const PAST_VOTE_AND_DELAY = 9 * 86400 + 60; // SystemParameters: 7d + 2d

  async function fixture() {
    const [owner, proposer, v1, v2, v3, outsider] = await ethers.getSigners();
    const idReg = await (
      await ethers.getContractFactory("IdentityRegistry")
    ).deploy();
    const rules = await (
      await ethers.getContractFactory("ComplianceRules")
    ).deploy(owner.address, [840], []);
    const vgt = await (
      await ethers.getContractFactory("GovernanceToken")
    ).deploy("VGT", "VGT", await idReg.getAddress(), await rules.getAddress());
    const gov = await (
      await ethers.getContractFactory("VanguardGovernance")
    ).deploy(
      await vgt.getAddress(),
      await idReg.getAddress(),
      owner.address,
      await rules.getAddress(),
      owner.address,
      await vgt.getAddress(),
      1,
    );
    const govAddr = await gov.getAddress();
    await vgt.addAgent(govAddr); // executeProposal burns locked fees
    await rules.setTokenIdentityRegistry(
      await vgt.getAddress(),
      await idReg.getAddress(),
    );
    await rules.addTrustedContract(govAddr);

    const kycIssuer = await (
      await ethers.getContractFactory("ClaimIssuer")
    ).deploy(owner.address, "KYC Issuer", "Trusted KYC attestations");
    await configureKyc(idReg, await kycIssuer.getAddress());

    const OID = await ethers.getContractFactory("OnchainID");
    const voters = [owner, proposer, v1, v2, v3];
    for (const s of voters) {
      const id = await (await OID.deploy(s.address)).getAddress();
      await idReg.registerIdentity(s.address, id, 840);
      await attest(kycIssuer, owner, id);
      if (s !== owner) await vgt.transfer(s.address, ethers.parseEther("100"));
      await vgt.connect(s).approve(govAddr, ethers.MaxUint256);
    }
    await vgt.connect(outsider).approve(govAddr, ethers.MaxUint256);
    return { owner, proposer, v1, v2, v3, outsider, idReg, rules, vgt, gov };
  }

  async function propose(gov: any, proposer: any) {
    const govAddr = await gov.getAddress();
    await gov.connect(proposer).createProposal(
      4, // SystemParameters: target is governance itself
      "t",
      "d",
      govAddr,
      gov.interface.encodeFunctionData("proposalCount"),
    );
    return gov.proposalCount();
  }

  it("is trusted and unregistered; the denominator counts voters only", async function () {
    const { idReg, rules, gov, proposer } = await fixture();
    const govAddr = await gov.getAddress();
    expect(await idReg.identity(govAddr)).to.equal(ethers.ZeroAddress);
    expect(await rules.isTrustedContract(govAddr)).to.equal(true);
    expect(await idReg.registeredIdentityCount()).to.equal(5n);
    const id = await propose(gov, proposer);
    const [p] = await gov.getProposal(id);
    expect(p.eligibleVotersAtCreation).to.equal(5n);
  });

  it("fees move in, a rejected proposal refunds out", async function () {
    const { proposer, v1, v2, v3, vgt, gov } = await fixture();
    const govAddr = await gov.getAddress();
    const before = await vgt.balanceOf(v1.address);
    const id = await propose(gov, proposer);
    for (const v of [v1, v2, v3]) await gov.connect(v).castVote(id, false, "n");
    expect(await vgt.balanceOf(govAddr)).to.equal(FEE * 4n);
    expect(await vgt.balanceOf(v1.address)).to.equal(before - FEE);

    await ethers.provider.send("evm_increaseTime", [PAST_VOTE_AND_DELAY]);
    await ethers.provider.send("evm_mine", []);
    await expect(gov.executeProposal(id)).to.emit(gov, "ProposalRejected");
    await gov.connect(v1).claimRefund(id);
    expect(await vgt.balanceOf(v1.address)).to.equal(before);
    expect(await vgt.balanceOf(govAddr)).to.equal(FEE * 3n);
  });

  it("a de-verified voter's refund waits until re-verified", async function () {
    const { proposer, v1, v2, v3, idReg, vgt, gov } = await fixture();
    const id = await propose(gov, proposer);
    for (const v of [v1, v2, v3]) await gov.connect(v).castVote(id, false, "n");
    await ethers.provider.send("evm_increaseTime", [PAST_VOTE_AND_DELAY]);
    await ethers.provider.send("evm_mine", []);
    await gov.executeProposal(id);
    const v1Id = await idReg.identity(v1.address);
    await idReg.deleteIdentity(v1.address);
    // Governance is trusted, so the token skips identities; ComplianceRules
    // still checks the human counterparty.
    await expect(gov.connect(v1).claimRefund(id)).to.be.revertedWith(
      "Compliance check failed",
    );
    expect(await gov.getClaimableRefund(id, v1.address)).to.equal(FEE);
    await idReg.registerIdentity(v1.address, v1Id, 840);
    const b0 = await vgt.balanceOf(v1.address);
    await gov.connect(v1).claimRefund(id);
    expect(await vgt.balanceOf(v1.address)).to.equal(b0 + FEE);
  });

  it("a passed proposal burns the locked fees", async function () {
    const { proposer, v1, v2, v3, vgt, gov } = await fixture();
    const govAddr = await gov.getAddress();
    const id = await propose(gov, proposer);
    for (const v of [v1, v2, v3]) await gov.connect(v).castVote(id, true, "y");
    const supply0 = await vgt.totalSupply();
    expect(await vgt.balanceOf(govAddr)).to.equal(FEE * 4n);

    await ethers.provider.send("evm_increaseTime", [PAST_VOTE_AND_DELAY]);
    await ethers.provider.send("evm_mine", []);
    await expect(gov.executeProposal(id)).to.emit(gov, "ProposalExecuted");
    expect(await vgt.balanceOf(govAddr)).to.equal(0n);
    expect(supply0 - (await vgt.totalSupply())).to.equal(FEE * 4n);
  });

  it("an unverified wallet with VGT still cannot propose or vote", async function () {
    const { owner, proposer, outsider, idReg, vgt, gov } = await fixture();
    // Give the outsider VGT while verified, then remove the identity: the
    // wallet keeps its balance and approval but is no longer eligible.
    const OID = await ethers.getContractFactory("OnchainID");
    const kycIssuerAddr = (await idReg.getTrustedIssuersForClaimTopic(6))[0];
    const kycIssuer = await ethers.getContractAt("ClaimIssuer", kycIssuerAddr);
    const id = await (await OID.deploy(outsider.address)).getAddress();
    await idReg.registerIdentity(outsider.address, id, 840);
    await attest(kycIssuer as any, owner, id);
    await vgt.transfer(outsider.address, ethers.parseEther("100"));
    await idReg.deleteIdentity(outsider.address);
    expect(await vgt.balanceOf(outsider.address)).to.be.greaterThan(FEE);

    await expect(
      gov
        .connect(outsider)
        .createProposal(4, "t", "d", await gov.getAddress(), "0x"),
    ).to.be.revertedWith("Must be KYC/AML verified");
    const pid = await propose(gov, proposer);
    await expect(
      gov.connect(outsider).castVote(pid, true, "y"),
    ).to.be.revertedWith("Must be KYC/AML verified");
    // Token level: the trusted path still checks the human counterparty.
    await expect(
      vgt.connect(outsider).transfer(await gov.getAddress(), 1n),
    ).to.be.revertedWith("Compliance check failed");
  });
});
