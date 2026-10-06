/**
 * @fileoverview Investor custody, plan v2 Task 4.3 (owner decision D13 = b):
 * the demo's "2-of-2 multisig" is the on-chain MultiSigWallet.
 *
 *   - InvestorRequestManager (bank = ops, wallet 10) deploys one
 *     MultiSigWallet per investor request and, as a ComplianceRules
 *     registrar on VSC for the MultiSigWallet code hash, trusts it in the
 *     same transaction (the wallet has no identity).
 *   - "Lock": the user approves the wallet and calls lockTokens; the tokens
 *     MOVE into the wallet; the user then confirms the lock on the manager.
 *   - Unlocking (downgrade, or paying out routed escrow fees) is
 *     proposeUnlock plus signUnlock by the user AND the bank. Neither can
 *     move the tokens alone, and the recipient passes the token's gate.
 *
 * Every function reads its facts back from chain. Option 23 (TokenModule
 * sub-options 2, 4, 5, 6, 8) and option 62 (EscrowModule) call it.
 */

const { ethers } = require("hardhat");
const { registerRegistrar } = require("./GovernedCalls");

const TYPES = { RETAIL: 1, ACCREDITED: 2, INSTITUTIONAL: 3 };
const STATUS = [
  "None",
  "Pending",
  "WalletCreated",
  "TokensLocked",
  "Approved",
  "Rejected",
];
const same = (a, b) => a.toLowerCase() === b.toLowerCase();
const fmt = (v) => Number(ethers.formatEther(v)).toLocaleString();

/** The custody bank: ops (wallet 10), never the deployer (handover). */
function bankSigner(state) {
  return state.signers[10];
}

/**
 * Deploy InvestorRequestManager for the current VSC and investor type
 * registry, unless one is recorded for both. Lock requirements are set
 * within the Normal type's one-transfer cap (a Normal holder locks in one
 * transfer); the manager becomes a compliance officer (approval assigns
 * the type) and a ComplianceRules registrar; ownership goes to ops.
 * Returns the manager, or null with the reason printed.
 */
async function deployCustody(state, log = console.log) {
  const token = state.getContract("digitalToken");
  const types = state.getContract("investorTypeRegistry");
  const idReg = state.getContract("identityRegistry");
  if (!token || !types || !idReg) {
    log("   ℹ️  Custody needs VSC and the investor type registry (21, 51)");
    return null;
  }
  const [vsc, typesAddr] = [await token.getAddress(), await types.getAddress()];
  let m = state.getContract("investorRequestManager");
  if (
    m &&
    same(await m.token(), vsc) &&
    same(await m.investorRegistry(), typesAddr)
  ) {
    return m;
  }
  const bank = bankSigner(state);
  const deployer = state.signers[0];
  m = await (
    await ethers.getContractFactory("InvestorRequestManager", deployer)
  ).deploy(bank.address, vsc, typesAddr, await idReg.getAddress());
  await m.waitForDeployment();
  const mAddr = await m.getAddress();
  log(`   ✅ InvestorRequestManager: ${mAddr} (bank = ops ${bank.address})`);

  const cap = (await types.getInvestorTypeConfig(0)).maxTransferAmount;
  const locks = [
    [TYPES.RETAIL, cap / 4n],
    [TYPES.ACCREDITED, cap / 2n],
    [TYPES.INSTITUTIONAL, cap],
  ];
  for (const [t, amount] of locks) {
    await (await m.updateLockRequirement(t, amount)).wait();
  }
  log(
    `   ✅ Lock requirements ${locks.map(([, a]) => fmt(a)).join(" / ")} VSC (Retail / Accredited / Institutional): a Normal holder moves at most ${fmt(cap)} VSC per transfer`,
  );
  // Review L1: ops owns the manager BEFORE it gains any power (officer,
  // registrar), so a failure below never leaves a deployer-owned officer.
  await (await m.transferOwnership(bank.address)).wait();
  log("   ✅ Manager owned by ops: the deployer keeps no custody power");

  if (same(await types.owner(), deployer.address)) {
    await (await types.setComplianceOfficer(mAddr, true)).wait();
    log("   ✅ Manager is an InvestorTypeRegistry compliance officer");
  } else {
    log(
      "   ⚠️  The registry is governance's: approvals need setComplianceOfficer(manager) by vote",
    );
  }
  const reg = await registerRegistrar(state, mAddr, "MultiSigWallet", log);
  if (reg.direct) {
    log(
      "   ✅ Manager is a ComplianceRules registrar on VSC: it trusts only the MultiSigWallets it deploys",
    );
  } else if (reg.proposalId) {
    log(
      `   ⏳ Wallets cannot be created until proposal #${reg.proposalId} passes (options 77, 78)`,
    );
  } else {
    log(`   ⚠️  Manager is not a registrar: ${reg.refused}`);
  }
  state.setContract("investorRequestManager", m);
  return m;
}

