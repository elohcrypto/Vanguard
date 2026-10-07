import { expect } from "chai";
import { ethers } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import { attest, configureKyc } from "../helpers/kyc";

// Task 4.10 (D37 = a): the per-type transfer cooldown is a transfer rule.
// InvestorTypeRegistry keeps one lastTransferAt per sender, written only by
// a token it authorized (authorizeToken, the hook) after a user transfer;
// Token._checkTransfer refuses a non-trusted sender inside its type's
// cooldown with "Transfer cooldown", and fails closed with "Token not
// authorized by investor registry" while its registry has not authorized it.
describe("Investor-type transfer cooldown (Task 4.10)", function () {
  const e = ethers.parseEther;
  const NOT_AUTH = "Token not authorized by investor registry";
  const COOLDOWN = {
    Normal: 60,
    Retail: 60,
    Accredited: 30,
    Institutional: 15,
  };

  async function deploy() {
    const s = await ethers.getSigners();
    const [owner, treasury, alice, bob, carol, fresh, stranger] = s;
    const registry = await (
      await ethers.getContractFactory("IdentityRegistry")
    ).deploy();
    const issuer = await (
      await ethers.getContractFactory("ClaimIssuer")
    ).deploy(owner.address, "KYC", "KYC issuer");
    await configureKyc(registry, await issuer.getAddress());
    const OnchainID = await ethers.getContractFactory("OnchainID");
    const ids: Record<string, string> = {};
    for (const w of [treasury, alice, bob, carol]) {
      const id = await OnchainID.deploy(w.address);
      await registry.registerIdentity(w.address, id.target, 840);
      await attest(issuer, owner, id.target as string);
      ids[w.address] = id.target as string;
    }
    const rules = await (
      await ethers.getContractFactory("ComplianceRules")
    ).deploy(owner.address, [840], []);
    const token = await (
      await ethers.getContractFactory("Token")
    ).deploy("VSC", "VSC", registry.target, rules.target);
    await rules.setTokenIdentityRegistry(token.target, registry.target);
    await registry.addAgent(token.target);
    const types = await (
      await ethers.getContractFactory("InvestorTypeRegistry")
    ).deploy();
    await token.setInvestorTypeRegistry(types.target);
    await types.authorizeToken(token.target, true);
    await types.setInvestorLimitExempt(treasury.address, true);
    await token.mint(treasury.address, e("100000"));
    for (const w of [alice, bob, carol])
      await token.connect(treasury).transfer(w.address, e("1000"));
    return {
      ...{ owner, treasury, alice, bob, carol, fresh, stranger },
      ...{ registry, rules, token, types, ids },
    };
  }

  // The predicate agrees with the transfer: same verdict, same reason.
  async function agree(
    token: any,
    from: SignerWithAddress,
    to: string,
    reason?: string,
  ) {
    expect(await token.canTransfer(from.address, to, 1n)).to.equal(
      reason === undefined,
    );
    const tx = token.connect(from).transfer(to, 1n);
    if (reason) await expect(tx).to.be.revertedWith(reason);
    else await tx;
  }

  // Send at an exact timestamp (a reverted transaction still mines a block).
  async function sendAt(
    token: any,
    from: SignerWithAddress,
    to: string,
    at: bigint,
    reason?: string,
  ) {
    await time.setNextBlockTimestamp(at);
    const tx = token.connect(from).transfer(to, 1n);
    if (reason) await expect(tx).to.be.revertedWith(reason);
    else await tx;
  }

  it("refuses a transfer inside the cooldown and allows it at the boundary", async function () {
    const { alice, bob, token, types } = await deploy();
    await token.connect(alice).transfer(bob.address, 1n);
    const t0 = await types.lastTransferAt(alice.address);
    expect(t0).to.equal(BigInt(await time.latest()));
    await agree(token, alice, bob.address, "Transfer cooldown");
    expect(await types.canTransferNow(alice.address)).to.equal(false);
    // A refused transfer writes no clock.
    expect(await types.lastTransferAt(alice.address)).to.equal(t0);
    await sendAt(token, alice, bob.address, t0 + 3599n, "Transfer cooldown");
    await sendAt(token, alice, bob.address, t0 + 3600n);
    expect(await types.lastTransferAt(alice.address)).to.equal(t0 + 3600n);
    await agree(token, alice, bob.address, "Transfer cooldown");
  });

  for (const [name, minutes] of Object.entries(COOLDOWN)) {
    it(`${name}: the chain's cooldown of ${minutes} minutes applies`, async function () {
      const { alice, bob, token, types } = await deploy();
      const typeId = Object.keys(COOLDOWN).indexOf(name);
      if (typeId > 0) await types.assignInvestorType(alice.address, typeId);
      expect(await types.getTransferCooldown(alice.address)).to.equal(minutes);
      await token.connect(alice).transfer(bob.address, 1n);
      const t0 = await types.lastTransferAt(alice.address);
      const end = t0 + BigInt(minutes * 60);
      await sendAt(token, alice, bob.address, end - 1n, "Transfer cooldown");
      await sendAt(token, alice, bob.address, end);
    });
  }

  it("an investorLimitExempt sender has no cooldown and no clock", async function () {
    const { treasury, alice, bob, token, types } = await deploy();
    await agree(token, treasury, alice.address);
    await agree(token, treasury, bob.address);
    expect(await types.lastTransferAt(treasury.address)).to.equal(0n);
    // A sender exempted later keeps its old clock but is never held to it.
    await token.connect(alice).transfer(bob.address, 1n);
    const t0 = await types.lastTransferAt(alice.address);
    await types.setInvestorLimitExempt(alice.address, true);
    await agree(token, alice, bob.address);
    expect(await types.lastTransferAt(alice.address)).to.equal(t0);
  });

  it("a type whose cooldown is 0 has no cooldown", async function () {
    const { alice, bob, token, types } = await deploy();
    const cfg = await types.getInvestorTypeConfig(0);
    await types.updateInvestorTypeConfig(0, {
      maxTransferAmount: cfg.maxTransferAmount,
      maxHoldingAmount: cfg.maxHoldingAmount,
      requiredWhitelistTier: cfg.requiredWhitelistTier,
      transferCooldownMinutes: 0,
      largeTransferThreshold: cfg.largeTransferThreshold,
      enhancedLogging: cfg.enhancedLogging,
      enhancedPrivacy: cfg.enhancedPrivacy,
    });
    await agree(token, alice, bob.address);
    await agree(token, alice, bob.address);
  });

  it("transferFrom writes the owner's clock, not the spender's", async function () {
    const { alice, bob, carol, token, types } = await deploy();
    await token.connect(alice).approve(carol.address, 10n);
    await token.connect(carol).transferFrom(alice.address, bob.address, 1n);
    expect(await types.lastTransferAt(alice.address)).to.be.gt(0n);
    expect(await types.lastTransferAt(carol.address)).to.equal(0n);
    await expect(
      token.connect(carol).transferFrom(alice.address, bob.address, 1n),
    ).to.be.revertedWith("Transfer cooldown");
  });

  it("receiving, mint, burn and recovery write no clock", async function () {
    const { owner, treasury, alice, bob, fresh, token, types, ids } =
      await deploy();
    // treasury's transfers in the fixture: bob received, wrote nothing.
    expect(await types.lastTransferAt(bob.address)).to.equal(0n);
    await token.mint(alice.address, e("10"));
    await token.burn(alice.address, e("10"));
    expect(await types.lastTransferAt(alice.address)).to.equal(0n);
    await token
      .connect(owner)
      .recoveryAddress(alice.address, fresh.address, ids[alice.address]);
    expect(await token.balanceOf(fresh.address)).to.equal(e("1000"));
    expect(await types.lastTransferAt(alice.address)).to.equal(0n);
    expect(await types.lastTransferAt(fresh.address)).to.equal(0n);
    // The recovered wallet may send at once.
    await agree(token, fresh, bob.address);
    // R-410-8: the exempt treasury sent in the fixture; no clock written.
    expect(await types.lastTransferAt(treasury.address)).to.equal(0n);
  });

  it("D26: the human sender's clock is written, a trusted sender has none", async function () {
    const { alice, bob, rules, token, types } = await deploy();
    const c = await (await ethers.getContractFactory("MockTarget")).deploy();
    const addr = await c.getAddress();
    await rules.addTrustedContract(token.target, addr);
    await ethers.provider.send("hardhat_setBalance", [
      addr,
      "0xDE0B6B3A7640000",
    ]);
    const t = await ethers.getImpersonatedSigner(addr);

    // human -> trusted: the human's cooldown applies and starts.
    await agree(token, alice, addr);
    expect(await types.lastTransferAt(alice.address)).to.be.gt(0n);
    await agree(token, alice, addr, "Transfer cooldown");

    // trusted -> human: no type, no cooldown, no clock.
    await token.connect(t).transfer(bob.address, 1n);
    expect(await token.canTransfer(addr, bob.address, 0n)).to.equal(true);
    await token.connect(t).transfer(bob.address, 0n);
    expect(await types.lastTransferAt(addr)).to.equal(0n);
    expect(await types.lastTransferAt(bob.address)).to.equal(0n);
  });

  it("R-410-1: an unauthorized token with a registry set refuses, loudly", async function () {
    const { treasury, alice, bob, token, types } = await deploy();
    await types.authorizeToken(token.target, false);
    await agree(token, alice, bob.address, NOT_AUTH);
    // An exempt sender too, and a mint: the token is misconfigured (R-410-3).
    await agree(token, treasury, bob.address, NOT_AUTH);
    expect(
      await token.canTransfer(ethers.ZeroAddress, bob.address, 1n),
    ).to.equal(false);
    await expect(token.mint(bob.address, 1n)).to.be.revertedWith(NOT_AUTH);
    // Burn does not consult the registry.
    await token.burn(bob.address, 1n);
    await types.authorizeToken(token.target, true);
    await agree(token, alice, bob.address);
  });

  it("only an authorized token can call recordTransfer", async function () {
    const { alice, stranger, token, types } = await deploy();
    await expect(
      types.connect(stranger).recordTransfer(alice.address),
    ).to.be.revertedWith("Token not authorized");

    const other = await (
      await ethers.getContractFactory("MockTarget")
    ).deploy();
    const asOther = await impersonate(await other.getAddress());
    await expect(
      types.connect(asOther).recordTransfer(alice.address),
    ).to.be.revertedWith("Token not authorized");

    const asToken = await impersonate(token.target as string);
    await types.connect(asToken).recordTransfer(alice.address);
    expect(await types.lastTransferAt(alice.address)).to.equal(
      BigInt(await time.latest()),
    );
    await types.authorizeToken(token.target, false);
    await expect(
      types.connect(asToken).recordTransfer(alice.address),
    ).to.be.revertedWith("Token not authorized");
  });

  it("a token without a registry has no cooldown and writes no clock", async function () {
    const { alice, bob, registry, rules } = await deploy();
    const plain = await (
      await ethers.getContractFactory("Token")
    ).deploy("P", "P", registry.target, rules.target);
    await rules.setTokenIdentityRegistry(plain.target, registry.target);
    await plain.mint(alice.address, 10n);
    await agree(plain, alice, bob.address);
    await agree(plain, alice, bob.address);
  });

  async function impersonate(addr: string) {
    await ethers.provider.send("hardhat_setBalance", [
      addr,
      "0xDE0B6B3A7640000",
    ]);
    return ethers.getImpersonatedSigner(addr);
  }
});
