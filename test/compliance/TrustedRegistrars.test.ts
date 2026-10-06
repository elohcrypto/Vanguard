import { expect } from "chai";
import { ethers, network } from "hardhat";
import { walletCodeHash } from "../helpers/registrars";

/**
 * Plan v2 Task 4.3 (lead ruling 1): addTrustedContract is the owner's, or a
 * per-token registrar's for accounts whose runtime code hash is the one the
 * owner registered. Human keys (a stranger, a rule administrator) get no
 * trust power; removal stays owner-only; every 2E.1/4.1 check still holds.
 */
describe("ComplianceRules trusted-contract registrars (Task 4.3)", function () {
  async function fixture() {
    const [owner, admin, stranger, bank, user] = await ethers.getSigners();
    const D = async (name: string, ...args: any[]) =>
      (await ethers.getContractFactory(name)).deploy(...args);
    const rules: any = await D("ComplianceRules", owner.address, [], []);
    const idReg: any = await D("IdentityRegistry");
    const vsc: any = await D("Token", "VSC", "VSC", idReg.target, rules.target);
    const vgt: any = await D("Token", "VGT", "VGT", idReg.target, rules.target);
    // The registrar is a contract the test speaks for (impersonated).
    const reg = await (await D("MockTarget")).getAddress();
    await network.provider.send("hardhat_setBalance", [
      reg,
      "0x56BC75E2D63100000",
    ]);
    const asReg = rules.connect(await ethers.getImpersonatedSigner(reg));
    const wallet = await (
      await D("MultiSigWallet", bank.address, user.address, vsc.target)
    ).getAddress();
    const other = await (await D("MockTarget")).getAddress();
    const hash = await walletCodeHash("MultiSigWallet");
    return {
      owner,
      admin,
      stranger,
      rules,
      vsc,
      vgt,
      reg,
      asReg,
      wallet,
      other,
      hash,
    };
  }

  it("every MultiSigWallet has the compiled code hash (no immutables)", async function () {
    const { vsc, wallet, hash } = await fixture();
    const [, , , a, b] = await ethers.getSigners();
    const second = await (
      await ethers.getContractFactory("MultiSigWallet")
    ).deploy(b.address, a.address, vsc.target);
    for (const w of [wallet, await second.getAddress()]) {
      expect(ethers.keccak256(await ethers.provider.getCode(w))).to.equal(hash);
    }
  });

  it("a registrar trusts an account with the registered code, not another", async function () {
    const { rules, vsc, vgt, reg, asReg, wallet, other, hash } =
      await fixture();
    await expect(rules.setTrustedRegistrar(vsc.target, reg, hash))
      .to.emit(rules, "TrustedRegistrarSet")
      .withArgs(vsc.target, reg, hash);
    expect(await rules.trustedRegistrars(vsc.target, reg)).to.equal(hash);
    await expect(
      asReg.addTrustedContract(vsc.target, other),
    ).to.be.revertedWith("ComplianceRules: code not registered");
    // A wallet address with no code yet is not the registered code either.
    await expect(
      asReg.addTrustedContract(
        vsc.target,
        ethers.Wallet.createRandom().address,
      ),
    ).to.be.revertedWith("ComplianceRules: code not registered");
    // Registered for VSC only (per token, G5).
    await expect(
      asReg.addTrustedContract(vgt.target, wallet),
    ).to.be.revertedWith("ComplianceRules: not owner or registrar");
    await expect(asReg.addTrustedContract(vsc.target, wallet))
      .to.emit(rules, "TrustedContractAdded")
      .withArgs(vsc.target, wallet);
    expect(
      await rules["isTrustedContract(address,address)"](vsc.target, wallet),
    ).to.equal(true);
    expect(await rules.isTrustedOnAnyToken(wallet)).to.equal(true);
    await expect(
      asReg.addTrustedContract(vsc.target, wallet),
    ).to.be.revertedWith("Already trusted");
  });

  it("a stranger and a rule administrator cannot trust; the owner still can", async function () {
    const { owner, admin, stranger, rules, vsc, wallet, other } =
      await fixture();
    await rules.setRuleAdministrator(vsc.target, admin.address, true);
    for (const who of [stranger, admin]) {
      await expect(
        rules.connect(who).addTrustedContract(vsc.target, wallet),
      ).to.be.revertedWith("ComplianceRules: not owner or registrar");
    }
    // The owner is not bound to a code hash, but still to code (2E.1).
    await rules.connect(owner).addTrustedContract(vsc.target, other);
    await expect(
      rules.addTrustedContract(vsc.target, stranger.address),
    ).to.be.revertedWith("ComplianceRules: not a contract");
  });

  it("removal stays owner-only; a cleared registrar loses the power", async function () {
    const { rules, vsc, reg, asReg, wallet, other, hash } = await fixture();
    await rules.setTrustedRegistrar(vsc.target, reg, hash);
    await asReg.addTrustedContract(vsc.target, wallet);
    await expect(
      asReg.removeTrustedContract(vsc.target, wallet),
    ).to.be.revertedWithCustomError(rules, "OwnableUnauthorizedAccount");
    await rules.removeTrustedContract(vsc.target, wallet);
    expect(await rules.isTrustedOnAnyToken(wallet)).to.equal(false);
    await expect(rules.setTrustedRegistrar(vsc.target, reg, ethers.ZeroHash))
      .to.emit(rules, "TrustedRegistrarSet")
      .withArgs(vsc.target, reg, ethers.ZeroHash);
    await expect(
      asReg.addTrustedContract(vsc.target, wallet),
    ).to.be.revertedWith("ComplianceRules: not owner or registrar");
    expect(other).to.not.equal(wallet);
  });

  it("setTrustedRegistrar: owner only, a contract, not a delegated wallet", async function () {
    const { stranger, rules, vsc, reg, hash } = await fixture();
    await expect(
      rules.connect(stranger).setTrustedRegistrar(vsc.target, reg, hash),
    ).to.be.revertedWithCustomError(rules, "OwnableUnauthorizedAccount");
    await expect(
      rules.setTrustedRegistrar(ethers.ZeroAddress, reg, hash),
    ).to.be.revertedWith("ComplianceRules: Invalid token address");
    await expect(
      rules.setTrustedRegistrar(vsc.target, ethers.ZeroAddress, hash),
    ).to.be.revertedWith("Invalid address");
    await expect(
      rules.setTrustedRegistrar(vsc.target, stranger.address, hash),
    ).to.be.revertedWith("ComplianceRules: not a contract");
    // EIP-7702 delegation indicator: a human key with 23 bytes of code.
    await network.provider.send("hardhat_setCode", [
      stranger.address,
      "0xef0100" + reg.slice(2).toLowerCase(),
    ]);
    try {
      await expect(
        rules.setTrustedRegistrar(vsc.target, stranger.address, hash),
      ).to.be.revertedWith("ComplianceRules: delegated wallet");
    } finally {
      await network.provider.send("hardhat_setCode", [stranger.address, "0x"]);
    }
    // Clearing needs no code (the registrar may be gone).
    await rules.setTrustedRegistrar(
      vsc.target,
      stranger.address,
      ethers.ZeroHash,
    );
  });
});
