/**
 * @fileoverview Escrow options 65-68, 70, 70a: proof, dispute, payee release, refund, sweep
 * @module EscrowDisputeFlow
 * @description Shipment proof, dispute and its resolution, the payee's release
 * signature, the investor's manual refund and the sweep of stranded tokens.
 * Moved out of demo/modules/EscrowModule.js (plan v2 Task 4.8). Each
 * function takes the module instance `mod` first (its state, promptUser,
 * logger and sibling methods) and runs the option's code unchanged.
 */

"use strict";

const {
  displaySection,
  displaySuccess,
  displayError,
} = require("./DisplayHelpers");
const { signShipmentProof } = require("./ShipmentProof");
const { ethers } = require("hardhat");

/** Option 65: Payee: Submit Shipment Proof */
async function submitShipmentProof(mod) {
  displaySection("PAYEE: SUBMIT SHIPMENT PROOF", "📦");

  if (
    !mod.state.enhancedEscrowWallets ||
    mod.state.enhancedEscrowWallets.size === 0
  ) {
    displayError("No escrow wallets. Please create and fund one first");
    return;
  }

  // List funded wallets
  const fundedWallets = Array.from(
    mod.state.enhancedEscrowWallets.values(),
  ).filter((w) => w.state === "Funded");
  if (fundedWallets.length === 0) {
    displayError("No funded wallets. Please fund a wallet first (Option 64)");
    return;
  }

  console.log("\n📋 FUNDED WALLETS:");
  fundedWallets.forEach((wallet, index) => {
    console.log(
      `${index}. Payment ID ${wallet.paymentId} - ${wallet.payerName} → ${wallet.payeeName} (${wallet.amount} VSC)`,
    );
  });

  const walletIndex = await mod.promptUser("\nSelect wallet (number): ");
  const selectedWallet = fundedWallets[parseInt(walletIndex)];

  if (!selectedWallet) {
    displayError("Invalid selection");
    return;
  }

  try {
    const payee = await mod.getSignerForAddress(selectedWallet.payee);
    const MultiSigEscrowWallet = await ethers.getContractFactory(
      "MultiSigEscrowWallet",
    );
    const walletAddress =
      selectedWallet.walletAddress || selectedWallet.address;
    const wallet = MultiSigEscrowWallet.attach(walletAddress);

    // Create shipment proof
    const proofData = JSON.stringify({
      trackingNumber: `TRK${Date.now()}`,
      carrier: "DHL Express",
      shipDate: new Date().toISOString(),
      estimatedDelivery: new Date(
        Date.now() + 7 * 24 * 60 * 60 * 1000,
      ).toISOString(),
      photos: ["photo1.jpg", "photo2.jpg"],
    });

    const dataHash = ethers.keccak256(ethers.toUtf8Bytes(proofData));
    const signature = await signShipmentProof(payee, walletAddress, dataHash);

    console.log("\n📝 Submitting shipment proof...");
    console.log(`   Tracking: TRK${Date.now()}`);
    console.log(`   Carrier: DHL Express`);

    const tx = await wallet
      .connect(payee)
      .submitShipmentProof(proofData, dataHash, signature);
    await tx.wait();

    selectedWallet.state = "ProofSubmitted";

    displaySuccess("Shipment proof submitted successfully!");
    console.log("   14-day dispute window started");
  } catch (error) {
    displayError(`Proof submission failed: ${error.message}`);
  }
}

/** Option 66: Payer: Raise Dispute */
async function raiseDispute(mod) {
  displaySection("PAYER: RAISE DISPUTE", "⚠️");

  const proofWallets = Array.from(
    mod.state.enhancedEscrowWallets.values(),
  ).filter((w) => w.state === "ProofSubmitted");
  if (proofWallets.length === 0) {
    displayError("No wallets with submitted proof");
    return;
  }

  console.log("\n📋 WALLETS WITH PROOF:");
  proofWallets.forEach((wallet, index) => {
    console.log(
      `${index}. Payment ID ${wallet.paymentId} - ${wallet.payerName} → ${wallet.payeeName}`,
    );
  });

  const walletIndex = await mod.promptUser("\nSelect wallet (number): ");
  const selectedWallet = proofWallets[parseInt(walletIndex)];

  if (!selectedWallet) {
    displayError("Invalid selection");
    return;
  }

  try {
    const payer = await mod.getSignerForAddress(selectedWallet.payer);
    const MultiSigEscrowWallet = await ethers.getContractFactory(
      "MultiSigEscrowWallet",
    );
    const walletAddress =
      selectedWallet.walletAddress || selectedWallet.address;
    const wallet = MultiSigEscrowWallet.attach(walletAddress);

    console.log("\n⚠️ Raising dispute...");
    const tx = await wallet.connect(payer).raiseDispute();
    await tx.wait();

    selectedWallet.state = "Disputed";

    displaySuccess("Dispute raised successfully!");
    console.log("   Investor will review and decide");
  } catch (error) {
    displayError(`Dispute failed: ${error.message}`);
  }
}

