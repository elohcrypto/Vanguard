import { expect } from "chai";
import { ethers } from "hardhat";

/**
 * Token.pause() may be called by the owner or a single guardian address, so a
 * guardian multisig can stop transfers without a governance vote. unpause()
 * stays owner-only: restarting the token is governance's call.
 */
describe("Token — guardian pause", () => {
  async function deployToken() {
    const [owner, guardian, stranger] = await ethers.getSigners();
    const identityRegistry = await (
      await ethers.getContractFactory("IdentityRegistry")
    ).deploy();
    const compliance = await (
      await ethers.getContractFactory("ComplianceRegistry")
    ).deploy();
    const token = await (
      await ethers.getContractFactory("Token")
    ).deploy(
      "Vanguard StableCoin",
      "VSC",
      await identityRegistry.getAddress(),
      await compliance.getAddress(),
    );
    await token.waitForDeployment();
    return { token, owner, guardian, stranger };
  }

  it("owner can pause and unpause", async () => {
    const { token } = await deployToken();
    await token.pause();
    expect(await token.paused()).to.equal(true);
    await token.unpause();
    expect(await token.paused()).to.equal(false);
  });

  it("guardian can pause", async () => {
    const { token, guardian } = await deployToken();
    await token.setGuardian(guardian.address);
    await token.connect(guardian).pause();
    expect(await token.paused()).to.equal(true);
  });

  it("guardian cannot unpause", async () => {
    const { token, guardian } = await deployToken();
    await token.setGuardian(guardian.address);
    await token.connect(guardian).pause();
    await expect(token.connect(guardian).unpause())
      .to.be.revertedWithCustomError(token, "OwnableUnauthorizedAccount")
      .withArgs(guardian.address);
    expect(await token.paused()).to.equal(true);
  });

  it("a stranger cannot pause", async () => {
    const { token, guardian, stranger } = await deployToken();
    await token.setGuardian(guardian.address);
    await expect(token.connect(stranger).pause()).to.be.revertedWith(
      "Token: caller is not owner or guardian",
    );
  });

  it("setGuardian is owner-only and emits GuardianUpdated", async () => {
    const { token, guardian, stranger } = await deployToken();
    await expect(token.connect(stranger).setGuardian(stranger.address))
      .to.be.revertedWithCustomError(token, "OwnableUnauthorizedAccount")
      .withArgs(stranger.address);
    await expect(token.setGuardian(guardian.address))
      .to.emit(token, "GuardianUpdated")
      .withArgs(ethers.ZeroAddress, guardian.address);
    expect(await token.guardian()).to.equal(guardian.address);
  });

  it("clearing the guardian removes the pause power", async () => {
    const { token, guardian } = await deployToken();
    await token.setGuardian(guardian.address);
    await expect(token.setGuardian(ethers.ZeroAddress))
      .to.emit(token, "GuardianUpdated")
      .withArgs(guardian.address, ethers.ZeroAddress);
    await expect(token.connect(guardian).pause()).to.be.revertedWith(
      "Token: caller is not owner or guardian",
    );
  });
});