/** The manager, deployed on first use. Throws when it cannot be. */
async function manager(state, log) {
  const m = await deployCustody(state, log);
  if (!m) throw new Error("custody is not deployed (options 21 and 51)");
  return m;
}

/** On-chain request status and amounts for `user`. */
async function requestOf(state, user) {
  const r = await state
    .getContract("investorRequestManager")
    .requests(user.address);
  return {
    status: STATUS[Number(r.status)],
    lock: r.requiredLockAmount,
    wallet: r.multiSigWallet,
  };
}

/** Sub-option 2: the user requests investor status on chain. */
async function requestStatus(state, user, typeName, log = console.log) {
  const m = await manager(state, log);
  await (
    await m.connect(user.signer).requestInvestorStatus(TYPES[typeName])
  ).wait();
  const r = await requestOf(state, user);
  log(`   ✅ Request on chain: ${typeName}, lock ${fmt(r.lock)} VSC`);
  return r;
}

/**
 * Sub-option 4: the bank creates the user's MultiSigWallet; the address is
 * read back from the request, and its code and VSC trust are checked.
 */
async function createWallet(state, user, log = console.log) {
  const m = await manager(state, log);
  const bank = bankSigner(state);
  await (await m.connect(bank).createMultiSigWallet(user.address)).wait();
  const { wallet } = await requestOf(state, user);
  const hasCode = (await ethers.provider.getCode(wallet)) !== "0x";
  const rules = state.getContract("complianceRules");
  const vsc = await state.getContract("digitalToken").getAddress();
  const trusted = await rules["isTrustedContract(address,address)"](
    vsc,
    wallet,
  );
  user.multiSigWallet = {
    address: wallet,
    bank: bank.address,
    user: user.address,
    createdAt: new Date().toISOString(),
    tokensLocked: 0,
  };
  log(`   ✅ MultiSigWallet ${wallet} (${hasCode ? "contract" : "NO CODE"})`);
  log(`   🏦 Signer 1: ${bank.address} (bank, ops)`);
  log(`   👤 Signer 2: ${user.address} (user)`);
  log(
    `   ${trusted ? "✅" : "❌"} Trusted on VSC by the manager (registrar) at creation`,
  );
  return wallet;
}

/** The user's MultiSigWallet contract. */
async function walletOf(user) {
  return ethers.getContractAt("MultiSigWallet", user.multiSigWallet.address);
}

/**
 * Sub-option 5: the user approves the wallet, locks the request's amount
 * (the tokens move into it) and confirms the lock on the manager.
 */
