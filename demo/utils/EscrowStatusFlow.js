/**
 * @fileoverview Escrow option 71: escrow wallet status
 * @module EscrowStatusFlow
 * @description Reads one escrow wallet's state, signatures and dispute window.
 * Moved out of demo/modules/EscrowModule.js (plan v2 Task 4.8). Each
 * function takes the module instance `mod` first (its state, promptUser,
 * logger and sibling methods) and runs the option's code unchanged.
 */

const { displaySection, displayError } = require("./DisplayHelpers");
const { ethers } = require("hardhat");

/**
 * Helper: Get state emoji
 */
function getStateEmoji(mod, state) {
  const emojis = ["⏳", "✅", "💰", "⚠️"];
  return emojis[Number(state)] || "❓";
}

/** Option 71: View Escrow Wallet Status */
async function viewEscrowStatus(mod) {
  displaySection("VIEW ESCROW WALLET STATUS - COMPREHENSIVE DETAILS", "📊");

  if (
    !mod.state.enhancedEscrowWallets ||
    mod.state.enhancedEscrowWallets.size === 0
  ) {
    displayError("No escrow wallets");
    return;
  }

  console.log("\n📋 ESCROW WALLETS:");
  const wallets = Array.from(mod.state.enhancedEscrowWallets.values());
  wallets.forEach((wallet, index) => {
    console.log(`${index}. Payment ID ${wallet.paymentId} - ${wallet.state}`);
  });

  const walletIndex = await mod.promptUser("\nSelect wallet (number): ");
  const selectedWallet = wallets[parseInt(walletIndex)];

  if (!selectedWallet) {
    displayError("Invalid selection");
    return;
  }

  try {
    const MultiSigEscrowWallet = await ethers.getContractFactory(
      "MultiSigEscrowWallet",
    );
    const walletAddress =
      selectedWallet.address || selectedWallet.walletAddress;
    const wallet = MultiSigEscrowWallet.attach(walletAddress);

    // Escrow wallet: trusted contract. Owner wallet: verified human.
    console.log("\n🔍 COMPLIANCE STATUS CHECK:");
    const complianceRules = mod.state.getContract("complianceRules");
    const isTrusted = await complianceRules[
      "isTrustedContract(address,address)"
    ](mod.state.getContract("digitalToken").target, walletAddress);
    console.log(
      `   Escrow Wallet (${walletAddress}): ${isTrusted ? "✅ TRUSTED" : "❌ NOT TRUSTED"}`,
    );

    const ownerWalletAddress = mod.state.signers[1].address;
    const isOwnerVerified = await mod.state
      .getContract("identityRegistry")
      .isVerified(ownerWalletAddress);
    console.log(
      `   Owner Wallet (${ownerWalletAddress}): ${isOwnerVerified ? "✅ VERIFIED" : "❌ NOT VERIFIED"}`,
    );

    const status = await wallet.getWalletStatus();
    const payer = await wallet.payer();
    const payee = await wallet.payee();
    const investor = await wallet.investor();
    const amount = await wallet.amount();
    const token = await wallet.vscToken();
    const owner = await wallet.owner();
    const shipmentProof = await wallet.shipmentProof();

    const ownerWallet = mod.state.signers[1];
    const tokenContract = await ethers.getContractAt("Token", token);

    const payerBalance =
      payer !== ethers.ZeroAddress ? await tokenContract.balanceOf(payer) : 0n;
    const payeeBalance = await tokenContract.balanceOf(payee);
    const investorBalance = await tokenContract.balanceOf(investor);
    const ownerBalance = await tokenContract.balanceOf(ownerWallet.address);
    const walletBalance = await tokenContract.balanceOf(walletAddress);

    // Calculate fees
    const investorFee = (amount * 3n) / 100n;
    const ownerFee = (amount * 2n) / 100n;
    const totalFees = investorFee + ownerFee;
    const totalRequired = amount + totalFees;

    console.log("\n" + "=".repeat(80));
    console.log("📄 INVOICE & PAYMENT DETAILS");
    console.log("=".repeat(80));

    console.log("\n🆔 PAYMENT IDENTIFICATION:");
    console.log(`   Payment ID: #${selectedWallet.paymentId}`);
    console.log(
      `   Invoice Number: INV-${selectedWallet.paymentId.toString().padStart(6, "0")}`,
    );
    console.log(`   Escrow Wallet: ${walletAddress}`);
    console.log(`   Creation Date: ${selectedWallet.createdAt || "N/A"}`);
    console.log(
      `   Current State: ${["Active", "Released", "Refunded", "Disputed"][Number(status.currentState)]} ${mod.getStateEmoji(status.currentState)}`,
    );

    console.log("\n" + "=".repeat(80));
    console.log("👥 PARTIES INFORMATION");
    console.log("=".repeat(80));

    console.log("\n💼 PAYER (Buyer):");
    if (payer === ethers.ZeroAddress) {
      console.log(`   Address: Unknown (Marketplace Mode)`);
      console.log(`   Status: ⏳ Waiting for first funder`);
      console.log(`   Name: N/A`);
    } else {
      console.log(`   Address: ${payer}`);
      console.log(`   Name: ${selectedWallet.payerName || "N/A"}`);
      console.log(
        `   Status: ${status.payerIsSet ? "✅ Confirmed" : "⏳ Pending"}`,
      );
      console.log(
        `   Current Balance: ${ethers.formatEther(payerBalance)} VSC`,
      );
      console.log(
        `   Signature Status: ${status.payerHasSigned ? "✅ Signed" : "❌ Not Signed"}`,
      );
    }

    console.log("\n📦 PAYEE (Seller):");
    console.log(`   Address: ${payee}`);
    console.log(`   Name: ${selectedWallet.payeeName || "N/A"}`);
    console.log(`   Current Balance: ${ethers.formatEther(payeeBalance)} VSC`);
    console.log(
      `   Signature Status: ${status.payeeHasSigned ? "✅ Signed" : "❌ Not Signed"}`,
    );
    console.log(
      `   Can Sign: ${status.readyForSignatures ? "✅ Yes (dispute window closed)" : "❌ No (dispute window open)"}`,
    );

    console.log("\n🏦 INVESTOR (Escrow Manager):");
    console.log(`   Address: ${investor}`);
    console.log(
      `   Current Balance: ${ethers.formatEther(investorBalance)} VSC`,
    );
    console.log(
      `   Signature Status: ${status.investorHasSigned ? "✅ Signed" : "❌ Not Signed"}`,
    );
    console.log(`   Fee Earned: ${ethers.formatEther(investorFee)} VSC (3%)`);

    console.log("\n👑 OWNER (Platform):");
    console.log(`   Address: ${owner}`);
    console.log(`   Wallet Address: ${ownerWallet.address}`);
    console.log(`   Current Balance: ${ethers.formatEther(ownerBalance)} VSC`);
    console.log(`   Fee Earned: ${ethers.formatEther(ownerFee)} VSC (2%)`);

    console.log("\n" + "=".repeat(80));
    console.log("💰 FINANCIAL BREAKDOWN");
    console.log("=".repeat(80));

    console.log("\n📊 PAYMENT STRUCTURE:");
    console.log(`   Base Payment Amount: ${ethers.formatEther(amount)} VSC`);
    console.log(`   Investor Fee (3%): ${ethers.formatEther(investorFee)} VSC`);
    console.log(`   Owner Fee (2%): ${ethers.formatEther(ownerFee)} VSC`);
    console.log(`   Total Fees (5%): ${ethers.formatEther(totalFees)} VSC`);
    console.log(`   ─────────────────────────────────────`);
    console.log(`   TOTAL REQUIRED: ${ethers.formatEther(totalRequired)} VSC`);

    console.log("\n💳 ESCROW WALLET BALANCE:");
    console.log(`   Current Balance: ${ethers.formatEther(walletBalance)} VSC`);
    console.log(
      `   Funded: ${walletBalance >= totalRequired ? "✅ Yes" : "❌ No"}`,
    );
    if (walletBalance < totalRequired) {
      console.log(
        `   Remaining: ${ethers.formatEther(totalRequired - walletBalance)} VSC`,
      );
    }

    // Continue in next part due to 150-line limit...
    await mod._viewEscrowStatusPart2(
      wallet,
      status,
      shipmentProof,
      amount,
      investorFee,
      ownerFee,
      selectedWallet,
      payer,
      payee,
      investor,
      token,
    );
  } catch (error) {
    displayError(`Status check failed: ${error.message}`);
  }
}

