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
    // The deployer is checked on VSC and VGT even with no event of its own.
    await rules.setRuleAdministrator(vsc.target, owner.address, true);
    const live = await liveRuleAdministrators(o, [owner.address]);
    expect(live).to.deep.include({ token: vsc.target, account: owner.address });
    expect(live).to.have.length(2);
    await rules.setRuleAdministrator(vgt.target, admin.address, false);
    await rules.setRuleAdministrator(vsc.target, owner.address, false);
    expect(await liveRuleAdministrators(o, [owner.address])).to.deep.equal([]);
  });
});
