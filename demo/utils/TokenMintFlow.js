/**
 * @fileoverview Token option 25 -> 1, 5: mint to the central bank
 * @module TokenMintFlow
 * @description The mint menu, minting to the treasury with its refusals explained,
 * and the treasury balance.
 * Moved out of demo/modules/TokenModule.js (plan v2 Task 4.8). Each
 * function takes the module instance `mod` first (its state, promptUser,
 * logger and sibling methods) and runs the option's code unchanged.
 */

const { attestAll } = require("./Kyc");
const { whitelistHints } = require("./WhitelistLiveFlow");
const { ethers } = require("hardhat");

/** Option 25: Mint and Distribute Tokens */
async function mintAndDistributeTokens(mod) {
  console.log("\n🪙 TOKEN ISSUER: MINT & DISTRIBUTE ERC-3643 VSC");
  console.log("=".repeat(60));

  const centralBank = Array.from(mod.state.bankingInstitutions.values()).find(
    (bank) => bank.type === "CENTRAL_BANK",
  );
  if (!centralBank) {
    console.log("❌ Token Issuer not found. Create it first (option 22)");
    return;
  }

  console.log("\n🎯 MINT & DISTRIBUTION OPTIONS:");
  console.log("1. 🏦 Mint Tokens to Central Bank");
  console.log("2. 💸 Distribute to All Approved Investors");
  console.log("3. 💸 Distribute to Specific Investor");
  console.log("4. 📊 Show Distribution Rules");
  console.log("5. 📈 View Central Bank Balance");
  console.log("0. Back");

  const choice = await mod.promptUser("Select option (0-5): ");

  try {
    switch (choice) {
      case "1":
        await mod.mintToCentralBank(centralBank);
        break;
      case "2":
        await mod.distributeToAllApprovedFromMenu(centralBank);
        break;
      case "3":
        await mod.distributeToSpecificInvestorFromMenu(centralBank);
        break;
      case "4":
        await mod.showDistributionRules();
        break;
      case "5":
        await mod.viewCentralBankBalance(centralBank);
        break;
      case "0":
        return;
      default:
        console.log("❌ Invalid choice");
    }
  } catch (error) {
    console.error("❌ Operation failed:", error.message);
  }
}

/**
 * Mint tokens to Central Bank
 * @private
 */
