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

  it("refuses an oracle whose getWhitelistInfo has no tier (5-tuple)", async function () {
    const { rules, token, short, wl } = await deploy();
    // It answers isWhitelisted, as the first probe requires.
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
 * Review L-1 (Task 4.16 round 2): every malformed getWhitelistInfo return
 * is OracleIncompatible at the setter, never a bare panic from the decode.
 * RawWhitelistOracle returns the stored bytes verbatim.
 */
describe("Whitelist oracle shape: malformed returns (L-1)", function () {
  const coder = ethers.AbiCoder.defaultAbiCoder();
  const TYPES = ["bool", "uint256", "uint256", "uint8", "string", "address[]"];

  async function deploy() {
    const [owner, alice] = await ethers.getSigners();
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
    const good = coder.encode(TYPES, [true, 1, 0, 3, "kyc", [alice.address]]);
    return { rules, token, raw, good, alice };
  }

  /** `hex` with the 32-byte word at `wordIndex` replaced by `value`. */
  const withWord = (hex: string, wordIndex: number, value: bigint) =>
    hex.slice(0, 2 + wordIndex * 64) +
    ethers.toBeHex(value, 32).slice(2) +
    hex.slice(2 + (wordIndex + 1) * 64);

  it("refuses a bool word of 2, a truncated string, a short array, a dirty address, absurd lengths", async function () {
    const { rules, token, raw, good } = await deploy();
    // Words: 0 bool, 1 ts, 2 expiry, 3 tier, 4 str offset, 5 arr offset,
    // 6 strLen, 7 string data, 8 arrLen, 9 the one address.
    const shapes: [string, string][] = [
      ["bool word of 2", withWord(good, 0, 2n)],
      // Task 4.17 (review A1 A1F-7): a tier word above uint8.
      ["tier word 256", withWord(good, 3, 256n)],
      [
        "string length 100 with no data",
        withWord(good, 6, 100n).slice(0, 2 + 7 * 64),
      ],
      ["array length 2 with one element word", withWord(good, 8, 2n)],
      ["dirty address word", withWord(good, 9, (1n << 200n) | 0xabcdn)],
      ["array length 2^200", withWord(good, 8, 1n << 200n)],
      // Would overflow (strLen + 31) without the string bound: a bare panic.
      ["string length 2^256 - 5", withWord(good, 6, (1n << 256n) - 5n)],
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

  it("accepts the canonical 6-tuple and, like the transfer-time decode, an extra trailing word", async function () {
    const { rules, token, raw, good } = await deploy();
    await raw.setRaw(good);
    await expect(rules.setWhitelistOracle(token.target, raw.target))
      .to.emit(rules, "WhitelistOracleSet")
      .withArgs(token.target, raw.target);
    await rules.setWhitelistOracle(token.target, ethers.ZeroAddress);
    // A word past the array is never read by abi.decode either way.
    await raw.setRaw(good + ethers.toBeHex(7n, 32).slice(2));
    await expect(rules.setWhitelistOracle(token.target, raw.target)).to.emit(
      rules,
      "WhitelistOracleSet",
    );
  });
});