async function lock(state, user, log = console.log) {
  const m = await manager(state, log);
  const token = state.getContract("digitalToken");
  const { lock: amount } = await requestOf(state, user);
  const w = await walletOf(user);
  const wAddr = await w.getAddress();
  const bal = async (a) => token.balanceOf(a);
  const [u0, w0] = [await bal(user.address), await bal(wAddr)];
  if (u0 < amount) {
    throw new Error(
      `${user.name} holds ${fmt(u0)} VSC, the lock needs ${fmt(amount)} (sub-option 3 first)`,
    );
  }
  await (await token.connect(user.signer).approve(wAddr, amount)).wait();
  await (await w.connect(user.signer).lockTokens(amount)).wait();
  await (await m.connect(user.signer).confirmTokensLocked()).wait();
  const [u1, w1] = [await bal(user.address), await bal(wAddr)];
  log(`   ✅ User approved ${fmt(amount)} VSC to the wallet and locked it`);
  log(`   💰 User balance:   ${fmt(u0)} -> ${fmt(u1)} VSC`);
  log(`   🔒 Wallet balance: ${fmt(w0)} -> ${fmt(w1)} VSC`);
  log(`   📋 Request status: ${(await requestOf(state, user)).status}`);
  user.tokenBalance = Number(ethers.formatEther(u1));
  user.multiSigWallet.tokensLocked = Number(ethers.formatEther(amount));
  user.investorRequest.tokensLocked = true;
  return { before: [u0, w0], after: [u1, w1] };
}

/** Sub-option 6: the bank approves; the manager assigns the type. */
async function approve(state, user, log = console.log) {
  const m = await manager(state, log);
  await (
    await m.connect(bankSigner(state)).approveRequest(user.address)
  ).wait();
  const t = await state
    .getContract("investorTypeRegistry")
    .getInvestorType(user.address);
  log(`   ✅ Approved by the bank; on-chain investor type ${t}`);
  return t;
}

/**
 * A 2-of-2 unlock of `amount` to `recipient`: the user proposes and signs,
 * the bank signs, the wallet executes on the second signature. Returns
 * { proposalId, receipt }.
 */
async function unlock(
  state,
  user,
  amount,
  recipient,
  reason,
  log = console.log,
) {
  const w = await walletOf(user);
  const bank = bankSigner(state);
  const rc = await (
    await w.connect(user.signer).proposeUnlock(amount, recipient, reason)
  ).wait();
  const ev = rc.logs
    .map((l) => {
      try {
        return w.interface.parseLog(l);
      } catch {
        return null;
      }
    })
    .find((p) => p && p.name === "UnlockProposalCreated");
  const proposalId = ev.args[0];
  log(`   📝 Unlock proposal ${proposalId.slice(0, 18)}... by the user`);
  await (await w.connect(user.signer).signUnlock(proposalId)).wait();
  log("   ✍️  User signed (1/2): nothing moves yet");
  const receipt = await (await w.connect(bank).signUnlock(proposalId)).wait();
  log("   ✍️  Bank signed (2/2): the wallet paid out");
  return { proposalId, receipt };
}

/**
 * Sub-option 8: both signers release everything the wallet holds (lock and
 * any routed fees) to the user, then a compliance officer sets the type
 * back to Normal (the deployer before the handover, ops after it).
 */
async function downgrade(state, user, log = console.log) {
  const token = state.getContract("digitalToken");
  const types = state.getContract("investorTypeRegistry");
  const w = await walletOf(user);
  const wAddr = await w.getAddress();
  const held = await token.balanceOf(wAddr);
  const u0 = await token.balanceOf(user.address);
  if (held > 0n) {
    await unlock(state, user, held, user.address, "Downgrade to Normal", log);
  }
  const u1 = await token.balanceOf(user.address);
  log(`   💰 User balance:   ${fmt(u0)} -> ${fmt(u1)} VSC`);
  log(
    `   🔓 Wallet balance: ${fmt(held)} -> ${fmt(await token.balanceOf(wAddr))} VSC`,
  );
  // A compliance officer: the registry owner passes too (the deployer
  // before the handover); ops after it.
  const owner = await types.owner();
  let signer = null;
  for (const s of [state.signers[0], bankSigner(state)]) {
    if (
      same(owner, s.address) ||
      (await types.isComplianceOfficer(s.address))
    ) {
      signer = s;
      break;
    }
  }
  if (!signer) {
    throw new Error("neither the deployer nor ops is a compliance officer");
  }
  await (
    await types.connect(signer).downgradeInvestorType(user.address, 0)
  ).wait();
  log(`   ✅ Investor type NORMAL (compliance officer ${signer.address})`);
  user.tokenBalance = Number(ethers.formatEther(u1));
  user.multiSigWallet.tokensLocked = 0;
  return { released: held };
}

