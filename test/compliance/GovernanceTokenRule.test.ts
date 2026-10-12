import { expect } from "chai";
import { ethers } from "hardhat";

// Task 4.17 slice C (D33 b (a)): ComplianceRules records the governance
// token once (owner only) and refuses any whitelist mode but OracleOnly
// and any whitelist oracle for it, so no type-1 vote can gate who votes.
describe("ComplianceRules governance token (D33 b)", function () {
  async function deploy() {
    const [owner, stranger] = await ethers.getSigners();
    const D = async (n: string, ...a: unknown[]) =>
      (await ethers.getContractFactory(n)).deploy(...a) as Promise<any>;
    const registry = await D("IdentityRegistry");
    const rules = await D("ComplianceRules", owner.address, [840], []);
    const vgt = await D("Token", "VGT", "VGT", registry.target, rules.target);
    const vsc = await D("Token", "VSC", "VSC", registry.target, rules.target);
    const binder = await D("MockWhitelistBinder");
    const om = await D("OracleManager");
    const wl = await D("WhitelistOracle", om.target, "WL", "d");
    return { owner, stranger, rules, vgt, vsc, binder, wl };
  }

  it("is recorded once, by the owner, never the zero address", async function () {
    const { stranger, rules, vgt, vsc } = await deploy();
    await expect(rules.connect(stranger).setGovernanceToken(vgt.target))
      .to.be.revertedWithCustomError(rules, "OwnableUnauthorizedAccount")
      .withArgs(stranger.address);
    await expect(
      rules.setGovernanceToken(ethers.ZeroAddress),
    ).to.be.revertedWithCustomError(rules, "InvalidTokenAddress");
    await expect(rules.setGovernanceToken(vgt.target))
      .to.emit(rules, "GovernanceTokenSet")
      .withArgs(vgt.target);
    await expect(rules.setGovernanceToken(vsc.target))
      .to.be.revertedWithCustomError(rules, "GovernanceTokenAlreadySet")
      .withArgs(vgt.target);
    expect(await rules.governanceToken()).to.equal(vgt.target);
  });

  it("refuses a token that already has a ZK mode or a whitelist oracle", async function () {
    const { rules, vgt, binder, wl } = await deploy();
    await rules.setPrivacyManager(vgt.target, binder.target);
    await rules.setWhitelistMode(vgt.target, 2);
    await expect(rules.setGovernanceToken(vgt.target))
      .to.be.revertedWithCustomError(rules, "GovernanceTokenWhitelist")
      .withArgs(vgt.target);
    await rules.setWhitelistMode(vgt.target, 0);
    await rules.setWhitelistOracle(vgt.target, wl.target);
    await expect(
      rules.setGovernanceToken(vgt.target),
    ).to.be.revertedWithCustomError(rules, "GovernanceTokenWhitelist");
    await rules.setWhitelistOracle(vgt.target, ethers.ZeroAddress);
    await rules.setGovernanceToken(vgt.target);
  });

  it("then refuses ZkOnly, Either and a whitelist oracle for it only", async function () {
    const { rules, vgt, vsc, binder, wl } = await deploy();
    await rules.setGovernanceToken(vgt.target);
    for (const t of [vgt, vsc])
      await rules.setPrivacyManager(t.target, binder.target);
    for (const mode of [1, 2])
      await expect(rules.setWhitelistMode(vgt.target, mode))
        .to.be.revertedWithCustomError(rules, "GovernanceTokenWhitelist")
        .withArgs(vgt.target);
    await expect(
      rules.setWhitelistOracle(vgt.target, wl.target),
    ).to.be.revertedWithCustomError(rules, "GovernanceTokenWhitelist");
    await rules.setWhitelistMode(vgt.target, 0);
    await rules.setWhitelistOracle(vgt.target, ethers.ZeroAddress);
    expect(await rules.whitelistMode(vgt.target)).to.equal(0);
    await rules.setWhitelistMode(vsc.target, 2);
    await rules.setWhitelistOracle(vsc.target, wl.target);
    expect(await rules.whitelistOracle(vsc.target)).to.equal(wl.target);
  });
});
