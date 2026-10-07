/**
 * @fileoverview Governance options 75a-75c: mint, burn, approve VGT
 * @module GovernanceTokenFlow
 * @description The VGT owner's mint and burn, and a holder's fee allowance to
 * governance.
 * Moved out of demo/modules/GovernanceModule.js (plan v2 Task 4.8). Each
 * function takes the module instance `mod` first (its state, promptUser,
 * logger and sibling methods) and runs the option's code unchanged.
 */

"use strict";

const {
  displaySection,
  displaySuccess,
  displayError,
} = require("./DisplayHelpers");
const { ethers } = require("hardhat");

/** Option 75a: Mint Governance Tokens */
async function mintGovernanceTokens(mod) {
  displaySection("MINT GOVERNANCE TOKENS", "🏭");

  const governanceToken = mod.state.getContract("governanceToken");
  if (!governanceToken) {
    displayError("Deploy Governance Token first (option 74)");
    return;
  }

  try {
    const owner = mod.state.signers[0];
    const ownerBalance = await governanceToken.balanceOf(owner.address);
    const totalSupply = await governanceToken.totalSupply();

    console.log("\n📊 CURRENT TOKEN SUPPLY:");
    console.log(`   Total Supply: ${ethers.formatEther(totalSupply)} VGT`);
    console.log(`   Owner Balance: ${ethers.formatEther(ownerBalance)} VGT`);
    console.log("");
    console.log(
      "⚠️  IMPORTANT: Only the contract owner (agent) can mint tokens",
    );
    console.log("   Minting increases total supply and creates new tokens");
    console.log("");

    // Get recipient address
    const recipient = await mod.promptUser(
      "Enter recipient address (or signer index 0-9): ",
    );

    let recipientAddress;
    if (recipient.match(/^[0-9]$/)) {
      const index = parseInt(recipient);
      if (index >= mod.state.signers.length) {
        displayError("Invalid signer index");
        return;
      }
      recipientAddress = mod.state.signers[index].address;
      console.log(`   Selected: Signer ${index} (${recipientAddress})`);
    } else if (recipient.match(/^0x[a-fA-F0-9]{40}$/)) {
      recipientAddress = recipient;
    } else {
      displayError("Invalid address format");
      return;
    }

    // Check if recipient is verified
    const identityRegistry = mod.state.getContract("identityRegistry");
    const isVerified = await identityRegistry.isVerified(recipientAddress);

    console.log(`\n👤 Recipient: ${recipientAddress}`);
    console.log(
      `   KYC/AML Status: ${isVerified ? "✅ Verified" : "❌ Not Verified"}`,
    );

    if (!isVerified) {
      displayError("Recipient must be KYC/AML verified to receive VGT tokens");
      console.log(
        "\n💡 TIP: Use Option 6 (KYC claim) and Option 7 (AML claim) first",
      );
      return;
    }

    // Get amount to mint
    const amount = await mod.promptUser("\nEnter amount to mint (VGT): ");
    const amountWei = ethers.parseEther(amount);

    const recipientBalance = await governanceToken.balanceOf(recipientAddress);

    console.log("\n📋 MINT SUMMARY:");
    console.log("=".repeat(70));
    console.log(`   Recipient: ${recipientAddress}`);
    console.log(
      `   Current Balance: ${ethers.formatEther(recipientBalance)} VGT`,
    );
    console.log(`   Amount to Mint: ${amount} VGT`);
    console.log(
      `   New Balance: ${ethers.formatEther(recipientBalance + amountWei)} VGT`,
    );
    console.log(
      `   New Total Supply: ${ethers.formatEther(totalSupply + amountWei)} VGT`,
    );

    const confirm = await mod.promptUser("\nProceed with minting? (y/n): ");
    if (confirm.toLowerCase() !== "y") {
      displayError("Minting cancelled");
      return;
    }

    // Mint tokens (only owner/agent can call this)
    const tx = await governanceToken.mint(recipientAddress, amountWei);
    await tx.wait();

    const newBalance = await governanceToken.balanceOf(recipientAddress);
    const newTotalSupply = await governanceToken.totalSupply();

    displaySuccess("TOKENS MINTED SUCCESSFULLY!");
    console.log(`   Recipient: ${recipientAddress}`);
    console.log(`   Amount Minted: ${amount} VGT`);
    console.log(`   New Balance: ${ethers.formatEther(newBalance)} VGT`);
    console.log(
      `   New Total Supply: ${ethers.formatEther(newTotalSupply)} VGT`,
    );
    console.log(`   Transaction: ${tx.hash}`);
  } catch (error) {
    displayError(`Minting failed: ${error.message}`);
    if (error.message.includes("onlyAgent")) {
      console.log(
        "\n💡 TIP: Only the contract owner (signer 0) can mint tokens",
      );
    } else if (error.message.includes("Identity not verified")) {
      console.log("\n💡 TIP: Recipient must be KYC/AML verified");
    }
  }
}