/** Option 67: Investor: Resolve Dispute */
async function resolveDispute(mod) {
  displaySection("INVESTOR: RESOLVE DISPUTE", "⚖️");

  const disputedWallets = Array.from(
    mod.state.enhancedEscrowWallets.values(),
  ).filter((w) => w.state === "Disputed");
  if (disputedWallets.length === 0) {
    displayError("No disputed wallets");
    return;
  }

  console.log("\n📋 DISPUTED WALLETS:");
  disputedWallets.forEach((wallet, index) => {
    console.log(
      `${index}. Payment ID ${wallet.paymentId} - ${wallet.payerName} → ${wallet.payeeName}`,
    );
  });

  const walletIndex = await mod.promptUser("\nSelect wallet (number): ");
  const selectedWallet = disputedWallets[parseInt(walletIndex)];

  if (!selectedWallet) {
    displayError("Invalid selection");
    return;
  }

  const decision = await mod.promptUser("\nRefund to payer? (yes/no): ");
  const refund = decision.toLowerCase() === "yes";

  try {
    const investor = await mod.getSignerForAddress(selectedWallet.investor);
    const MultiSigEscrowWallet = await ethers.getContractFactory(
      "MultiSigEscrowWallet",
    );
    const walletAddress =
      selectedWallet.walletAddress || selectedWallet.address;
    const wallet = MultiSigEscrowWallet.attach(walletAddress);

    console.log(`\n⚖️ Resolving dispute (${refund ? "REFUND" : "RELEASE"})...`);
    const tx = await wallet.connect(investor).resolveDispute(refund);
    await tx.wait();

    selectedWallet.state = refund ? "Refunded" : "ProofSubmitted";

    displaySuccess("Dispute resolved!");
    console.log(
      `   Decision: ${refund ? "Refund to payer" : "Continue to release"}`,
    );
  } catch (error) {
    displayError(`Resolution failed: ${error.message}`);
  }
}

/** Option 68: Payee: Sign Release */
async function payeeSignRelease(mod) {
  displaySection("PAYEE: SIGN RELEASE", "✍️");

  const readyWallets = Array.from(
    mod.state.enhancedEscrowWallets.values(),
  ).filter((w) => w.state === "ProofSubmitted");
  if (readyWallets.length === 0) {
    displayError("No wallets ready for signing");
    return;
  }

  console.log("\n📋 WALLETS READY FOR SIGNING:");
  readyWallets.forEach((wallet, index) => {
    console.log(
      `${index}. Payment ID ${wallet.paymentId} - ${wallet.payerName} → ${wallet.payeeName}`,
    );
  });

  const walletIndex = await mod.promptUser("\nSelect wallet (number): ");
  const selectedWallet = readyWallets[parseInt(walletIndex)];

  if (!selectedWallet) {
    displayError("Invalid selection");
    return;
  }

  try {
    const payee = await mod.getSignerForAddress(selectedWallet.payee);
    const MultiSigEscrowWallet = await ethers.getContractFactory(
      "MultiSigEscrowWallet",
    );
    const walletAddress =
      selectedWallet.walletAddress || selectedWallet.address;
    const wallet = MultiSigEscrowWallet.attach(walletAddress);

    console.log("\n✍️ Payee signing...");
    const tx = await wallet.connect(payee).signAsPayee();
    await tx.wait();

    displaySuccess("Payee signed successfully!");
    console.log("   Waiting for investor signature to release funds");
  } catch (error) {
    if (/Dispute window still open/.test(error.message))
      console.log(
        "⛔ Signing refused (expected): Dispute window still open (73b closes it)",
      );
    else displayError(`Signing failed: ${error.message}`);
  }
}

