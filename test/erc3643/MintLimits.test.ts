import { expect } from "chai";
import { ethers } from "hardhat";
import { attest, configureKyc } from "../helpers/kyc";

// Task 2E.3 / D22 (a): mint enforces the recipient's investor-type holding
// cap through the same path as canTransfer(0, to, amount); a treasury is
// exempted by an explicit, event-logged registry flag.
describe("Token.mint investor limits (2E.3)", function () {
  const e = ethers.parseEther;

  async function deploy() {
    const [owner, treasury, investor, stranger, outsider] =
      await ethers.getSigners();
    const registry = await (
      await ethers.getContractFactory("IdentityRegistry")
    ).deploy();
    const issuer = await (
      await ethers.getContractFactory("ClaimIssuer")
    ).deploy(owner.address, "KYC", "KYC issuer");
    await configureKyc(registry, await issuer.getAddress());
    const OnchainID = await ethers.getContractFactory("OnchainID");
    for (const w of [treasury, investor]) {
      const id = await OnchainID.deploy(w.address);
      await registry.registerIdentity(w.address, id.target, 840);
      await attest(issuer, owner, id.target);
    }
    const compliance = await (
      await ethers.getContractFactory("ComplianceRegistry")
    ).deploy();
    const token = await (
      await ethers.getContractFactory("Token")
    ).deploy("VSC", "VSC", registry.target, compliance.target);
    const types = await (
      await ethers.getContractFactory("InvestorTypeRegistry")
    ).deploy();
    await token.setInvestorTypeRegistry(types.target);
    await types.authorizeToken(token.target, true);
    return { owner, treasury, investor, stranger, outsider, token, types };
  }

  it("reverts a mint above the untyped (Normal) cap; predicate agrees", async function () {
    const { investor, token } = await deploy();
    expect(
      await token.canTransfer(ethers.ZeroAddress, investor.address, e("60000")),
    ).to.equal(false);
    await expect(token.mint(investor.address, e("60000"))).to.be.revertedWith(
      "Holding limit exceeded",
    );
  });

  it("allows a mint within the cap, then counts the existing balance", async function () {
    const { investor, token } = await deploy();
    expect(
      await token.canTransfer(ethers.ZeroAddress, investor.address, e("40000")),
    ).to.equal(true);
    await token.mint(investor.address, e("40000"));
    expect(await token.balanceOf(investor.address)).to.equal(e("40000"));
    await expect(token.mint(investor.address, e("10001"))).to.be.revertedWith(
      "Holding limit exceeded",
    );
  });

  it("an exempt treasury mints 100,000,000 and the flag is logged", async function () {
    const { treasury, owner, token, types } = await deploy();
    await expect(types.setInvestorLimitExempt(treasury.address, true))
      .to.emit(types, "InvestorLimitExemptionUpdated")
      .withArgs(treasury.address, true);
    expect(await types.investorLimitExempt(treasury.address)).to.equal(true);
    await token.connect(owner).mint(treasury.address, e("100000000"));
    expect(await token.balanceOf(treasury.address)).to.equal(e("100000000"));
    expect(
      await types.canTransferAmount(treasury.address, e("10000000")),
    ).to.equal(true);
    expect(
      await types.canHoldAmount(treasury.address, e("1000000000")),
    ).to.equal(true);
  });

  it("revoking the exemption restores the cap", async function () {
    const { treasury, token, types } = await deploy();
    await types.setInvestorLimitExempt(treasury.address, true);
    await types.setInvestorLimitExempt(treasury.address, false);
    await expect(token.mint(treasury.address, e("60000"))).to.be.revertedWith(
      "Holding limit exceeded",
    );
  });

  it("only a compliance officer (or owner) sets the flag", async function () {
    const { treasury, stranger, types } = await deploy();
    await expect(
      types.connect(stranger).setInvestorLimitExempt(treasury.address, true),
    ).to.be.revertedWith("Not authorized compliance officer");
    await types.setComplianceOfficer(stranger.address, true);
    await types
      .connect(stranger)
      .setInvestorLimitExempt(treasury.address, true);
    expect(await types.investorLimitExempt(treasury.address)).to.equal(true);
    await expect(
      types.setInvestorLimitExempt(ethers.ZeroAddress, true),
    ).to.be.revertedWith("Invalid account address");
  });

  it("reverts a mint to an unverified wallet with the identity reason", async function () {
    const { outsider, token } = await deploy();
    expect(
      await token.canTransfer(ethers.ZeroAddress, outsider.address, 1n),
    ).to.equal(false);
    await expect(token.mint(outsider.address, 1n)).to.be.revertedWith(
      "Identity not verified",
    );
  });
});
