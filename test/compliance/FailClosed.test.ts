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
});
