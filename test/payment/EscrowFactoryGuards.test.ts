import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import { AMOUNT, deployEscrow, newEscrow, shipProof } from "../helpers/escrow";

// Plan v2 Task 5.3: every EscrowWalletFactory guard a caller can reach,
// each asserted by its reason (the factory's branch floor is 80).
describe("EscrowWalletFactory guards (Task 5.3)", function () {
  const UNAUTH = "AccessControlUnauthorizedAccount";
  const Z = ethers.ZeroAddress;

  it("the constructor refuses a zero or codeless dependency", async function () {
    const f = await loadFixture(deployEscrow);
    const F: any = await ethers.getContractFactory("EscrowWalletFactory");
    const eoa = f.stranger.address;
    const ok = [
      f.vsc.target,
      f.ownerWallet.address,
      f.registry.target,
      f.rules.target,
    ];
    const cases: [number, string, string][] = [
      [0, Z, "Invalid token"],
      [0, eoa, "EscrowWalletFactory: VSC token is not a contract"],
      [1, Z, "Invalid owner wallet"],
      [2, Z, "Invalid identity registry"],
      [2, eoa, "EscrowWalletFactory: Identity registry is not a contract"],
      [3, Z, "Invalid compliance rules"],
      [3, eoa, "EscrowWalletFactory: Compliance rules is not a contract"],
    ];
    for (const [i, bad, reason] of cases) {
      const a = [...ok];
      a[i] = bad;
      await expect(F.deploy(...a)).to.be.revertedWith(reason);
    }
  });

  it("setComplianceRules is the owner's and refuses zero or a codeless address", async function () {
    const f = await loadFixture(deployEscrow);
    await expect(
      f.factory.connect(f.stranger).setComplianceRules(f.rules.target),
    ).to.be.revertedWithCustomError(f.factory, "OwnableUnauthorizedAccount");
    await expect(f.factory.setComplianceRules(Z)).to.be.revertedWith(
      "Invalid compliance rules",
    );
    await expect(
      f.factory.setComplianceRules(f.stranger.address),
    ).to.be.revertedWith(
      "EscrowWalletFactory: Compliance rules is not a contract",
    );
    const next = await f.deployC("ComplianceRules", f.owner.address, [840], []);
    await f.factory.setComplianceRules(next.target);
    expect(await f.factory.complianceRules()).to.equal(next.target);
  });

  it("setIdentityRegistry refuses zero or a codeless address", async function () {
    const f = await loadFixture(deployEscrow);
    await expect(f.factory.setIdentityRegistry(Z)).to.be.revertedWith(
      "Invalid identity registry",
    );
    await expect(
      f.factory.setIdentityRegistry(f.stranger.address),
    ).to.be.revertedWith(
      "EscrowWalletFactory: Identity registry is not a contract",
    );
  });

  it("setOwnerWallet refuses the zero address", async function () {
    const f = await loadFixture(deployEscrow);
    await expect(f.factory.setOwnerWallet(Z)).to.be.revertedWith(
      "Invalid wallet",
    );
  });

  it("registerInvestor is ADMIN_ROLE's and refuses a zero investor or wallet", async function () {
    const f = await loadFixture(deployEscrow);
    await expect(
      f.factory
        .connect(f.stranger)
        .registerInvestor(f.stranger.address, f.stranger.address),
    ).to.be.revertedWithCustomError(f.factory, UNAUTH);
    await expect(
      f.factory.registerInvestor(Z, f.stranger.address),
    ).to.be.revertedWith("Invalid investor");
    await expect(
      f.factory.registerInvestor(f.stranger.address, Z),
    ).to.be.revertedWith("Invalid wallet");
  });

  it("deactivateInvestor is ADMIN_ROLE's and refuses an inactive investor", async function () {
    const f = await loadFixture(deployEscrow);
    await expect(
      f.factory.connect(f.stranger).deactivateInvestor(f.investor.address),
    ).to.be.revertedWithCustomError(f.factory, UNAUTH);
    await expect(
      f.factory.deactivateInvestor(f.stranger.address),
    ).to.be.revertedWith("Not active");
    await f.factory.deactivateInvestor(f.investor.address);
    await expect(
      f.factory.deactivateInvestor(f.investor.address),
    ).to.be.revertedWith("Not active");
  });

  it("createEscrowWallet is INVESTOR_ROLE's and refuses a zero payee or amount", async function () {
    const f = await loadFixture(deployEscrow);
    const create = (who: any, payee: string, amount: bigint) =>
      f.factory.connect(who).createEscrowWallet(f.payer.address, payee, amount);
    await expect(
      create(f.stranger, f.payee.address, AMOUNT),
    ).to.be.revertedWithCustomError(f.factory, UNAUTH);
    await expect(create(f.investor, Z, AMOUNT)).to.be.revertedWith(
      "Invalid payee",
    );
    // A zero amount is refused before the KYC reads (an unverified payee
    // would be refused there) and before the escrow's own amount check.
    await expect(create(f.investor, f.stranger.address, 0n)).to.be.revertedWith(
      "Invalid amount",
    );
  });

  it("fundEscrowWallet refuses an unknown payment id", async function () {
    const f = await loadFixture(deployEscrow);
    await expect(
      f.factory.connect(f.payer).fundEscrowWallet(99),
    ).to.be.revertedWith("Wallet not found");
  });

  it("fundEscrowWallet refuses an escrow no longer active (disputed before funding)", async function () {
    const f = await loadFixture(deployEscrow);
    const { id, wallet } = await newEscrow(f);
    await shipProof(f, wallet);
    await wallet.connect(f.payer).raiseDispute();
    await f.vsc.connect(f.payer).approve(f.factory.target, AMOUNT * 2n);
    await expect(
      f.factory.connect(f.payer).fundEscrowWallet(id),
    ).to.be.revertedWith("Wallet not active");
  });

  it("ownership moved to a role admin keeps that admin's role, and only it", async function () {
    const f = await loadFixture(deployEscrow);
    const ADMIN = await f.factory.DEFAULT_ADMIN_ROLE();
    const next = f.stranger;
    await f.factory.grantRole(ADMIN, next.address);
    await f.factory.transferOwnership(next.address);
    await f.factory.connect(next).acceptOwnership();
    expect(await f.factory.hasRole(ADMIN, next.address)).to.equal(true);
    expect(await f.factory.hasRole(ADMIN, f.owner.address)).to.equal(false);
    expect(await f.factory.getRoleMemberCount(ADMIN)).to.equal(1);
  });

  it("renouncing ownership leaves no role admin at all", async function () {
    const f = await loadFixture(deployEscrow);
    const ADMIN = await f.factory.DEFAULT_ADMIN_ROLE();
    await f.factory.renounceOwnership();
    expect(await f.factory.owner()).to.equal(Z);
    expect(await f.factory.getRoleMemberCount(ADMIN)).to.equal(0);
  });
});
