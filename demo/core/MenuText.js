/**
 * @fileoverview The interactive menu's printed text
 * @module MenuText
 * @description Prints the main menu, line for line as MenuSystem printed it.
 * Moved out of demo/core/MenuSystem.js (plan v2 Task 4.8). Each
 * function takes the module instance `mod` first (its state, promptUser,
 * logger and sibling methods) and runs the option's code unchanged.
 */

"use strict";

/**
 * Display the main menu
 *
 * @private
 */
function displayMenu(mod) {
  console.log("\n🎮 INTERACTIVE MENU");
  console.log("=".repeat(70));
  console.log("");
  console.log("🏗️  === CORE SYSTEM ===");
  console.log("1.  Deploy All Contracts (core layer + privacy pair)");
  console.log(
    "1a. 🚀 ONE-CLICK: Deploy Everything (core + compliance + token + investor types + governance)",
  );
  console.log("");
  console.log("🆔 === ONCHAINID MANAGEMENT (Options 2-12) ===");
  console.log("2.  Create Management Keys");
  console.log("3.  Create OnchainID for User");
  console.log("4.  Review Identity Keys");
  console.log("5.  Recover Lost Keys (KeyManager recovery / rotation)");
  console.log(
    "5a. Remove a key with its holder's signature (removeKeyWithProof)",
  );
  console.log("6.  Manage KYC Claims");
  console.log("7.  Manage AML Claims");
  console.log("8.  Review Claim Status & History");
  console.log("9.  Create UTXO with KYC/AML Data");
  console.log("10. Verify UTXO Contains Compliance Data");
  console.log("11. Demo: KYC Claim Expiry (Short-Lived Claim)");
  console.log(
    "12. Key lifecycle: authorize + rotate + recover (KeyManager, wallet 1)",
  );
  console.log("12a. Toggle KeyManager authorization on wallet 1's identity");
  console.log("12b. Set wallet 1's identity rotation timelock (hours)");
  console.log("");
  console.log("⚖️  === COMPLIANCE RULES ENGINE (Options 13-20) ===");
  console.log("13. Deploy ComplianceRules Contract");
  console.log("14. Configure Jurisdiction Rules");
  console.log("15. Investor Type Limits (InvestorTypeRegistry)");
  console.log("16. Transfer Cooldowns (InvestorTypeRegistry)");
  console.log("17. Required Whitelist Tiers (InvestorTypeRegistry)");
  console.log("18. Test All Compliance Validations");
  console.log("19. Test Access Control");
  console.log("20. Show ComplianceRules Dashboard");
  console.log("20a. View Jurisdiction Rules (Whitelist/Blacklist)");
  console.log("20b. View Investor Type Limits");
  console.log("20c. View Transfer Cooldowns");
  console.log("20d. View Required Whitelist Tiers");
  console.log("");
  console.log("🏛️  === ERC-3643 DIGITAL TOKEN SYSTEM (Options 21-30) ===");
  console.log("21. Deploy ERC-3643 Vanguard StableCoin System");
  console.log("22. Create Token Issuer");
  console.log("23. INVESTOR ONBOARDING SYSTEM");
  console.log("24. Create Normal Users (OnchainID)");
  console.log("25. Token Issuer: Mint & Distribute ERC-3643 VSC");
  console.log("26. Investor-to-Investor Transfer");
  console.log("27. Investor-to-User Transfer");
  console.log("27.5 User-to-User Transfer");
  console.log("28. Demonstrate Transfer Restrictions");
  console.log("29. ERC-3643 Dashboard");
  console.log("30. Transaction Summary");
  console.log("");
  console.log("🔮 === ORACLE MANAGEMENT SYSTEM (Options 31-40) ===");
  console.log("31. Deploy Oracle Management System");
  console.log("32. Register & Configure Oracles");
  console.log("33. Manage Oracle Whitelist (Access Approval)");
  console.log("33a. Whitelist by consensus: query, 2 of 3 nodes, verdict");
  console.log("34. Manage Oracle Blacklist (Access Restriction)");
  console.log("34a. Blacklist by consensus: HIGH query, 2 of 3, verdict");
  console.log("35. Emergency Oracle Actions");
  console.log("35a. Oracle lifecycle: ops pauses, unpauses, designates");
  console.log("36. Oracle Reputation Management");
  console.log("37. Oracle Consensus Operations");
  console.log("38. Integrate Oracles with Vanguard StableCoin");
  console.log("39. Oracle System Dashboard");
  console.log("40. Test Complete Oracle Integration");
  console.log("");
  console.log("🔐 === PRIVACY & ZK VERIFICATION (Options 41-50) ===");
  console.log("🔐 Real ZK proofs only (PLONK, all five circuits)");
  console.log("");

  console.log(
    "41. Attach Privacy & ZK System (option 1 deploys it; prints the VSC wiring)",
  );
  console.log("41b. View ZK Status (verifier, circuits, generator)");
  console.log(
    "42. Submit Private Compliance Proofs (1 = whitelist live on VSC)",
  );
  console.log("43. Verify Private Whitelist Membership");
  console.log("44. Verify Private Jurisdiction Eligibility");
  console.log("45. Verify Private Accreditation Status");
  console.log("46. Privacy-Preserving Compliance Validation");
  console.log("47. Manage Privacy Settings");
  console.log("48. ZK Statistics & Analytics Dashboard");
  console.log("49. Test Complete Privacy Integration");
  console.log("50. Integrate Privacy with Vanguard StableCoin");
  console.log("");
  console.log("👥 === INVESTOR TYPE SYSTEM (Options 51-60) ===");
  console.log("51. Deploy Investor Type System");
  console.log("52. Show Investor Type Configurations");
  console.log("53. Assign Investor Types");
  console.log("54. Upgrade/Downgrade Investor Types");
  console.log("55. Test Transfer Limits by Type");
  console.log("56. Test Holding Limits by Type");
  console.log("57. Test Large Transfer Detection");
  console.log("58. Test Transfer Cooldowns");
  console.log("59. Run Complete Investor Type Tests");
  console.log("60. Investor Type System Dashboard");
  console.log("");
  console.log("💼 === ENHANCED ESCROW SYSTEM (Options 61-73) ===");
  console.log("61. Deploy Enhanced Escrow System");
  console.log("62. Register Investor (from Option 23)");
  console.log("63. Investor: Create Escrow Wallet");
  console.log("64. Payer: Fund Escrow Wallet");
  console.log("65. Payee: Submit Shipment Proof");
  console.log("66. Payer: Raise Dispute");
  console.log("67. Investor: Resolve Dispute");
  console.log("68. Payee: Sign Release");
  console.log("69. Investor: Sign Release");
  console.log("70. Investor: Manual Refund");
  console.log("70a. Sweep Stranded Tokens (settled escrow)");
  console.log("71. View Escrow Wallet Status");
  console.log("71a. View All Parties Balances");
  console.log("72. Enhanced Escrow Dashboard");
  console.log("73. Demo Complete Enhanced Escrow Workflow");
  console.log("");
  console.log("⏰ Escrow Time Travel:");
  console.log("73a. Time Travel (13 Days - Test Dispute Window)");
  console.log("73b. Time Travel (14 Days - Test Auto Settlement)");
  console.log("");
  console.log("🗳️  === GOVERNANCE SYSTEM (Options 74-83) ===");
  console.log("74. Deploy Governance System");
  console.log("75. Distribute Governance Tokens");
  console.log("75a. 🏭 Mint Governance Tokens (Owner Only)");
  console.log("75b. 🔥 Burn Governance Tokens (Owner Only)");
  console.log(
    "75c. ✅ Approve Governance Spending (Required for Proposals/Voting)",
  );
  console.log("76. Create Proposal");
  console.log("77. Vote on Proposal");
  console.log("78. Execute Proposal");
  console.log("78a. Claim Refund (from Rejected/Cancelled proposals)");
  console.log("79. Time Travel (Fast Forward 9 Days)");
  console.log("");
  console.log("📈 Governance Tools:");
  console.log("80. Governance Dashboard");
  console.log("81. Test Compliance Enforcement (VSC & VGT)");
  console.log("82. Demo Complete Governance Workflow");
  console.log("83. Manage InvestorTypeRegistry via Governance");
  console.log("83a. Change Governance Costs (Proposal & Voting)");
  console.log("83b. Governance Accepts Registry Ownership (by vote) 🏛️");
  console.log(
    "83c. Handover step 1: deployer grants ops/guardian, nominates governance",
  );
  console.log(
    "83d. Handover step 2: governance accepts ownership by vote (all nominated contracts)",
  );
  console.log("83e. Handover step 3: verify the deployer holds no power");
  console.log("");
  console.log("📋 === DYNAMIC LIST MANAGEMENT (Options 84-88) ===");
  console.log("84. Deploy Dynamic List Manager");
  console.log("85. Manage Whitelist/Blacklist Status");
  console.log("86. Create List Update Proposal");
  console.log("87. View User Status History");
  console.log("88. Demo Complete User Lifecycle (Whitelist ↔ Blacklist)");
  console.log("89. Quick Fix: Verify Existing Signer for Voting");
  console.log("");
  console.log("0.  ❌ Exit");
  console.log("");
}

module.exports = {
  displayMenu,
};
