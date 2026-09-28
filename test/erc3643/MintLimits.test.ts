import { expect } from "chai";
import { ethers } from "hardhat";
import { attest, configureKyc } from "../helpers/kyc";

// Task 2E.3 / D22 (a): mint enforces freeze, identity, compliance and the
// recipient's investor-type holding cap through the same path as
// canTransfer(0, to, amount); a treasury is exempted by an explicit,
// event-logged registry flag that only the owner (governance) can set.
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
    const rules = await (
      await ethers.getContractFactory("ComplianceRules")
    ).deploy(owner.address, [840], []);
    const token = await (
      await ethers.getContractFactory("Token")
    ).deploy("VSC", "VSC", registry.target, rules.target);
    await rules.setTokenIdentityRegistry(token.target, registry.target);
    const types = await (
      await ethers.getContractFactory("InvestorTypeRegistry")
    ).deploy();
    await token.setInvestorTypeRegistry(types.target);
    await types.authorizeToken(token.target, true);
    // The predicate must agree with the mint: same reason, same outcome.
    const agree = async (to: string, amount: bigint, reason?: string) => {
      const ok = await token.canTransfer(ethers.ZeroAddress, to, amount);
      expect(ok).to.equal(reason === undefined);
      if (reason)
        await expect(token.mint(to, amount)).to.be.revertedWith(reason);
      else await token.mint(to, amount);
    };
    return {
      ...{ owner, treasury, investor, stranger, outsider },
      ...{ registry, rules, token, types, agree },
    };
  }

  it("refuses a mint above the untyped (Normal) cap", async function () {
    const { investor, agree } = await deploy();
    await agree(investor.address, e("60000"), "Holding limit exceeded");
  });

  it("allows a mint within the cap, then counts the existing balance", async function () {
    const { investor, token, agree } = await deploy();
    await agree(investor.address, e("40000"));
    expect(await token.balanceOf(investor.address)).to.equal(e("40000"));
    await agree(investor.address, e("10001"), "Holding limit exceeded");
  });

  it("an exempt treasury mints 100,000,000 and the flag is logged", async function () {
    const { treasury, token, types, agree } = await deploy();
    await expect(types.setInvestorLimitExempt(treasury.address, true))
      .to.emit(types, "InvestorLimitExemptionUpdated")
      .withArgs(treasury.address, true);
    expect(await types.investorLimitExempt(treasury.address)).to.equal(true);
    await agree(treasury.address, e("100000000"));
    expect(await token.balanceOf(treasury.address)).to.equal(e("100000000"));
    expect(
      await types.canTransferAmount(treasury.address, e("10000000")),
    ).to.equal(true);
  });

  it("revoking the exemption restores the cap", async function () {
    const { treasury, types, agree } = await deploy();
    await types.setInvestorLimitExempt(treasury.address, true);
    await agree(treasury.address, e("60000"));
    await types.setInvestorLimitExempt(treasury.address, false);
    await agree(treasury.address, 1n, "Holding limit exceeded");
  });

  it("the flag survives assignInvestorType", async function () {
    const { treasury, types, agree } = await deploy();
    await types.setInvestorLimitExempt(treasury.address, true);
    await types.assignInvestorType(treasury.address, 3); // Institutional
    expect(await types.investorLimitExempt(treasury.address)).to.equal(true);
    await agree(treasury.address, e("10000000")); // above the 5M cap
  });

  it("only the owner (governance) sets the flag, not a compliance officer", async function () {
    const { treasury, stranger, outsider, types } = await deploy();
    await expect(
      types.connect(stranger).setInvestorLimitExempt(treasury.address, true),
    ).to.be.revertedWithCustomError(types, "OwnableUnauthorizedAccount");
    await types.setComplianceOfficer(outsider.address, true);
    await expect(
      types.connect(outsider).setInvestorLimitExempt(treasury.address, true),
    ).to.be.revertedWithCustomError(types, "OwnableUnauthorizedAccount");
    await types.setInvestorLimitExempt(treasury.address, true);
    expect(await types.investorLimitExempt(treasury.address)).to.equal(true);
    await expect(
      types.setInvestorLimitExempt(ethers.ZeroAddress, true),
    ).to.be.revertedWith("Invalid account address");
  });

  it("refuses an unverified wallet, exempt or not", async function () {
    const { outsider, types, agree } = await deploy();
    await agree(outsider.address, 1n, "Identity not verified");
    await types.setInvestorLimitExempt(outsider.address, true);
    await agree(outsider.address, 1n, "Identity not verified");
  });

  it("refuses a recipient in a blocked jurisdiction", async function () {
    const { investor, registry, rules, token, agree } = await deploy();
    await rules.setJurisdictionRule(token.target, [840], [643]);
    await registry.updateCountry(investor.address, 643);
    await agree(investor.address, 1n, "Compliance check failed");
  });

  it("refuses a frozen recipient", async function () {
    const { investor, token, agree } = await deploy();
    await token.setAddressFrozen(investor.address, true);
    await agree(investor.address, 1n, "Recipient frozen");
  });
});
