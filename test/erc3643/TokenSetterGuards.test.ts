import { expect } from "chai";
import { ethers } from "hardhat";

/**
 * Token's three dependency setters replace contracts the transfer path calls on
 * every transfer. Before these guards they accepted any address — including the
 * zero address and plain wallets — and the failure surfaced later inside
 * transfer() as a revert with no reason string.
 *
 * Each case asserts both directions: a bad address is rejected, and a real
 * contract is still accepted, so the guard is not over-broad.
 */
describe("Token — dependency setter guards", () => {
  async function deployToken() {
    const [owner] = await ethers.getSigners();

    const identityRegistry = await (
      await ethers.getContractFactory("IdentityRegistry")
    ).deploy();
    await identityRegistry.waitForDeployment();

    const compliance = await (
      await ethers.getContractFactory("ComplianceRegistry")
    ).deploy();
    await compliance.waitForDeployment();

    const token = await (
      await ethers.getContractFactory("Token")
    ).deploy(
      "Vanguard StableCoin",
      "VSC",
      await identityRegistry.getAddress(),
      await compliance.getAddress(),
    );
    await token.waitForDeployment();

    return { token, owner, identityRegistry, compliance };
  }

  it("the constructor rejects non-contract dependencies", async () => {
    const [owner] = await ethers.getSigners();
    const Token = await ethers.getContractFactory("Token");

    const ir = await (
      await ethers.getContractFactory("IdentityRegistry")
    ).deploy();
    await ir.waitForDeployment();
    const cr = await (
      await ethers.getContractFactory("ComplianceRegistry")
    ).deploy();
    await cr.waitForDeployment();

    // A token deployed with a bad dependency cannot be repaired — unlike a
    // setter mistake, it has to be redeployed. Guard at construction too.
    await expect(
      Token.deploy("V", "VSC", owner.address, await cr.getAddress()),
    ).to.be.revertedWith("Token: Identity registry is not a contract");

    await expect(
      Token.deploy("V", "VSC", await ir.getAddress(), owner.address),
    ).to.be.revertedWith("Token: Compliance is not a contract");

    await expect(
      Token.deploy("V", "VSC", ethers.ZeroAddress, await cr.getAddress()),
    ).to.be.revertedWith("Token: Identity registry is zero address");

    // Valid dependencies still deploy.
    await expect(
      Token.deploy("V", "VSC", await ir.getAddress(), await cr.getAddress()),
    ).to.not.be.reverted;
  });

  it("setIdentityRegistry rejects zero address and EOAs, accepts a contract", async () => {
    const { token, owner, identityRegistry } = await deployToken();

    await expect(
      token.setIdentityRegistry(ethers.ZeroAddress),
    ).to.be.revertedWith("Token: Identity registry is zero address");
    await expect(token.setIdentityRegistry(owner.address)).to.be.revertedWith(
      "Token: Identity registry is not a contract",
    );
    await expect(token.setIdentityRegistry(await identityRegistry.getAddress()))
      .to.not.be.reverted;
  });

  it("setCompliance rejects zero address and EOAs, accepts a contract", async () => {
    const { token, owner, compliance } = await deployToken();

    await expect(token.setCompliance(ethers.ZeroAddress)).to.be.revertedWith(
      "Token: Compliance is zero address",
    );
    await expect(token.setCompliance(owner.address)).to.be.revertedWith(
      "Token: Compliance is not a contract",
    );
    await expect(token.setCompliance(await compliance.getAddress())).to.not.be
      .reverted;
  });

  it("setInvestorTypeRegistry rejects zero address and EOAs, accepts a contract", async () => {
    const { token, owner } = await deployToken();

    const registry = await (
      await ethers.getContractFactory("InvestorTypeRegistry")
    ).deploy();
    await registry.waitForDeployment();

    await expect(
      token.setInvestorTypeRegistry(ethers.ZeroAddress),
    ).to.be.revertedWith("Token: Investor type registry is zero address");
    await expect(
      token.setInvestorTypeRegistry(owner.address),
    ).to.be.revertedWith("Token: Investor type registry is not a contract");
    await expect(token.setInvestorTypeRegistry(await registry.getAddress())).to
      .not.be.reverted;
  });
});