async function mintToCentralBank(mod, centralBank) {
  console.log("\n🏦 MINT TOKENS TO CENTRAL BANK");
  console.log("=".repeat(60));

  const digitalToken = mod.state.getContract("digitalToken");
  if (!digitalToken) {
    console.log("❌ Digital Token not deployed!");
    console.log("💡 Deploy Digital Token system first (Option 21)");
    return;
  }

  console.log(`\n🏦 Central Bank: ${centralBank.name}`);
  console.log(`🆔 Address: ${centralBank.address}`);

  // Verify Central Bank is registered in IdentityRegistry
  try {
    const identityRegistry = mod.state.getContract("identityRegistry");
    const isVerified = await identityRegistry.isVerified(centralBank.address);

    if (!isVerified) {
      console.log(
        "\n⚠️  WARNING: Central Bank is not verified in IdentityRegistry!",
      );
      console.log("💡 Attempting to re-register Central Bank...");

      // Try to re-register the Central Bank
      try {
        // Get country code from stored data or use default
        const countryCode = centralBank.countryCode || 840;

        console.log(`\n📝 Re-registering Central Bank...`);
        console.log(`   Address: ${centralBank.address}`);
        console.log(`   OnchainID: ${centralBank.onchainId}`);
        console.log(`   Country Code: ${countryCode}`);

        try {
          const tx = await identityRegistry.registerIdentity(
            centralBank.address,
            centralBank.onchainId,
            countryCode,
          );
          await tx.wait();
        } catch (registerError) {
          // Already registered is fine here — the wallet may be
          // missing only the KYC claim below, not the registration.
          if (!/already registered/i.test(registerError.message)) {
            throw registerError;
          }
        }

        // Registration alone no longer verifies: attest the
        // required KYC and AML claims through the trusted ClaimIssuers.
        console.log(`\n📝 Attesting Central Bank KYC/AML claims...`);
        await attestAll(
          mod.state,
          centralBank.onchainId,
          "central-bank-repair",
        );

        // Verify again
        const nowVerified = await identityRegistry.isVerified(
          centralBank.address,
        );
        if (nowVerified) {
          console.log(`✅ Central Bank re-registered successfully!`);
        } else {
          console.log("\n❌ ERROR: Re-registration failed!");
          console.log(
            "💡 Please try creating the Central Bank again (Option 22)",
          );
          return;
        }
      } catch (reregError) {
        console.log("\n❌ ERROR: Failed to re-register Central Bank!");
        console.log(`   Error: ${reregError.message}`);
        console.log(
          "💡 Please try creating the Central Bank again (Option 22)",
        );
        console.log("\n🔍 Debug Info:");
        console.log(`   Central Bank Address: ${centralBank.address}`);
        console.log(`   OnchainID: ${centralBank.onchainId}`);
        console.log(`   Verified: ${isVerified}`);
        return;
      }
    } else {
      console.log(`✅ Central Bank Verification: VERIFIED`);
    }
  } catch (error) {
    console.log("\n❌ ERROR: Failed to verify Central Bank identity!");
    console.log(`   Error: ${error.message}`);
    console.log(
      "💡 Please ensure the Central Bank was created properly (Option 22)",
    );
    return;
  }

  // Get current balance
  const currentBalance = await digitalToken.balanceOf(centralBank.address);
  console.log(`💰 Current Balance: ${ethers.formatEther(currentBalance)} VSC`);

  console.log("\n💡 Suggested amounts:");
  console.log("   1. 1,000,000 VSC (Small scale)");
  console.log("   2. 10,000,000 VSC (Medium scale)");
  console.log("   3. 100,000,000 VSC (Large scale)");
  console.log("   4. Custom amount");

  const choice = await mod.promptUser("Select amount (1-4): ");

  let mintAmount;
  switch (choice) {
    case "1":
      mintAmount = "1000000";
      break;
    case "2":
      mintAmount = "10000000";
      break;
    case "3":
      mintAmount = "100000000";
      break;
    case "4":
      const customAmount = await mod.promptUser("Enter amount (in VSC): ");
      mintAmount = customAmount.replace(/,/g, "");
      break;
    default:
      console.log("❌ Invalid choice");
      return;
  }

  // Continue in next chunk due to 150-line limit...
  await mod.completeMintToCentralBank(centralBank, digitalToken, mintAmount);
}

/**
 * Pre-check a mint with the token's own predicate (2E.3: mint and
 * canTransfer(0, to, amount) share one path). Returns null when the mint
 * would succeed, else a reason built from the investor-type registry.
 * @private
 */
async function _mintRefusal(mod, digitalToken, to, amountWei) {
  if (await digitalToken.canTransfer(ethers.ZeroAddress, to, amountWei))
    return null;
  // Same order as Token._checkTransfer: pause first (mint is whenNotPaused).
  if (await digitalToken.paused()) return "token paused";
  if (await digitalToken.isFrozen(to)) return "recipient frozen";
  const identityRegistry = mod.state.getContract("identityRegistry");
  if (!(await identityRegistry.isVerified(to))) return "not verified";
  // The registry the token enforces, not the one demo state remembers
  // (state only when the token ABI has no getter).
  let registry = mod.state.getContract("investorTypeRegistry");
  if (typeof digitalToken.investorTypeRegistry === "function") {
    const a = await digitalToken.investorTypeRegistry();
    registry =
      a === ethers.ZeroAddress
        ? null
        : await ethers.getContractAt("InvestorTypeRegistry", a);
  }
  const balance = await digitalToken.balanceOf(to);
  if (!registry || (await registry.canHoldAmount(to, balance + amountWei))) {
    // Task 3.6: after option 42 -> 1 VSC's allow list may be the cause.
    const [hint] = await whitelistHints(mod.state, [to]);
    return hint || "compliance refused (jurisdiction or blacklist)";
  }
  const type = await registry.getInvestorType(to);
  const cap = (await registry.getInvestorTypeConfig(type)).maxHoldingAmount;
  const names = ["Normal", "Retail", "Accredited", "Institutional"];
  return (
    `holding cap: type ${names[Number(type)] ?? type}, ` +
    `cap ${ethers.formatEther(cap)} VSC, balance ${ethers.formatEther(balance)} VSC, ` +
    `mint ${ethers.formatEther(amountWei)} VSC`
  );
}

