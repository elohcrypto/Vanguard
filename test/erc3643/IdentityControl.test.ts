import { expect } from "chai";
import { ethers } from "hardhat";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import { attest, configureKyc } from "../helpers/kyc";

// Plan v2 Task 4.14, D41 (A2 L-3): a wallet is bound to an identity only
// when it controls it, under the one rule governance votes by (D25 b):
// it owns the identity or holds a MANAGEMENT or ACTION key on it.
// Token.recoveryAddress, IdentityRegistry.registerIdentity,
// batchRegisterIdentity and moveIdentity all refuse a stranger wallet, so
// the asset-side and identity-side recoveries cannot diverge.

const MGMT = 1;
const ACTION = 2;
const k = (a: string) => ethers.solidityPackedKeccak256(["address"], [a]);
const E = (n: string) => ethers.parseEther(n);

describe("Wallets bound to an identity must control it (4.14, D41)", function () {
  let owner: SignerWithAddress,
    lost: SignerWithAddress,
    fresh: SignerWithAddress,
    other: SignerWithAddress,
    stranger: SignerWithAddress;
  let idReg: any, token: any, kycIssuer: any, lostIdC: any, lostId: string;

  beforeEach(async function () {
    [owner, lost, fresh, other, stranger] = await ethers.getSigners();
    idReg = await (
      await ethers.getContractFactory("IdentityRegistry")
    ).deploy();
    const rules = await (
      await ethers.getContractFactory("ComplianceRules")
    ).deploy(owner.address, [840], []);
    token = await (
      await ethers.getContractFactory("Token")
    ).deploy(
      "Vanguard",
      "VSC",
      await idReg.getAddress(),
      await rules.getAddress(),
    );
    await rules.setTokenIdentityRegistry(
      await token.getAddress(),
      await idReg.getAddress(),
    );
    await idReg.addAgent(owner.address);
    await idReg.addAgent(await token.getAddress());
    kycIssuer = await (
      await ethers.getContractFactory("ClaimIssuer")
    ).deploy(owner.address, "KYC Issuer", "Trusted KYC attestations");
    await configureKyc(idReg, await kycIssuer.getAddress());
    lostIdC = await (
      await ethers.getContractFactory("OnchainID")
    ).deploy(lost.address);
    lostId = await lostIdC.getAddress();
    await idReg.registerIdentity(lost.address, lostId, 840);
    await attest(kycIssuer, owner, lostId);
    await token.mint(lost.address, E("1000"));
  });

  /** Gives `fresh` the named control over the lost identity. */
  async function control(how: string) {
    if (how === "owner") {
      await lostIdC.connect(lost).transferOwnership(fresh.address);
      await lostIdC.connect(fresh).acceptOwnership();
    } else if (how === "MANAGEMENT") {
      await lostIdC.connect(lost).addKey(k(fresh.address), MGMT, 1);
    } else if (how === "ACTION") {
      await lostIdC.connect(lost).addKey(k(fresh.address), ACTION, 1);
    }
  }

  for (const how of ["owner", "MANAGEMENT", "ACTION"]) {
    it(`recoveryAddress and moveIdentity accept a new wallet that is the identity's ${how}`, async function () {
      await expect(token.recoveryAddress(lost.address, fresh.address, lostId))
        .to.be.revertedWithCustomError(token, "WalletDoesNotControlIdentity")
        .withArgs(fresh.address, lostId);
      await expect(idReg.moveIdentity(lost.address, fresh.address))
        .to.be.revertedWithCustomError(idReg, "WalletDoesNotControlIdentity")
        .withArgs(fresh.address, lostId);
      await control(how);
      await token.recoveryAddress(lost.address, fresh.address, lostId);
      expect(await token.balanceOf(fresh.address)).to.equal(E("1000"));
      expect(await idReg.identity(fresh.address)).to.equal(lostId);
      expect(await idReg.identity(lost.address)).to.equal(ethers.ZeroAddress);
    });
  }

  it("moveIdentity alone: the destination wallet must control the identity", async function () {
    await expect(idReg.moveIdentity(lost.address, stranger.address))
      .to.be.revertedWithCustomError(idReg, "WalletDoesNotControlIdentity")
      .withArgs(stranger.address, lostId);
    await lostIdC.connect(lost).addKey(k(stranger.address), ACTION, 1);
    await idReg.moveIdentity(lost.address, stranger.address);
    expect(await idReg.identity(stranger.address)).to.equal(lostId);
  });

  it("registerIdentity and batchRegisterIdentity refuse a wallet that does not control the identity, or an identity with no code", async function () {
    const otherIdC = await (
      await ethers.getContractFactory("OnchainID")
    ).deploy(other.address);
    const otherId = await otherIdC.getAddress();
    await expect(idReg.registerIdentity(stranger.address, otherId, 840))
      .to.be.revertedWithCustomError(idReg, "WalletDoesNotControlIdentity")
      .withArgs(stranger.address, otherId);
    await expect(
      idReg.batchRegisterIdentity([stranger.address], [otherId], [840]),
    )
      .to.be.revertedWithCustomError(idReg, "WalletDoesNotControlIdentity")
      .withArgs(stranger.address, otherId);
    await expect(
      idReg.registerIdentity(stranger.address, stranger.address, 840),
    )
      .to.be.revertedWithCustomError(idReg, "WalletDoesNotControlIdentity")
      .withArgs(stranger.address, stranger.address);
    // The owner registers; a MANAGEMENT or ACTION key holder registers too.
    await idReg.batchRegisterIdentity([other.address], [otherId], [840]);
    expect(await idReg.identity(other.address)).to.equal(otherId);
    const freshIdC = await (
      await ethers.getContractFactory("OnchainID")
    ).deploy(fresh.address);
    const freshId = await freshIdC.getAddress();
    await freshIdC.connect(fresh).addKey(k(stranger.address), ACTION, 1);
    await idReg.registerIdentity(stranger.address, freshId, 840);
    expect(await idReg.identity(stranger.address)).to.equal(freshId);
  });
});