/** Option 70: Investor: Manual Refund */
async function manualRefund(mod) {
  displaySection("INVESTOR: MANUAL REFUND", "🔄");

  // manualRefund reverts once the payee has shipped (RefundBlockedAfterShipment).
  // Offer it only for pre-shipment (Funded) or disputed escrows.
  const activeWallets = Array.from(
    mod.state.enhancedEscrowWallets.values(),
  ).filter((w) => w.state === "Funded" || w.state === "Disputed");
  if (activeWallets.length === 0) {
    console.log(
      "ℹ️  No active wallets (refund needs a Funded or Disputed escrow)",
    );
    return;
  }

  console.log("\n📋 ACTIVE WALLETS:");
  activeWallets.forEach((wallet, index) => {
    console.log(
      `${index}. Payment ID ${wallet.paymentId} - ${wallet.payerName} → ${wallet.payeeName}`,
    );
  });

  const walletIndex = await mod.promptUser("\nSelect wallet (number): ");
  const selectedWallet = activeWallets[parseInt(walletIndex)];

  if (!selectedWallet) {
    displayError("Invalid selection");
    return;
  }

  const confirm = await mod.promptUser(
    "\n⚠️ Confirm manual refund? (yes/no): ",
  );
  if (confirm.toLowerCase() !== "yes") {
    displayError("Refund cancelled");
    return;
  }

  try {
    const investor = await mod.getSignerForAddress(selectedWallet.investor);
    const MultiSigEscrowWallet = await ethers.getContractFactory(
      "MultiSigEscrowWallet",
    );
    const walletAddress =
      selectedWallet.walletAddress || selectedWallet.address;
    const wallet = MultiSigEscrowWallet.attach(walletAddress);

    console.log("\n🔄 Processing manual refund...");
    const tx = await wallet.connect(investor).manualRefund();
    await tx.wait();

    selectedWallet.state = "Refunded";

    displaySuccess("Manual refund completed!");
    console.log("   Funds returned to payer");
  } catch (error) {
    displayError(`Refund failed: ${error.message}`);
  }
}

/** Option 70a: Sweep tokens stranded in a settled escrow */
async function sweepExcess(mod) {
  displaySection("SWEEP STRANDED TOKENS", "🧹");

  // `funded` only stops a second FACTORY funding. Anyone can transfer
  // straight to an escrow address, and release/refund pay fixed sums, so
  // anything else that arrived stays behind. Once settled it can be swept
  // back to the payer (or the platform fee wallet if no payer was set).
  const settled = Array.from(mod.state.enhancedEscrowWallets.values()).filter(
    (w) => w.state === "Released" || w.state === "Refunded",
  );
  if (settled.length === 0) {
    displayError("No released or refunded wallets to sweep");
    return;
  }

  const token = mod.state.getContract("digitalToken");
  console.log("\n📋 SETTLED WALLETS:");
  for (const [index, w] of settled.entries()) {
    const held = await token.balanceOf(w.walletAddress || w.address);
    console.log(
      `${index}. Payment ID ${w.paymentId} - ${w.state} - holds ${ethers.formatEther(held)} VSC`,
    );
  }

  const walletIndex = await mod.promptUser("\nSelect wallet (number): ");
  const selected = settled[parseInt(walletIndex)];
  if (!selected) {
    displayError("Invalid selection");
    return;
  }

  try {
    const wallet = await ethers.getContractAt(
      "MultiSigEscrowWallet",
      selected.walletAddress || selected.address,
    );
    const receipt = await (await wallet.sweepExcess()).wait();
    const swept = receipt.logs
      .map((log) => {
        try {
          return wallet.interface.parseLog(log);
        } catch (e) {
          return null;
        }
      })
      .find((parsed) => parsed && parsed.name === "ExcessSwept");

    displaySuccess("Stranded tokens returned");
    console.log(`   To: ${swept.args.to}`);
    console.log(`   Amount: ${ethers.formatEther(swept.args.amount)} VSC`);
  } catch (error) {
    if (/NothingToSweep/.test(error.message))
      console.log(
        "ℹ️  Nothing to sweep: the escrow holds no stranded VSC (chain)",
      );
    else displayError(`Sweep failed: ${error.message}`);
  }
}

module.exports = {
  submitShipmentProof,
  raiseDispute,
  resolveDispute,
  payeeSignRelease,
  manualRefund,
  sweepExcess,
};
