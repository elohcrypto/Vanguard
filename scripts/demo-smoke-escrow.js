/**
 * Smoke legs on the REAL demo VSC (`digitalToken`), called from demo-smoke.js.
 *
 * 1. Plan 2E.3 / D22 (a): mint enforces investor-type holding caps; the
 *    treasury (deployer, the demo central bank) is exempt by a logged flag.
 * 2. Escrow (option 73b): payer funded through the real mint, only the
 *    escrow wallet trusted, fees paid to verified (untrusted) fee wallets.
 * 3. D26: fee wallets exempt; an over-cap release reverts, refund works.
 */
const { ethers } = require("hardhat");
const { signShipmentProof } = require("../demo/utils/ShipmentProof");
const { attestAll } = require("../demo/utils/Kyc");
const EscrowModule = require("../demo/modules/EscrowModule");
const { EnhancedLogger } = require("../demo/logging");

const e = ethers.parseEther;

async function onboard(state, signer, tag) {
  const idReg = state.getContract("identityRegistry");
  if (await idReg.isVerified(signer.address)) return;
  const id = await (
    await ethers.getContractFactory("OnchainID")
  ).deploy(signer.address);
  await (
    await idReg.registerIdentity(signer.address, await id.getAddress(), 840)
  ).wait();
  await attestAll(state, await id.getAddress(), `${tag}:${signer.address}`);
}

