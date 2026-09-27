import { expect } from "chai";
import { ethers } from "hardhat";

/**
 * Token, IdentityRegistry, ComplianceRules and OracleManager are Ownable2Step:
 * transferOwnership only nominates, and the nominee must call acceptOwnership.
 * A typo or a contract that cannot accept therefore never strands ownership.
 */
describe("Core contracts — Ownable2Step", () => {
  async function deployAll() {
    const [owner] = await ethers.getSigners();
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
    const complianceRules = await (
      await ethers.getContractFactory("ComplianceRules")
    ).deploy(owner.address, [840], []);
    const oracleManager = await (
      await ethers.getContractFactory("OracleManager")
    ).deploy();
    return { token, identityRegistry, complianceRules, oracleManager };
  }

  for (const name of [
    "token",
    "identityRegistry",
    "complianceRules",
    "oracleManager",
  ] as const) {
    describe(name, () => {
      it("transferOwnership nominates without moving ownership", async () => {
        const [owner, next] = await ethers.getSigners();
        const c = (await deployAll())[name];
        await c.transferOwnership(next.address);
        expect(await c.owner()).to.equal(owner.address);
        expect(await c.pendingOwner()).to.equal(next.address);
      });

      it("acceptOwnership by the nominee completes the transfer", async () => {
        const [, next] = await ethers.getSigners();
        const c = (await deployAll())[name];
        await c.transferOwnership(next.address);
        await c.connect(next).acceptOwnership();
        expect(await c.owner()).to.equal(next.address);
        expect(await c.pendingOwner()).to.equal(ethers.ZeroAddress);
      });

      it("acceptOwnership by anyone else reverts", async () => {
        const [owner, next, stranger] = await ethers.getSigners();
        const c = (await deployAll())[name];
        await c.transferOwnership(next.address);
        await expect(c.connect(stranger).acceptOwnership())
          .to.be.revertedWithCustomError(c, "OwnableUnauthorizedAccount")
          .withArgs(stranger.address);
        expect(await c.owner()).to.equal(owner.address);
      });
    });
  }
});
