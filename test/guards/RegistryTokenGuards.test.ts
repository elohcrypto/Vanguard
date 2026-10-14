import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import { T, deployCustody } from "../helpers/custody";

// Plan v2 Task 5.3: guards that no test reached before (4.17 had filed
// them "defensive"); each is reachable by its own caller (agent, owner,
// compliance officer, deployer) and asserted by its reason here.
describe("Registry, type-registry and token guards (Task 5.3)", function () {
  const Z = ethers.ZeroAddress;
  const E = ethers.parseEther;

  describe("IdentityRegistry", function () {
    it("registerIdentity refuses the zero identity", async function () {
      const f = await loadFixture(deployCustody);
      await expect(
        f.registry.registerIdentity(f.stranger.address, Z, 840),
      ).to.be.revertedWith("Invalid identity address");
    });

    it("updateIdentity refuses a zero wallet, a zero identity and an unregistered wallet", async function () {
      const f = await loadFixture(deployCustody);
      const id = await f.registry.identity(f.user.address);
      await expect(f.registry.updateIdentity(Z, id)).to.be.revertedWith(
        "Invalid user address",
      );
      await expect(
        f.registry.updateIdentity(f.user.address, Z),
      ).to.be.revertedWith("Invalid identity address");
      await expect(
        f.registry.updateIdentity(f.stranger.address, id),
      ).to.be.revertedWith("Identity not registered");
    });

    it("batchRegisterIdentity refuses arrays of different lengths", async function () {
      const f = await loadFixture(deployCustody);
      await expect(
        f.registry.batchRegisterIdentity([f.stranger.address], [], [840]),
      ).to.be.revertedWith("Array length mismatch");
    });
  });

  describe("InvestorTypeRegistry", function () {
    const cfg = (o: Record<string, unknown> = {}) => ({
      maxTransferAmount: E("9000"),
      maxHoldingAmount: E("60000"),
      requiredWhitelistTier: 2,
      transferCooldownMinutes: 30,
      largeTransferThreshold: E("4000"),
      enhancedLogging: false,
      enhancedPrivacy: false,
      ...o,
    });

    it("assign, upgrade and downgrade refuse the zero investor", async function () {
      const f = await loadFixture(deployCustody);
      const BAD = "Invalid investor address";
      await expect(f.types.assignInvestorType(Z, T.Retail)).to.be.revertedWith(
        BAD,
      );
      await expect(f.types.upgradeInvestorType(Z, T.Retail)).to.be.revertedWith(
        BAD,
      );
      await expect(
        f.types.downgradeInvestorType(Z, T.Normal),
      ).to.be.revertedWith(BAD);
    });

    it("downgradeInvestorType refuses a type that is not lower", async function () {
      const f = await loadFixture(deployCustody);
      await expect(
        f.types.downgradeInvestorType(f.user.address, T.Retail),
      ).to.be.revertedWith("Not a downgrade");
    });

    it("updateInvestorTypeConfig refuses zero caps and a tier outside 1..5", async function () {
      const f = await loadFixture(deployCustody);
      const set = (o: Record<string, unknown>) =>
        f.types.updateInvestorTypeConfig(T.Retail, cfg(o));
      await expect(set({ maxTransferAmount: 0n })).to.be.revertedWith(
        "Invalid max transfer amount",
      );
      await expect(set({ maxHoldingAmount: 0n })).to.be.revertedWith(
        "Invalid max holding amount",
      );
      for (const tier of [0, 6])
        await expect(set({ requiredWhitelistTier: tier })).to.be.revertedWith(
          "Invalid whitelist tier",
        );
    });

    it("setComplianceOfficer and authorizeToken refuse the zero address", async function () {
      const f = await loadFixture(deployCustody);
      await expect(f.types.setComplianceOfficer(Z, true)).to.be.revertedWith(
        "Invalid officer address",
      );
      await expect(f.types.authorizeToken(Z, true)).to.be.revertedWith(
        "Invalid token address",
      );
    });
  });

  describe("Token", function () {
    it("the constructor refuses the zero compliance", async function () {
      const f = await loadFixture(deployCustody);
      const F = await ethers.getContractFactory("Token");
      await expect(F.deploy("V", "V", f.registry.target, Z)).to.be.revertedWith(
        "Token: Compliance is zero address",
      );
    });

    it("burn refuses more than the balance; a partial freeze refuses more than is free", async function () {
      const f = await loadFixture(deployCustody);
      await f.token.mint(f.user.address, 100n);
      await expect(f.token.burn(f.user.address, 101n)).to.be.revertedWith(
        "Insufficient balance",
      );
      await f.token.freezePartialTokens(f.user.address, 60n);
      await expect(
        f.token.freezePartialTokens(f.user.address, 41n),
      ).to.be.revertedWith("Insufficient balance to freeze");
    });
  });

  it("ComplianceRules.addTrustedContract refuses the zero contract", async function () {
    const f = await loadFixture(deployCustody);
    await expect(
      f.rules.addTrustedContract(f.token.target, Z),
    ).to.be.revertedWith("Invalid address");
  });
});
