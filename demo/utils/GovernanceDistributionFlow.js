/**
 * @fileoverview Governance option 75: distribute VGT
 * @module GovernanceDistributionFlow
 * @description Distributes VGT to investors, to listed addresses or in equal amounts.
 * Moved out of demo/modules/GovernanceModule.js (plan v2 Task 4.8). Each
 * function takes the module instance `mod` first (its state, promptUser,
 * logger and sibling methods) and runs the option's code unchanged.
 */

const {
  displaySection,
  displaySuccess,
  displayError,
} = require("./DisplayHelpers");
const { ethers } = require("hardhat");

/** Option 75: Distribute Governance Tokens */
async function distributeGovernanceTokens(mod) {
  displaySection("DISTRIBUTE GOVERNANCE TOKENS", "📊");

  const governanceToken = mod.state.getContract("governanceToken");
  if (!governanceToken) {
    displayError("Deploy Governance Token first (option 74)");
    return;
  }

  try {
    console.log("\n👥 DISTRIBUTION OPTIONS:");
    console.log("1. Distribute to Selected Investors (Choose from list)");
    console.log("2. Distribute to Specific Addresses (Manual entry)");
    console.log("3. Distribute Equal Amounts (Auto to first N signers)");
    console.log("0. Back");

    const choice = await mod.promptUser("Select option (0-3): ");

    if (choice === "0") return;

    if (choice === "1") {
      await mod._distributeToSelectedInvestors();
    } else if (choice === "2") {
      await mod._distributeToSpecificAddresses();
    } else if (choice === "3") {
      await mod._distributeEqualAmounts();
    }
  } catch (error) {
    displayError(`Distribution failed: ${error.message}`);
  }
}

/**
 * Helper: Distribute to selected investors
 * @private
 */
async function _distributeToSelectedInvestors(mod) {
  console.log("\n👥 DISTRIBUTE TO SELECTED INVESTORS");
  console.log("=".repeat(60));

  const governanceToken = mod.state.getContract("governanceToken");
  const identityRegistry = mod.state.getContract("identityRegistry");

  // Get investors from state
  const investors = mod.state.investors || new Map();

  if (investors.size === 0) {
    displayError(
      "No investors found. Create investors first using Option 23 (Investor Onboarding)",
    );
    console.log(
      "\n💡 TIP: Use Option 23 to create investors before distributing governance tokens",
    );
    return;
  }

  // Show available investors with their verification status
  console.log("\n📋 AVAILABLE INVESTORS:");
  const availableInvestors = [];
  let index = 0;

  for (const [address, investorData] of investors) {
    let status = "❓ Unknown";

    // Check if verified
    if (identityRegistry) {
      try {
        const isVerified = await identityRegistry.isVerified(address);
        status = isVerified ? "✅ Verified" : "❌ Not Verified";
      } catch (error) {
        status = "⚠️ Error checking";
      }
    }

    // Check current VGT balance
    let balance = "0";
    if (governanceToken) {
      try {
        const bal = await governanceToken.balanceOf(address);
        balance = ethers.formatEther(bal);
      } catch (error) {
        balance = "Error";
      }
    }

    console.log(`${index}. ${address}`);
    console.log(
      `   Type: ${investorData.type || "Unknown"} | Status: ${status} | Current VGT: ${balance}`,
    );
    availableInvestors.push({ index, address, data: investorData });
    index++;
  }

  console.log("\n💡 Enter investor numbers to distribute to (comma-separated)");
  console.log("   Example: 0,1,2 to distribute to investors 0, 1, and 2");

  const selection = await mod.promptUser("Select investors: ");
  const selectedIndices = selection.split(",").map((s) => parseInt(s.trim()));

  // Validate selections
  const validInvestors = availableInvestors.filter((inv) =>
    selectedIndices.includes(inv.index),
  );
  if (validInvestors.length === 0) {
    displayError("No valid investors selected");
    return;
  }

  const amount = await mod.promptUser("Enter amount per investor (VGT): ");
  const amountWei = ethers.parseEther(amount);

  console.log("\n🔗 DISTRIBUTING GOVERNANCE TOKENS...");

  const recipients = [];
  const amounts = [];

  for (const investor of validInvestors) {
    recipients.push(investor.address);
    amounts.push(amountWei);
  }

  console.log(`\n📊 Distribution Summary:`);
  for (let i = 0; i < validInvestors.length; i++) {
    const investor = validInvestors[i];
    console.log(
      `   ${i + 1}. ${investor.address} (${investor.data.type || "Unknown"}) → ${amount} VGT`,
    );
  }

  const confirm = await mod.promptUser("\nConfirm distribution? (y/n): ");
  if (confirm.toLowerCase() !== "y") {
    displayError("Distribution cancelled");
    return;
  }

  const tx = await governanceToken.distributeGovernanceTokens(
    recipients,
    amounts,
  );
  await tx.wait();

  displaySuccess("DISTRIBUTION COMPLETE!");
  console.log(
    `   Distributed ${amount} VGT to ${recipients.length} selected investors`,
  );
  console.log(`   Transaction: ${tx.hash}`);
}

/**
 * Helper: Distribute to specific addresses
 * @private
 */
async function _distributeToSpecificAddresses(mod) {
  const governanceToken = mod.state.getContract("governanceToken");

  const addresses = await mod.promptUser("Enter addresses (comma-separated): ");
  const amounts = await mod.promptUser(
    "Enter amounts (comma-separated, in VGT): ",
  );

  const addressArray = addresses.split(",").map((a) => a.trim());
  const amountArray = amounts
    .split(",")
    .map((a) => ethers.parseEther(a.trim()));

  const tx = await governanceToken.distributeGovernanceTokens(
    addressArray,
    amountArray,
  );
  await tx.wait();

  displaySuccess(
    `Distributed governance tokens to ${addressArray.length} addresses`,
  );
}

/**
 * Helper: Distribute equal amounts
 * @private
 */
async function _distributeEqualAmounts(mod) {
  const governanceToken = mod.state.getContract("governanceToken");

  const count = await mod.promptUser("Number of recipients: ");
  const amount = await mod.promptUser("Amount per recipient (VGT): ");
  const amountWei = ethers.parseEther(amount);

  const recipients = [];
  const amounts = [];

  for (let i = 1; i <= parseInt(count); i++) {
    recipients.push(mod.state.signers[i].address);
    amounts.push(amountWei);
  }

  const tx = await governanceToken.distributeGovernanceTokens(
    recipients,
    amounts,
  );
  await tx.wait();

  displaySuccess(`Distributed ${amount} VGT to ${count} recipients`);
}

module.exports = {
  distributeGovernanceTokens,
  _distributeToSelectedInvestors,
  _distributeToSpecificAddresses,
  _distributeEqualAmounts,
};
