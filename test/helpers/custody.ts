import { ethers } from "hardhat";
import { attest, configureKyc } from "./kyc";
import { addRegistrar } from "./registrars";

/** Investor types as the registry numbers them. */
export const T = { Normal: 0, Retail: 1, Accredited: 2, Institutional: 3 };

/** A config with the Normal (type 0) caps changed, every other field kept. */
export async function setNormalCaps(
  types: any,
  transfer: bigint,
  holding: bigint,
) {
  const c = await types.getInvestorTypeConfig(0);
  await types.updateInvestorTypeConfig(0, {
    maxTransferAmount: transfer,
    maxHoldingAmount: holding,
    requiredWhitelistTier: c.requiredWhitelistTier,
    transferCooldownMinutes: c.transferCooldownMinutes,
    largeTransferThreshold: c.largeTransferThreshold,
    enhancedLogging: c.enhancedLogging,
    enhancedPrivacy: c.enhancedPrivacy,
  });
}

/**
 * The custody stack on one token: a KYC-gated registry with `user` and
 * `other` verified, ComplianceRules, the token with an investor-type
 * registry, the request manager (bank = signer 1) trusted as a registrar,
 * and an unbound whitelist and blacklist oracle. `cap` is the smaller
 * Normal cap that bounds every lock.
 */
export async function deployCustody() {
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
    return id.target as string;
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
  const bl = await deployC("BlacklistOracle", om.target, "BL", "d");
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
    issuer,
    rules,
    token,
    types,
    m,
    wl,
    bl,
    cap,
    verify,
  };
}

/** Request `type`, the bank's wallet, the user's lock, confirmed. */
export async function lockedRequest(f: any, type: number) {
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