/** Option 75b: Burn Governance Tokens */
async function burnGovernanceTokens(mod) {
  displaySection("BURN GOVERNANCE TOKENS", "🔥");

  const governanceToken = mod.state.getContract("governanceToken");
  if (!governanceToken) {
    displayError("Deploy Governance Token first (option 74)");
    return;
  }

  try {
    const owner = mod.state.signers[0];
    const ownerBalance = await governanceToken.balanceOf(owner.address);
    const totalSupply = await governanceToken.totalSupply();

    console.log("\n📊 CURRENT TOKEN SUPPLY:");
    console.log(`   Total Supply: ${ethers.formatEther(totalSupply)} VGT`);
    console.log(`   Owner Balance: ${ethers.formatEther(ownerBalance)} VGT`);
    console.log("");
    console.log("⚠️  IMPORTANT: Burning permanently destroys tokens");
    console.log("   This reduces total supply and cannot be undone");
    console.log(
      "   Only the contract owner (agent) can burn tokens from their balance",
    );
    console.log("");

    if (ownerBalance === 0n) {
      displayError("Owner has no VGT tokens to burn");
      return;
    }

    // Get amount to burn
    const amount = await mod.promptUser(
      `Enter amount to burn (max: ${ethers.formatEther(ownerBalance)} VGT): `,
    );
    const amountWei = ethers.parseEther(amount);

    if (amountWei > ownerBalance) {
      displayError(
        `Insufficient balance. You have ${ethers.formatEther(ownerBalance)} VGT`,
      );
      return;
    }

    console.log("\n📋 BURN SUMMARY:");
    console.log("=".repeat(70));
    console.log(`   Current Balance: ${ethers.formatEther(ownerBalance)} VGT`);
    console.log(`   Amount to Burn: ${amount} VGT`);
    console.log(
      `   New Balance: ${ethers.formatEther(ownerBalance - amountWei)} VGT`,
    );
    console.log(
      `   Current Total Supply: ${ethers.formatEther(totalSupply)} VGT`,
    );
    console.log(
      `   New Total Supply: ${ethers.formatEther(totalSupply - amountWei)} VGT`,
    );
    console.log("");
    console.log("⚠️  WARNING: This action is PERMANENT and IRREVERSIBLE!");

    const confirm = await mod.promptUser(
      "\nAre you sure you want to burn these tokens? (yes/no): ",
    );
    if (confirm.toLowerCase() !== "yes") {
      displayError("Burning cancelled");
      return;
    }

    // Burn tokens (only owner/agent can call this)
    const tx = await governanceToken.burn(amountWei);
    await tx.wait();

    const newBalance = await governanceToken.balanceOf(owner.address);
    const newTotalSupply = await governanceToken.totalSupply();

    displaySuccess("TOKENS BURNED SUCCESSFULLY!");
    console.log(`   Amount Burned: ${amount} VGT 🔥`);
    console.log(`   New Balance: ${ethers.formatEther(newBalance)} VGT`);
    console.log(
      `   New Total Supply: ${ethers.formatEther(newTotalSupply)} VGT`,
    );
    console.log(`   Tokens Destroyed: PERMANENT`);
    console.log(`   Transaction: ${tx.hash}`);
  } catch (error) {
    displayError(`Burning failed: ${error.message}`);
    if (error.message.includes("onlyAgent")) {
      console.log(
        "\n💡 TIP: Only the contract owner (signer 0) can burn tokens",
      );
    }
  }
}