async function runEscrowSmoke(state, failures) {
  const signers = state.signers;
  const [treasury, investor, payer, payee, investorWallet, ownerWallet] =
    signers;
  const token = state.getContract("digitalToken");
  const registry = state.getContract("investorTypeRegistry");
  const rules = state.getContract("complianceRules");
  const idReg = state.getContract("identityRegistry");
  if (!(await token.isAgent(treasury.address)))
    await (await token.addAgent(treasury.address)).wait();
  for (const [s, tag] of [
    [payer, "escrow"],
    [payee, "escrow"],
    [investorWallet, "fee"],
    [ownerWallet, "fee"],
  ])
    await onboard(state, s, tag);

  // 1. Mint limits (2E.3). demo-smoke.js set the exemption while the
  //    deployer still owned the registry (owner only, D22).
  if (!(await registry.investorLimitExempt(treasury.address)))
    failures.push("treasury is not investor-limit exempt after the flag");
  try {
    await (await token.mint(treasury.address, e("100000000"))).wait();
  } catch (err) {
    failures.push(
      `exempt treasury mint reverted: ${err.message.slice(0, 120)}`,
    );
  }
  // payee: verified, untyped (Normal, 50,000 cap), no VSC yet.
  if ((await token.balanceOf(payee.address)) !== 0n)
    failures.push("payee holds VSC before the mint-limit check");
  if (await token.canTransfer(ethers.ZeroAddress, payee.address, e("60000")))
    failures.push(
      "canTransfer(0, untyped, 60000) is true — mint cap not enforced",
    );
  if (!(await token.canTransfer(ethers.ZeroAddress, payee.address, e("40000"))))
    failures.push("canTransfer(0, untyped, 40000) is false — within the cap");
  // The mint itself, not only the predicate, refuses above the cap.
  try {
    await (await token.mint(payee.address, e("60000"))).wait();
    failures.push("mint(untyped, 60000) succeeded — mint cap not enforced");
  } catch (err) {
    const why = `${err.reason ?? ""} ${err.message}`;
    if (!/Holding limit exceeded/.test(why))
      failures.push(`mint above the cap: wrong revert: ${why.slice(0, 120)}`);
  }

  // 2. Escrow on the real token; mirrors /tmp proof of 2E.1.
  const factory = await (
    await ethers.getContractFactory("EscrowWalletFactory")
  ).deploy(
    await token.getAddress(),
    ownerWallet.address,
    await idReg.getAddress(),
    await rules.getAddress(),
  );
  await (
    await factory.registerInvestor(investor.address, investorWallet.address)
  ).wait();
  await (
    await factory
      .connect(investor)
      .createEscrowWallet(payer.address, payee.address, e("1000"))
  ).wait();
  const wAddr = await factory.getWalletAddress(1);
  await (await rules.addTrustedContract(token.target, wAddr)).wait();
  // Payer funds come through the real mint, within the Normal cap.
  await (await token.mint(payer.address, e("10000"))).wait();
  await (
    await token.connect(payer).approve(await factory.getAddress(), e("1050"))
  ).wait();
  await (await factory.connect(payer).fundEscrowWallet(1)).wait();
  const wallet = await ethers.getContractAt("MultiSigEscrowWallet", wAddr);
  const proofData = JSON.stringify({
    trackingNumber: "SMOKE-1",
    carrier: "UPS",
  });
  const dataHash = ethers.keccak256(ethers.toUtf8Bytes(proofData));
  await (
    await wallet
      .connect(payee)
      .submitShipmentProof(
        proofData,
        dataHash,
        await signShipmentProof(payee, wAddr, dataHash),
      )
  ).wait();
  state.setContract("escrowFactory", factory);
  state.enhancedEscrowWallets.set("1", {
    paymentId: "1",
    walletAddress: wAddr,
    payer: payer.address,
    payee: payee.address,
    investor: investor.address,
    amount: "1000",
    createdAt: new Date().toISOString(),
    state: "ProofSubmitted",
  });
  const esc = new EscrowModule(state, new EnhancedLogger(), async () => "y");
  const l73 = [];
  const rl73 = console.log;
  console.log = (...a) => l73.push(a.join(" "));
  try {
    await esc.timeTravel14Days();
  } finally {
    console.log = rl73;
  }
  const proof = await wallet.shipmentProof();
  const win = await wallet.DISPUTE_WINDOW();
  const ts = (await ethers.provider.getBlock("latest")).timestamp;
  if (!(ts > Number(proof.submittedAt + win))) {
    failures.push(
      `option 73b did not advance past the dispute window; output: ${l73.join(" | ").slice(0, 300)}`,
    );
    return;
  }
  const bal = async () =>
    Promise.all(
      [payee, investorWallet, ownerWallet].map((s) =>
        token.balanceOf(s.address),
      ),
    );
  const before = await bal();
  try {
    await (await wallet.connect(payee).signAsPayee()).wait();
    await (await wallet.connect(investor).signAsInvestor(true)).wait();
  } catch (err) {
    failures.push(
      `after option 73b, payee release reverted: ${err.message.slice(0, 120)}`,
    );
    return;
  }
  const after = await bal();
  const want = [e("1000"), e("30"), e("20")];
  ["payee", "investor fee wallet", "owner fee wallet"].forEach((who, i) => {
    if (after[i] - before[i] !== want[i])
      failures.push(
        `escrow release: ${who} got ${ethers.formatEther(after[i] - before[i])} VSC, expected ${ethers.formatEther(want[i])}`,
      );
  });
  if ((await token.balanceOf(wAddr)) !== 0n)
    failures.push("escrow wallet not empty after release");
  for (const s of [payee, investorWallet, ownerWallet])
    if (
      await rules["isTrustedContract(address,address)"](token.target, s.address)
    )
      failures.push(`${s.address} is trusted; only the escrow wallet may be`);

  // 3. D26: the human side of a trusted transfer is capped. The fee wallets
  //    carry the D22 exemption (demo-smoke.js, before the handover); a
  //    release that would put the payee over its holding cap reverts at
  //    release, and the refund path stays open.
  for (const s of [investorWallet, ownerWallet])
    if (!(await registry.investorLimitExempt(s.address)))
      failures.push(`fee wallet ${s.address} is not limit-exempt (D26)`);
  await (await token.mint(payee.address, e("48500"))).wait(); // 49,500 held
  await (
    await factory
      .connect(investor)
      .createEscrowWallet(payer.address, payee.address, e("1000"))
  ).wait();
  const w2Addr = await factory.getWalletAddress(2);
  await (await rules.addTrustedContract(token.target, w2Addr)).wait();
  await (
    await token.connect(payer).approve(await factory.getAddress(), e("1050"))
  ).wait();
  await (await factory.connect(payer).fundEscrowWallet(2)).wait();
  const w2 = await ethers.getContractAt("MultiSigEscrowWallet", w2Addr);
  await (
    await w2
      .connect(payee)
      .submitShipmentProof(
        proofData,
        dataHash,
        await signShipmentProof(payee, w2Addr, dataHash),
      )
  ).wait();
  await ethers.provider.send("evm_increaseTime", [15 * 24 * 60 * 60]);
  await ethers.provider.send("evm_mine", []);
  await (await w2.connect(payee).signAsPayee()).wait();
  try {
    await (await w2.connect(investor).signAsInvestor(true)).wait();
    failures.push("over-cap escrow release succeeded: payee cap skipped");
  } catch (err) {
    const why = `${err.reason ?? ""} ${err.message}`;
    if (!/Holding limit exceeded/.test(why))
      failures.push(`over-cap release: wrong revert: ${why.slice(0, 120)}`);
  }
  const payerBefore = await token.balanceOf(payer.address);
  try {
    await (await w2.connect(payer).signAsPayer()).wait();
    await (await w2.connect(investor).signAsInvestor(false)).wait();
  } catch (err) {
    failures.push(
      `refund after a refused release: ${err.message.slice(0, 120)}`,
    );
    return;
  }
  if ((await token.balanceOf(payer.address)) - payerBefore !== e("1050"))
    failures.push("refund after a refused release did not return 1,050 VSC");
}

module.exports = { runEscrowSmoke };
