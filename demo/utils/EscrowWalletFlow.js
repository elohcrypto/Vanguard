/**
 * @fileoverview Escrow options 63-64: create and fund an escrow wallet
 * @module EscrowWalletFlow
 * @description The investor creates a one-time escrow wallet; the payer funds it.
 * Moved out of demo/modules/EscrowModule.js (plan v2 Task 4.8). Each
 * function takes the module instance `mod` first (its state, promptUser,
 * logger and sibling methods) and runs the option's code unchanged.
 */

const {
  displaySection,
  displaySuccess,
  displayError,
  displayWarning,
} = require("./DisplayHelpers");
const { ethers } = require("hardhat");

/** Option 63: Investor: Create Escrow Wallet */
async function createEscrowWallet(mod) {
  displaySection("INVESTOR: CREATE ESCROW WALLET", "💼");

  const escrowFactory = mod.state.getContract("escrowFactory");
  if (!escrowFactory) {
    displayError(
      "Enhanced Escrow not deployed. Please deploy first (option 61)",
    );
    return;
  }

  if (
    !mod.state.registeredInvestors ||
    mod.state.registeredInvestors.size === 0
  ) {
    displayError("No registered investors. Please register first (Option 62)");
    return;
  }

  // Initialize enhancedEscrowWallets if not exists
  if (!mod.state.enhancedEscrowWallets) {
    mod.state.enhancedEscrowWallets = new Map();
  }
  if (!mod.state.enhancedPaymentCounter) {
    mod.state.enhancedPaymentCounter = 0;
  }

  try {
    // Select investor
    const investorArray = Array.from(mod.state.registeredInvestors.values());
    console.log("\n📋 REGISTERED INVESTORS:");
    investorArray.forEach((inv, index) => {
      const displayName = inv.name || "Unknown";
      const displayAddress =
        inv.investorAddress || inv.user || inv.address || "Unknown";
      console.log(`${index}. ${displayName} (${displayAddress})`);
    });

    const invChoice = await mod.promptUser("\nSelect investor (number): ");
    const investor = investorArray[parseInt(invChoice)];

    if (!investor) {
      displayError("Invalid selection");
      return;
    }

    // Get the actual investor address
    const investorAddress =
      investor.investorAddress || investor.user || investor.address;

    // Get payer from normal users
    let payerAddress = null;
    let payerName = null;
    if (mod.state.normalUsers && mod.state.normalUsers.size > 0) {
      console.log("\n👤 SELECT PAYER (Normal User with KYC/AML):");
      const normalUsersArray = Array.from(
        mod.state.normalUsers.values(),
      ).filter((u) => u.tokenEligible);

      if (normalUsersArray.length === 0) {
        displayError("No compliant normal users found!");
        console.log("💡 Create a compliant user first (Option 24 → 1)");
        return;
      }

      normalUsersArray.forEach((user, index) => {
        console.log(
          `${index}. ${user.name} (${user.address.substring(0, 10)}...) ✅`,
        );
      });
      console.log(
        `${normalUsersArray.length}. Unknown Payer (Marketplace Mode)`,
      );

      const payerChoice = await mod.promptUser(
        `\nSelect payer (0-${normalUsersArray.length}): `,
      );
      const payerIndex = parseInt(payerChoice);

      if (payerIndex === normalUsersArray.length) {
        // Unknown payer (marketplace mode)
        payerAddress = ethers.ZeroAddress;
        payerName = "Unknown (Marketplace)";
      } else if (payerIndex >= 0 && payerIndex < normalUsersArray.length) {
        const selectedPayer = normalUsersArray[payerIndex];
        payerAddress = selectedPayer.address;
        payerName = selectedPayer.name;
      } else {
        displayError("Invalid selection");
        return;
      }
    } else {
      displayError("No normal users found!");
      console.log("💡 Create normal users first (Option 24)");
      return;
    }

    // Get payee from normal users
    let payeeAddress = null;
    let payeeName = null;
    if (mod.state.normalUsers && mod.state.normalUsers.size > 0) {
      console.log("\n👤 SELECT PAYEE (Normal User with KYC/AML):");
      const normalUsersArray = Array.from(
        mod.state.normalUsers.values(),
      ).filter((u) => u.tokenEligible);

      normalUsersArray.forEach((user, index) => {
        console.log(
          `${index}. ${user.name} (${user.address.substring(0, 10)}...) ✅`,
        );
      });

      const payeeChoice = await mod.promptUser(
        `\nSelect payee (0-${normalUsersArray.length - 1}): `,
      );
      const payeeIndex = parseInt(payeeChoice);

      if (payeeIndex >= 0 && payeeIndex < normalUsersArray.length) {
        const selectedPayee = normalUsersArray[payeeIndex];
        payeeAddress = selectedPayee.address;
        payeeName = selectedPayee.name;
      } else {
        displayError("Invalid selection");
        return;
      }
    }

    const amountInput = await mod.promptUser("\nEnter payment amount (VSC): ");
    const amount = ethers.parseEther(amountInput);

    console.log("\n📝 Creating escrow wallet...");
    console.log(`   Investor: ${investorAddress}`);
    console.log(
      `   Payer: ${payerName} (${payerAddress === ethers.ZeroAddress ? "Unknown" : payerAddress})`,
    );
    console.log(`   Payee: ${payeeName} (${payeeAddress})`);
    console.log(`   Amount: ${amountInput} VSC`);

    // Payer and payee are humans, never trusted. The factory refuses to
    // deploy a wallet unless both are verified, so onboard them first;
    // payments and refunds then pass the identity gate as investors.
    console.log("\n🔐 Checking payer and payee identities...");
    if (payerAddress !== ethers.ZeroAddress) {
      await mod._ensureVerified(payerAddress, "payer");
    }
    await mod._ensureVerified(payeeAddress, "payee");

    // Get investor signer
    const investorSigner = await mod.getSignerForAddress(investorAddress);

    const tx = await escrowFactory
      .connect(investorSigner)
      .createEscrowWallet(payerAddress, payeeAddress, amount);
    const receipt = await tx.wait();

    // Get payment ID from event
    const event = receipt.logs.find((log) => {
      try {
        return (
          escrowFactory.interface.parseLog(log).name === "EscrowWalletCreated"
        );
      } catch (e) {
        return false;
      }
    });

    if (event) {
      const parsedEvent = escrowFactory.interface.parseLog(event);
      const paymentId = parsedEvent.args.paymentId;
      const walletAddress = parsedEvent.args.walletAddress;

      // The factory trusted it in the same transaction (registrar, 4.3).
      const rules = mod.state.getContract("complianceRules");
      const vsc = await mod.state.getContract("digitalToken").getAddress();
      const trusted = await rules["isTrustedContract(address,address)"](
        vsc,
        walletAddress,
      );
      console.log(
        `   ${trusted ? "✅" : "❌"} Wallet trusted on VSC by the factory at creation`,
      );

      mod.state.enhancedEscrowWallets.set(paymentId.toString(), {
        paymentId: paymentId.toString(),
        walletAddress,
        payer: payerAddress,
        payee: payeeAddress,
        payerName: payerName,
        payeeName: payeeName,
        investor: investorAddress,
        amount: amountInput,
        createdAt: new Date().toISOString(),
        state: "Active",
      });

      mod.state.enhancedPaymentCounter++;

      displaySuccess("Escrow wallet created successfully!");
      console.log(`   Payment ID: ${paymentId}`);
      console.log(`   Wallet Address: ${walletAddress}`);
      console.log(`   Payer: ${payerName}`);
      console.log(`   Payee: ${payeeName}`);
      console.log(
        `   Investor Fee (3%): ${parseFloat(amountInput) * 0.03} VSC`,
      );
      console.log(`   Owner Fee (2%): ${parseFloat(amountInput) * 0.02} VSC`);
      console.log(`   Total Required: ${parseFloat(amountInput) * 1.05} VSC`);
    }
  } catch (error) {
    displayError(`Wallet creation failed: ${error.message}`);
  }
}

