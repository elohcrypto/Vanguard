import { expect } from "chai";
import { ethers, network } from "hardhat";
import { attest, configureKyc } from "../helpers/kyc";

const {
  escrowFactoriesFromChain,
  liveRuleAdministrators,
  liveTrustedContracts,
} = require("../../demo/utils/HandoverScans");

/**
 * Plan v2 Task 4.1, G5 (D36 a): trusted contracts and rule administrators
 * are per token. Token and GovernanceToken read the 1-arg
 * isTrustedContract as "trusted for msg.sender"; off-chain readers (the
 * handover scans, the escrow demo) use isTrustedContract(token, account)
 * and the token-indexed TrustedContractAdded / RuleAdministratorUpdated.
 */
describe("ComplianceRules per-token trust and administrators (G5)", function () {
  async function fixture() {
    const [owner, admin, alice, bob, carol] = await ethers.getSigners();
    const D = async (name: string, ...args: any[]) =>
      (await ethers.getContractFactory(name)).deploy(...args);
    const rules: any = await D("ComplianceRules", owner.address, [], []);
    const idReg: any = await D("IdentityRegistry");
    const rulesAddr = await rules.getAddress();
    const vsc: any = await D("Token", "VSC", "VSC", idReg.target, rulesAddr);
    const vgt: any = await D("Token", "VGT", "VGT", idReg.target, rulesAddr);
    return { owner, admin, alice, bob, carol, rules, idReg, vsc, vgt };
  }

  /** Call `rules` as `token` would: msg.sender is the token. */
  async function tokenSigner(token: string) {
    await network.provider.send("hardhat_setBalance", [
      token,
      "0x56BC75E2D63100000",
    ]);
    return ethers.getImpersonatedSigner(token);
  }
  async function asToken(rules: any, token: string, account: string) {
    const signer = await tokenSigner(token);
    return rules.connect(signer)["isTrustedContract(address)"](account);
  }

  it("canReceive refuses an account trusted on any token (recovery, M1)", async function () {
    const { rules, vsc, vgt } = await fixture();
    const g = await (
      await (await ethers.getContractFactory("MockToken")).deploy("G", "G", 0)
    ).getAddress();
    const viaVsc = rules.connect(await tokenSigner(vsc.target));
    expect(await viaVsc.canReceive(g)).to.equal(true);
    await rules.addTrustedContract(vgt.target, g);
    await rules.addTrustedContract(vsc.target, g);
    expect(await viaVsc.canReceive(g)).to.equal(false);
    await rules.removeTrustedContract(vsc.target, g);
    // Still trusted on VGT: still not a recovery target on VSC.
    expect(await viaVsc.canReceive(g)).to.equal(false);
    await rules.removeTrustedContract(vgt.target, g);
    expect(await viaVsc.canReceive(g)).to.equal(true);
  });

  // Review L1: the identity registry is shared, so a recovery on one token
  // must not move a holder's identity onto a contract another token trusts.
  // Each token's own trusted check sees only its map (G5); canReceive's
  // any-token refusal closes both directions. VSC into a VGT-only contract
  // is the governance case (GovernanceAgentLimits P1); here a generic stub.
  for (const [recoverOn, trustOn] of [
    ["VGT", "VSC"],
    ["VSC", "VGT"],
  ]) {
    it(`a ${recoverOn} recovery into a contract trusted only on ${trustOn} reverts`, async function () {
      const { owner, alice, idReg, rules } = await fixture();
      const D = async (name: string, ...args: any[]) =>
        (await ethers.getContractFactory(name)).deploy(...args);
      // VGT is a real GovernanceToken (its D23 hook refuses only VGT-trusted).
      const vsc: any = await D(
        "Token",
        "VSC",
        "VSC",
        idReg.target,
        rules.target,
      );
      const vgt: any = await D(
        "GovernanceToken",
        "VGT",
        "VGT",
        idReg.target,
        rules.target,
      );
      const tok: Record<string, any> = { VSC: vsc, VGT: vgt };
      const issuer = await D("ClaimIssuer", owner.address, "KYC", "KYC");
      await configureKyc(idReg, await issuer.getAddress());
      const id = await D("OnchainID", alice.address);
      await idReg.registerIdentity(alice.address, id.target, 840);
      await attest(issuer as any, owner, id.target as string);
      for (const t of [vsc, vgt]) {
        await rules.setTokenIdentityRegistry(t.target, idReg.target);
        await idReg.addAgent(t.target); // recovery calls moveIdentity
      }
      const token = tok[recoverOn];
      await token.mint(alice.address, 100n);
      const stub = (await D("MockToken", "S", "S", 0)).target as string;
      await rules.addTrustedContract(tok[trustOn].target, stub);
      // The cause is the trust elsewhere, not this token's own map or a list.
      expect(await rules.isTrustedOnAnyToken(stub)).to.equal(true);
      expect(
        await rules["isTrustedContract(address,address)"](token.target, stub),
      ).to.equal(false);

      await expect(
        token.recoveryAddress(alice.address, stub, id.target),
      ).to.be.revertedWith("Recovery blocked by compliance");
      expect(await idReg.identity(alice.address)).to.equal(id.target);
      expect(await idReg.identity(stub)).to.equal(ethers.ZeroAddress);
      expect(await token.balanceOf(alice.address)).to.equal(100n);

      // Untrusted there, the same recovery goes through.
      await rules.removeTrustedContract(tok[trustOn].target, stub);
      expect(await rules.isTrustedOnAnyToken(stub)).to.equal(false);
      await token.recoveryAddress(alice.address, stub, id.target);
      expect(await idReg.identity(stub)).to.equal(id.target);
    });
  }

  it("trust on one token is not trust on another; events name the token", async function () {
    const { rules, vsc, vgt } = await fixture();
    const [vscAddr, vgtAddr] = [vsc.target, vgt.target];
    const escrow = await (
      await ethers.getContractFactory("MockToken")
    ).deploy("E", "E", 0);
    const e = await escrow.getAddress();
    await expect(rules.addTrustedContract(vgtAddr, e))
      .to.emit(rules, "TrustedContractAdded")
      .withArgs(vgtAddr, e);
    expect(
      await rules["isTrustedContract(address,address)"](vgtAddr, e),
    ).to.equal(true);
    expect(
      await rules["isTrustedContract(address,address)"](vscAddr, e),
    ).to.equal(false);
    expect(await asToken(rules, vgtAddr, e)).to.equal(true);
    expect(await asToken(rules, vscAddr, e)).to.equal(false);
    // From a wallet, the 1-arg view reads the wallet's (empty) map.
    expect(await rules["isTrustedContract(address)"](e)).to.equal(false);

    await expect(rules.removeTrustedContract(vscAddr, e)).to.be.revertedWith(
      "Not trusted",
    );
    await expect(rules.removeTrustedContract(vgtAddr, e))
      .to.emit(rules, "TrustedContractRemoved")
      .withArgs(vgtAddr, e);
    expect(
      await rules["isTrustedContract(address,address)"](vgtAddr, e),
    ).to.equal(false);
  });

  it("refuses the zero token; the owner stays trusted on every token (D21)", async function () {
    const { owner, rules, vsc, vgt } = await fixture();
    const c = await (
      await ethers.getContractFactory("MockToken")
    ).deploy("G", "G", 0);
    const g = await c.getAddress();
    await expect(
      rules.addTrustedContract(ethers.ZeroAddress, g),
    ).to.be.revertedWith("ComplianceRules: Invalid token address");
    for (const t of [vsc.target, vgt.target]) {
      await rules.addTrustedContract(t, g);
    }
    await rules.transferOwnership(g);
    await network.provider.send("hardhat_setBalance", [
      g,
      "0x56BC75E2D63100000",
    ]);
    const asOwner = rules.connect(await ethers.getImpersonatedSigner(g));
    await asOwner.acceptOwnership();
    for (const t of [vsc.target, vgt.target]) {
      await expect(asOwner.removeTrustedContract(t, g)).to.be.revertedWith(
        "ComplianceRules: owner stays trusted",
      );
    }
    expect(await rules.owner()).to.not.equal(owner.address);
  });

  it("the escrow-factory scan finds the factory of an escrow trusted on VSC", async function () {
    const { owner, alice, bob, carol, idReg, rules, vsc, vgt } =
      await fixture();
    // The factory checks payer and payee identities.
    const issuer = await (
      await ethers.getContractFactory("ClaimIssuer")
    ).deploy(owner.address, "KYC", "KYC issuer");
    await configureKyc(idReg, await issuer.getAddress());
    const OnchainID = await ethers.getContractFactory("OnchainID");
    for (const w of [alice, bob, carol]) {
      const id = await OnchainID.deploy(w.address);
      await idReg.registerIdentity(w.address, id.target, 840);
      await attest(issuer, owner, id.target as string);
    }
    const factory: any = await (
      await ethers.getContractFactory("EscrowWalletFactory")
    ).deploy(vsc.target, owner.address, idReg.target, rules.target);
    await factory.registerInvestor(carol.address, carol.address);
    await factory
      .connect(carol)
      .createEscrowWallet(alice.address, bob.address, ethers.parseEther("1"));
    const w = await factory.getWalletAddress(1);
    const o = { complianceRules: rules, token: vsc, governanceToken: vgt };
    expect(await escrowFactoriesFromChain(o)).to.deep.equal([]);

    await rules.addTrustedContract(vsc.target, w);
    const fAddr = await factory.getAddress();
    expect(await escrowFactoriesFromChain(o)).to.deep.equal([
      { factory: fAddr, escrow: w },
    ]);
    expect(await liveTrustedContracts(o)).to.deep.equal([
      { token: vsc.target, account: w },
    ]);
    // Untrusted again: the live scan drops it although the event remains.
    await rules.removeTrustedContract(vsc.target, w);
    expect(await escrowFactoriesFromChain(o)).to.deep.equal([]);
    expect(await liveTrustedContracts(o)).to.deep.equal([]);
  });

  it("rule administrators are found per token, the deployer on every named token", async function () {
    const { owner, admin, rules, vsc, vgt } = await fixture();
    const o = { complianceRules: rules, token: vsc, governanceToken: vgt };
    await expect(rules.setRuleAdministrator(vgt.target, admin.address, true))
      .to.emit(rules, "RuleAdministratorUpdated")
      .withArgs(vgt.target, admin.address, true);
    expect(await liveRuleAdministrators(o, [owner.address])).to.deep.equal([
      { token: vgt.target, account: admin.address },
    ]);
    // The deployer, passed as `extra`, is checked on VSC and VGT too.
    await rules.setRuleAdministrator(vsc.target, owner.address, true);
    const live = await liveRuleAdministrators(o, [owner.address]);
    expect(live).to.deep.include({ token: vsc.target, account: owner.address });
    expect(live).to.have.length(2);
    await rules.setRuleAdministrator(vgt.target, admin.address, false);
    await rules.setRuleAdministrator(vsc.target, owner.address, false);
    expect(await liveRuleAdministrators(o, [owner.address])).to.deep.equal([]);
  });
});
