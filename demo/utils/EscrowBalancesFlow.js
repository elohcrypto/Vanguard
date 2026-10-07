/**
 * @fileoverview Escrow options 71a and 72: balances and dashboard
 * @module EscrowBalancesFlow
 * @description Every party's balances for one escrow, and the escrow dashboard.
 * Moved out of demo/modules/EscrowModule.js (plan v2 Task 4.8). Each
 * function takes the module instance `mod` first (its state, promptUser,
 * logger and sibling methods) and runs the option's code unchanged.
 */

const { displaySection, displayError } = require("./DisplayHelpers");
const { ethers } = require("hardhat");

/** Option 71a: View All Parties Balances */
async function viewAllPartiesBalances(mod) {
  displaySection("ESCROW WALLET - ALL PARTIES BALANCES", "💰");

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
    const wallet = MultiSigEscrowWallet.attach(
      selectedWallet.address || selectedWallet.walletAddress,
    );

    const statusResult = await wallet.getWalletStatus();
    const status = {
      state: statusResult[0],
      payerIsSet: statusResult[1],
      proofSubmitted: statusResult[2],
      disputeWindowOpen: statusResult[3],
      readyForSignatures: statusResult[4],
      payerSigned: statusResult[5],
      payeeSigned: statusResult[6],
      investorSigned: statusResult[7],
      timeUntilSignatures: statusResult[8],
    };

    const payer = await wallet.payer();
    const payee = await wallet.payee();
    const investor = await wallet.investor();
    const amount = await wallet.amount();
    const investorFee = await wallet.investorFee();
    const ownerFee = await wallet.ownerFee();
    const vscToken = await wallet.vscToken();
    const owner = await wallet.owner();
    const investorWallet = await wallet.investorWallet();
    const ownerWallet = await wallet.ownerWallet();
    const walletAddress =
      selectedWallet.address || selectedWallet.walletAddress;

    // Get token contract
    const Token = await ethers.getContractFactory("Token");
    const tokenContract = Token.attach(vscToken);

    console.log("\n" + "=".repeat(80));
    console.log("💰 ALL PARTIES BALANCES");
    console.log("=".repeat(80));

    // 1. ESCROW WALLET
    const escrowBalance = await tokenContract.balanceOf(walletAddress);
    const escrowBalanceVSC = parseFloat(ethers.formatEther(escrowBalance));

    console.log("\n🏦 ESCROW WALLET:");
    console.log(`   Address: ${walletAddress}`);
    console.log(`   Balance: ${escrowBalanceVSC.toLocaleString()} VSC`);
    console.log(
      `   State: ${["Active", "Released", "Refunded", "Disputed"][Number(status.state)]}`,
    );
    console.log(
      `   Payment Amount: ${parseFloat(ethers.formatEther(amount)).toLocaleString()} VSC`,
    );
    console.log(
      `   Investor Fee (3%): ${parseFloat(ethers.formatEther(investorFee)).toLocaleString()} VSC`,
    );
    console.log(
      `   Owner Fee (2%): ${parseFloat(ethers.formatEther(ownerFee)).toLocaleString()} VSC`,
    );
    const totalAmount =
      parseFloat(ethers.formatEther(amount)) +
      parseFloat(ethers.formatEther(investorFee)) +
      parseFloat(ethers.formatEther(ownerFee));
    console.log(`   Total Required: ${totalAmount.toLocaleString()} VSC`);

    // 2. PAYER
    const payerBalance = await tokenContract.balanceOf(payer);
    const payerBalanceVSC = parseFloat(ethers.formatEther(payerBalance));
    const payerFreeBalance = await tokenContract.getFreeBalance(payer);
    const payerFreeBalanceVSC = parseFloat(
      ethers.formatEther(payerFreeBalance),
    );
    const payerFrozen = await tokenContract.frozenTokens(payer);
    const payerFrozenVSC = parseFloat(ethers.formatEther(payerFrozen));

    console.log("\n👤 PAYER:");
    console.log(`   Address: ${payer}`);
    console.log(`   Total Balance: ${payerBalanceVSC.toLocaleString()} VSC`);
    console.log(`   Free Balance: ${payerFreeBalanceVSC.toLocaleString()} VSC`);
    if (payerFrozenVSC > 0) {
      console.log(`   Frozen: ${payerFrozenVSC.toLocaleString()} VSC`);
    }
    console.log(`   Signed: ${status.payerSigned ? "✅ Yes" : "❌ No"}`);

    // 3. PAYEE
    const payeeBalance = await tokenContract.balanceOf(payee);
    const payeeBalanceVSC = parseFloat(ethers.formatEther(payeeBalance));
    const payeeFreeBalance = await tokenContract.getFreeBalance(payee);
    const payeeFreeBalanceVSC = parseFloat(
      ethers.formatEther(payeeFreeBalance),
    );
    const payeeFrozen = await tokenContract.frozenTokens(payee);
    const payeeFrozenVSC = parseFloat(ethers.formatEther(payeeFrozen));

    console.log("\n👥 PAYEE:");
    console.log(`   Address: ${payee}`);
    console.log(`   Total Balance: ${payeeBalanceVSC.toLocaleString()} VSC`);
    console.log(`   Free Balance: ${payeeFreeBalanceVSC.toLocaleString()} VSC`);
    if (payeeFrozenVSC > 0) {
      console.log(`   Frozen: ${payeeFrozenVSC.toLocaleString()} VSC`);
    }
    console.log(`   Signed: ${status.payeeSigned ? "✅ Yes" : "❌ No"}`);
    console.log(
      `   Will Receive: ${parseFloat(ethers.formatEther(amount)).toLocaleString()} VSC (if released)`,
    );

    // 4. INVESTOR
    const investorBalance = await tokenContract.balanceOf(investor);
    const investorBalanceVSC = parseFloat(ethers.formatEther(investorBalance));
    const investorFreeBalance = await tokenContract.getFreeBalance(investor);
    const investorFreeBalanceVSC = parseFloat(
      ethers.formatEther(investorFreeBalance),
    );
    const investorFrozen = await tokenContract.frozenTokens(investor);
    const investorFrozenVSC = parseFloat(ethers.formatEther(investorFrozen));

    console.log("\n💼 INVESTOR:");
    console.log(`   Address: ${investor}`);
    console.log(`   Total Balance: ${investorBalanceVSC.toLocaleString()} VSC`);
    console.log(
      `   Free Balance: ${investorFreeBalanceVSC.toLocaleString()} VSC`,
    );
    if (investorFrozenVSC > 0) {
      console.log(`   Frozen: ${investorFrozenVSC.toLocaleString()} VSC`);
    }
    console.log(`   Signed: ${status.investorSigned ? "✅ Yes" : "❌ No"}`);
    console.log(`   Fee Wallet: ${investorWallet}`);

    // Get investor fee wallet balance
    const investorFeeWalletBalance =
      await tokenContract.balanceOf(investorWallet);
    const investorFeeWalletVSC = parseFloat(
      ethers.formatEther(investorFeeWalletBalance),
    );
    console.log(
      `   Fee Wallet Balance: ${investorFeeWalletVSC.toLocaleString()} VSC`,
    );
    console.log(
      `   Will Receive: ${parseFloat(ethers.formatEther(investorFee)).toLocaleString()} VSC (if released)`,
    );

    // 5. PLATFORM OWNER
    const ownerBalance = await tokenContract.balanceOf(owner);
    const ownerBalanceVSC = parseFloat(ethers.formatEther(ownerBalance));

    console.log("\n🏢 PLATFORM OWNER:");
    console.log(`   Address: ${owner}`);
    console.log(`   Total Balance: ${ownerBalanceVSC.toLocaleString()} VSC`);
    console.log(`   Fee Wallet: ${ownerWallet}`);

    // Get owner fee wallet balance
    const ownerFeeWalletBalance = await tokenContract.balanceOf(ownerWallet);
    const ownerFeeWalletVSC = parseFloat(
      ethers.formatEther(ownerFeeWalletBalance),
    );
    console.log(
      `   Fee Wallet Balance: ${ownerFeeWalletVSC.toLocaleString()} VSC`,
    );
    console.log(
      `   Will Receive: ${parseFloat(ethers.formatEther(ownerFee)).toLocaleString()} VSC (if released)`,
    );

    // SUMMARY
    console.log("\n" + "=".repeat(80));
    console.log("📊 SUMMARY");
    console.log("=".repeat(80));

    const totalInSystem =
      escrowBalanceVSC +
      payerBalanceVSC +
      payeeBalanceVSC +
      investorBalanceVSC +
      investorFeeWalletVSC +
      ownerBalanceVSC +
      ownerFeeWalletVSC;

    console.log(
      `\n💰 Total VSC in System: ${totalInSystem.toLocaleString()} VSC`,
    );
    console.log(`   Escrow Wallet: ${escrowBalanceVSC.toLocaleString()} VSC`);
    console.log(`   Payer: ${payerBalanceVSC.toLocaleString()} VSC`);
    console.log(`   Payee: ${payeeBalanceVSC.toLocaleString()} VSC`);
    console.log(`   Investor: ${investorBalanceVSC.toLocaleString()} VSC`);
    console.log(
      `   Investor Fee Wallet: ${investorFeeWalletVSC.toLocaleString()} VSC`,
    );
    console.log(`   Platform Owner: ${ownerBalanceVSC.toLocaleString()} VSC`);
    console.log(
      `   Owner Fee Wallet: ${ownerFeeWalletVSC.toLocaleString()} VSC`,
    );

    console.log(`\n🔐 Multi-Sig Status:`);
    console.log(`   Payer Signed: ${status.payerSigned ? "✅" : "❌"}`);
    console.log(`   Payee Signed: ${status.payeeSigned ? "✅" : "❌"}`);
    console.log(`   Investor Signed: ${status.investorSigned ? "✅" : "❌"}`);
    console.log(`   Required: Investor + (Payer OR Payee)`);
  } catch (error) {
    displayError(`Balance check failed: ${error.message}`);
  }
}