/** Option 64: Payer: Fund Escrow Wallet */
async function fundEscrowWallet(mod) {
  displaySection("PAYER: FUND ESCROW WALLET", "💰");

  const escrowFactory = mod.state.getContract("escrowFactory");
  if (!escrowFactory) {
    displayError(
      "Enhanced Escrow not deployed. Please deploy first (option 61)",
    );
    return;
  }

  if (
    !mod.state.enhancedEscrowWallets ||
    mod.state.enhancedEscrowWallets.size === 0
  ) {
    displayError(
      "No escrow wallets created. Please create one first (Option 63)",
    );
    return;
  }

  // List available wallets (only Active and not yet funded)
  console.log("\n📋 AVAILABLE ESCROW WALLETS:");
  const allWallets = Array.from(mod.state.enhancedEscrowWallets.values());
  const wallets = allWallets.filter(
    (w) => w.state === "Active" || w.state === "ProofSubmitted",
  );

  if (wallets.length === 0) {
    displayError("No active wallets available for funding");
    console.log("💡 All wallets are either funded, released, or refunded");
    return;
  }

  wallets.forEach((wallet, index) => {
    console.log(
      `${index}. Payment ID ${wallet.paymentId} - ${wallet.payerName || "Unknown Payer"} → ${wallet.payeeName} (${wallet.amount} VSC)`,
    );
  });

  const walletIndex = await mod.promptUser(
    "\nSelect wallet to fund (number): ",
  );
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
      selectedWallet.walletAddress || selectedWallet.address;

    if (!walletAddress) {
      displayError("Wallet address not found");
      console.log("💡 Wallet data:", selectedWallet);
      return;
    }

    const wallet = MultiSigEscrowWallet.attach(walletAddress);

    // Check if payer is set
    const payerSet = await wallet.payerSet();
    let payerAddress;

    if (!payerSet) {
      console.log("\n🛒 MARKETPLACE MODE: Payer unknown");
      console.log("First person to fund becomes the payer!");

      // List available signers
      console.log("\n📋 AVAILABLE SIGNERS:");
      mod.state.signers.slice(0, 10).forEach((signer, index) => {
        console.log(`${index}. ${signer.address}`);
      });

      const signerIndex = await mod.promptUser(
        "\nSelect signer to fund as payer (number): ",
      );
      const payer = mod.state.signers[parseInt(signerIndex)];
      payerAddress = payer.address;

      console.log(`\n📝 Funding as payer: ${payerAddress}`);
    } else {
      payerAddress = await wallet.payer();
      console.log(`\n📝 Payer: ${payerAddress}`);
    }

    const payer = await mod.getSignerForAddress(payerAddress);

    // Funding is once-only on chain. Check BEFORE approving: otherwise
    // the operator burns gas on an approval and then hits a raw revert
    // from the factory. A second funding used to silently succeed and
    // strand the extra tokens in the wallet forever.
    if (await wallet.funded()) {
      displayWarning(
        "This escrow is already funded - funding once is all it takes.",
      );
      console.log(
        `   Escrow balance: ${ethers.formatEther(await mod.state.getContract("digitalToken").balanceOf(walletAddress))} VSC`,
      );
      return;
    }

    const totalAmount = ethers.parseEther(
      (parseFloat(selectedWallet.amount) * 1.05).toString(),
    );

    // D26: the payer's per-transfer cap applies to the funding leg.
    // Explain a refusal BEFORE an approval is spent. This only explains:
    // the funding call stays the source of truth (a revert is caught).
    const digitalToken = mod.state.getContract("digitalToken");
    const fundTotal =
      (await wallet.amount()) +
      (await wallet.investorFee()) +
      (await wallet.ownerFee());
    if (
      !(await digitalToken.canTransfer(payerAddress, walletAddress, fundTotal))
    ) {
      console.log(
        `⛔ The token refuses payer -> escrow for ${ethers.formatEther(fundTotal)} VSC (expected, chain rule; nothing approved)`,
      );
      const types = mod.state.getContract("investorTypeRegistry");
      if (types && !(await types.canTransferAmount(payerAddress, fundTotal))) {
        const t = Number(await types.getInvestorType(payerAddress));
        const cap = (await types.getInvestorTypeConfig(t)).maxTransferAmount;
        const rate = await escrowFactory.TOTAL_FEE_RATE();
        const den = await escrowFactory.FEE_DENOMINATOR();
        const name = ["Normal", "Retail", "Accredited", "Institutional"][t];
        console.log(
          `   Reason: a ${name} payer may send at most ${ethers.formatEther(cap)} VSC per transfer`,
        );
        console.log(
          `   Largest escrow a ${name} payer can fund: about ${ethers.formatEther((cap * den) / (den + rate))} VSC (+${Number(rate) / 100}% fees)`,
        );
        console.log(
          "   Remedies: raise the payer's investor type (options 53/54), split the escrow into smaller ones, or exempt the payer (option 76, type 0, choice 2 after the handover)",
        );
      } else {
        console.log(
          "   Reason: not the investor-type cap; check the payer's KYC, country, freeze state and token pause",
        );
      }
      return;
    }

    console.log(`\n💰 Approving ${ethers.formatEther(totalAmount)} VSC...`);
    const approveTx = await digitalToken
      .connect(payer)
      .approve(await escrowFactory.getAddress(), totalAmount);
    await approveTx.wait();

    console.log("\n🔍 COMPLIANCE CHECK (trust is per token: VSC):");
    console.log(`   Payer: ${payerAddress}`);
    console.log(`   Wallet: ${walletAddress}`);

    const identityRegistry = mod.state.getContract("identityRegistry");
    const complianceRules = mod.state.getContract("complianceRules");

    const payerVerified = await identityRegistry.isVerified(payerAddress);
    console.log(`   Payer Verified: ${payerVerified}`);

    const walletTrusted = await complianceRules[
      "isTrustedContract(address,address)"
    ](mod.state.getContract("digitalToken").target, walletAddress);
    console.log(`   Wallet Trusted: ${walletTrusted}`);

    const payerCountry = await identityRegistry.investorCountry(payerAddress);
    console.log(`   Payer Country: ${payerCountry}`);

    const payerBalance = await digitalToken.balanceOf(payerAddress);
    console.log(`   Payer Balance: ${ethers.formatEther(payerBalance)} VSC`);
    console.log(`   Required: ${ethers.formatEther(totalAmount)} VSC`);

    if (payerBalance < totalAmount) {
      displayError("Insufficient balance!");
      console.log("💡 Use Option 25 to mint tokens to payer");
      return;
    }

    console.log("💸 Funding escrow wallet...");
    const fundTx = await escrowFactory
      .connect(payer)
      .fundEscrowWallet(selectedWallet.paymentId);
    await fundTx.wait();

    selectedWallet.state = "Funded";
    if (!payerSet) {
      selectedWallet.payer = payerAddress;
      selectedWallet.payerName = payerAddress; // Update with actual address
    }

    displaySuccess("Escrow wallet funded successfully!");
    console.log(`   Payment ID: ${selectedWallet.paymentId}`);
    console.log(`   Payer: ${payerAddress}`);
    console.log(`   Amount: ${ethers.formatEther(totalAmount)} VSC`);
  } catch (error) {
    displayError(`Funding failed: ${error.message}`);
  }
}

module.exports = { createEscrowWallet, fundEscrowWallet };