/**
 * D22 (a): the central bank is a treasury, not an investor. Mint enforces
 * investor-type holding caps (2E.3), so mark it exempt on the registry
 * (logged on-chain). No-op without a registry or when already exempt.
 * Owner only (D22): the deployer before the handover, governance after.
 * @private
 */
async function _ensureTreasuryExempt(mod, centralBank) {
  const registry = mod.state.getContract("investorTypeRegistry");
  if (!registry || (await registry.investorLimitExempt(centralBank.address)))
    return;
  if ((await registry.owner()) !== (await registry.runner.getAddress())) {
    console.log(
      "   central bank not exempt: after the handover only governance can exempt a treasury (InvestorTypeConfig vote)",
    );
    return;
  }
  await (
    await registry.setInvestorLimitExempt(centralBank.address, true)
  ).wait();
  console.log("   central bank exempt from investor limits (treasury, D22)");
}

/**
 * Complete minting to Central Bank (part 2)
 * @private
 */
async function completeMintToCentralBank(
  mod,
  centralBank,
  digitalToken,
  mintAmount,
) {
  try {
    await mod._ensureTreasuryExempt(centralBank);
    console.log(
      `\n🪙 Minting ${Number(mintAmount).toLocaleString()} VSC to Central Bank...`,
    );

    const tx = await digitalToken
      .connect(centralBank.signer)
      .mint(centralBank.address, ethers.parseEther(mintAmount));
    const receipt = await tx.wait();

    const newBalance = await digitalToken.balanceOf(centralBank.address);

    console.log(`\n✅ TOKENS MINTED SUCCESSFULLY!`);
    console.log("=".repeat(60));
    console.log(`💰 Amount Minted: ${Number(mintAmount).toLocaleString()} VSC`);
    console.log(`🏦 Recipient: Central Bank`);
    console.log(`📊 New Balance: ${ethers.formatEther(newBalance)} VSC`);
    console.log(`⛽ Gas Used: ${receipt.gasUsed.toLocaleString()}`);
    console.log(`📝 Transaction Hash: ${receipt.hash}`);
    console.log("");
    console.log("🎯 NEXT STEPS:");
    console.log(
      "   - Use Option 23 → Sub-option 3 to transfer tokens to users",
    );
    console.log(
      "   - Or use Option 25 → Sub-option 2/3 to distribute to investors",
    );
  } catch (error) {
    console.error("❌ Minting failed:", error.message);
    if (error.message.includes("AccessControl")) {
      console.log("💡 Make sure Central Bank has minting authority");
    }
  }
}

/**
 * View Central Bank balance
 * @private
 */
async function viewCentralBankBalance(mod, centralBank) {
  console.log("\n📈 CENTRAL BANK BALANCE");
  console.log("=".repeat(60));

  const digitalToken = mod.state.getContract("digitalToken");
  if (!digitalToken) {
    console.log("❌ Digital Token not deployed!");
    return;
  }

  const balance = await digitalToken.balanceOf(centralBank.address);
  const totalSupply = await digitalToken.totalSupply();

  console.log(`🏦 Central Bank: ${centralBank.name}`);
  console.log(`🆔 Address: ${centralBank.address}`);
  console.log(`💰 Balance: ${ethers.formatEther(balance)} VSC`);
  console.log(`📊 Total Supply: ${ethers.formatEther(totalSupply)} VSC`);
  console.log(
    `📈 Percentage: ${((Number(balance) / Number(totalSupply)) * 100).toFixed(2)}%`,
  );
}

module.exports = {
  mintAndDistributeTokens,
  mintToCentralBank,
  _mintRefusal,
  _ensureTreasuryExempt,
  completeMintToCentralBank,
  viewCentralBankBalance,
};
