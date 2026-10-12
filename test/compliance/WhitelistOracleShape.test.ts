import { expect } from "chai";
import { ethers } from "hardhat";
import { attest, configureKyc } from "../helpers/kyc";

/**
 * Task 4.16 (review A1 L1): ComplianceRules.setWhitelistOracle probes
 * getWhitelistInfo and refuses an oracle without the 6-tuple
 * (OracleIncompatible), so a pre-4.10 oracle fails at configuration, not
 * on every transfer; and a bound 6-tuple oracle's tier is enforced on the
 * token (D47: the tier rule acts on VSC once an oracle is bound).
 */
describe("Whitelist oracle shape at setWhitelistOracle (Task 4.16)", function () {
  const e = ethers.parseEther;
  const REFUSED = "Compliance check failed";

  async function deploy() {
    const [owner, treasury, alice, bob] = await ethers.getSigners();
    const deployC = async (name: string, ...a: unknown[]) =>
      (await ethers.getContractFactory(name)).deploy(...a) as Promise<any>;
    const registry = await deployC("IdentityRegistry");
    const issuer = await deployC("ClaimIssuer", owner.address, "KYC", "d");
    await configureKyc(registry, await issuer.getAddress());
    const OnchainID = await ethers.getContractFactory("OnchainID");
    for (const w of [treasury, alice, bob]) {
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
    const wl = await deployC("WhitelistOracle", om.target, "WL", "d");
    const short = await deployC("ShortWhitelistOracle");
    await token.mint(treasury.address, e("100000"));
    return {
      owner,
      treasury,
      alice,
      bob,
      registry,
      rules,
      token,
      types,
      wl,
      short,
    };
  }

  // Task 4.17 (A1F-3): the probe reads whitelistStanding, the one call
  // the transfer path makes; a pre-4.17 oracle lacks it.
  it("refuses an oracle without whitelistStanding (a 5-tuple oracle)", async function () {
    const { rules, token, short, wl } = await deploy();
    expect(await short.isWhitelisted(rules.target)).to.equal(false);
    await expect(rules.setWhitelistOracle(token.target, short.target))
      .to.be.revertedWithCustomError(rules, "OracleIncompatible")
      .withArgs(short.target);
    expect(await rules.whitelistOracle(token.target)).to.equal(
      ethers.ZeroAddress,
    );
    // The real oracle's 6-tuple passes the same probe.
    await expect(rules.setWhitelistOracle(token.target, wl.target))
      .to.emit(rules, "WhitelistOracleSet")
      .withArgs(token.target, wl.target);
    expect(await rules.whitelistOracle(token.target)).to.equal(wl.target);
  });

  it("a bound 6-tuple oracle's tier is enforced on the token", async function () {
    const { treasury, alice, bob, rules, token, types, wl } = await deploy();
    await rules.setWhitelistOracle(token.target, wl.target);
    // OracleOnly, default-deny: list everyone, then fund.
    for (const w of [treasury, alice, bob])
      await wl.addToWhitelist(w.address, 5, 0, "kyc");
    await token.connect(treasury).transfer(alice.address, e("1000"));
    await types.assignInvestorType(alice.address, 1); // Retail: tier 2+
    expect(await types.getRequiredWhitelistTier(alice.address)).to.equal(2);
    await wl.addToWhitelist(alice.address, 1, 0, "short");
    expect(
      await rules.whitelistTierAllows(token.target, alice.address),
    ).to.equal(false);
    expect(await token.canTransfer(alice.address, bob.address, 1n)).to.equal(
      false,
    );
    await expect(
      token.connect(alice).transfer(bob.address, 1n),
    ).to.be.revertedWith(REFUSED);
    await wl.addToWhitelist(alice.address, 2, 0, "at tier");
    expect(
      await rules.whitelistTierAllows(token.target, alice.address),
    ).to.equal(true);
    expect(await token.canTransfer(alice.address, bob.address, 1n)).to.equal(
      true,
    );
    await token.connect(alice).transfer(bob.address, 1n);
    expect(await token.balanceOf(bob.address)).to.equal(1n);
  });
});

/**
 * Review L-1 (Task 4.16 round 2), as reshaped by Task 4.17 (A1F-3): every
 * malformed whitelistStanding return is OracleIncompatible at the setter,
 * never a bare revert from the decode. RawWhitelistOracle returns the
 * stored bytes verbatim for any call.
 */
describe("Whitelist oracle shape: malformed returns (L-1)", function () {
  const coder = ethers.AbiCoder.defaultAbiCoder();

  async function deploy() {
    const [owner] = await ethers.getSigners();
    const deployC = async (name: string, ...a: unknown[]) =>
      (await ethers.getContractFactory(name)).deploy(...a) as Promise<any>;
    const registry = await deployC("IdentityRegistry");
    const rules = await deployC("ComplianceRules", owner.address, [840], []);
    const token = await deployC(
      "Token",
      "VSC",
      "VSC",
      registry.target,
      rules.target,
    );
    const raw = await deployC("RawWhitelistOracle");
    const good = coder.encode(["bool", "uint8"], [true, 3]);
    return { rules, token, raw, good };
  }

  it("refuses a bool word of 2, a tier word above 255 and a short return", async function () {
    const { rules, token, raw, good } = await deploy();
    const shapes: [string, string][] = [
      ["bool word of 2", coder.encode(["uint256", "uint256"], [2, 3])],
      // Review A1 A1F-7: a tier word above uint8.
      ["tier word 256", coder.encode(["uint256", "uint256"], [1, 256])],
      ["one word", good.slice(0, 2 + 64)],
      ["empty", "0x"],
    ];
    for (const [what, hex] of shapes) {
      await raw.setRaw(hex);
      await expect(rules.setWhitelistOracle(token.target, raw.target), what)
        .to.be.revertedWithCustomError(rules, "OracleIncompatible")
        .withArgs(raw.target);
    }
    expect(await rules.whitelistOracle(token.target)).to.equal(
      ethers.ZeroAddress,
    );
  });

  it("accepts the canonical pair and, like the transfer-time decode, an extra trailing word", async function () {
    const { rules, token, raw, good } = await deploy();
    await raw.setRaw(good);
    await expect(rules.setWhitelistOracle(token.target, raw.target))
      .to.emit(rules, "WhitelistOracleSet")
      .withArgs(token.target, raw.target);
    await rules.setWhitelistOracle(token.target, ethers.ZeroAddress);
    await raw.setRaw(good + ethers.toBeHex(7n, 32).slice(2));
    await expect(rules.setWhitelistOracle(token.target, raw.target)).to.emit(
      rules,
      "WhitelistOracleSet",
    );
  });
});
