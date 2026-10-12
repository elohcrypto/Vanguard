import { expect } from "chai";
import { ethers } from "hardhat";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import { attest, configureKyc } from "../helpers/kyc";

/**
 * Task 2A.4: ComplianceRules fails closed for a token with no IdentityRegistry
 * bound (no one can be verified, so no ordinary transfer passes), and
 * canReceive applies only the oracle lists.
 */
describe("ComplianceRules fails closed without a bound registry", function () {
  let owner: SignerWithAddress,
    alice: SignerWithAddress,
    bob: SignerWithAddress;
  let idReg: any, rules: any, token: any;
  const E = (n: number) => ethers.parseEther(String(n));

  beforeEach(async function () {
    [owner, alice, bob] = await ethers.getSigners();

    idReg = await (
      await ethers.getContractFactory("IdentityRegistry")
    ).deploy();
    rules = await (
      await ethers.getContractFactory("ComplianceRules")
    ).deploy(owner.address, [840], [643]);
    token = await (
      await ethers.getContractFactory("Token")
    ).deploy(
      "Vanguard",
      "VSC",
      await idReg.getAddress(),
      await rules.getAddress(),
    );
    // Deliberately NOT calling rules.setTokenIdentityRegistry here.
    await idReg.addAgent(owner.address);

    const kycIssuer = await (
      await ethers.getContractFactory("ClaimIssuer")
    ).deploy(owner.address, "KYC Issuer", "Trusted KYC attestations");
    await configureKyc(idReg, await kycIssuer.getAddress());

    const OID = await ethers.getContractFactory("OnchainID");
    for (const who of [alice, bob]) {
      const id = await OID.deploy(who.address);
      await idReg.registerIdentity(who.address, await id.getAddress(), 840);
      await attest(kycIssuer, owner, await id.getAddress());
    }
    await token.mint(alice.address, E(1000));
  });

  const bind = async () =>
    rules.setTokenIdentityRegistry(
      await token.getAddress(),
      await idReg.getAddress(),
    );

  it("refuses a transfer between verified parties while no registry is bound", async function () {
    expect(await token.canTransfer(alice.address, bob.address, 1)).to.equal(
      false,
    );
    await expect(
      token.connect(alice).transfer(bob.address, E(1)),
    ).to.be.revertedWith("Compliance check failed");
  });

  it("allows the same transfer once the registry is bound", async function () {
    await bind();
    expect(await token.canTransfer(alice.address, bob.address, 1)).to.equal(
      true,
    );
    await token.connect(alice).transfer(bob.address, E(1));
    expect(await token.balanceOf(bob.address)).to.equal(E(1));
  });

  it("rejects binding an EOA as the identity registry", async function () {
    await expect(
      rules.setTokenIdentityRegistry(await token.getAddress(), bob.address),
    ).to.be.revertedWith("ComplianceRules: registry is not a contract");
  });

  it("isProductionCompliance(token) is false before binding, true after", async function () {
    const t = await token.getAddress();
    expect(await rules["isProductionCompliance(address)"](t)).to.equal(false);
    await bind();
    expect(await rules["isProductionCompliance(address)"](t)).to.equal(true);
  });

  it("canReceive applies the blacklist oracle for the calling token", async function () {
    const om = await (
      await ethers.getContractFactory("OracleManager")
    ).deploy();
    const bl = await (
      await ethers.getContractFactory("BlacklistOracle")
    ).deploy(await om.getAddress(), "BL", "blacklist");
    const t = await token.getAddress();
    await rules.setBlacklistOracle(t, await bl.getAddress());
    await bl.addToBlacklist(bob.address, 2, 0, "AML risk");

    // canReceive reads msg.sender as the token, so query from the token address.
    const asToken = rules.connect(await ethers.getImpersonatedSigner(t));
    expect(await asToken.canReceive.staticCall(bob.address)).to.equal(false);
    expect(await asToken.canReceive.staticCall(alice.address)).to.equal(true);
  });

  // Task 4.15 (C §2 ComplianceRulesAdmin rows: N03 and the zero, code
  // and mode checks around the per-token setters).
  describe("admin setters", function () {
    let t: string, r: string;
    beforeEach(async function () {
      t = await token.getAddress();
      r = await idReg.getAddress();
    });

    it("setTokenIdentityRegistry is the owner's and refuses zero on both sides (N03)", async function () {
      await expect(rules.connect(bob).setTokenIdentityRegistry(t, r))
        .to.be.revertedWithCustomError(rules, "OwnableUnauthorizedAccount")
        .withArgs(bob.address);
      await expect(
        rules.setTokenIdentityRegistry(ethers.ZeroAddress, r),
      ).to.be.revertedWith("ComplianceRules: Invalid token address");
      await expect(
        rules.setTokenIdentityRegistry(t, ethers.ZeroAddress),
      ).to.be.revertedWith(
        "ComplianceRules: Invalid identity registry address",
      );
      expect(await rules.tokenIdentityRegistry(t)).to.equal(ethers.ZeroAddress);
    });

    it("the oracle, privacy, mode and administrator setters are the owner's", async function () {
      const s = rules.connect(bob);
      for (const call of [
        async () => s.setBlacklistOracle(t, ethers.ZeroAddress),
        async () => s.setWhitelistOracle(t, ethers.ZeroAddress),
        async () => s.setPrivacyManager(t, ethers.ZeroAddress),
        async () => s.setWhitelistMode(t, 0),
        async () => s.setRuleAdministrator(t, bob.address, true),
      ])
        await expect(call())
          .to.be.revertedWithCustomError(rules, "OwnableUnauthorizedAccount")
          .withArgs(bob.address);
    });

    it("the setters refuse the zero token and an oracle with no code", async function () {
      for (const call of [
        async () =>
          rules.setBlacklistOracle(ethers.ZeroAddress, ethers.ZeroAddress),
        async () =>
          rules.setWhitelistOracle(ethers.ZeroAddress, ethers.ZeroAddress),
        async () =>
          rules.setPrivacyManager(ethers.ZeroAddress, ethers.ZeroAddress),
        async () => rules.setWhitelistMode(ethers.ZeroAddress, 0),
      ])
        await expect(call()).to.be.revertedWithCustomError(
          rules,
          "InvalidTokenAddress",
        );
      await expect(rules.setBlacklistOracle(t, bob.address))
        .to.be.revertedWithCustomError(rules, "OracleNotAContract")
        .withArgs(bob.address);
      await expect(rules.setWhitelistOracle(t, bob.address))
        .to.be.revertedWithCustomError(rules, "OracleNotAContract")
        .withArgs(bob.address);
      await expect(
        rules.setRuleAdministrator(ethers.ZeroAddress, bob.address, true),
      ).to.be.revertedWith("ComplianceRules: Invalid token address");
      await expect(
        rules.setRuleAdministrator(t, ethers.ZeroAddress, true),
      ).to.be.revertedWith("ComplianceRules: Invalid administrator address");
    });

    it("ZkOnly and Either need a PrivacyManager: PrivacyManagerNotSet (173)", async function () {
      for (const mode of [1, 2])
        await expect(rules.setWhitelistMode(t, mode))
          .to.be.revertedWithCustomError(rules, "PrivacyManagerNotSet")
          .withArgs(t);
      await expect(rules.setWhitelistMode(t, 0))
        .to.emit(rules, "WhitelistModeSet")
        .withArgs(t, 0);
    });
  });
});
