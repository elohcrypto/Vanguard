import { expect } from "chai";
import { ethers } from "hardhat";
import { attest, configureKyc } from "../helpers/kyc";

/**
 * Task 4.16 (review A1 L1): ComplianceRules.setWhitelistOracle probes
 * getWhitelistInfo and refuses an oracle without the 6-tuple
 * (OracleIncompatible), so a pre-4.10 oracle fails at configuration, not
 * on every transfer; and a bound 6-tuple oracle's tier is enforced on the
 * token (D47: the tier rule acts on VSC once an oracle is bound).
 */
describe("Whitelist oracle shape at setWhitelistOracle (Task 4.16)", function () {
  const e = ethers.parseEther;
  const REFUSED = "Compliance check failed";

  async function deploy() {
    const [owner, treasury, alice, bob] = await ethers.getSigners();
    const deployC = async (name: string, ...a: unknown[]) =>
      (await ethers.getContractFactory(name)).deploy(...a) as Promise<any>;
    const registry = await deployC("IdentityRegistry");
    const issuer = await deployC("ClaimIssuer", owner.address, "KYC", "d");
    await configureKyc(registry, await issuer.getAddress());
    const OnchainID = await ethers.getContractFactory("OnchainID");
    for (const w of [treasury, alice, bob]) {
      const id = await OnchainID.deploy(w.address);
      await registry.registerIdentity(w.address, id.target, 840);
      await attest(issuer, owner, id.target as string);
    }
    const rules = await deployC("ComplianceRules", owner.address, [840], []);
    const token = await deployC(
      "Token",
      "VSC",
      "VSC",
      registry.target,
      rules.target,
    );
    await rules.setTokenIdentityRegistry(token.target, registry.target);
    const types = await deployC("InvestorTypeRegistry");
    await token.setInvestorTypeRegistry(types.target);
    await types.authorizeToken(token.target, true);
    await types.setInvestorLimitExempt(treasury.address, true);
    const om = await deployC("OracleManager");
    const wl = await deployC("WhitelistOracle", om.target, "WL", "d");
    const short = await deployC("ShortWhitelistOracle");
    await token.mint(treasury.address, e("100000"));
    return {
      owner,
      treasury,
      alice,
      bob,
      registry,
      rules,
      token,
      types,
      wl,
      short,
    };
  }

  it("refuses an oracle whose getWhitelistInfo has no tier (5-tuple)", async function () {
    const { rules, token, short, wl } = await deploy();
    // It answers isWhitelisted, as the first probe requires.
    expect(await short.isWhitelisted(rules.target)).to.equal(false);
    await expect(rules.setWhitelistOracle(token.target, short.target))
      .to.be.revertedWithCustomError(rules, "OracleIncompatible")
      .withArgs(short.target);
    expect(await rules.whitelistOracle(token.target)).to.equal(
      ethers.ZeroAddress,
    );
    // The real oracle's 6-tuple passes the same probe.
    await expect(rules.setWhitelistOracle(token.target, wl.target))
      .to.emit(rules, "WhitelistOracleSet")
      .withArgs(token.target, wl.target);
    expect(await rules.whitelistOracle(token.target)).to.equal(wl.target);
  });

  it("a bound 6-tuple oracle's tier is enforced on the token", async function () {
    const { treasury, alice, bob, rules, token, types, wl } = await deploy();
    await rules.setWhitelistOracle(token.target, wl.target);
    // OracleOnly, default-deny: list everyone, then fund.
    for (const w of [treasury, alice, bob])
      await wl.addToWhitelist(w.address, 5, 0, "kyc");
    await token.connect(treasury).transfer(alice.address, e("1000"));
    await types.assignInvestorType(alice.address, 1); // Retail: tier 2+
    expect(await types.getRequiredWhitelistTier(alice.address)).to.equal(2);
    await wl.addToWhitelist(alice.address, 1, 0, "short");
    expect(
      await rules.whitelistTierAllows(token.target, alice.address),
    ).to.equal(false);
    expect(await token.canTransfer(alice.address, bob.address, 1n)).to.equal(
      false,
    );
    await expect(
      token.connect(alice).transfer(bob.address, 1n),
    ).to.be.revertedWith(REFUSED);
    await wl.addToWhitelist(alice.address, 2, 0, "at tier");
    expect(
      await rules.whitelistTierAllows(token.target, alice.address),
    ).to.equal(true);
    expect(await token.canTransfer(alice.address, bob.address, 1n)).to.equal(
      true,
    );
    await token.connect(alice).transfer(bob.address, 1n);
    expect(await token.balanceOf(bob.address)).to.equal(1n);
  });
});
