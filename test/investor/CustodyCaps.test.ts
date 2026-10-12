import { expect } from "chai";
import { ethers } from "hardhat";
import { attest, configureKyc } from "../helpers/kyc";
import { addRegistrar } from "../helpers/registrars";

/**
 * Task 4.16 (D45, review A1 L2/L4, Q7 c): custody locks fit the Normal
 * caps of the token's registry, read at call time; an approval never
 * strands the user behind the new type's whitelist tier; an unlock pays
 * only the user or a verified, non-trusted wallet.
 */
describe("Custody caps, tier and unlock recipient (Task 4.16)", function () {
  const e = ethers.parseEther;
  const T = { Normal: 0, Retail: 1, Accredited: 2, Institutional: 3 };

  async function deploy() {
    const [owner, bank, user, other, stranger] = await ethers.getSigners();
    const deployC = async (name: string, ...a: unknown[]) =>
      (await ethers.getContractFactory(name)).deploy(...a) as Promise<any>;
    const registry = await deployC("IdentityRegistry");
    const issuer = await deployC("ClaimIssuer", owner.address, "KYC", "d");
    await configureKyc(registry, await issuer.getAddress());
    const OnchainID = await ethers.getContractFactory("OnchainID");
    const verify = async (w: { address: string }) => {
      const id = await OnchainID.deploy(w.address);
      await registry.registerIdentity(w.address, id.target, 840);
      await attest(issuer, owner, id.target as string);
    };
    for (const w of [user, other]) await verify(w);
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
    const m = await deployC(
      "InvestorRequestManager",
      bank.address,
      token.target,
      types.target,
      registry.target,
    );
    await addRegistrar(rules, token, m, "MultiSigWallet");
    await types.setComplianceOfficer(m.target, true);
    const om = await deployC("OracleManager");
    const wl = await deployC("WhitelistOracle", om.target, "WL", "d");
    const normal = await types.getInvestorTypeConfig(T.Normal);
    const cap =
      normal.maxTransferAmount < normal.maxHoldingAmount
        ? normal.maxTransferAmount
        : normal.maxHoldingAmount;
    return {
      owner,
      bank,
      user,
      other,
      stranger,
      registry,
      rules,
      token,
      types,
      m,
      wl,
      cap,
      verify,
    };
  }

  /** A config with the Normal caps changed, every other field kept. */
  async function setNormalCaps(types: any, transfer: bigint, holding: bigint) {
    const c = await types.getInvestorTypeConfig(T.Normal);
    await types.updateInvestorTypeConfig(T.Normal, {
      maxTransferAmount: transfer,
      maxHoldingAmount: holding,
      requiredWhitelistTier: c.requiredWhitelistTier,
      transferCooldownMinutes: c.transferCooldownMinutes,
      largeTransferThreshold: c.largeTransferThreshold,
      enhancedLogging: c.enhancedLogging,
      enhancedPrivacy: c.enhancedPrivacy,
    });
  }

  /** Request `type`, the bank's wallet, the user's lock, confirmed. */
  async function lockedRequest(f: any, type: number) {
    const { m, bank, user, token } = f;
    await m.connect(user).requestInvestorStatus(type);
    await m.connect(bank).createMultiSigWallet(user.address);
    const w = (await m.requests(user.address)).multiSigWallet;
    const lock = (await m.requests(user.address)).requiredLockAmount;
    await token.connect(user).approve(w, lock);
    const wallet = await ethers.getContractAt("MultiSigWallet", w);
    await wallet.connect(user).lockTokens(lock);
    await m.connect(user).confirmTokensLocked();
    return { wallet, lock };
  }

  it("the constructor defaults are cap/4, cap/2, cap of the Normal type", async function () {
    const { m, cap } = await deploy();
    expect(cap).to.equal(e("8000"));
    expect(await m.lockRequirements(T.Retail)).to.equal(cap / 4n);
    expect(await m.lockRequirements(T.Accredited)).to.equal(cap / 2n);
    expect(await m.lockRequirements(T.Institutional)).to.equal(cap);
    expect(await m.lockRequirements(T.Normal)).to.equal(0n);
  });

  it("updateLockRequirement refuses a lock above the Normal per-transfer cap", async function () {
    const { m, cap } = await deploy();
    await expect(
      m.updateLockRequirement(T.Retail, cap + 1n),
    ).to.be.revertedWithCustomError(m, "LockAboveNormalCap");
    await expect(m.updateLockRequirement(T.Institutional, cap))
      .to.emit(m, "LockRequirementUpdated")
      .withArgs(T.Institutional, cap, cap);
    await m.updateLockRequirement(T.Retail, e("1"));
    expect(await m.lockRequirements(T.Retail)).to.equal(e("1"));
  });

  it("the cap is the smaller of the per-transfer and holding caps, read at call time", async function () {
    const f = await deploy();
    const { m, types, token, cap } = f;
    // Holding cap below the transfer cap: it bounds the lock.
    await setNormalCaps(types, cap, e("3000"));
    await expect(
      m.updateLockRequirement(T.Retail, e("3001")),
    ).to.be.revertedWithCustomError(m, "LockAboveNormalCap");
    await m.updateLockRequirement(T.Retail, e("3000"));
    // The token's live registry decides, not the manager's immutable one.
    const other = await (
      await ethers.getContractFactory("InvestorTypeRegistry")
    ).deploy();
    await setNormalCaps(other, e("500"), e("500"));
    await other.authorizeToken(token.target, true);
    await token.setInvestorTypeRegistry(other.target);
    await expect(
      m.updateLockRequirement(T.Retail, e("501")),
    ).to.be.revertedWithCustomError(m, "LockAboveNormalCap");
    await m.updateLockRequirement(T.Retail, e("500"));
    // A token with no registry of its own: the manager's bounds it.
    const bare = await (
      await ethers.getContractFactory("Token")
    ).deploy("B", "B", await f.registry.getAddress(), f.rules.target);
    const m2 = await (
      await ethers.getContractFactory("InvestorRequestManager")
    ).deploy(
      f.bank.address,
      bare.target,
      types.target,
      await f.registry.getAddress(),
    );
    expect(await m2.lockRequirements(T.Institutional)).to.equal(e("3000"));
    await expect(
      m2.updateLockRequirement(T.Retail, e("3001")),
    ).to.be.revertedWithCustomError(m2, "LockAboveNormalCap");
    await m2.updateLockRequirement(T.Retail, e("3000"));
  });

  it("approveRequest refuses while the user's live entry is below the new type's tier (Q7 c)", async function () {
    const f = await deploy();
    const { m, bank, user, token, types, rules, wl } = f;
    // OracleOnly: the user is listed at the Normal tier (1) and funded.
    await rules.setWhitelistOracle(token.target, wl.target);
    await wl.addToWhitelist(user.address, 1, 0, "kyc");
    await token.mint(user.address, e("8000"));
    await lockedRequest(f, T.Retail); // Retail needs tier 2
    expect(await types.getInvestorTypeConfig(T.Retail)).to.satisfy(
      (c: any) => Number(c.requiredWhitelistTier) === 2,
    );
    await expect(
      m.connect(bank).approveRequest(user.address),
    ).to.be.revertedWithCustomError(m, "TierBelowNewType");
    expect(await types.getInvestorType(user.address)).to.equal(T.Normal);
    await wl.addToWhitelist(user.address, 2, 0, "aml");
    await m.connect(bank).approveRequest(user.address);
    expect(await types.getInvestorType(user.address)).to.equal(T.Retail);
    expect(
      await rules.whitelistTierAllows(token.target, user.address),
    ).to.equal(true);
  });

  it("the tier rule is inert without an oracle, in ZkOnly, and for an unlisted user", async function () {
    // No oracle bound: approved.
    let f = await deploy();
    await f.token.mint(f.user.address, e("8000"));
    await lockedRequest(f, T.Retail);
    await f.m.connect(f.bank).approveRequest(f.user.address);
    expect(await f.types.getInvestorType(f.user.address)).to.equal(T.Retail);
    // ZkOnly: the entry is not read, so a short one does not refuse.
    f = await deploy();
    await f.rules.setWhitelistOracle(f.token.target, f.wl.target);
    const binder = await (
      await ethers.getContractFactory("MockWhitelistBinder")
    ).deploy();
    await f.rules.setPrivacyManager(f.token.target, binder.target);
    await f.rules.setWhitelistMode(f.token.target, 1);
    await binder.setBound(f.user.address, true);
    await f.wl.addToWhitelist(f.user.address, 1, 0, "short");
    await f.token.mint(f.user.address, e("8000"));
    await lockedRequest(f, T.Retail);
    await f.m.connect(f.bank).approveRequest(f.user.address);
    expect(await f.types.getInvestorType(f.user.address)).to.equal(T.Retail);
    // OracleOnly, no entry: the whitelist decides, not the tier.
    f = await deploy();
    await f.token.mint(f.user.address, e("8000"));
    await lockedRequest(f, T.Retail);
    await f.rules.setWhitelistOracle(f.token.target, f.wl.target);
    expect(await f.wl.isWhitelisted(f.user.address)).to.equal(false);
    await f.m.connect(f.bank).approveRequest(f.user.address);
    expect(await f.types.getInvestorType(f.user.address)).to.equal(T.Retail);
  });

  it("proposeUnlock: the user, or a verified wallet that is not trusted (A1 L4)", async function () {
    const f = await deploy();
    const { m, bank, user, other, stranger, token, rules } = f;
    await token.mint(user.address, e("8000"));
    const { wallet, lock } = await lockedRequest(f, T.Retail);
    const ok = (to: string, why: string) =>
      wallet.connect(user).proposeUnlock(1n, to, why);
    await expect(ok(user.address, "self")).to.emit(
      wallet,
      "UnlockProposalCreated",
    );
    await expect(ok(other.address, "verified")).to.emit(
      wallet,
      "UnlockProposalCreated",
    );
    await expect(
      ok(stranger.address, "stranger"),
    ).to.be.revertedWithCustomError(wallet, "RecipientNotVerified");
    await expect(
      wallet.connect(bank).proposeUnlock(lock, bank.address, "bank"),
    ).to.be.revertedWithCustomError(wallet, "RecipientNotVerified");
    // A trusted contract: another custody wallet the owner trusts.
    const t = await (
      await ethers.getContractFactory("MultiSigWallet")
    ).deploy(bank.address, other.address, token.target);
    await rules.addTrustedContract(token.target, t.target);
    await expect(
      ok(t.target as string, "trusted"),
    ).to.be.revertedWithCustomError(wallet, "RecipientTrusted");
    expect(await m.hasActiveRequest(user.address)).to.equal(true);
  });
});