/** Option 75c: Approve Governance Contract to Spend VGT */
async function approveGovernanceSpending(mod) {
  displaySection("APPROVE GOVERNANCE CONTRACT TO SPEND VGT", "✅");

  const governanceToken = mod.state.getContract("governanceToken");
  const vanguardGovernance = mod.state.getContract("vanguardGovernance");

  if (!governanceToken || !vanguardGovernance) {
    displayError("Deploy Governance Token first (option 74)");
    return;
  }

  try {
    const owner = mod.state.signers[0];
    const ownerBalance = await governanceToken.balanceOf(owner.address);
    const governanceAddress = await vanguardGovernance.getAddress();
    const currentAllowance = await governanceToken.allowance(
      owner.address,
      governanceAddress,
    );

    console.log("\n📊 CURRENT STATUS:");
    console.log(`   Your VGT Balance: ${ethers.formatEther(ownerBalance)} VGT`);
    console.log(
      `   Current Allowance: ${ethers.formatEther(currentAllowance)} VGT`,
    );
    console.log(`   Governance Contract: ${governanceAddress}`);
    console.log("");
    console.log("💡 WHAT IS APPROVAL?");
    console.log(
      "   Approval allows the Governance contract to spend your VGT tokens",
    );
    console.log("   This is required for:");
    console.log("   • Creating proposals (costs VGT)");
    console.log("   • Voting on proposals (costs VGT)");
    console.log("");

    const proposalCost = await vanguardGovernance.proposalCreationCost();
    const votingCost = await vanguardGovernance.votingCost();

    console.log("📋 GOVERNANCE COSTS:");
    console.log(
      `   Proposal Creation: ${ethers.formatEther(proposalCost)} VGT`,
    );
    console.log(`   Voting: ${ethers.formatEther(votingCost)} VGT per vote`);
    console.log("");

    // Suggest approval amount
    const suggestedAmount = proposalCost * 10n + votingCost * 100n; // 10 proposals + 100 votes
    console.log("💡 SUGGESTED APPROVAL AMOUNTS:");
    console.log(
      `   Minimum (1 proposal + 1 vote): ${ethers.formatEther(proposalCost + votingCost)} VGT`,
    );
    console.log(
      `   Recommended (10 proposals + 100 votes): ${ethers.formatEther(suggestedAmount)} VGT`,
    );
    console.log(`   Maximum (unlimited): Enter "max" for unlimited approval`);
    console.log("");

    const amount = await mod.promptUser(
      'Enter approval amount (VGT) or "max": ',
    );

    let approvalAmount;
    if (amount.toLowerCase() === "max") {
      approvalAmount = ethers.MaxUint256;
      console.log("   Setting UNLIMITED approval (MaxUint256)");
    } else {
      approvalAmount = ethers.parseEther(amount);
      if (approvalAmount > ownerBalance) {
        console.log(
          `   ⚠️  Warning: Approval amount (${amount}) exceeds your balance (${ethers.formatEther(ownerBalance)})`,
        );
        console.log("   This is OK - you can approve more than you have");
      }
    }

    console.log("\n📋 APPROVAL SUMMARY:");
    console.log("=".repeat(70));
    console.log(`   Spender: VanguardGovernance (${governanceAddress})`);
    console.log(
      `   Current Allowance: ${ethers.formatEther(currentAllowance)} VGT`,
    );
    console.log(
      `   New Allowance: ${amount.toLowerCase() === "max" ? "UNLIMITED" : amount + " VGT"}`,
    );

    const confirm = await mod.promptUser("\nProceed with approval? (y/n): ");
    if (confirm.toLowerCase() !== "y") {
      displayError("Approval cancelled");
      return;
    }

    const tx = await governanceToken.approve(governanceAddress, approvalAmount);
    await tx.wait();

    const newAllowance = await governanceToken.allowance(
      owner.address,
      governanceAddress,
    );

    displaySuccess("APPROVAL SUCCESSFUL!");
    console.log(`   Spender: ${governanceAddress}`);
    console.log(
      `   New Allowance: ${amount.toLowerCase() === "max" ? "UNLIMITED" : ethers.formatEther(newAllowance) + " VGT"}`,
    );
    console.log(`   Transaction: ${tx.hash}`);
    console.log("");
    console.log("✅ You can now:");
    console.log("   • Create proposals (Option 76)");
    console.log("   • Vote on proposals (Option 77)");
  } catch (error) {
    displayError(`Approval failed: ${error.message}`);
  }
}

module.exports = {
  mintGovernanceTokens,
  burnGovernanceTokens,
  approveGovernanceSpending,
};