/** Helper: View Escrow Status Part 2 (continuation) */
async function _viewEscrowStatusPart2(
  mod,
  wallet,
  status,
  shipmentProof,
  amount,
  investorFee,
  ownerFee,
  selectedWallet,
  payer,
  payee,
  investor,
  token,
) {
  console.log("\n" + "=".repeat(80));
  console.log("📦 SHIPMENT PROOF & DISPUTE STATUS");
  console.log("=".repeat(80));

  console.log("\n📋 PROOF DETAILS:");
  console.log(`   Submitted: ${status.proofSubmitted ? "✅ Yes" : "❌ No"}`);
  if (status.proofSubmitted) {
    const proofDate = new Date(Number(shipmentProof.submittedAt) * 1000);
    const windowEnd = new Date(
      (Number(shipmentProof.submittedAt) + 14 * 24 * 60 * 60) * 1000,
    );

    console.log(`   Submission Date: ${proofDate.toISOString()}`);
    console.log(`   Data Hash: ${shipmentProof.dataHash}`);
    console.log(`   Signature: ${shipmentProof.signature.slice(0, 20)}...`);

    try {
      const proofData = JSON.parse(shipmentProof.data);
      console.log(`   Tracking Number: ${proofData.trackingNumber || "N/A"}`);
      console.log(`   Carrier: ${proofData.carrier || "N/A"}`);
    } catch (e) {
      console.log(`   Raw Data: ${shipmentProof.data.slice(0, 50)}...`);
    }

    console.log("\n⏰ DISPUTE WINDOW (14 Days):");
    console.log(`   Window Closes: ${windowEnd.toISOString()}`);
    console.log(
      `   Status: ${status.disputeWindowOpen ? "⚠️  OPEN" : "✅ CLOSED"}`,
    );

    if (status.disputeWindowOpen) {
      const hoursLeft = Math.floor(Number(status.timeUntilSignatures) / 3600);
      const daysLeft = Math.floor(hoursLeft / 24);
      console.log(
        `   Time Remaining: ${daysLeft} days, ${hoursLeft % 24} hours`,
      );
      console.log(`   Payer Can Dispute: ✅ Yes`);
      console.log(`   Payee Can Sign: ❌ No`);
    } else {
      console.log(`   Time Remaining: 0 (Closed)`);
      console.log(`   Payer Can Dispute: ❌ No`);
      console.log(`   Payee Can Sign: ✅ Yes`);
    }
  }

  console.log("\n" + "=".repeat(80));
  console.log("✍️  MULTI-SIGNATURE STATUS (2-of-3)");
  console.log("=".repeat(80));

  console.log("\n📝 SIGNATURE REQUIREMENTS:");
  console.log(`   Required Signatures: 2 of 3`);
  console.log(`   Investor MUST Sign: ✅ (Always Required)`);
  console.log(`   Plus ONE of: Payer OR Payee`);

  console.log("\n✅ CURRENT SIGNATURES:");
  console.log(
    `   ${status.payerHasSigned ? "✅" : "❌"} Payer (${payer === ethers.ZeroAddress ? "Unknown" : payer.slice(0, 10)}...)`,
  );
  console.log(
    `   ${status.payeeHasSigned ? "✅" : "❌"} Payee (${payee.slice(0, 10)}...)`,
  );
  console.log(
    `   ${status.investorHasSigned ? "✅" : "❌"} Investor (${investor.slice(0, 10)}...)`,
  );

  const sigCount =
    (status.payerHasSigned ? 1 : 0) +
    (status.payeeHasSigned ? 1 : 0) +
    (status.investorHasSigned ? 1 : 0);
  console.log(`\n   Total Signatures: ${sigCount} / 2`);

  console.log("\n🔀 RELEASE PATHS:");
  console.log(`   Investor + Payee → Release to Payee (Normal)`);
  console.log(`   Investor + Payer → Refund to Payer (Dispute/Refund)`);

  // Show detailed transaction information based on state and signatures
  const stateNames = ["Active", "Released", "Refunded", "Disputed"];
  const currentStateName = stateNames[Number(status.currentState)] || "Unknown";

  if (currentStateName === "Released") {
    console.log(`\n   🎉 PAYMENT RELEASED TO PAYEE!`);
    console.log(`\n   💰 RELEASE TRANSACTION DETAILS:`);
    console.log(`   ✅ Investor + Payee signed → Normal release`);
    console.log(
      `   📤 Payee received: ${parseFloat(ethers.formatEther(amount)).toLocaleString()} VSC`,
    );
    console.log(
      `   📤 Investor fee: ${parseFloat(ethers.formatEther(investorFee)).toLocaleString()} VSC`,
    );
    console.log(
      `   📤 Owner fee: ${parseFloat(ethers.formatEther(ownerFee)).toLocaleString()} VSC`,
    );
  } else if (currentStateName === "Refunded") {
    console.log(`\n   💰 PAYMENT REFUNDED TO PAYER!`);
    console.log(`\n   💰 REFUND TRANSACTION DETAILS:`);
    if (status.investorHasSigned && status.payerHasSigned) {
      console.log(`   ✅ Investor + Payer signed → Refund approved`);
    } else if (status.investorHasSigned) {
      console.log(`   ✅ Investor initiated manual refund`);
    }
    const totalRefund =
      parseFloat(ethers.formatEther(amount)) +
      parseFloat(ethers.formatEther(investorFee)) +
      parseFloat(ethers.formatEther(ownerFee));
    console.log(
      `   📤 Payer received full refund: ${totalRefund.toLocaleString()} VSC`,
    );
    console.log(
      `   💡 Includes: ${parseFloat(ethers.formatEther(amount)).toLocaleString()} VSC payment + ${parseFloat(ethers.formatEther(investorFee + ownerFee)).toLocaleString()} VSC fees`,
    );
  } else if (status.investorHasSigned && status.payeeHasSigned) {
    console.log(`\n   🎉 READY TO RELEASE TO PAYEE!`);
    console.log(`   💡 Execute release to complete transaction`);
  } else if (status.investorHasSigned && status.payerHasSigned) {
    console.log(`\n   💰 READY TO REFUND TO PAYER!`);
    console.log(`   💡 Execute refund to complete transaction`);
  } else if (sigCount >= 1) {
    console.log(`\n   ⏳ Waiting for ${2 - sigCount} more signature(s)`);
  }

  console.log("\n" + "=".repeat(80));
  console.log("📊 TRANSACTION SUMMARY");
  console.log("=".repeat(80));

  const escrowFactory = mod.state.getContract("escrowFactory");
  console.log("\n🔗 BLOCKCHAIN TRANSACTIONS:");
  console.log(`   Token Contract: ${token}`);
  console.log(`   Escrow Factory: ${await escrowFactory.getAddress()}`);

  console.log("\n📈 NEXT STEPS:");
  if (!status.proofSubmitted) {
    console.log(
      `   1. ⏳ Waiting for payee to submit shipment proof (Option 65)`,
    );
  } else if (status.disputeWindowOpen) {
    console.log(
      `   1. ⏰ Dispute window open (${Math.floor(Number(status.timeUntilSignatures) / 86400)} days left)`,
    );
    console.log(`   2. 🚨 Payer can raise dispute (Option 66)`);
    console.log(`   3. ⏰ Or wait for window to close (Option 73b)`);
  } else if (!status.payeeHasSigned && !status.investorHasSigned) {
    console.log(`   1. ✍️  Payee should sign release (Option 68)`);
    console.log(`   2. ✍️  Investor should sign release (Option 69)`);
    console.log(`   3. 🎉 Payment will auto-release!`);
  } else if (status.payeeHasSigned && !status.investorHasSigned) {
    console.log(`   1. ✍️  Investor should sign release (Option 69)`);
    console.log(`   2. 🎉 Payment will auto-release!`);
  } else if (status.investorHasSigned && !status.payeeHasSigned) {
    console.log(`   1. ✍️  Payee should sign release (Option 68)`);
    console.log(`   2. 🎉 Payment will auto-release!`);
  } else if (Number(status.currentState) === 1) {
    console.log(`   ✅ Payment completed and released to payee!`);
  } else if (Number(status.currentState) === 2) {
    console.log(`   ✅ Payment refunded to payer!`);
  }

  console.log("\n" + "=".repeat(80));
}

module.exports = { getStateEmoji, viewEscrowStatus, _viewEscrowStatusPart2 };