/**
 * Whether `addr` is provably a keyless placeholder (review M1): no code,
 * not any demo signer (deployer, ops, issuers, users: every key the demo
 * holds), and its registry OnchainID, if any, gives no demo signer a
 * MANAGEMENT key. A pre-4.3 run derived the placeholder from a hash, so
 * no key exists for it; a real person's wallet fails one of these.
 */
async function isKeylessPlaceholder(state, addr) {
  if ((await ethers.provider.getCode(addr)) !== "0x") return false;
  if (state.signers.some((s) => same(s.address, addr))) return false;
  const id = await state.getContract("identityRegistry").identity(addr);
  if (id === ethers.ZeroAddress) return true;
  const oid = await ethers.getContractAt(
    ["function keyHasPurpose(bytes32,uint256) view returns (bool)"],
    id,
  );
  for (const s of state.signers) {
    const key = ethers.solidityPackedKeccak256(["address"], [s.address]);
    const managed = await oid.keyHasPurpose(key, 1).catch(() => true);
    if (managed) return false;
  }
  return true;
}

/**
 * Option 62, the 2E.1 interim undone: an investor registered in the escrow
 * factory with a fee wallet that is not a contract gets deactivated so
 * option 62 can re-register it with its MultiSigWallet. The old fee
 * wallet's registry identity is deleted (by a registry agent: the deployer
 * before the handover, ops after) ONLY when it is provably a keyless
 * placeholder (isKeylessPlaceholder); a keyed wallet keeps its identity
 * and its vote. Returns true when the investor was deactivated.
 */
async function retirePlaceholder(
  state,
  factory,
  admin,
  investor,
  wallet,
  log = console.log,
) {
  const p = await factory.getInvestorProfile(investor);
  if (!p.isActive || same(p.walletAddress, wallet)) return false;
  if ((await ethers.provider.getCode(p.walletAddress)) !== "0x") return false;
  const idReg = state.getContract("identityRegistry");
  const keyless = await isKeylessPlaceholder(state, p.walletAddress);
  if (!keyless) {
    log(
      `   ℹ️  Old fee wallet ${p.walletAddress} is a keyed wallet: its identity is kept`,
    );
  } else if ((await idReg.identity(p.walletAddress)) !== ethers.ZeroAddress) {
    const agents = [state.signers[0], bankSigner(state)];
    let done = false;
    for (const a of agents) {
      if (!(await idReg.isAgent(a.address))) continue;
      await (await idReg.connect(a).deleteIdentity(p.walletAddress)).wait();
      log(
        `   🗑️  Placeholder identity ${p.walletAddress} deleted (agent ${a.address})`,
      );
      done = true;
      break;
    }
    if (!done)
      log(
        "   ⚠️  No registry agent available to delete the placeholder identity",
      );
  }
  await (await factory.connect(admin).deactivateInvestor(investor)).wait();
  log(`   ↩️  Investor deactivated to replace fee wallet ${p.walletAddress}`);
  return true;
}

module.exports = {
  TYPES,
  bankSigner,
  deployCustody,
  requestOf,
  requestStatus,
  createWallet,
  lock,
  approve,
  unlock,
  downgrade,
  retirePlaceholder,
  isKeylessPlaceholder,
};
