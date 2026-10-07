import { expect } from "chai";
import { ethers } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import { attest, configureKyc } from "../helpers/kyc";

// Task 4.10 (D37 = a): the required whitelist tier is a transfer rule.
// ComplianceRules, wherever a party passes the whitelist by its oracle entry
// (OracleOnly, or Either with a live entry), requires the entry's tier to
// reach the tier the party's investor type requires in the token's own
// investor-type registry. ZkOnly, and a party passing Either by a proof
// binding with no entry, carry no tier: not applicable. Token reports the
// refusal as "Compliance check failed"; whitelistTierAllows names the cause.
describe("Investor-type whitelist tier (Task 4.10)", function () {
  const e = ethers.parseEther;
  const M = { OracleOnly: 0, ZkOnly: 1, Either: 2 };
  const T = { Normal: 0, Retail: 1, Accredited: 2, Institutional: 3 };
  const REFUSED = "Compliance check failed";

  async function deploy() {
    const [owner, treasury, alice, bob, carol] = await ethers.getSigners();
    const deployC = async (name: string, ...a: unknown[]) =>
      (await ethers.getContractFactory(name)).deploy(...a) as Promise<any>;
    const registry = await deployC("IdentityRegistry");
    const issuer = await deployC("ClaimIssuer", owner.address, "KYC", "d");
    await configureKyc(registry, await issuer.getAddress());
    const OnchainID = await ethers.getContractFactory("OnchainID");
    for (const w of [treasury, alice, bob, carol]) {
      const id = await OnchainID.deploy(w.address);
      await registry.registerIdentity(w.address, id.target, 840);
      await attest(issuer, owner, id.target as string);
    }
    const rules = await deployC("ComplianceRules", owner.address, [840], []);
    const token = await deployC(
      "Token",
      "VSC",
      "VSC",
      registry.target,
      rules.target,
    );
    await rules.setTokenIdentityRegistry(token.target, registry.target);
    const types = await deployC("InvestorTypeRegistry");
    await token.setInvestorTypeRegistry(types.target);
    await types.authorizeToken(token.target, true);
    await types.setInvestorLimitExempt(treasury.address, true);

    const om = await deployC("OracleManager");
    const wl = await deployC(
      "WhitelistOracle",
      await om.getAddress(),
      "WL",
      "d",
    );
    await rules.setWhitelistOracle(token.target, wl.target);
    const binder = await deployC("MockWhitelistBinder");
    await rules.setPrivacyManager(token.target, binder.target);

    // Everyone listed at tier 5, then funded; tests lower one entry.
    for (const w of [treasury, alice, bob, carol])
      await wl.addToWhitelist(w.address, 5, 0, "kyc");
    await token.mint(treasury.address, e("100000"));
    for (const w of [alice, bob, carol])
      await token.connect(treasury).transfer(w.address, e("1000"));
    await types.assignInvestorType(alice.address, T.Accredited); // tier 3
    await types.assignInvestorType(bob.address, T.Institutional); // tier 4

    const tierOk = (who: string) =>
      rules.whitelistTierAllows(token.target, who);
    const can = (from: string, to: string) => token.canTransfer(from, to, 1n);
    const list = (who: string, tier: number) =>
      wl.addToWhitelist(who, tier, 0, "kyc");
    return {
      ...{ owner, treasury, alice, bob, carol },
      ...{ registry, rules, token, types, wl, binder, tierOk, can, list },
    };
  }

  it("the sender: refused below its type's tier, allowed at and above", async function () {
    const { alice, carol, token, types, tierOk, can, list } = await deploy();
    expect(await types.getRequiredWhitelistTier(alice.address)).to.equal(3);
    await list(alice.address, 2);
    expect(await tierOk(alice.address)).to.equal(false);
    expect(await can(alice.address, carol.address)).to.equal(false);
    await expect(
      token.connect(alice).transfer(carol.address, 1n),
    ).to.be.revertedWith(REFUSED);
    for (const tier of [3, 5]) {
      await list(alice.address, tier);
      expect(await tierOk(alice.address)).to.equal(true);
      await token.connect(alice).transfer(carol.address, 1n);
      await time.increase(30 * 60); // Accredited cooldown
    }
  });

  it("the recipient: its own type's tier applies", async function () {
    const { alice, bob, carol, token, tierOk, can, list } = await deploy();
    await list(bob.address, 3); // Institutional needs 4
    expect(await tierOk(bob.address)).to.equal(false);
    expect(await can(carol.address, bob.address)).to.equal(false);
    // carol (Normal, tier 1) still sends to alice.
    expect(await can(carol.address, alice.address)).to.equal(true);
    await list(bob.address, 4);
    await token.connect(carol).transfer(bob.address, 1n);
  });

  it("R-410-4: a mint recipient meets its tier", async function () {
    const { bob, token, list } = await deploy();
    await list(bob.address, 3);
    await expect(token.mint(bob.address, 1n)).to.be.revertedWith(REFUSED);
    await list(bob.address, 4);
    await token.mint(bob.address, 1n);
  });

  it("an investorLimitExempt party has no tier, as it has no caps", async function () {
    const { alice, carol, token, types, tierOk, list } = await deploy();
    await list(alice.address, 1);
    expect(await tierOk(alice.address)).to.equal(false);
    await types.setInvestorLimitExempt(alice.address, true);
    expect(await tierOk(alice.address)).to.equal(true);
    await token.connect(alice).transfer(carol.address, 1n);
  });

  it("ZkOnly: not applicable, a proof binding carries no tier", async function () {
    const { alice, carol, rules, token, binder, tierOk, can, list } =
      await deploy();
    await list(alice.address, 1);
    await binder.setBound(alice.address, true);
    await binder.setBound(carol.address, true);
    await rules.setWhitelistMode(token.target, M.ZkOnly);
    expect(await tierOk(alice.address)).to.equal(true);
    expect(await can(alice.address, carol.address)).to.equal(true);
    await token.connect(alice).transfer(carol.address, 1n);
  });

  it("Either: a proof-bound party with no entry has no tier; a live short entry refuses", async function () {
    const { alice, carol, rules, token, wl, binder, tierOk, can, list } =
      await deploy();
    await rules.setWhitelistMode(token.target, M.Either);
    await binder.setBound(alice.address, true);
    await wl.removeFromWhitelist(alice.address, "zk only");
    expect(await tierOk(alice.address)).to.equal(true);
    expect(await can(alice.address, carol.address)).to.equal(true);

    await list(alice.address, 2); // a live entry below Accredited's 3
    expect(await tierOk(alice.address)).to.equal(false);
    expect(await can(alice.address, carol.address)).to.equal(false);
    await list(alice.address, 3);
    await token.connect(alice).transfer(carol.address, 1n);
  });

  it("D26 trusted path: the human's tier is checked, the contract's is not", async function () {
    const { alice, rules, token, can, list } = await deploy();
    const c = await (await ethers.getContractFactory("MockTarget")).deploy();
    const addr = await c.getAddress();
    await rules.addTrustedContract(token.target, addr);
    expect(await can(alice.address, addr)).to.equal(true);
    await list(alice.address, 2);
    expect(await can(alice.address, addr)).to.equal(false);
    await list(alice.address, 3);
    await token.connect(alice).transfer(addr, 1n);
  });

  it("a token with no investor-type registry has no tier rule", async function () {
    const { owner, alice, carol, registry, rules, wl, list } = await deploy();
    const plain: any = await (
      await ethers.getContractFactory("Token")
    ).deploy("P", "P", registry.target, rules.target);
    await rules.setTokenIdentityRegistry(plain.target, registry.target);
    await rules.setWhitelistOracle(plain.target, wl.target);
    await list(alice.address, 1);
    expect(
      await rules.whitelistTierAllows(plain.target, alice.address),
    ).to.equal(true);
    await plain.connect(owner).mint(alice.address, 5n);
    await plain.connect(alice).transfer(carol.address, 1n);
  });

  it("whitelistTierAllows is not applicable without an oracle or an entry", async function () {
    const { alice, rules, token, wl, tierOk } = await deploy();
    await wl.removeFromWhitelist(alice.address, "gone");
    expect(await tierOk(alice.address)).to.equal(true);
    expect(
      await rules.whitelistTierAllows(ethers.ZeroAddress, alice.address),
    ).to.equal(true);
    expect(await token.canTransfer(alice.address, alice.address, 1n)).to.equal(
      false,
    ); // unlisted in OracleOnly: the whitelist itself refuses
  });
});
