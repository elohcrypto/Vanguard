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

  // Task 4.15 (C §2: Token's onlyAgent and onlyOwner arms). The agent
  // surface refuses a stranger; an agent that is not the owner passes, and
  // so does the owner with its agent flag cleared (the modifier's second
  // arm). The owner surface refuses an agent.
  it("the agent surface refuses a stranger and takes both arms of onlyAgent", async () => {
    const { token, owner } = await deployToken();
    const [, agent, stranger, user] = await ethers.getSigners();
    const NOT_AGENT = "Not authorized agent";
    const s = token.connect(stranger);
    for (const call of [
      async () => s.mint(user.address, 1n),
      async () => s.burn(user.address, 1n),
      async () => s.setAddressFrozen(user.address, true),
      async () => s.freezePartialTokens(user.address, 1n),
      async () => s.unfreezePartialTokens(user.address, 1n),
      async () =>
        s.recoveryAddress(user.address, stranger.address, stranger.address),
    ])
      await expect(call()).to.be.revertedWith(NOT_AGENT);
    await token.addAgent(agent.address);
    await token.connect(agent).setAddressFrozen(user.address, true);
    expect(await token.isFrozen(user.address)).to.equal(true);
    await token.removeAgent(owner.address);
    expect(await token.isAgent(owner.address)).to.equal(false);
    await token.setAddressFrozen(user.address, false);
    expect(await token.isFrozen(user.address)).to.equal(false);
  });

  it("the owner surface refuses an agent", async () => {
    const { token, identityRegistry, compliance } = await deployToken();
    const [, agent] = await ethers.getSigners();
    await token.addAgent(agent.address);
    const a = token.connect(agent);
    for (const call of [
      async () => a.addAgent(agent.address),
      async () => a.removeAgent(agent.address),
      async () => a.setGuardian(agent.address),
      async () => a.setIdentityRegistry(await identityRegistry.getAddress()),
      async () => a.setCompliance(await compliance.getAddress()),
      async () => a.setInvestorTypeRegistry(await compliance.getAddress()),
    ])
      await expect(call())
        .to.be.revertedWithCustomError(token, "OwnableUnauthorizedAccount")
        .withArgs(agent.address);
  });
});