/** Option 72: Enhanced Escrow Dashboard */
async function showDashboard(mod) {
  displaySection("ENHANCED ESCROW DASHBOARD", "💳");

  const escrowFactory = mod.state.getContract("escrowFactory");
  if (!escrowFactory) {
    displayError("Enhanced Escrow not deployed");
    return;
  }

  try {
    console.log("\n📊 SYSTEM OVERVIEW:");
    console.log(`Factory: ${await escrowFactory.getAddress()}`);
    console.log(
      `Total Wallets: ${mod.state.enhancedEscrowWallets ? mod.state.enhancedEscrowWallets.size : 0}`,
    );
    console.log(
      `Registered Investors: ${mod.state.registeredInvestors ? mod.state.registeredInvestors.size : 0}`,
    );
    console.log("");

    if (
      mod.state.enhancedEscrowWallets &&
      mod.state.enhancedEscrowWallets.size > 0
    ) {
      console.log("📋 WALLET SUMMARY:");
      const states = {
        Active: 0,
        Funded: 0,
        ProofSubmitted: 0,
        Disputed: 0,
        Released: 0,
        Refunded: 0,
      };

      for (const wallet of mod.state.enhancedEscrowWallets.values()) {
        states[wallet.state] = (states[wallet.state] || 0) + 1;
      }

      console.log(`   Active: ${states.Active || 0}`);
      console.log(`   Funded: ${states.Funded || 0}`);
      console.log(`   Proof Submitted: ${states.ProofSubmitted || 0}`);
      console.log(`   Disputed: ${states.Disputed || 0}`);
      console.log(`   Released: ${states.Released || 0}`);
      console.log(`   Refunded: ${states.Refunded || 0}`);
      console.log("");

      console.log("📜 RECENT WALLETS:");
      const wallets = Array.from(
        mod.state.enhancedEscrowWallets.values(),
      ).slice(-5);
      wallets.forEach((wallet) => {
        console.log(
          `   Payment ${wallet.paymentId}: ${wallet.payerName || "Unknown"} → ${wallet.payeeName} (${wallet.state})`,
        );
      });
    }
  } catch (error) {
    displayError(`Dashboard failed: ${error.message}`);
  }
}

module.exports = { viewAllPartiesBalances, showDashboard };