/**
 * Round 2 (review L-2, L-3; R-416-15): a token without the registry getter
 * falls back to the manager's immutable registry, and a token that applies
 * another registry makes requests and approvals fail closed.
 */
describe("Custody: registry fallback and divergence (Task 4.16 round 2)", function () {
  const e = ethers.parseEther;
  const T = { Normal: 0, Retail: 1 };

  async function deploy() {
    const [owner, bank, user, other] = await ethers.getSigners();
    const deployC = async (name: string, ...a: unknown[]) =>
      (await ethers.getContractFactory(name)).deploy(...a) as Promise<any>;
    const registry = await deployC("IdentityRegistry");
    const issuer = await deployC("ClaimIssuer", owner.address, "KYC", "d");
    await configureKyc(registry, await issuer.getAddress());
    const id = await (
      await ethers.getContractFactory("OnchainID")
    ).deploy(user.address);
    await registry.registerIdentity(user.address, id.target, 840);
    await attest(issuer, owner, id.target as string);
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
    const m = await deployC(
      "InvestorRequestManager",
      bank.address,
      token.target,
      types.target,
      registry.target,
    );
    await addRegistrar(rules, token, m, "MultiSigWallet");
    await types.setComplianceOfficer(m.target, true);
    return { owner, bank, user, other, registry, rules, token, types, m };
  }

  it("a token without investorTypeRegistry() falls back to the manager's registry (L-2)", async function () {
    const { bank, registry, types } = await deploy();
    const mock = await (
      await ethers.getContractFactory("MockToken")
    ).deploy("M", "M", 0);
    const m = await (
      await ethers.getContractFactory("InvestorRequestManager")
    ).deploy(bank.address, mock.target, types.target, registry.target);
    const cap = (await types.getInvestorTypeConfig(T.Normal)).maxTransferAmount;
    expect(await m.lockRequirements(T.Retail)).to.equal(cap / 4n);
    await expect(
      m.updateLockRequirement(T.Retail, cap + 1n),
    ).to.be.revertedWithCustomError(m, "LockAboveNormalCap");
    await m.updateLockRequirement(T.Retail, cap);
  });

  it("a token applying another registry: request and approval refuse RegistryDiverged (L-3)", async function () {
    const f = await deploy();
    const { bank, user, token, types, m } = f;
    await token.mint(user.address, e("8000"));
    // A request made while the registries agree, then the token moves.
    await m.connect(user).requestInvestorStatus(T.Retail);
    await m.connect(bank).createMultiSigWallet(user.address);
    const w = (await m.requests(user.address)).multiSigWallet;
    const lock = (await m.requests(user.address)).requiredLockAmount;
    await token.connect(user).approve(w, lock);
    await (
      await ethers.getContractAt("MultiSigWallet", w)
    )
      .connect(user)
      .lockTokens(lock);
    await m.connect(user).confirmTokensLocked();
    const other = await (
      await ethers.getContractFactory("InvestorTypeRegistry")
    ).deploy();
    await other.authorizeToken(token.target, true);
    await token.setInvestorTypeRegistry(other.target);
    await expect(m.connect(bank).approveRequest(user.address))
      .to.be.revertedWithCustomError(m, "RegistryDiverged")
      .withArgs(other.target, types.target);
    expect(await types.getInvestorType(user.address)).to.equal(T.Normal);
    await expect(m.connect(f.other).requestInvestorStatus(T.Retail))
      .to.be.revertedWithCustomError(m, "RegistryDiverged")
      .withArgs(other.target, types.target);
    // Pointed back: the approval goes through.
    await token.setInvestorTypeRegistry(types.target);
    await m.connect(bank).approveRequest(user.address);
    expect(await types.getInvestorType(user.address)).to.equal(T.Retail);
  });
});
