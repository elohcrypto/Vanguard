/**
 * Smoke leg on the REAL demo VSC, called from demo-smoke-escrow.js: plan v2
 * Task 4.3 (D13 b), investor custody in the on-chain MultiSigWallet, driven
 * through demo/utils/CustodyFlow.js as option 23 drives it.
 *
 *   custody deployed (bank = ops), registrar named -> request -> the bank
 *   creates the wallet (trusted by the manager, compiled code hash) -> the
 *   user locks (tokens MOVE in) -> the bank approves -> the bank alone
 *   cannot unlock -> user + bank release everything back (downgrade).
 *
 * Every assertion reads chain state; failures are pushed, never thrown.
 */
const { ethers, artifacts } = require("hardhat");
const { attestAll } = require("../demo/utils/Kyc");
const Custody = require("../demo/utils/CustodyFlow");

const quiet = () => {};

async function runCustodySmoke(state, failures) {
  const fail = (m) => failures.push(`custody (4.3): ${m}`);
  const token = state.getContract("digitalToken");
  const rules = state.getContract("complianceRules");
  const idReg = state.getContract("identityRegistry");
  const types = state.getContract("investorTypeRegistry");
  const vsc = await token.getAddress();
  let checks = 0;
  const check = (ok, m) => {
    checks++;
    if (!ok) fail(m);
  };

  const m = await Custody.deployCustody(state, quiet);
  if (!m) return fail("InvestorRequestManager was not deployed");
  const mAddr = await m.getAddress();
  const ops = Custody.bankSigner(state);
  const walletHash = ethers.keccak256(
    (await artifacts.readArtifact("MultiSigWallet")).deployedBytecode,
  );
  check(
    (await rules.trustedRegistrars(vsc, mAddr)) === walletHash,
    "the manager is not VSC's registrar for the MultiSigWallet code hash",
  );
  check(
    (await m.bank()) === ops.address && (await m.owner()) === ops.address,
    "the manager's bank and owner are not ops",
  );

  // A fresh, verified Normal user (signer 13 is unused by the other legs).
  const signer = state.signers[13];
  const id = await (
    await ethers.getContractFactory("OnchainID")
  ).deploy(signer.address);
  await (
    await idReg.registerIdentity(signer.address, await id.getAddress(), 840)
  ).wait();
  await attestAll(state, await id.getAddress(), "custody-smoke");
  const user = {
    name: "Custody smoke user",
    address: signer.address,
    signer,
    investorRequest: { requestedType: "RETAIL" },
  };

  const req = await Custody.requestStatus(state, user, "RETAIL", quiet);
  const lock = req.lock;
  await (await token.mint(signer.address, lock)).wait();

  const wAddr = await Custody.createWallet(state, user, quiet);
  check(
    ethers.keccak256(await ethers.provider.getCode(wAddr)) === walletHash,
    `wallet ${wAddr} code is not the compiled MultiSigWallet`,
  );
  check(
    await rules["isTrustedContract(address,address)"](vsc, wAddr),
    "the wallet is not trusted on VSC after creation",
  );
  check(
    await rules.isTrustedOnAnyToken(wAddr),
    "isTrustedOnAnyToken(wallet) is false",
  );
  check(
    (await idReg.identity(wAddr)) === ethers.ZeroAddress,
    "the wallet has a registry identity (it must be trusted, not verified)",
  );

  const u0 = await token.balanceOf(signer.address);
  await Custody.lock(state, user, quiet);
  check(
    (await token.balanceOf(wAddr)) === lock &&
      (await token.balanceOf(signer.address)) === u0 - lock,
    "the lock did not move the tokens from the user into the wallet",
  );
  check(
    (await token.frozenTokens(signer.address)) === 0n,
    "the lock froze tokens instead of moving them",
  );
  check(
    (await Custody.requestOf(state, user)).status === "TokensLocked",
    "the request is not TokensLocked after confirmTokensLocked",
  );
  await Custody.approve(state, user, quiet);
  check(
    Number(await types.getInvestorType(signer.address)) === 1,
    "approval did not make the user Retail",
  );

  // The bank alone: a proposal it signs twice moves nothing.
  const w = await ethers.getContractAt("MultiSigWallet", wAddr);
  const rc = await (
    await w.connect(ops).proposeUnlock(lock, ops.address, "bank alone")
  ).wait();
  const pid = rc.logs
    .map((l) => {
      try {
        return w.interface.parseLog(l);
      } catch {
        return null;
      }
    })
    .find((p) => p && p.name === "UnlockProposalCreated").args[0];
  await (await w.connect(ops).signUnlock(pid)).wait();
  let second = false;
  try {
    await w.connect(ops).signUnlock.staticCall(pid);
    second = true;
  } catch {}
  check(
    !second && (await token.balanceOf(wAddr)) === lock,
    "the bank alone moved or could re-sign the locked tokens",
  );

  // Both signers: everything back to the user, type back to Normal.
  const { released } = await Custody.downgrade(state, user, quiet);
  check(
    released === lock &&
      (await token.balanceOf(wAddr)) === 0n &&
      (await token.balanceOf(signer.address)) === u0,
    "user + bank did not release the lock back to the user",
  );
  check(
    Number(await types.getInvestorType(signer.address)) === 0,
    "the downgrade did not make the user Normal",
  );
  console.log(
    `   ✅ custody smoke: ${checks} checks (wallet ${wAddr}, lock ${ethers.formatEther(lock)} VSC)`,
  );
}

module.exports = { runCustodySmoke };
