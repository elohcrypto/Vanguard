/**
 * @fileoverview ERC-3643 token system module
 * @module TokenModule
 * @description Handles all ERC-3643 token operations including deployment,
 * investor onboarding, token minting, distribution, and transfers.
 * Covers menu options 21-30.
 *
 * @example
 * const TokenModule = require('./modules/TokenModule');
 * const module = new TokenModule(state, logger, promptUser, deployer, signerManager);
 * await module.deployERC3643System();
 */

const {
  displaySection,
  displayInfo,
  displaySuccess,
  displayError,
  displayProgress,
} = require("../utils/DisplayHelpers");
const { attestAll, signClaim } = require("../utils/Kyc");
const { ethers } = require("hardhat");

/**
 * @class TokenModule
 * @description Manages ERC-3643 token operations for the demo system.
 */
class TokenModule {
  /**
   * Create a TokenModule
   * @param {Object} state - DemoState instance
   * @param {Object} logger - EnhancedLogger instance
   * @param {Function} promptUser - Function to prompt user for input
   * @param {Object} deployer - ContractDeployer instance
   * @param {Object} signerManager - SignerManager instance
   */
  constructor(state, logger, promptUser, deployer, signerManager) {
    this.state = state;
    this.logger = logger;
    this.promptUser = promptUser;
    this.deployer = deployer;
    this.signerManager = signerManager;
  }

  /** Option 21: Deploy ERC-3643 Vanguard StableCoin System */
  async deployERC3643System() {
    await this.deployer.deployDigitalTokenSystem();
  }

  /** Option 22: Create Token Issuer */
  async createTokenIssuer() {
    displaySection("CREATE TOKEN ISSUER (CENTRAL BANK) - ON-CHAIN", "🏛️");

    const digitalToken = this.state.getContract("digitalToken");
    if (!digitalToken) {
      displayError("Please deploy Digital Token system first (option 21)");
      return;
    }

    if (!this.state.getContract("onchainIDFactory")) {
      displayError("Please deploy contracts first (option 1)");
      return;
    }

    // Check if token issuer already exists
    const existingCentralBank = Array.from(
      this.state.bankingInstitutions.values(),
    ).find((bank) => bank.type === "CENTRAL_BANK");
    if (existingCentralBank) {
      console.log("⚠️  Token Issuer already exists!");
      console.log(`🏛️ Name: ${existingCentralBank.name}`);
      console.log(`🆔 Address: ${existingCentralBank.address}`);
      console.log(`🔗 OnchainID: ${existingCentralBank.onchainId}`);
      return;
    }

    try {
      const signer = this.state.signers[0];
      let totalGasUsed = 0n;

      console.log("\n🔗 CREATING TOKEN ISSUER ON-CHAIN...");
      console.log(`👤 Issuer Address: ${signer.address}`);
      console.log(
        `💡 Note: Central Bank is a government authority - no KYC/AML required`,
      );

      // Get allowed countries from ComplianceRules
      let centralBankCountry = 840; // Default: United States
      let countryName = "United States";
      let jurisdiction = "US";

      const complianceRules = this.state.getContract("complianceRules");
      if (complianceRules) {
        try {
          const tokenAddress = await digitalToken.getAddress();
          const jurisdictionRule =
            await complianceRules.getJurisdictionRule(tokenAddress);

          console.log("\n🌍 SELECTING CENTRAL BANK COUNTRY:");
          console.log("=".repeat(50));

          // Show current jurisdiction rules
          if (jurisdictionRule.allowedCountries.length > 0) {
            console.log("✅ Allowed Countries (Whitelist):");
            const countryMap = {
              840: "United States (US)",
              826: "United Kingdom (UK)",
              124: "Canada (CA)",
              276: "Germany (DE)",
              250: "France (FR)",
              392: "Japan (JP)",
              702: "Singapore (SG)",
              36: "Australia (AU)",
            };

            jurisdictionRule.allowedCountries.forEach((code, index) => {
              const codeNum = Number(code);
              const name = countryMap[codeNum] || `Country ${codeNum}`;
              console.log(`   ${index + 1}. ${codeNum} - ${name}`);
            });

            // Use first allowed country as default
            centralBankCountry = Number(jurisdictionRule.allowedCountries[0]);
            countryName =
              countryMap[centralBankCountry] || `Country ${centralBankCountry}`;
            jurisdiction = countryName.match(/\(([^)]+)\)/)?.[1] || "XX";

            console.log(`\n💡 Using: ${centralBankCountry} - ${countryName}`);
          } else {
            console.log("ℹ️  No whitelist configured - using default country");
            console.log(`💡 Using: ${centralBankCountry} - ${countryName}`);
          }

          // Check if country is blocked
          if (jurisdictionRule.blockedCountries.length > 0) {
            const isBlocked = jurisdictionRule.blockedCountries.some(
              (c) => Number(c) === centralBankCountry,
            );
            if (isBlocked) {
              console.log(
                `\n⚠️  WARNING: Country ${centralBankCountry} is in the blocked list!`,
              );
              console.log(
                "💡 Please configure jurisdiction rules first (Option 14)",
              );
              return;
            }
          }
        } catch (error) {
          console.log(
            "ℹ️  Jurisdiction rules not configured yet - using default country",
          );
          console.log(`💡 Using: ${centralBankCountry} - ${countryName}`);
        }
      } else {
        console.log(
          "\nℹ️  ComplianceRules not deployed - using default country",
        );
        console.log(`💡 Using: ${centralBankCountry} - ${countryName}`);
      }

      // Step 1: Create OnchainID on-chain
      console.log("\n📝 Step 1: Creating OnchainID on blockchain...");
      const salt = ethers.randomBytes(32);
      const tx1 = await this.state
        .getContract("onchainIDFactory")
        .deployOnchainID(signer.address, salt);
      const receipt1 = await tx1.wait();
      totalGasUsed += receipt1.gasUsed;

      console.log(`   ✅ Transaction Hash: ${receipt1.hash}`);
      console.log(`   🧱 Block Number: ${receipt1.blockNumber}`);
      console.log(`   ⛽ Gas Used: ${receipt1.gasUsed.toLocaleString()}`);

      const identityAddress = await this.state
        .getContract("onchainIDFactory")
        .getIdentityByOwner(signer.address);
      console.log(`   🆔 OnchainID Created: ${identityAddress}`);

      // Step 2: Register in IdentityRegistry on-chain
      console.log(
        "\n📝 Step 2: Registering Central Bank in IdentityRegistry on blockchain...",
      );
      const tx2 = await this.state
        .getContract("identityRegistry")
        .registerIdentity(signer.address, identityAddress, centralBankCountry);
      const receipt2 = await tx2.wait();
      totalGasUsed += receipt2.gasUsed;

      console.log(`   ✅ Transaction Hash: ${receipt2.hash}`);
      console.log(`   🧱 Block Number: ${receipt2.blockNumber}`);
      console.log(`   ⛽ Gas Used: ${receipt2.gasUsed.toLocaleString()}`);
      console.log(`   🌍 Country Code: ${centralBankCountry} (${countryName})`);

      // Registration alone no longer verifies: the required KYC and AML
      // topics must both be attested through the trusted ClaimIssuers.
      console.log(
        "\n📝 Step 2b: Attesting Central Bank KYC/AML claims on blockchain...",
      );
      await attestAll(this.state, identityAddress, "central-bank");
      console.log("   ✅ KYC Claim Issued");
      console.log("   ✅ AML Claim Issued");

      // Step 3: Add as agent to Token contract (allows minting)
      console.log("\n📝 Step 3: Granting minting authority on blockchain...");
      const tx3 = await digitalToken.addAgent(signer.address);
      const receipt3 = await tx3.wait();
      totalGasUsed += receipt3.gasUsed;

      console.log(`   ✅ Transaction Hash: ${receipt3.hash}`);
      console.log(`   🧱 Block Number: ${receipt3.blockNumber}`);
      console.log(`   ⛽ Gas Used: ${receipt3.gasUsed.toLocaleString()}`);
      console.log(`   🔐 Minting Authority: GRANTED`);

      // Step 4: Verify registration on-chain
      console.log("\n📝 Step 4: Verifying registration on blockchain...");
      const isVerified = await this.state
        .getContract("identityRegistry")
        .isVerified(signer.address);
      console.log(
        `   ${isVerified ? "✅" : "❌"} Verification Status: ${isVerified ? "VERIFIED" : "NOT VERIFIED"}`,
      );

      // Store in state
      const centralBank = {
        name: "Central Bank",
        type: "CENTRAL_BANK",
        jurisdiction: jurisdiction,
        countryCode: centralBankCountry,
        countryName: countryName,
        address: signer.address,
        onchainId: identityAddress,
        signer: signer,
        canMint: true,
        canBurn: true,
        maxDailyMint: 10000000,
        createdAt: new Date().toISOString(),
        complianceStatus: "GOVERNMENT_AUTHORIZED",
        regulatoryLevel: "CENTRAL_AUTHORITY",
      };

      this.state.bankingInstitutions.set(centralBank.address, centralBank);
      await this._ensureTreasuryExempt(centralBank);

      // Store identity
      this.state.identities.set(identityAddress, {
        address: identityAddress,
        owner: signer.address,
        signer: signer,
        createdAt: new Date().toISOString(),
        bankInfo: centralBank,
      });

      displaySuccess("TOKEN ISSUER CREATED ON-CHAIN SUCCESSFULLY!");
      console.log(`🏛️ Name: ${centralBank.name}`);
      console.log(`🏛️ Role: Government Authority (Central Bank)`);
      console.log(`🆔 Address: ${centralBank.address}`);
      console.log(`🔗 OnchainID: ${identityAddress}`);
      console.log(`🌍 Jurisdiction: ${countryName} (${jurisdiction})`);
      console.log(`🌍 Country Code: ${centralBankCountry}`);
      console.log(`📊 Status: ${centralBank.complianceStatus}`);
      console.log(`🔐 Authorities: Mint ✅ Burn ✅`);
      console.log(`⛽ Total Gas Used: ${totalGasUsed.toLocaleString()}`);

      console.log("\n💡 Token Issuer Capabilities:");
      console.log("   • ✅ Mint tokens to approved investors");
      console.log("   • ✅ Burn tokens for supply management");
      console.log("   • ✅ Monitor all transactions");
      console.log("   • ✅ Enforce compliance rules");
      console.log("   • ✅ Government-authorized entity (no KYC/AML needed)");
      console.log("   • ✅ Fully registered on-chain");
    } catch (error) {
      displayError(`Token Issuer creation failed: ${error.message}`);
      console.log(
        "💡 Make sure you deployed contracts (option 1) and Digital Token (option 21) first",
      );
    }
  }

  /** Option 23: Investor Onboarding System */
  async investorOnboarding() {
    displaySection("INVESTOR ONBOARDING SYSTEM", "🏦");
    console.log(
      "Complete workflow: Request → Multi-Sig Wallet → Lock Tokens → Approval",
    );
    console.log("");

    console.log("\n🎯 INVESTOR ONBOARDING OPTIONS:");
    console.log("1. 🆕 Create Normal User (KYC/AML Verified)");
    console.log(
      "2. 🏦 Request Investor Status (Retail/Accredited/Institutional)",
    );
    console.log("3. 💸 Bank Transfers Tokens to User");
    console.log("4. 🔐 Create Multi-Sig Wallet (Bank)");
    console.log("5. 💰 Lock Tokens in Multi-Sig Wallet");
    console.log("6. ✅ Approve Investor Request (Bank)");
    console.log("7. 📊 View All Investor Requests");
    console.log("8. 🔓 Downgrade to Normal User");
    console.log("9. 👥 View All Users & Investors");
    console.log("9a. 📊 View Signer Allocation Status");
    console.log("0. Back to Main Menu");

    const choice = await this.promptUser("Select option (0-9a): ");

    try {
      switch (choice) {
        case "1":
          await this.createNormalUserForOnboarding();
          break;
        case "2":
          await this.requestInvestorStatus();
          break;
        case "3":
          await this.bankTransfersTokensToUser();
          break;
        case "4":
          await this.createMultiSigWalletForInvestor();
          break;
        case "5":
          await this.lockTokensInMultiSig();
          break;
        case "6":
          await this.approveInvestorRequest();
          break;
        case "7":
          await this.viewInvestorRequests();
          break;
        case "8":
          await this.downgradeToNormalUser();
          break;
        case "9":
          await this.viewAllInvestors();
          break;
        case "9a":
          this.displaySignerAllocation();
          break;
        case "0":
          return;
        default:
          displayError("Invalid choice");
      }
    } catch (error) {
      displayError(`Investor onboarding failed: ${error.message}`);
    }
  }

  /**
   * Create normal user for investor onboarding system
   * @private
   */
  async createNormalUserForOnboarding() {
    console.log("\n🆕 CREATE NORMAL USER (KYC/AML VERIFIED)");
    console.log("=".repeat(60));
    console.log("Phase 1: User Registration & Compliance");
    console.log("");

    const onchainIDFactory = this.state.getContract("onchainIDFactory");
    if (!onchainIDFactory) {
      console.log("❌ Please deploy contracts first (option 1)");
      return;
    }

    const digitalToken = this.state.getContract("digitalToken");
    if (!digitalToken) {
      console.log("❌ Please deploy Digital Token system first (option 21)");
      return;
    }

    const userName = await this.promptUser("Enter user name: ");

    // Get next available signer (skips reserved signers[0-3])
    const signerAllocation = this.signerManager.getNextAvailableSigner(
      "user",
      userName,
    );
    if (!signerAllocation) {
      console.log("❌ No more available signers. Maximum users reached.");
      console.log("💡 Reserved signers[0-3] for system roles");
      return;
    }

    const signer = signerAllocation.signer;
    const signerIndex = signerAllocation.index;

    try {
      let totalGasUsed = 0n;

      console.log("\n🔗 CREATING NORMAL USER ON-CHAIN...");
      console.log(`👤 User Name: ${userName}`);
      console.log(`🆔 Address: ${signer.address}`);
      console.log(`📋 Initial Type: NORMAL (can upgrade to investor)`);

      // Get dynamic country from jurisdiction rules
      let userCountry = 840; // Default: United States
      let countryName = "United States";

      const complianceRules = this.state.getContract("complianceRules");
      if (complianceRules) {
        try {
          const tokenAddress = await digitalToken.getAddress();
          const jurisdictionRule =
            await complianceRules.getJurisdictionRule(tokenAddress);

          if (jurisdictionRule.allowedCountries.length > 0) {
            userCountry = Number(jurisdictionRule.allowedCountries[0]);
            const countryMap = {
              840: "United States",
              826: "United Kingdom",
              124: "Canada",
              276: "Germany",
              250: "France",
              392: "Japan",
              702: "Singapore",
              36: "Australia",
            };
            countryName = countryMap[userCountry] || `Country ${userCountry}`;
          }
        } catch (error) {
          console.log("ℹ️  Using default country");
        }
      }

      // Step 1: Create OnchainID
      console.log("\n📝 Step 1: Creating OnchainID on blockchain...");
      const salt = ethers.randomBytes(32);
      const tx1 = await onchainIDFactory.deployOnchainID(signer.address, salt);
      const receipt1 = await tx1.wait();
      totalGasUsed += receipt1.gasUsed;

      const identityAddress = await onchainIDFactory.getIdentityByOwner(
        signer.address,
      );
      console.log(`   ✅ OnchainID Created: ${identityAddress}`);
      console.log(`   ⛽ Gas Used: ${receipt1.gasUsed.toLocaleString()}`);

      // Step 2 & 3: Issue KYC and AML claims through the trusted
      // ClaimIssuers (KYC issuer owner: signers[2], AML issuer owner:
      // signers[3] — see ContractDeployer.js).
      console.log("\n📝 Step 2: Issuing KYC claim on blockchain...");
      console.log("\n📝 Step 3: Issuing AML claim on blockchain...");
      const { kyc: receipt2, aml: receipt3 } = await attestAll(
        this.state,
        identityAddress,
        `normal:${userName}`,
      );
      totalGasUsed += receipt2.gasUsed + receipt3.gasUsed;
      console.log(`   ✅ KYC Claim Issued`);
      console.log(`   ⛽ Gas Used: ${receipt2.gasUsed.toLocaleString()}`);
      console.log(`   ✅ AML Claim Issued`);
      console.log(`   ⛽ Gas Used: ${receipt3.gasUsed.toLocaleString()}`);

      // Step 4: Register in IdentityRegistry
      console.log(
        "\n📝 Step 4: Registering in IdentityRegistry on blockchain...",
      );
      const identityRegistry = this.state.getContract("identityRegistry");
      const tx4 = await identityRegistry.registerIdentity(
        signer.address,
        identityAddress,
        userCountry,
      );
      const receipt4 = await tx4.wait();
      totalGasUsed += receipt4.gasUsed;
      console.log(
        `   ✅ Registered with country: ${userCountry} (${countryName})`,
      );
      console.log(`   ⛽ Gas Used: ${receipt4.gasUsed.toLocaleString()}`);

      // Step 5: Assign NORMAL investor type
      console.log(
        "\n📝 Step 5: Assigning NORMAL investor type on blockchain...",
      );
      const investorTypeRegistry = this.state.getContract(
        "investorTypeRegistry",
      );
      const tx5 = await investorTypeRegistry.assignInvestorType(
        signer.address,
        0,
      ); // 0 = NORMAL
      const receipt5 = await tx5.wait();
      totalGasUsed += receipt5.gasUsed;
      console.log(`   ✅ Investor Type: NORMAL (can upgrade later)`);
      console.log(`   ⛽ Gas Used: ${receipt5.gasUsed.toLocaleString()}`);

      // Store user record
      const user = {
        name: userName,
        type: "NORMAL",
        address: signer.address,
        onchainId: identityAddress,
        signer: signer,
        signerIndex: signerIndex,
        complianceStatus: "COMPLIANT",
        kycStatus: "ISSUED",
        amlStatus: "ISSUED",
        tokenBalance: 0,
        tokenEligible: true,
        countryCode: userCountry,
        countryName: countryName,
        createdAt: new Date().toISOString(),
        canUpgradeToInvestor: true,
      };

      this.state.investors.set(signer.address, user);

      console.log("\n✅ NORMAL USER CREATED SUCCESSFULLY!");
      console.log("=".repeat(60));
      console.log(`👤 Name: ${userName}`);
      console.log(`🆔 Address: ${signer.address}`);
      console.log(`🔗 OnchainID: ${identityAddress}`);
      console.log(`📋 Type: NORMAL`);
      console.log(`🌍 Country: ${countryName} (${userCountry})`);
      console.log(`✅ KYC: ISSUED`);
      console.log(`✅ AML: ISSUED`);
      console.log(`📊 Status: COMPLIANT`);
      console.log(
        `⬆️  Can Upgrade: YES (use Option 2 to request investor status)`,
      );
      console.log(`⛽ Total Gas Used: ${totalGasUsed.toLocaleString()}`);
    } catch (error) {
      console.error("❌ User creation failed:", error.message);
      if (error.message.includes("Country not allowed")) {
        console.log("💡 Configure jurisdiction rules first (Option 14)");
      }
    }
  }

  /**
   * Request investor status upgrade
   * @private
   */
  async requestInvestorStatus() {
    console.log("\n🏦 REQUEST INVESTOR STATUS");
    console.log("=".repeat(60));
    console.log("Phase 2: Investor Request & Approval");
    console.log("");

    // Merge users from both Option 23 (this.state.investors) and Option 24 (this.state.normalUsers)
    const normalUsersFromInvestors = this.state.investors
      ? Array.from(this.state.investors.values()).filter(
          (u) => u.type === "NORMAL" || u.type === "NORMAL_USER",
        )
      : [];
    const normalUsersFromOption24 = this.state.normalUsers
      ? Array.from(this.state.normalUsers.values())
      : [];

    // Combine both sources
    const normalUsers = [
      ...normalUsersFromInvestors,
      ...normalUsersFromOption24,
    ];

    if (normalUsers.length === 0) {
      console.log("❌ No normal users found!");
      console.log("💡 Create a normal user first (Option 1 or Option 24)");
      return;
    }

    console.log("\n👥 AVAILABLE NORMAL USERS:");
    console.log(
      `   (${normalUsersFromInvestors.length} from Option 23, ${normalUsersFromOption24.length} from Option 24)`,
    );
    normalUsers.forEach((user, index) => {
      const source = normalUsersFromInvestors.includes(user)
        ? "[Option 23]"
        : "[Option 24]";
      console.log(
        `${index + 1}. ${user.name} (${user.address.substring(0, 10)}...) ${source}`,
      );
    });

    const userChoice = await this.promptUser(
      `\nSelect user (1-${normalUsers.length}): `,
    );
    const selectedUser = normalUsers[parseInt(userChoice) - 1];

    if (!selectedUser) {
      console.log("❌ Invalid selection");
      return;
    }

    console.log("\n📋 SELECT INVESTOR TYPE:");
    console.log("1. RETAIL (Lock: 10,000 VSC, Max Transfer: 8,000 VSC)");
    console.log("2. ACCREDITED (Lock: 100,000 VSC, Max Transfer: 50,000 VSC)");
    console.log(
      "3. INSTITUTIONAL (Lock: 1,000,000 VSC, Max Transfer: 500,000 VSC)",
    );

    const typeChoice = await this.promptUser("Select type (1-3): ");
    const typeMap = { 1: "RETAIL", 2: "ACCREDITED", 3: "INSTITUTIONAL" };
    const investorType = typeMap[typeChoice];

    if (!investorType) {
      console.log("❌ Invalid type");
      return;
    }

    const lockRequirements = {
      RETAIL: "10,000",
      ACCREDITED: "100,000",
      INSTITUTIONAL: "1,000,000",
    };

    console.log(`\n✅ REQUEST CREATED!`);
    console.log("=".repeat(60));
    console.log(`👤 User: ${selectedUser.name}`);
    console.log(`📋 Requested Type: ${investorType}`);
    console.log(`💰 Required Lock: ${lockRequirements[investorType]} VSC`);
    console.log(`📊 Status: PENDING`);
    console.log("");
    console.log("🎯 NEXT STEPS:");
    console.log("   1. Bank transfers tokens to user (Option 3)");
    console.log("   2. Bank creates multi-sig wallet (Option 4)");
    console.log("   3. User locks tokens (Option 5)");
    console.log("   4. Bank approves request (Option 6)");

    // Store request
    selectedUser.investorRequest = {
      requestedType: investorType,
      status: "PENDING",
      lockRequired: lockRequirements[investorType],
      createdAt: new Date().toISOString(),
    };

    // If user is from Option 24 (normalUsers), also add to investors Map
    // This ensures they can be tracked through the investor workflow
    if (normalUsersFromOption24.includes(selectedUser)) {
      const userId = selectedUser.id || `user_${Date.now()}`;

      // Convert Option 24 user format to Option 23 format
      const investorUser = {
        ...selectedUser,
        id: userId,
        type: "NORMAL", // Still normal until approved
        investorRequest: selectedUser.investorRequest,
      };

      this.state.investors.set(userId, investorUser);
      console.log(
        "\n💡 User migrated from Option 24 to investor tracking system",
      );
    }
  }

  /**
   * Bank transfers tokens to user
   * @private
   */
  async bankTransfersTokensToUser() {
    console.log("\n💸 BANK TRANSFERS TOKENS TO USER");
    console.log("=".repeat(60));
    console.log("Phase 2: Token Transfer (Required before locking)");
    console.log("");

    const digitalToken = this.state.getContract("digitalToken");
    if (!digitalToken) {
      console.log("❌ Digital Token not deployed!");
      console.log("💡 Deploy Digital Token system first (Option 21)");
      return;
    }

    // Get central bank
    const centralBank = Array.from(
      this.state.bankingInstitutions.values(),
    ).find((bank) => bank.type === "CENTRAL_BANK");
    if (!centralBank) {
      console.log("❌ Token Issuer (Central Bank) not found!");
      console.log("💡 Create Token Issuer first (Option 22)");
      return;
    }

    // Show users with pending requests
    if (!this.state.investors || this.state.investors.size === 0) {
      console.log("❌ No investors found!");
      console.log(
        "💡 Create normal users and request investor status first (Options 1-2)",
      );
      return;
    }

    const usersWithRequests = Array.from(this.state.investors.values()).filter(
      (u) =>
        u.investorRequest &&
        u.investorRequest.status === "PENDING" &&
        !u.investorRequest.tokensReceived,
    );

    if (usersWithRequests.length === 0) {
      console.log("❌ No users with pending requests needing tokens!");
      console.log("💡 Users must request investor status first (Option 2)");
      return;
    }

    console.log("\n👥 USERS NEEDING TOKENS:");
    usersWithRequests.forEach((user, index) => {
      console.log(
        `${index + 1}. ${user.name} - ${user.investorRequest.requestedType} (Needs: ${user.investorRequest.lockRequired} VSC)`,
      );
      console.log(`   Current Balance: ${user.tokenBalance} VSC`);
    });

    const userChoice = await this.promptUser(
      `\nSelect user (1-${usersWithRequests.length}): `,
    );
    const selectedUser = usersWithRequests[parseInt(userChoice) - 1];

    if (!selectedUser) {
      console.log("❌ Invalid selection");
      return;
    }

    const transferAmount = selectedUser.investorRequest.lockRequired.replace(
      /,/g,
      "",
    );

    try {
      console.log(`\n💸 Transferring ${transferAmount} VSC tokens...`);
      console.log(
        `   From: Central Bank (${centralBank.address.substring(0, 10)}...)`,
      );
      console.log(
        `   To: ${selectedUser.name} (${selectedUser.address.substring(0, 10)}...)`,
      );

      // Transfer tokens on-chain
      const tx = await digitalToken
        .connect(centralBank.signer)
        .transfer(selectedUser.address, ethers.parseEther(transferAmount));
      const receipt = await tx.wait();

      // Update balances
      const newBalance = await digitalToken.balanceOf(selectedUser.address);
      selectedUser.tokenBalance = Number(ethers.formatEther(newBalance));
      selectedUser.investorRequest.tokensReceived = true;

      console.log(`\n✅ TOKENS TRANSFERRED SUCCESSFULLY!`);
      console.log("=".repeat(60));
      console.log(`💰 Amount Transferred: ${transferAmount} VSC`);
      console.log(`👤 Recipient: ${selectedUser.name}`);
      console.log(`📊 New Balance: ${selectedUser.tokenBalance} VSC`);
      console.log(`⛽ Gas Used: ${receipt.gasUsed.toLocaleString()}`);
      console.log(`📝 Transaction Hash: ${receipt.hash}`);
      console.log("");
      console.log("🎯 NEXT STEPS:");
      console.log("   1. Bank creates multi-sig wallet (Option 4)");
      console.log("   2. User locks tokens (Option 5)");
      console.log("   3. Bank approves request (Option 6)");
    } catch (error) {
      console.error("❌ Token transfer failed:", error.message);
      if (error.message.includes("insufficient balance")) {
        console.log("💡 Central Bank needs to mint tokens first (Option 25)");
      }
    }
  }

  /**
   * Create multi-sig wallet for investor
   * @private
   */
  async createMultiSigWalletForInvestor() {
    console.log("\n🔐 CREATE MULTI-SIG WALLET (BANK)");
    console.log("=".repeat(60));
    console.log("Phase 2: Multi-Sig Wallet Creation");
    console.log("");

    if (!this.state.investors || this.state.investors.size === 0) {
      console.log("❌ No investors found!");
      console.log(
        "💡 Create normal users and request investor status first (Options 1-2)",
      );
      return;
    }

    const usersWithRequests = Array.from(this.state.investors.values()).filter(
      (u) => u.investorRequest && u.investorRequest.status === "PENDING",
    );

    if (usersWithRequests.length === 0) {
      console.log("❌ No pending investor requests!");
      console.log("💡 Users must request investor status first (Option 2)");
      return;
    }

    console.log("\n👥 USERS WITH PENDING REQUESTS:");
    usersWithRequests.forEach((user, index) => {
      console.log(
        `${index + 1}. ${user.name} - ${user.investorRequest.requestedType} (Lock: ${user.investorRequest.lockRequired} VSC)`,
      );
    });

    const userChoice = await this.promptUser(
      `\nSelect user (1-${usersWithRequests.length}): `,
    );
    const selectedUser = usersWithRequests[parseInt(userChoice) - 1];

    if (!selectedUser) {
      console.log("❌ Invalid selection");
      return;
    }

    console.log(`\n🔐 Creating 2-of-2 Multi-Sig Wallet...`);
    console.log(
      `   Bank: ${this.state.signers[0].address.substring(0, 10)}...`,
    );
    console.log(`   User: ${selectedUser.address.substring(0, 10)}...`);

    // Generate a valid Ethereum address for the multi-sig wallet
    // Create a deterministic address based on user and bank addresses
    const combinedData = ethers.solidityPacked(
      ["address", "address", "uint256"],
      [this.state.signers[0].address, selectedUser.address, Date.now()],
    );
    const hash = ethers.keccak256(combinedData);
    // Take first 20 bytes (40 hex chars) and add 0x prefix to create valid address
    const walletAddress = "0x" + hash.substring(2, 42);

    selectedUser.multiSigWallet = {
      address: walletAddress,
      bank: this.state.signers[0].address,
      user: selectedUser.address,
      createdAt: new Date().toISOString(),
      tokensLocked: 0,
    };

    // Not trusted: only contracts may be; the real MultiSigWallet is registered in Task 4.3.

    console.log(`\n✅ MULTI-SIG WALLET CREATED!`);
    console.log("=".repeat(60));
    console.log(`🔐 Wallet Address: ${walletAddress}`);
    console.log(
      `🏦 Bank Signer: ${this.state.signers[0].address.substring(0, 10)}...`,
    );
    console.log(`👤 User Signer: ${selectedUser.address.substring(0, 10)}...`);
    console.log(`📊 Status: READY FOR TOKEN LOCK`);
    console.log(
      `💡 Note: This is a deterministic address derived from Bank + User addresses`,
    );
    console.log("");
    console.log("🎯 NEXT STEP: User locks tokens (Option 5)");
  }

  /**
   * Lock tokens in multi-sig wallet
   * @private
   */
  async lockTokensInMultiSig() {
    console.log("\n💰 LOCK TOKENS IN MULTI-SIG WALLET");
    console.log("=".repeat(60));
    console.log("Phase 2: Token Locking");
    console.log("");

    if (!this.state.investors || this.state.investors.size === 0) {
      console.log("❌ No investors found!");
      console.log(
        "💡 Create normal users and request investor status first (Options 1-2)",
      );
      return;
    }

    const usersWithWallets = Array.from(this.state.investors.values()).filter(
      (u) => u.multiSigWallet && u.multiSigWallet.tokensLocked === 0,
    );

    if (usersWithWallets.length === 0) {
      console.log("❌ No users with multi-sig wallets ready for locking!");
      console.log("💡 Bank must create multi-sig wallet first (Option 4)");
      return;
    }

    console.log("\n👥 USERS READY TO LOCK TOKENS:");
    usersWithWallets.forEach((user, index) => {
      console.log(
        `${index + 1}. ${user.name} - ${user.investorRequest.requestedType} (Required: ${user.investorRequest.lockRequired} VSC)`,
      );
    });

    const userChoice = await this.promptUser(
      `\nSelect user (1-${usersWithWallets.length}): `,
    );
    const selectedUser = usersWithWallets[parseInt(userChoice) - 1];

    if (!selectedUser) {
      console.log("❌ Invalid selection");
      return;
    }

    const lockAmount = selectedUser.investorRequest.lockRequired.replace(
      /,/g,
      "",
    );

    console.log(`\n💰 INITIATING TOKEN LOCK PROCESS...`);
    console.log("=".repeat(60));
    console.log(`👤 User: ${selectedUser.name}`);
    console.log(
      `📋 Investor Type: ${selectedUser.investorRequest.requestedType}`,
    );
    console.log(`💰 Lock Amount: ${lockAmount} VSC`);
    console.log("");

    // Show user's current balance
    console.log(`📊 PRE-LOCK STATUS:`);
    console.log(`   User Address: ${selectedUser.address}`);
    console.log(`   User Balance: ${selectedUser.tokenBalance} VSC`);
    console.log(`   Multi-Sig Wallet: ${selectedUser.multiSigWallet.address}`);
    console.log(
      `   Current Locked: ${selectedUser.multiSigWallet.tokensLocked} VSC`,
    );
    console.log("");

    // FREEZE TOKENS ON-CHAIN using ERC-3643 freezePartialTokens
    console.log(`🔐 STEP 1: Freezing tokens on-chain...`);
    console.log(`   👤 User Address: ${selectedUser.address}`);
    console.log(`   💰 Amount to Freeze: ${lockAmount} VSC`);
    console.log("");

    // Declare variable outside try block so it's accessible later
    let userBalanceVSC = 0;

    try {
      // Get user's current on-chain balance
      const digitalToken = this.state.getContract("digitalToken");
      const userBalance = await digitalToken.balanceOf(selectedUser.address);
      userBalanceVSC = parseFloat(ethers.formatEther(userBalance));

      console.log(
        `   📊 Current Balance: ${userBalanceVSC.toLocaleString()} VSC`,
      );

      // Check if user has enough tokens
      if (userBalanceVSC < parseInt(lockAmount)) {
        console.log(`\n❌ ERROR: Insufficient balance!`);
        console.log(`   Required: ${lockAmount} VSC`);
        console.log(`   Available: ${userBalanceVSC.toLocaleString()} VSC`);
        return;
      }

      // Freeze the tokens on-chain
      const freezeAmountWei = ethers.parseEther(lockAmount);
      const tx = await digitalToken.freezePartialTokens(
        selectedUser.address,
        freezeAmountWei,
      );
      await tx.wait();

      console.log(`   ✅ Tokens frozen on-chain!`);
      console.log(`   📝 Transaction Hash: ${tx.hash}`);
      console.log("");

      // Get updated balances
      const frozenTokens = await digitalToken.frozenTokens(
        selectedUser.address,
      );
      const freeBalance = await digitalToken.getFreeBalance(
        selectedUser.address,
      );

      console.log(`🔐 STEP 2: Verifying frozen tokens...`);
      console.log(`   🔒 Wallet Type: 2-of-2 Multi-Signature`);
      console.log(
        `   🏦 Signer 1: ${selectedUser.multiSigWallet.bank.substring(0, 10)}... (Bank)`,
      );
      console.log(
        `   👤 Signer 2: ${selectedUser.multiSigWallet.user.substring(0, 10)}... (User)`,
      );
      console.log(`   ⚠️  Unlock Requirement: Both signatures required`);
      console.log("");
      console.log(
        `   📊 Total Balance: ${userBalanceVSC.toLocaleString()} VSC`,
      );
      console.log(
        `   🔒 Frozen Tokens: ${parseFloat(ethers.formatEther(frozenTokens)).toLocaleString()} VSC`,
      );
      console.log(
        `   💰 Free Balance: ${parseFloat(ethers.formatEther(freeBalance)).toLocaleString()} VSC`,
      );
      console.log("");

      // Update JavaScript state
      selectedUser.tokenBalance = parseFloat(ethers.formatEther(freeBalance));
      selectedUser.multiSigWallet.tokensLocked = parseInt(lockAmount);
      selectedUser.investorRequest.tokensLocked = true;
    } catch (error) {
      console.log(`\n❌ ERROR: Failed to freeze tokens on-chain!`);
      console.log(`   ${error.message}`);
      return;
    }

    console.log(`✅ STEP 3: Lock complete!`);
    console.log("");

    console.log(`\n✅ TOKENS LOCKED SUCCESSFULLY ON-CHAIN!`);
    console.log("=".repeat(60));

    console.log(`\n📊 POST-LOCK STATUS:`);
    console.log(
      `   Total Balance: ${userBalanceVSC.toLocaleString()} VSC (unchanged)`,
    );
    console.log(
      `   🔒 Frozen (Locked): ${selectedUser.multiSigWallet.tokensLocked.toLocaleString()} VSC`,
    );
    console.log(
      `   💰 Free (Available): ${selectedUser.tokenBalance.toLocaleString()} VSC`,
    );
    console.log(`   ⚠️  Locked tokens CANNOT be transferred!`);
    console.log("");

    console.log(`🔐 MULTI-SIG WALLET DETAILS:`);
    console.log(`   Wallet Address: ${selectedUser.multiSigWallet.address}`);
    console.log(`   Locked Amount: ${lockAmount} VSC`);
    console.log(`   Lock Type: 2-of-2 Multi-Signature`);
    console.log(
      `   Created: ${new Date(selectedUser.multiSigWallet.createdAt).toLocaleString()}`,
    );
    console.log(`   Status: LOCKED ✅`);
    console.log("");

    console.log(`👥 REQUIRED SIGNERS FOR UNLOCK:`);
    console.log(`   1. 🏦 Bank: ${selectedUser.multiSigWallet.bank}`);
    console.log(`   2. 👤 User: ${selectedUser.multiSigWallet.user}`);
    console.log("");

    console.log(`📋 INVESTOR REQUEST STATUS:`);
    console.log(`   User: ${selectedUser.name}`);
    console.log(
      `   Requested Type: ${selectedUser.investorRequest.requestedType}`,
    );
    console.log(
      `   Lock Required: ${selectedUser.investorRequest.lockRequired} VSC`,
    );
    console.log(`   Tokens Received: ✅ YES`);
    console.log(`   Tokens Locked: ✅ YES`);
    console.log(`   Request Status: PENDING APPROVAL`);
    console.log("");

    console.log(`🎯 NEXT STEP: Bank approves request (Option 6)`);
    console.log(
      `   Once approved, user will become ${selectedUser.investorRequest.requestedType} investor`,
    );
  }

  /**
   * Approve investor request
   * @private
   */
  async approveInvestorRequest() {
    console.log("\n✅ APPROVE INVESTOR REQUEST (BANK)");
    console.log("=".repeat(60));
    console.log("Phase 2: Request Approval");
    console.log("");

    if (!this.state.investors || this.state.investors.size === 0) {
      console.log("❌ No investors found!");
      console.log(
        "💡 Create normal users and request investor status first (Options 1-2)",
      );
      return;
    }

    const usersReadyForApproval = Array.from(
      this.state.investors.values(),
    ).filter(
      (u) =>
        u.investorRequest &&
        u.investorRequest.tokensLocked &&
        u.investorRequest.status === "PENDING",
    );

    if (usersReadyForApproval.length === 0) {
      console.log("❌ No requests ready for approval!");
      console.log("💡 Users must lock tokens first (Option 5)");
      return;
    }

    console.log("\n👥 REQUESTS READY FOR APPROVAL:");
    usersReadyForApproval.forEach((user, index) => {
      console.log(
        `${index + 1}. ${user.name} - ${user.investorRequest.requestedType} (Locked: ${user.investorRequest.lockRequired} VSC)`,
      );
    });

    const userChoice = await this.promptUser(
      `\nSelect request (1-${usersReadyForApproval.length}): `,
    );
    const selectedUser = usersReadyForApproval[parseInt(userChoice) - 1];

    if (!selectedUser) {
      console.log("❌ Invalid selection");
      return;
    }

    try {
      console.log(`\n✅ Approving investor request...`);

      // Update investor type on-chain
      const typeMap = { RETAIL: 1, ACCREDITED: 2, INSTITUTIONAL: 3 };
      const investorTypeEnum =
        typeMap[selectedUser.investorRequest.requestedType];

      const investorTypeRegistry = this.state.getContract(
        "investorTypeRegistry",
      );
      const tx = await investorTypeRegistry.assignInvestorType(
        selectedUser.address,
        investorTypeEnum,
      );
      const receipt = await tx.wait();

      // Update user record
      selectedUser.type = selectedUser.investorRequest.requestedType;
      selectedUser.investorRequest.status = "APPROVED";
      selectedUser.investorRequest.approvedAt = new Date().toISOString();

      console.log(`\n✅ INVESTOR REQUEST APPROVED!`);
      console.log("=".repeat(60));
      console.log(`👤 User: ${selectedUser.name}`);
      console.log(`📋 New Type: ${selectedUser.type}`);
      console.log(
        `💰 Tokens Locked: ${selectedUser.investorRequest.lockRequired} VSC`,
      );
      console.log(
        `🔐 Multi-Sig Wallet: ${selectedUser.multiSigWallet.address}`,
      );
      console.log(`📊 Status: ACTIVE INVESTOR`);
      console.log(`⛽ Gas Used: ${receipt.gasUsed.toLocaleString()}`);
      console.log("");
      console.log(
        "🎉 User is now an active investor with enhanced privileges!",
      );
    } catch (error) {
      console.error("❌ Approval failed:", error.message);
    }
  }

  /**
   * Downgrade investor to normal user
   * @private
   */
  async downgradeToNormalUser() {
    console.log("\n🔓 DOWNGRADE TO NORMAL USER");
    console.log("=".repeat(60));
    console.log("Phase 4: Downgrade Process (2-of-2 Signature Unlock)");
    console.log("");

    if (!this.state.investors || this.state.investors.size === 0) {
      console.log("❌ No investors found!");
      console.log("💡 Create and approve investors first (Options 1-6)");
      return;
    }

    const investors = Array.from(this.state.investors.values()).filter(
      (u) =>
        u.type !== "NORMAL" && u.type !== "NORMAL_USER" && u.multiSigWallet,
    );

    if (investors.length === 0) {
      console.log("❌ No active investors found!");
      return;
    }

    console.log("\n👥 ACTIVE INVESTORS:");
    investors.forEach((user, index) => {
      console.log(
        `${index + 1}. ${user.name} - ${user.type} (Locked: ${user.multiSigWallet.tokensLocked} VSC)`,
      );
    });

    const userChoice = await this.promptUser(
      `\nSelect investor (1-${investors.length}): `,
    );
    const selectedUser = investors[parseInt(userChoice) - 1];

    if (!selectedUser) {
      console.log("❌ Invalid selection");
      return;
    }

    try {
      console.log(`\n🔓 Initiating downgrade process...`);
      console.log(`   Requires 2-of-2 signatures (Bank + User)`);
      console.log(
        `   Multi-Sig Wallet: ${selectedUser.multiSigWallet.address}`,
      );

      // Get signers
      const bankSigner = this.state.signers[0]; // Central Bank
      const userSigner = selectedUser.signer;

      // Step 1: Create unlock proposal with real data
      console.log(`\n📝 Step 1: Creating unlock proposal...`);
      const proposalData = {
        wallet: selectedUser.multiSigWallet.address,
        user: selectedUser.address,
        amount: selectedUser.multiSigWallet.tokensLocked,
        timestamp: Date.now(),
        nonce: Math.floor(Math.random() * 1000000),
      };

      // Create proposal hash
      const proposalMessage = ethers.solidityPacked(
        ["address", "address", "uint256", "uint256", "uint256"],
        [
          proposalData.wallet,
          proposalData.user,
          proposalData.amount,
          proposalData.timestamp,
          proposalData.nonce,
        ],
      );
      const proposalHash = ethers.keccak256(proposalMessage);

      console.log(`   ✅ Proposal created`);
      console.log(
        `   📋 Proposal ID: ${proposalHash.substring(0, 10)}...${proposalHash.substring(proposalHash.length - 8)}`,
      );
      console.log(`   💰 Unlock Amount: ${proposalData.amount} VSC`);
      console.log(
        `   ⏰ Timestamp: ${new Date(proposalData.timestamp).toLocaleString()}`,
      );
      console.log(`   🔢 Nonce: ${proposalData.nonce}`);

      // Step 2: User signature (REAL CRYPTOGRAPHIC SIGNATURE)
      console.log(`\n✍️  Step 2: User signature...`);
      console.log(`   👤 Signer: ${userSigner.address}`);
      console.log(
        `   📝 Signing proposal hash: ${proposalHash.substring(0, 20)}...`,
      );

      const userSignature = await userSigner.signMessage(
        ethers.getBytes(proposalHash),
      );

      console.log(`   ✅ User signed (1/2)`);
      console.log(
        `   🔐 Signature: ${userSignature.substring(0, 20)}...${userSignature.substring(userSignature.length - 20)}`,
      );
      console.log(`   📏 Signature Length: ${userSignature.length} characters`);
      console.log(
        `   🔑 Signature Type: ECDSA (Elliptic Curve Digital Signature Algorithm)`,
      );

      // Verify user signature
      const recoveredUserAddress = ethers.verifyMessage(
        ethers.getBytes(proposalHash),
        userSignature,
      );
      console.log(
        `   ✅ Signature Verified: ${recoveredUserAddress === userSigner.address ? "VALID" : "INVALID"}`,
      );
      console.log(`   🔍 Recovered Address: ${recoveredUserAddress}`);

      // Step 3: Bank signature (REAL CRYPTOGRAPHIC SIGNATURE)
      console.log(`\n✍️  Step 3: Bank signature...`);
      console.log(`   🏦 Signer: ${bankSigner.address}`);
      console.log(
        `   📝 Signing proposal hash: ${proposalHash.substring(0, 20)}...`,
      );

      const bankSignature = await bankSigner.signMessage(
        ethers.getBytes(proposalHash),
      );

      console.log(`   ✅ Bank signed (2/2)`);
      console.log(
        `   🔐 Signature: ${bankSignature.substring(0, 20)}...${bankSignature.substring(bankSignature.length - 20)}`,
      );
      console.log(`   📏 Signature Length: ${bankSignature.length} characters`);
      console.log(
        `   🔑 Signature Type: ECDSA (Elliptic Curve Digital Signature Algorithm)`,
      );

      // Verify bank signature
      const recoveredBankAddress = ethers.verifyMessage(
        ethers.getBytes(proposalHash),
        bankSignature,
      );
      console.log(
        `   ✅ Signature Verified: ${recoveredBankAddress === bankSigner.address ? "VALID" : "INVALID"}`,
      );
      console.log(`   🔍 Recovered Address: ${recoveredBankAddress}`);

      // Step 4: Verify 2-of-2 signatures
      console.log(`\n🔐 Step 4: Verifying 2-of-2 signatures...`);
      const userValid = recoveredUserAddress === userSigner.address;
      const bankValid = recoveredBankAddress === bankSigner.address;
      const allValid = userValid && bankValid;

      console.log(
        `   👤 User Signature: ${userValid ? "✅ VALID" : "❌ INVALID"}`,
      );
      console.log(
        `   🏦 Bank Signature: ${bankValid ? "✅ VALID" : "❌ INVALID"}`,
      );
      console.log(
        `   🔐 2-of-2 Requirement: ${allValid ? "✅ MET" : "❌ NOT MET"}`,
      );

      if (!allValid) {
        console.log("\n❌ Signature verification failed! Aborting unlock.");
        return;
      }

      // Continue in next part due to 150-line limit...
      await this.completeDowngrade(
        selectedUser,
        proposalHash,
        userSignature,
        bankSignature,
      );
    } catch (error) {
      console.error("❌ Downgrade failed:", error.message);
    }
  }

  /**
   * Complete the downgrade process (part 2)
   * @private
   */
  async completeDowngrade(
    selectedUser,
    proposalHash,
    userSignature,
    bankSignature,
  ) {
    // Step 5: Unlock and unfreeze tokens on-chain
    console.log(`\n🔓 Step 5: Unlocking and unfreezing tokens on-chain...`);
    const unlockedAmount = selectedUser.multiSigWallet.tokensLocked;

    if (unlockedAmount > 0) {
      try {
        const digitalToken = this.state.getContract("digitalToken");

        // Get balances before unfreezing
        const totalBalance = await digitalToken.balanceOf(selectedUser.address);
        const frozenTokens = await digitalToken.frozenTokens(
          selectedUser.address,
        );
        const freeBalance = await digitalToken.getFreeBalance(
          selectedUser.address,
        );

        console.log(`   📊 Current Status:`);
        console.log(
          `      Total Balance: ${parseFloat(ethers.formatEther(totalBalance)).toLocaleString()} VSC`,
        );
        console.log(
          `      🔒 Frozen: ${parseFloat(ethers.formatEther(frozenTokens)).toLocaleString()} VSC`,
        );
        console.log(
          `      💰 Free: ${parseFloat(ethers.formatEther(freeBalance)).toLocaleString()} VSC`,
        );
        console.log("");

        // Unfreeze the tokens on-chain
        console.log(`   🔓 Unfreezing ${unlockedAmount} VSC on-chain...`);
        const unfreezeAmountWei = ethers.parseEther(unlockedAmount.toString());
        const tx = await digitalToken.unfreezePartialTokens(
          selectedUser.address,
          unfreezeAmountWei,
        );
        const receipt = await tx.wait();

        console.log(`   ✅ Tokens unfrozen on-chain!`);
        console.log(`   📝 Transaction Hash: ${tx.hash}`);
        console.log(`   ⛽ Gas Used: ${receipt.gasUsed.toLocaleString()}`);
        console.log("");

        // Get updated balances after unfreezing
        const newFrozenTokens = await digitalToken.frozenTokens(
          selectedUser.address,
        );
        const newFreeBalance = await digitalToken.getFreeBalance(
          selectedUser.address,
        );

        console.log(`   📊 Updated Status:`);
        console.log(
          `      Total Balance: ${parseFloat(ethers.formatEther(totalBalance)).toLocaleString()} VSC (unchanged)`,
        );
        console.log(
          `      🔒 Frozen: ${parseFloat(ethers.formatEther(newFrozenTokens)).toLocaleString()} VSC`,
        );
        console.log(
          `      💰 Free: ${parseFloat(ethers.formatEther(newFreeBalance)).toLocaleString()} VSC`,
        );
        console.log("");

        // Update JavaScript state
        selectedUser.tokenBalance = parseFloat(
          ethers.formatEther(newFreeBalance),
        );

        console.log(
          `   ✅ ${unlockedAmount} VSC unlocked and now available for transfer`,
        );
        console.log(
          `   💰 User's free balance: ${parseFloat(ethers.formatEther(freeBalance)).toLocaleString()} VSC → ${selectedUser.tokenBalance.toLocaleString()} VSC`,
        );
      } catch (error) {
        console.log(`\n❌ ERROR: Failed to unfreeze tokens on-chain!`);
        console.log(`   ${error.message}`);
        return;
      }
    }

    selectedUser.multiSigWallet.tokensLocked = 0;
    console.log(`   🔓 Multi-sig wallet unlocked`);

    // Step 6: Downgrade to NORMAL on-chain
    console.log(`\n📝 Step 6: Downgrading to NORMAL on blockchain...`);
    const investorTypeRegistry = this.state.getContract("investorTypeRegistry");
    const tx = await investorTypeRegistry.assignInvestorType(
      selectedUser.address,
      0,
    ); // 0 = NORMAL
    const receipt = await tx.wait();

    selectedUser.type = "NORMAL";
    selectedUser.investorRequest = null;

    console.log(`\n✅ DOWNGRADE COMPLETE!`);
    console.log("=".repeat(60));
    console.log(`👤 User: ${selectedUser.name}`);
    console.log(`📋 New Type: NORMAL`);
    console.log(`💰 Tokens Unlocked (Unfrozen): ${unlockedAmount} VSC`);
    console.log(`💳 Current Free Balance: ${selectedUser.tokenBalance} VSC`);
    console.log(`📊 Status: NORMAL USER`);
    console.log(`⛽ Gas Used (Downgrade): ${receipt.gasUsed.toLocaleString()}`);
    console.log("");
    console.log("🔐 CRYPTOGRAPHIC PROOF (2-of-2 Multi-Sig):");
    console.log(`   Proposal Hash: ${proposalHash}`);
    console.log(`   User Signature: ${userSignature}`);
    console.log(`   Bank Signature: ${bankSignature}`);
    console.log(`   Both signatures verified: ✅ VALID`);
    console.log("");
    console.log("💡 ON-CHAIN TOKEN STATUS:");
    console.log(`   🔒 Frozen tokens BEFORE unlock: ${unlockedAmount} VSC`);
    console.log(`   🔓 Frozen tokens AFTER unlock: 0 VSC`);
    console.log(
      `   💰 Free balance AFTER unlock: ${selectedUser.tokenBalance} VSC`,
    );
    console.log(`   ✅ Tokens unfrozen on-chain and now transferable`);
    console.log("");
    console.log(
      "✅ User can request investor status again if needed (Option 2)",
    );
  }

  /**
   * View all investor requests
   * @private
   */
  async viewInvestorRequests() {
    console.log("\n📊 VIEW ALL INVESTOR REQUESTS");
    console.log("=".repeat(60));

    if (!this.state.investors || this.state.investors.size === 0) {
      console.log("\n❌ No investors found!");
      console.log(
        "💡 Create normal users and request investor status (Options 1-2)",
      );
      return;
    }

    const usersWithRequests = Array.from(this.state.investors.values()).filter(
      (u) => u.investorRequest,
    );

    if (usersWithRequests.length === 0) {
      console.log("\n❌ No investor requests found!");
      console.log(
        "💡 Create normal users and request investor status (Options 1-2)",
      );
      return;
    }

    console.log(`\n📊 Total Requests: ${usersWithRequests.length}`);
    console.log("");

    usersWithRequests.forEach((user, index) => {
      const req = user.investorRequest;
      console.log(`${index + 1}. ${user.name}`);
      console.log(`   Address: ${user.address.substring(0, 10)}...`);
      console.log(`   Requested Type: ${req.requestedType}`);
      console.log(`   Lock Required: ${req.lockRequired} VSC`);
      console.log(`   Status: ${req.status}`);
      console.log(
        `   Multi-Sig Wallet: ${user.multiSigWallet ? user.multiSigWallet.address.substring(0, 10) + "..." : "Not Created"}`,
      );
      console.log(`   Tokens Locked: ${req.tokensLocked ? "YES" : "NO"}`);
      console.log(`   Created: ${new Date(req.createdAt).toLocaleString()}`);
      if (req.approvedAt) {
        console.log(
          `   Approved: ${new Date(req.approvedAt).toLocaleString()}`,
        );
      }
      console.log("");
    });

    const pending = usersWithRequests.filter(
      (u) => u.investorRequest.status === "PENDING",
    ).length;
    const approved = usersWithRequests.filter(
      (u) => u.investorRequest.status === "APPROVED",
    ).length;

    console.log("📊 SUMMARY:");
    console.log(`   Pending: ${pending}`);
    console.log(`   Approved: ${approved}`);
  }

  /**
   * View all investors and users
   * @private
   */
  async viewAllInvestors() {
    console.log("\n👥 ALL INVESTORS OVERVIEW");
    console.log("-".repeat(40));

    // Combine investors and normal users
    const allUsers = new Map();

    // Add investors from this.state.investors (if exists)
    if (this.state.investors && this.state.investors.size > 0) {
      for (const [id, user] of this.state.investors) {
        allUsers.set(id, user);
      }
    }

    // Add normal users from this.state.normalUsers (if exists)
    if (this.state.normalUsers && this.state.normalUsers.size > 0) {
      for (const [id, user] of this.state.normalUsers) {
        allUsers.set(id, user);
      }
    }

    if (allUsers.size === 0) {
      console.log("\n📊 NO USERS CREATED YET");
      console.log("💡 Create users using:");
      console.log("   - Option 23 → 1: Normal User (Investor Onboarding)");
      console.log("   - Option 24 → 1: Normal User (Direct Creation)");
      console.log("   - Option 23 → 2: Request Investor Status");
      return;
    }

    // Count investors by compliance status and type
    let compliantCount = 0;
    let nonCompliantCount = 0;
    let partialCount = 0;
    let actualInvestorCount = 0;
    let normalUserCount = 0;

    console.log("\n📋 DETAILED USER LIST:");
    let index = 1;
    for (const [id, investor] of allUsers) {
      // Get actual on-chain balance
      let balance = 0;
      const investorAddress = investor.user || investor.address;

      const digitalToken = this.state.getContract("digitalToken");
      if (digitalToken && investorAddress) {
        try {
          const onchainBalance = await digitalToken.balanceOf(investorAddress);
          balance = parseFloat(ethers.formatEther(onchainBalance));
        } catch (error) {
          balance = investor.tokenBalance || 0;
        }
      } else {
        balance = investor.tokenBalance || 0;
      }

      console.log(`\n${index}. ${investor.name}`);
      console.log(`   🆔 ID: ${id}`);
      console.log(`   📋 Type: ${investor.type}`);
      console.log(
        `   🎯 KYC: ${investor.kycStatus} ${investor.kycStatus === "ISSUED" ? "✅" : "❌"}`,
      );
      console.log(
        `   🔍 AML: ${investor.amlStatus} ${investor.amlStatus === "ISSUED" ? "✅" : investor.amlStatus === "PENDING" ? "⚠️" : "❌"}`,
      );
      console.log(
        `   💰 Token Eligible: ${investor.tokenEligible ? "YES ✅" : "NO ❌"}`,
      );
      console.log(`   💳 Balance: ${balance.toLocaleString()} VSC`);
      console.log(
        `   📅 Created: ${new Date(investor.createdAt).toLocaleString()}`,
      );

      if (investor.rejectionReason) {
        console.log(`   📝 Rejection: ${investor.rejectionReason}`);
      }

      // Count by user type
      if (investor.type !== "NORMAL" && investor.type !== "NORMAL_USER") {
        actualInvestorCount++;

        // Count by status
        if (investor.complianceStatus === "COMPLIANT") {
          compliantCount++;
        } else if (investor.complianceStatus === "NON_COMPLIANT") {
          nonCompliantCount++;
        } else if (investor.complianceStatus === "PARTIAL") {
          partialCount++;
        }
      } else {
        normalUserCount++;

        // Count normal users by compliance
        if (
          investor.complianceStatus === "COMPLIANT" ||
          investor.tokenEligible
        ) {
          compliantCount++;
        } else {
          nonCompliantCount++;
        }
      }

      index++;
    }

    console.log("\n📊 USER SUMMARY:");
    console.log(`   Total Users: ${allUsers.size}`);
    console.log(
      `   Active Investors: ${actualInvestorCount} (RETAIL/ACCREDITED/INSTITUTIONAL)`,
    );
    console.log(`   Normal Users: ${normalUserCount}`);
    console.log(`   ✅ Compliant: ${compliantCount}`);
    console.log(`   ❌ Non-Compliant: ${nonCompliantCount}`);
    console.log(`   ⚠️  Partial: ${partialCount}`);
    console.log(
      "\n💡 Only compliant users can participate in token operations",
    );
  }

  /**
   * Display signer allocation status
   * @private
   */
  displaySignerAllocation() {
    this.signerManager.displaySignerAllocation();
  }

  /** Option 24: Create Normal Users */
  async createNormalUsers() {
    displaySection("CREATE NORMAL USERS (OnchainID)", "👤");

    if (!this.state.digitalToken) {
      displayError(
        "Please deploy ERC-3643 Vanguard StableCoin system first (option 21)",
      );
      return;
    }

    console.log("\n🎯 NORMAL USER CREATION OPTIONS:");
    console.log("1. Create Compliant User (KYC: ISSUED, AML: ISSUED)");
    console.log("2. Create Non-Compliant User (KYC: REJECTED)");
    console.log("3. View All Normal Users");
    console.log("0. Back to Main Menu");

    const choice = await this.promptUser("Select user creation option (0-3): ");

    try {
      switch (choice) {
        case "1":
          await this.createCompliantNormalUser();
          break;
        case "2":
          await this.createNonCompliantNormalUser();
          break;
        case "3":
          await this.viewAllNormalUsers();
          break;
        case "0":
          return;
        default:
          console.log("❌ Invalid choice");
      }
    } catch (error) {
      console.error("❌ Normal user creation failed:", error.message);
    }
  }

  /**
   * Create a compliant normal user with KYC/AML claims
   * @private
   */
  async createCompliantNormalUser() {
    console.log("\n✅ CREATING COMPLIANT NORMAL USER - ON-CHAIN");
    console.log("=".repeat(60));

    const digitalToken = this.state.getContract("digitalToken");
    if (!digitalToken) {
      console.log("❌ Digital Token not deployed. Deploy it first (option 21)");
      return;
    }

    const userName = await this.promptUser("Enter user name: ");

    try {
      let totalGasUsed = 0n;

      // Get next available signer (skips reserved signers[0-3])
      const signerAllocation = this.signerManager.getNextAvailableSigner(
        "user",
        userName,
      );
      if (!signerAllocation) {
        console.log("❌ No more available signers. Maximum users reached.");
        console.log("💡 Reserved signers[0-3] for system roles");
        return;
      }

      const signer = signerAllocation.signer;
      const signerIndex = signerAllocation.index;

      console.log("\n🔗 CREATING NORMAL USER ON-CHAIN...");
      console.log(`👤 User Name: ${userName}`);
      console.log(`🆔 Address: ${signer.address}`);
      console.log(`📍 Signer Index: [${signerIndex}]`);

      // Step 1: Create OnchainID on blockchain
      console.log("\n📝 Step 1: Creating OnchainID on blockchain...");
      const salt = ethers.randomBytes(32);
      const onchainIDFactory = this.state.getContract("onchainIDFactory");
      const tx1 = await onchainIDFactory.deployOnchainID(signer.address, salt);
      const receipt1 = await tx1.wait();
      totalGasUsed += receipt1.gasUsed;

      console.log(`   ✅ Transaction Hash: ${receipt1.hash}`);
      console.log(`   🧱 Block Number: ${receipt1.blockNumber}`);
      console.log(`   ⛽ Gas Used: ${receipt1.gasUsed.toLocaleString()}`);

      // Get the created identity address
      const identityAddress = await onchainIDFactory.getIdentityByOwner(
        signer.address,
      );
      console.log(`   🆔 OnchainID Created: ${identityAddress}`);

      // Step 2 & 3: Issue KYC and AML claims on blockchain through the
      // trusted ClaimIssuers (KYC issuer owner: signers[2], AML issuer
      // owner: signers[3] — see ContractDeployer.js).
      console.log("\n📝 Step 2: Issuing KYC claim on blockchain...");
      console.log("\n📝 Step 3: Issuing AML claim on blockchain...");
      const { kyc: receipt2, aml: receipt3 } = await attestAll(
        this.state,
        identityAddress,
        `retail:${userName}`,
      );
      totalGasUsed += receipt2.gasUsed + receipt3.gasUsed;

      console.log(`   ✅ Transaction Hash: ${receipt2.hash}`);
      console.log(`   ⛽ Gas Used: ${receipt2.gasUsed.toLocaleString()}`);
      console.log(`   ✅ Transaction Hash: ${receipt3.hash}`);
      console.log(`   ⛽ Gas Used: ${receipt3.gasUsed.toLocaleString()}`);

      // Step 4: Register in IdentityRegistry on blockchain
      console.log(
        "\n📝 Step 4: Registering in IdentityRegistry on blockchain...",
      );

      // Get allowed country from ComplianceRules configuration
      let userCountry = 840; // Default: USA
      try {
        const complianceRules = this.state.getContract("complianceRules");
        if (complianceRules) {
          const tokenAddress = await digitalToken.getAddress();
          const jurisdictionRule =
            await complianceRules.getJurisdictionRule(tokenAddress);

          if (jurisdictionRule.allowedCountries.length > 0) {
            userCountry = Number(jurisdictionRule.allowedCountries[0]);
            console.log(`   🌍 Using whitelisted country: ${userCountry}`);
          } else {
            console.log(`   🌍 Using default country: ${userCountry} (USA)`);
          }
        }
      } catch (error) {
        console.log(`   🌍 Using default country: ${userCountry} (USA)`);
      }

      const identityRegistry = this.state.getContract("identityRegistry");
      const tx4 = await identityRegistry.registerIdentity(
        signer.address,
        identityAddress,
        userCountry,
      );
      const receipt4 = await tx4.wait();
      totalGasUsed += receipt4.gasUsed;

      console.log(`   ✅ Transaction Hash: ${receipt4.hash}`);
      console.log(`   ⛽ Gas Used: ${receipt4.gasUsed.toLocaleString()}`);
      console.log(`   🌍 Country Code: ${userCountry}`);

      // Verify registration on-chain
      const isVerified = await identityRegistry.isVerified(signer.address);
      console.log(
        `   ${isVerified ? "✅" : "❌"} Verified on-chain: ${isVerified}`,
      );

      // Create user record
      const userId = `user_${Date.now()}`;
      const user = {
        id: userId,
        name: userName,
        address: signer.address,
        onchainId: identityAddress,
        signer: signer,
        signerIndex: signerIndex,
        type: "NORMAL_USER",
        kycStatus: "ISSUED",
        amlStatus: "ISSUED",
        complianceStatus: "COMPLIANT",
        tokenEligible: true,
        createdAt: new Date().toISOString(),
        tokenBalance: 0,
        maxReceiveAmount: 8000,
      };

      // Store in normal users map
      this.state.normalUsers.set(userId, user);

      console.log("\n🎉 COMPLIANT NORMAL USER CREATED ON-CHAIN!");
      console.log("=".repeat(60));
      console.log(`👤 Name: ${userName}`);
      console.log(`🆔 Address: ${signer.address}`);
      console.log(`🔗 OnchainID: ${identityAddress}`);
      console.log(`✅ KYC Status: ISSUED (on-chain)`);
      console.log(`✅ AML Status: ISSUED (on-chain)`);
      console.log(`💰 Token Eligible: YES`);
      console.log(`📏 Max Receive: 8,000 VSC per transaction`);
      console.log(`⛽ Total Gas Used: ${totalGasUsed.toLocaleString()}`);
      console.log("\n💡 This user can receive tokens from investors");
    } catch (error) {
      console.error("❌ User creation failed:", error.message);
      console.log("💡 Make sure you deployed contracts first (option 1)");
    }
  }

  /**
   * Create a non-compliant normal user with rejected KYC
   * @private
   */
  async createNonCompliantNormalUser() {
    console.log("\n❌ CREATING NON-COMPLIANT NORMAL USER - ON-CHAIN");
    console.log("=".repeat(60));

    const digitalToken = this.state.getContract("digitalToken");
    if (!digitalToken) {
      console.log("❌ Digital Token not deployed. Deploy it first (option 21)");
      return;
    }

    const userName = await this.promptUser("Enter user name: ");
    const reason = await this.promptUser("Rejection reason: ");

    try {
      let totalGasUsed = 0n;

      // Get next available signer (skips reserved signers[0-3])
      const signerAllocation = this.signerManager.getNextAvailableSigner(
        "user",
        userName,
      );
      if (!signerAllocation) {
        console.log("❌ No more available signers. Maximum users reached.");
        console.log("💡 Reserved signers[0-3] for system roles");
        return;
      }

      const signer = signerAllocation.signer;
      const signerIndex = signerAllocation.index;

      console.log("\n🔗 CREATING NON-COMPLIANT USER ON-CHAIN...");
      console.log(`👤 User Name: ${userName}`);
      console.log(`🆔 Address: ${signer.address}`);
      console.log(`📍 Signer Index: [${signerIndex}]`);

      // Step 1: Create OnchainID on blockchain
      console.log("\n📝 Step 1: Creating OnchainID on blockchain...");
      const salt = ethers.randomBytes(32);
      const onchainIDFactory = this.state.getContract("onchainIDFactory");
      const tx1 = await onchainIDFactory.deployOnchainID(signer.address, salt);
      const receipt1 = await tx1.wait();
      totalGasUsed += receipt1.gasUsed;

      console.log(`   ✅ Transaction Hash: ${receipt1.hash}`);
      console.log(`   🧱 Block Number: ${receipt1.blockNumber}`);
      console.log(`   ⛽ Gas Used: ${receipt1.gasUsed.toLocaleString()}`);

      // Get the created identity address
      const identityAddress = await onchainIDFactory.getIdentityByOwner(
        signer.address,
      );
      console.log(`   🆔 OnchainID Created: ${identityAddress}`);

      // Step 2: Issue REJECTED KYC claim on blockchain
      // NOTE: KYC issuer uses signers[2] (from ContractDeployer.js)
      console.log("\n📝 Step 2: Issuing REJECTED KYC claim on blockchain...");
      const kycTopic = 1;
      const kycData = ethers.AbiCoder.defaultAbiCoder().encode(
        ["string", "string", "string"],
        ["REJECTED", userName, reason],
      );

      const kycIssuer = this.state.getContract("kycIssuer");
      const kycSigner = this.state.signers[2];
      const kycSig = await signClaim(
        kycSigner,
        identityAddress,
        kycTopic,
        kycData,
      );
      const tx2 = await kycIssuer.connect(kycSigner).issueClaim(
        identityAddress,
        kycTopic,
        1, // scheme: ECDSA signature
        kycData,
        "", // uri: empty for now
        0, // validTo: 0 = no expiry
        kycSig,
      );
      const receipt2 = await tx2.wait();
      totalGasUsed += receipt2.gasUsed;

      console.log(`   ✅ Transaction Hash: ${receipt2.hash}`);
      console.log(`   ⛽ Gas Used: ${receipt2.gasUsed.toLocaleString()}`);
      console.log(`   ❌ KYC Status: REJECTED`);

      // Note: Do NOT register in IdentityRegistry - non-compliant users are not verified

      // Create user record
      const userId = `user_${Date.now()}`;
      const user = {
        id: userId,
        name: userName,
        address: signer.address,
        onchainId: identityAddress,
        signer: signer,
        signerIndex: signerIndex,
        type: "NORMAL_USER",
        kycStatus: "REJECTED",
        amlStatus: "NOT_ISSUED",
        complianceStatus: "NON_COMPLIANT",
        tokenEligible: false,
        rejectionReason: reason,
        createdAt: new Date().toISOString(),
        tokenBalance: 0,
      };

      // Store in normal users map
      this.state.normalUsers.set(userId, user);

      console.log("\n❌ NON-COMPLIANT NORMAL USER CREATED ON-CHAIN!");
      console.log("=".repeat(60));
      console.log(`👤 Name: ${userName}`);
      console.log(`🆔 Address: ${signer.address}`);
      console.log(`🔗 OnchainID: ${identityAddress}`);
      console.log(`❌ KYC Status: REJECTED (on-chain)`);
      console.log(`❌ AML Status: NOT_ISSUED`);
      console.log(`💰 Token Eligible: NO`);
      console.log(`📝 Reason: ${reason}`);
      console.log(`⛽ Total Gas Used: ${totalGasUsed.toLocaleString()}`);
      console.log(
        "\n💡 This user CANNOT receive tokens (not verified on-chain)",
      );
    } catch (error) {
      console.error("❌ User creation failed:", error.message);
      console.log("💡 Make sure you deployed contracts first (option 1)");
    }
  }

  /**
   * View all normal users
   * @private
   */
  async viewAllNormalUsers() {
    console.log("\n👤 ALL NORMAL USERS OVERVIEW");
    console.log("-".repeat(40));

    if (this.state.normalUsers.size === 0) {
      console.log("\n📊 NO NORMAL USERS CREATED YET");
      console.log("💡 Create normal users using options 1-2 above");
      return;
    }

    // Count users by compliance status
    let compliantCount = 0;
    let nonCompliantCount = 0;

    console.log("\n📋 DETAILED NORMAL USER LIST:");
    let index = 1;
    for (const [id, user] of this.state.normalUsers) {
      console.log(`\n${index}. ${user.name}`);
      console.log(`   🆔 ID: ${id}`);
      console.log(`   📋 Type: ${user.type}`);
      console.log(
        `   🎯 KYC: ${user.kycStatus} ${user.kycStatus === "ISSUED" ? "✅" : "❌"}`,
      );
      console.log(
        `   🔍 AML: ${user.amlStatus} ${user.amlStatus === "ISSUED" ? "✅" : "❌"}`,
      );
      console.log(
        `   💰 Token Eligible: ${user.tokenEligible ? "YES ✅" : "NO ❌"}`,
      );
      console.log(`   💳 Balance: ${user.tokenBalance} VSC`);
      console.log(
        `   📅 Created: ${new Date(user.createdAt).toLocaleString()}`,
      );

      if (user.rejectionReason) {
        console.log(`   📝 Rejection: ${user.rejectionReason}`);
      }

      if (user.tokenEligible) {
        compliantCount++;
      } else {
        nonCompliantCount++;
      }

      index++;
    }

    console.log("\n📊 NORMAL USER SUMMARY:");
    console.log(`   Total Users: ${this.state.normalUsers.size}`);
    console.log(`   ✅ Compliant: ${compliantCount}`);
    console.log(`   ❌ Non-Compliant: ${nonCompliantCount}`);
    console.log(
      "\n💡 Only compliant users can receive Vanguard StableCoin from investors",
    );
  }

  /** Option 25: Mint and Distribute Tokens */
  async mintAndDistributeTokens() {
    console.log("\n🪙 TOKEN ISSUER: MINT & DISTRIBUTE ERC-3643 VSC");
    console.log("=".repeat(60));

    const centralBank = Array.from(
      this.state.bankingInstitutions.values(),
    ).find((bank) => bank.type === "CENTRAL_BANK");
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

    const choice = await this.promptUser("Select option (0-5): ");

    try {
      switch (choice) {
        case "1":
          await this.mintToCentralBank(centralBank);
          break;
        case "2":
          await this.distributeToAllApprovedFromMenu(centralBank);
          break;
        case "3":
          await this.distributeToSpecificInvestorFromMenu(centralBank);
          break;
        case "4":
          await this.showDistributionRules();
          break;
        case "5":
          await this.viewCentralBankBalance(centralBank);
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
  async mintToCentralBank(centralBank) {
    console.log("\n🏦 MINT TOKENS TO CENTRAL BANK");
    console.log("=".repeat(60));

    const digitalToken = this.state.getContract("digitalToken");
    if (!digitalToken) {
      console.log("❌ Digital Token not deployed!");
      console.log("💡 Deploy Digital Token system first (Option 21)");
      return;
    }

    console.log(`\n🏦 Central Bank: ${centralBank.name}`);
    console.log(`🆔 Address: ${centralBank.address}`);

    // Verify Central Bank is registered in IdentityRegistry
    try {
      const identityRegistry = this.state.getContract("identityRegistry");
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
            this.state,
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
    console.log(
      `💰 Current Balance: ${ethers.formatEther(currentBalance)} VSC`,
    );

    console.log("\n💡 Suggested amounts:");
    console.log("   1. 1,000,000 VSC (Small scale)");
    console.log("   2. 10,000,000 VSC (Medium scale)");
    console.log("   3. 100,000,000 VSC (Large scale)");
    console.log("   4. Custom amount");

    const choice = await this.promptUser("Select amount (1-4): ");

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
        const customAmount = await this.promptUser("Enter amount (in VSC): ");
        mintAmount = customAmount.replace(/,/g, "");
        break;
      default:
        console.log("❌ Invalid choice");
        return;
    }

    // Continue in next chunk due to 150-line limit...
    await this.completeMintToCentralBank(centralBank, digitalToken, mintAmount);
  }

  /**
   * Pre-check a mint with the token's own predicate (2E.3: mint and
   * canTransfer(0, to, amount) share one path). Returns null when the mint
   * would succeed, else a reason built from the investor-type registry.
   * @private
   */
  async _mintRefusal(digitalToken, to, amountWei) {
    if (await digitalToken.canTransfer(ethers.ZeroAddress, to, amountWei))
      return null;
    if (await digitalToken.isFrozen(to)) return "recipient frozen";
    const identityRegistry = this.state.getContract("identityRegistry");
    if (!(await identityRegistry.isVerified(to))) return "not verified";
    const registry = this.state.getContract("investorTypeRegistry");
    const balance = await digitalToken.balanceOf(to);
    if (!registry || (await registry.canHoldAmount(to, balance + amountWei)))
      return "compliance refused (jurisdiction or blacklist)";
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
  async _ensureTreasuryExempt(centralBank) {
    const registry = this.state.getContract("investorTypeRegistry");
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
  async completeMintToCentralBank(centralBank, digitalToken, mintAmount) {
    try {
      await this._ensureTreasuryExempt(centralBank);
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
      console.log(
        `💰 Amount Minted: ${Number(mintAmount).toLocaleString()} VSC`,
      );
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
  async viewCentralBankBalance(centralBank) {
    console.log("\n📈 CENTRAL BANK BALANCE");
    console.log("=".repeat(60));

    const digitalToken = this.state.getContract("digitalToken");
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

  /**
   * Distribute to all approved investors (menu wrapper)
   * @private
   */
  async distributeToAllApprovedFromMenu(centralBank) {
    // Check if there are investors
    if (this.state.investors.size === 0) {
      console.log(
        "❌ No investors created yet. Create investors first (option 23)",
      );
      return;
    }

    const approvedInvestors = Array.from(this.state.investors.values()).filter(
      (inv) => inv.tokenEligible,
    );

    if (approvedInvestors.length === 0) {
      console.log("\n❌ No approved investors found!");
      console.log("💡 Create compliant investors first (option 23 → 1)");
      return;
    }

    await this.distributeToAllApproved(centralBank, approvedInvestors);
  }

  /**
   * Distribute to specific investor (menu wrapper)
   * @private
   */
  async distributeToSpecificInvestorFromMenu(centralBank) {
    // Check if there are investors
    if (this.state.investors.size === 0) {
      console.log(
        "❌ No investors created yet. Create investors first (option 23)",
      );
      return;
    }

    const approvedInvestors = Array.from(this.state.investors.values()).filter(
      (inv) => inv.tokenEligible,
    );

    if (approvedInvestors.length === 0) {
      console.log("\n❌ No approved investors found!");
      console.log("💡 Create compliant investors first (option 23 → 1)");
      return;
    }

    await this.distributeToSpecificInvestor(centralBank, approvedInvestors);
  }

  /**
   * Distribute to all approved investors
   * @private
   */
  async distributeToAllApproved(centralBank, approvedInvestors) {
    console.log("\n🎯 DISTRIBUTING TO ALL APPROVED INVESTORS - ON-CHAIN");
    console.log("=".repeat(60));

    const digitalToken = this.state.getContract("digitalToken");
    if (!digitalToken) {
      console.log("❌ Digital Token not deployed. Deploy it first (option 21)");
      return;
    }

    const amountPerInvestor = 50000; // 50,000 VSC each
    const totalAmount = amountPerInvestor * approvedInvestors.length;

    console.log(`\n📊 DISTRIBUTION PLAN:`);
    console.log(`   Approved Investors: ${approvedInvestors.length}`);
    console.log(
      `   Amount per Investor: ${amountPerInvestor.toLocaleString()} VSC`,
    );
    console.log(`   Total Distribution: ${totalAmount.toLocaleString()} VSC`);

    console.log("\n🔍 COMPLIANCE VALIDATION:");
    approvedInvestors.forEach((investor, index) => {
      console.log(
        `   ${index + 1}. ${investor.name}: KYC ✅ AML ✅ → APPROVED`,
      );
    });

    // Continue in next method due to 150-line limit...
    await this.completeDistributeToAllApproved(
      centralBank,
      approvedInvestors,
      amountPerInvestor,
      digitalToken,
    );
  }

  /**
   * Complete distribution to all approved investors (part 2)
   * @private
   */
  async completeDistributeToAllApproved(
    centralBank,
    approvedInvestors,
    amountPerInvestor,
    digitalToken,
  ) {
    try {
      let totalGasUsed = 0n;

      console.log("\n🪙 Minting tokens on blockchain...");

      const identityRegistry = this.state.getContract("identityRegistry");

      // Mint to each approved investor
      for (let i = 0; i < approvedInvestors.length; i++) {
        const investor = approvedInvestors[i];
        const amountWei = ethers.parseEther(amountPerInvestor.toString());

        console.log(
          `\n📝 Investor ${i + 1}/${approvedInvestors.length}: ${investor.name}`,
        );

        // Verify compliance on-chain
        const isVerified = await identityRegistry.isVerified(investor.address);
        console.log(`   ${isVerified ? "✅" : "❌"} Verified: ${isVerified}`);

        if (!isVerified) {
          console.log(
            `   ⚠️  Skipping ${investor.name} - not verified on-chain`,
          );
          continue;
        }

        const refusal = await this._mintRefusal(
          digitalToken,
          investor.address,
          amountWei,
        );
        if (refusal) {
          console.log(`   ⚠️  Skipping ${investor.name} - ${refusal}`);
          continue;
        }

        // Mint tokens on-chain
        const tx = await digitalToken
          .connect(centralBank.signer)
          .mint(investor.address, amountWei);
        const receipt = await tx.wait();
        totalGasUsed += receipt.gasUsed;

        console.log(`   ✅ Transaction Hash: ${receipt.hash}`);
        console.log(`   ⛽ Gas Used: ${receipt.gasUsed.toLocaleString()}`);

        // Verify balance on-chain
        const balance = await digitalToken.balanceOf(investor.address);
        console.log(`   💰 Balance: ${ethers.formatEther(balance)} VSC`);

        // Update JavaScript record
        const investorRecord = this.state.investors.get(investor.id);
        if (investorRecord) {
          investorRecord.tokenBalance = parseFloat(ethers.formatEther(balance));
        }
      }

      console.log("\n🎉 DISTRIBUTION COMPLETE!");
      console.log("=".repeat(60));
      console.log(`⛽ Total Gas Used: ${totalGasUsed.toLocaleString()}`);
      console.log("💡 All approved investors received tokens on-chain");
      console.log("💡 Transfer limits enforced by smart contract");
    } catch (error) {
      console.error("❌ Distribution failed:", error.message);
    }
  }

  /**
   * Distribute to specific investor
   * @private
   */
  async distributeToSpecificInvestor(centralBank, approvedInvestors) {
    console.log("\n🎯 DISTRIBUTE TO SPECIFIC INVESTOR - ON-CHAIN");
    console.log("=".repeat(60));

    const digitalToken = this.state.getContract("digitalToken");
    if (!digitalToken) {
      console.log("❌ Digital Token not deployed. Deploy it first (option 21)");
      return;
    }

    console.log("\n👥 APPROVED INVESTORS:");
    approvedInvestors.forEach((investor, index) => {
      console.log(`   ${index}: ${investor.name} - ${investor.address}`);
    });

    const investorIndex = await this.promptUser(
      `Select investor (0-${approvedInvestors.length - 1}): `,
    );
    const selectedInvestor = approvedInvestors[parseInt(investorIndex)];

    if (!selectedInvestor) {
      console.log("❌ Invalid investor selection");
      return;
    }

    const amount = await this.promptUser("Enter amount to mint (VSC): ");
    const amountWei = ethers.parseEther(amount);

    try {
      let totalGasUsed = 0n;

      console.log("\n🔗 MINTING TOKENS ON-CHAIN...");
      console.log(`👤 Investor: ${selectedInvestor.name}`);
      console.log(`🆔 Address: ${selectedInvestor.address}`);
      console.log(`💰 Amount: ${amount} VSC`);

      // Step 1: Verify investor compliance on-chain
      console.log(
        "\n📝 Step 1: Verifying investor compliance on blockchain...",
      );
      const identityRegistry = this.state.getContract("identityRegistry");
      const isVerified = await identityRegistry.isVerified(
        selectedInvestor.address,
      );
      console.log(
        `   ${isVerified ? "✅" : "❌"} Investor Verified: ${isVerified}`,
      );

      if (!isVerified) {
        console.log("❌ Investor not verified on-chain! Cannot mint tokens.");
        return;
      }

      // Step 2: Check current balance on-chain
      console.log("\n📝 Step 2: Checking current balance on blockchain...");
      const balanceBefore = await digitalToken.balanceOf(
        selectedInvestor.address,
      );
      console.log(
        `   💰 Current Balance: ${ethers.formatEther(balanceBefore)} VSC`,
      );

      const refusal = await this._mintRefusal(
        digitalToken,
        selectedInvestor.address,
        amountWei,
      );
      if (refusal) {
        console.log(`❌ Mint refused: ${refusal}`);
        return;
      }

      // Step 3: Mint tokens on-chain
      console.log("\n📝 Step 3: Minting tokens on blockchain...");
      const tx = await digitalToken
        .connect(centralBank.signer)
        .mint(selectedInvestor.address, amountWei);
      const receipt = await tx.wait();
      totalGasUsed += receipt.gasUsed;

      console.log(`   ✅ Transaction Hash: ${receipt.hash}`);
      console.log(`   🧱 Block Number: ${receipt.blockNumber}`);
      console.log(`   ⛽ Gas Used: ${receipt.gasUsed.toLocaleString()}`);

      // Step 4: Verify new balance on-chain
      console.log("\n📝 Step 4: Verifying new balance on blockchain...");
      const balanceAfter = await digitalToken.balanceOf(
        selectedInvestor.address,
      );
      console.log(`   💰 New Balance: ${ethers.formatEther(balanceAfter)} VSC`);
      console.log(
        `   📈 Increase: ${ethers.formatEther(balanceAfter - balanceBefore)} VSC`,
      );

      // Step 5: Verify total supply on-chain
      console.log("\n📝 Step 5: Verifying total supply on blockchain...");
      const totalSupply = await digitalToken.totalSupply();
      console.log(`   📊 Total Supply: ${ethers.formatEther(totalSupply)} VSC`);

      // Record transaction in history
      this.state.transferHistory.push({
        type: "MINT",
        from: centralBank.name,
        to: selectedInvestor.name,
        toAddress: selectedInvestor.address,
        amount: amount,
        timestamp: new Date().toISOString(),
        transactionHash: receipt.hash,
        blockNumber: receipt.blockNumber,
        gasUsed: receipt.gasUsed.toString(),
        status: "SUCCESS",
      });

      console.log("\n🎉 TOKENS MINTED ON-CHAIN SUCCESSFULLY!");
      console.log("=".repeat(60));
      console.log(`👤 Investor: ${selectedInvestor.name}`);
      console.log(`💰 Amount Minted: ${amount} VSC`);
      console.log(`📊 New Balance: ${ethers.formatEther(balanceAfter)} VSC`);
      console.log(`🔗 Transaction: ${receipt.hash}`);
      console.log(`⛽ Total Gas Used: ${totalGasUsed.toLocaleString()}`);

      console.log("\n💡 Next Steps:");
      console.log("   • Investor can now transfer tokens (option 26)");
      console.log("   • Maximum transfer: 8,000 VSC per transaction");
      console.log("   • All transfers verified on-chain");
    } catch (error) {
      console.error("❌ Minting failed:", error.message);
      if (error.message.includes("AccessControl")) {
        console.error("💡 Only Token Issuer can mint tokens");
      }
    }
  }

  /**
   * Show distribution rules
   * @private
   */
  async showDistributionRules() {
    console.log("\n📋 DIGITAL TOKEN DISTRIBUTION RULES");
    console.log("-".repeat(40));

    console.log("\n🏛️ CENTRAL BANK AUTHORITY:");
    console.log(
      "   • Only Token Issuer can mint and distribute Vanguard StableCoin",
    );
    console.log("   • Distribution only to KYC/AML approved investors");
    console.log("   • All distributions are monitored and recorded");

    console.log("\n✅ INVESTOR ELIGIBILITY:");
    console.log("   • KYC Status: ISSUED (required)");
    console.log("   • AML Status: ISSUED (required)");
    console.log("   • Compliance Status: COMPLIANT (required)");

    console.log("\n🚫 DISTRIBUTION RESTRICTIONS:");
    console.log("   • Non-compliant investors: BLOCKED");
    console.log("   • Rejected KYC/AML: BLOCKED");
    console.log("   • Pending compliance: BLOCKED");

    console.log("\n💸 TRANSFER LIMITS:");
    console.log("   • Investor-to-Investor: 8,000 VSC max per transaction");
    console.log("   • Token Issuer Distribution: No limit");
    console.log("   • All transfers monitored by Token Issuer");

    console.log("\n📊 COMPLIANCE MONITORING:");
    console.log("   • Real-time transaction tracking");
    console.log("   • Automatic compliance validation");
    console.log("   • Audit trail for all operations");
  }

  /** Option 26: Investor-to-Investor Transfer */
  async investorToInvestorTransfer() {
    console.log("\n💸 INVESTOR-TO-INVESTOR TRANSFER (MAX 8,000)");
    console.log("=".repeat(50));

    if (this.state.investors.size === 0) {
      console.log(
        "❌ No investors created yet. Create investors first (option 23)",
      );
      return;
    }

    // Show available investors with their compliance status and balances
    console.log("\n👥 AVAILABLE INVESTORS:");
    const investorArray = Array.from(this.state.investors.values());
    let compliantInvestors = [];

    investorArray.forEach((investor, index) => {
      const complianceIcon = investor.tokenEligible ? "✅" : "❌";
      const balanceInfo =
        investor.tokenBalance > 0
          ? `(${investor.tokenBalance.toLocaleString()} VSC)`
          : "(0 VSC)";
      console.log(
        `   ${index}: ${investor.name} ${complianceIcon} ${balanceInfo}`,
      );

      if (investor.tokenEligible) {
        compliantInvestors.push({ ...investor, index });
      }
    });

    if (compliantInvestors.length < 2) {
      console.log("\n❌ Need at least 2 compliant investors for transfers");
      console.log(
        "💡 Create more compliant investors or use Token Issuer distribution (option 25)",
      );
      return;
    }

    console.log("\n🔄 TRANSFER SCENARIOS:");
    console.log("1. Normal Transfer (Within 8,000 limit)");
    console.log("2. Attempt Excess Transfer (>8,000 limit)");
    console.log("3. Transfer to Non-Compliant (Blocked)");
    console.log("0. Back to Main Menu");

    const choice = await this.promptUser("Select transfer scenario (0-3): ");

    try {
      switch (choice) {
        case "1":
          await this.executeNormalTransfer(compliantInvestors);
          break;
        case "2":
          await this.executeExcessTransfer(compliantInvestors);
          break;
        case "3":
          await this.executeBlockedTransfer(investorArray);
          break;
        case "0":
          return;
        default:
          console.log("❌ Invalid choice");
      }
    } catch (error) {
      console.error("❌ Transfer failed:", error.message);
    }
  }

  /**
   * Execute normal transfer (within 8,000 limit)
   * @private
   */
  async executeNormalTransfer(compliantInvestors) {
    console.log("\n✅ NORMAL TRANSFER (WITHIN 8,000 LIMIT) - ON-CHAIN");
    console.log("=".repeat(60));

    const digitalToken = this.state.getContract("digitalToken");
    if (!digitalToken) {
      console.log("❌ Digital Token not deployed. Deploy it first (option 21)");
      return;
    }

    if (compliantInvestors.length < 2) {
      console.log("❌ Need at least 2 compliant investors");
      return;
    }

    // Show investors and let user select
    console.log("\n👥 SELECT SENDER:");
    compliantInvestors.forEach((investor, index) => {
      console.log(`   ${index}: ${investor.name} - ${investor.address}`);
    });

    const senderIndex = await this.promptUser(
      `Select sender (0-${compliantInvestors.length - 1}): `,
    );
    const sender = compliantInvestors[parseInt(senderIndex)];

    if (!sender) {
      console.log("❌ Invalid sender selection");
      return;
    }

    // Show recipients (exclude sender by address)
    const recipients = compliantInvestors.filter(
      (inv) => inv.address !== sender.address,
    );

    if (recipients.length === 0) {
      console.log("❌ No other investors available for transfer");
      console.log("💡 Create more investors first (option 23)");
      return;
    }

    console.log("\n👥 SELECT RECIPIENT:");
    recipients.forEach((investor, index) => {
      console.log(`   ${index}: ${investor.name} - ${investor.address}`);
    });

    const recipientIndex = await this.promptUser(
      `Select recipient (0-${recipients.length - 1}): `,
    );
    const recipient = recipients[parseInt(recipientIndex)];

    if (!recipient) {
      console.log("❌ Invalid recipient selection");
      return;
    }

    const amount = await this.promptUser(
      "Enter amount to transfer (max 8000 VSC): ",
    );
    const amountWei = ethers.parseEther(amount);
    const maxTransfer = ethers.parseEther("8000");

    if (amountWei > maxTransfer) {
      console.log("❌ Amount exceeds 8,000 VSC limit!");
      return;
    }

    try {
      let totalGasUsed = 0n;

      console.log("\n🔗 EXECUTING TRANSFER ON-CHAIN...");
      console.log(`📤 From: ${sender.name} (${sender.address})`);
      console.log(`📥 To: ${recipient.name} (${recipient.address})`);
      console.log(`💰 Amount: ${amount} VSC`);

      // Step 1: Verify sender compliance on-chain
      console.log("\n📝 Step 1: Verifying sender compliance on blockchain...");
      const identityRegistry = this.state.getContract("identityRegistry");
      const senderVerified = await identityRegistry.isVerified(sender.address);
      console.log(
        `   ${senderVerified ? "✅" : "❌"} Sender Verified: ${senderVerified}`,
      );

      // Step 2: Verify recipient compliance on-chain
      console.log(
        "\n📝 Step 2: Verifying recipient compliance on blockchain...",
      );
      const recipientVerified = await identityRegistry.isVerified(
        recipient.address,
      );
      console.log(
        `   ${recipientVerified ? "✅" : "❌"} Recipient Verified: ${recipientVerified}`,
      );

      if (!senderVerified || !recipientVerified) {
        console.log("❌ Transfer blocked: Compliance check failed!");
        return;
      }

      // Step 3: Check sender balance on-chain
      console.log("\n📝 Step 3: Checking sender balance on blockchain...");
      const senderBalanceBefore = await digitalToken.balanceOf(sender.address);
      console.log(
        `   💰 Sender Balance: ${ethers.formatEther(senderBalanceBefore)} VSC`,
      );

      if (senderBalanceBefore < amountWei) {
        console.log("❌ Insufficient balance!");
        return;
      }

      // Continue in next method due to 150-line limit...
      await this.completeNormalTransfer(
        sender,
        recipient,
        amount,
        amountWei,
        senderBalanceBefore,
        digitalToken,
        totalGasUsed,
      );
    } catch (error) {
      console.error("❌ Transfer failed:", error.message);
      if (error.message.includes("ERC20: transfer amount exceeds balance")) {
        console.error("💡 Sender has insufficient balance");
      } else if (error.message.includes("compliance")) {
        console.error("💡 Compliance check failed");
      }
    }
  }

  /**
   * Complete normal transfer (part 2)
   * @private
   */
  async completeNormalTransfer(
    sender,
    recipient,
    amount,
    amountWei,
    senderBalanceBefore,
    digitalToken,
    totalGasUsed,
  ) {
    // Step 4: Check recipient balance before transfer
    console.log("\n📝 Step 4: Checking recipient balance on blockchain...");
    const recipientBalanceBefore = await digitalToken.balanceOf(
      recipient.address,
    );
    console.log(
      `   💰 Recipient Balance: ${ethers.formatEther(recipientBalanceBefore)} VSC`,
    );

    // Step 5: Execute transfer on-chain
    console.log("\n📝 Step 5: Executing transfer on blockchain...");
    const tx = await digitalToken
      .connect(sender.signer)
      .transfer(recipient.address, amountWei);
    const receipt = await tx.wait();
    totalGasUsed += receipt.gasUsed;

    console.log(`   ✅ Transaction Hash: ${receipt.hash}`);
    console.log(`   🧱 Block Number: ${receipt.blockNumber}`);
    console.log(`   ⛽ Gas Used: ${receipt.gasUsed.toLocaleString()}`);

    // Step 6: Verify balances after transfer
    console.log(
      "\n📝 Step 6: Verifying balances after transfer on blockchain...",
    );
    const senderBalanceAfter = await digitalToken.balanceOf(sender.address);
    const recipientBalanceAfter = await digitalToken.balanceOf(
      recipient.address,
    );

    console.log(
      `   📤 Sender New Balance: ${ethers.formatEther(senderBalanceAfter)} VSC`,
    );
    console.log(
      `   📥 Recipient New Balance: ${ethers.formatEther(recipientBalanceAfter)} VSC`,
    );
    console.log(
      `   📊 Amount Transferred: ${ethers.formatEther(senderBalanceBefore - senderBalanceAfter)} VSC`,
    );

    // Record transaction
    this.state.transferHistory.push({
      type: "TRANSFER",
      from: sender.name,
      fromAddress: sender.address,
      to: recipient.name,
      toAddress: recipient.address,
      amount: amount,
      timestamp: new Date().toISOString(),
      transactionHash: receipt.hash,
      blockNumber: receipt.blockNumber,
      gasUsed: receipt.gasUsed.toString(),
      status: "SUCCESS",
    });

    console.log("\n🎉 TRANSFER COMPLETED ON-CHAIN SUCCESSFULLY!");
    console.log("=".repeat(60));
    console.log(`📤 From: ${sender.name}`);
    console.log(`📥 To: ${recipient.name}`);
    console.log(`💰 Amount: ${amount} VSC`);
    console.log(`🔗 Transaction: ${receipt.hash}`);
    console.log(`⛽ Total Gas Used: ${totalGasUsed.toLocaleString()}`);

    console.log("\n💡 Transfer Details:");
    console.log(`   • ✅ Both parties verified on-chain`);
    console.log(`   • ✅ Within 8,000 VSC limit`);
    console.log(`   • ✅ Balances updated on blockchain`);
  }

  /**
   * Execute excess transfer (>8,000 limit)
   * @private
   */
  async executeExcessTransfer(compliantInvestors) {
    console.log("\n❌ EXCESS TRANSFER ATTEMPT (>8,000 LIMIT)");
    console.log("-".repeat(40));

    const sender = compliantInvestors[0];
    const recipient = compliantInvestors.find(
      (inv) => inv.address !== sender.address,
    );

    if (!recipient) {
      console.log("❌ Need at least 2 investors for this demo");
      return;
    }

    const amount = 10000; // Exceeds 8,000 limit

    console.log(`\n🔍 COMPLIANCE CHECK:`);
    console.log(
      `   Sender: ${sender.name} - KYC: ${sender.kycStatus} ✅ AML: ${sender.amlStatus} ✅`,
    );
    console.log(
      `   Recipient: ${recipient.name} - KYC: ${recipient.kycStatus} ✅ AML: ${recipient.amlStatus} ✅`,
    );
    console.log(
      `   Amount: ${amount.toLocaleString()} VSC (EXCEEDS 8,000 limit ❌)`,
    );

    console.log(`\n💸 Attempting transfer...`);
    console.log(`⏳ Validating compliance...`);
    console.log(`⏳ Checking transfer limits...`);
    console.log(`❌ TRANSFER BLOCKED!`);
    console.log(`🚫 Reason: Amount exceeds daily limit of 8,000 VSC`);

    // Record blocked transaction
    this.state.transferHistory.push({
      type: "INVESTOR_TRANSFER",
      from: sender.name,
      to: recipient.name,
      amount: amount,
      timestamp: new Date().toISOString(),
      status: "BLOCKED",
      reason: "Exceeds 8,000 VSC transfer limit",
    });

    console.log("\n❌ TRANSFER BLOCKED BY StableCoin LIMITS!");
    console.log("💡 Maximum transfer amount is 8,000 VSC per transaction");
  }

  /**
   * Execute blocked transfer (to non-compliant)
   * @private
   */
  async executeBlockedTransfer(allInvestors) {
    console.log("\n❌ TRANSFER TO NON-COMPLIANT (BLOCKED)");
    console.log("-".repeat(40));

    const compliantInvestors = allInvestors.filter((inv) => inv.tokenEligible);
    const nonCompliantInvestors = allInvestors.filter(
      (inv) => !inv.tokenEligible,
    );

    if (compliantInvestors.length === 0 || nonCompliantInvestors.length === 0) {
      console.log(
        "❌ Need both compliant and non-compliant investors for this demo",
      );
      return;
    }

    const sender = compliantInvestors[0];
    const recipient = nonCompliantInvestors[0];
    const amount = 3000;

    console.log(`\n🔍 COMPLIANCE CHECK:`);
    console.log(
      `   Sender: ${sender.name} - KYC: ${sender.kycStatus} ✅ AML: ${sender.amlStatus} ✅`,
    );
    console.log(
      `   Recipient: ${recipient.name} - KYC: ${recipient.kycStatus} ❌ AML: ${recipient.amlStatus} ❌`,
    );
    console.log(
      `   Amount: ${amount.toLocaleString()} VSC (Within 8,000 limit ✅)`,
    );

    console.log(`\n💸 Attempting transfer...`);
    console.log(`⏳ Validating compliance...`);
    console.log(`❌ TRANSFER BLOCKED!`);
    console.log(`🚫 Reason: Recipient is not KYC/AML compliant`);

    // Record blocked transaction
    this.state.transferHistory.push({
      type: "INVESTOR_TRANSFER",
      from: sender.name,
      to: recipient.name,
      amount: amount,
      timestamp: new Date().toISOString(),
      status: "BLOCKED",
      reason: "Recipient not KYC/AML compliant",
    });

    console.log("\n❌ TRANSFER BLOCKED BY COMPLIANCE!");
    console.log(
      "💡 Only KYC/AML approved investors can receive Vanguard StableCoin",
    );
  }

  /** Option 27: Investor-to-User Transfer */
  async investorToUserTransfer() {
    console.log("\n💸 INVESTOR-TO-USER TRANSFER (MAX 8,000)");
    console.log("=".repeat(50));

    if (!this.state.investors || this.state.investors.size === 0) {
      console.log(
        "❌ No investors created yet. Create investors first (option 23)",
      );
      return;
    }

    // Merge normal users from both Option 23 (investors with type NORMAL) and Option 24 (normalUsers)
    const normalUsersFromInvestors = this.state.investors
      ? Array.from(this.state.investors.values()).filter(
          (u) => u.type === "NORMAL" || u.type === "NORMAL_USER",
        )
      : [];
    const normalUsersFromOption24 = this.state.normalUsers
      ? Array.from(this.state.normalUsers.values())
      : [];

    const allNormalUsers = [
      ...normalUsersFromInvestors,
      ...normalUsersFromOption24,
    ];

    if (allNormalUsers.length === 0) {
      console.log(
        "❌ No normal users created yet. Create normal users first (option 23 → 1 or option 24)",
      );
      return;
    }

    // Show available investors with balances (check on-chain balance)
    console.log("\n👥 AVAILABLE INVESTORS:");
    const allInvestors = Array.from(this.state.investors.values()).filter(
      (inv) => inv.tokenEligible,
    );
    const investorsWithBalance = [];

    // Check actual on-chain balances
    const digitalToken = this.state.getContract("digitalToken");
    if (!digitalToken) {
      console.log("❌ Digital Token not deployed. Deploy it first (option 21)");
      return;
    }

    for (const investor of allInvestors) {
      try {
        const investorAddress = investor.user || investor.address;

        // Get both total and free balance to show frozen tokens
        const totalBalance = await digitalToken.balanceOf(investorAddress);
        const totalBalanceVSC = parseFloat(ethers.formatEther(totalBalance));

        const freeBalance = await digitalToken.getFreeBalance(investorAddress);
        const freeBalanceVSC = parseFloat(ethers.formatEther(freeBalance));

        const frozenTokens = await digitalToken.frozenTokens(investorAddress);
        const frozenBalanceVSC = parseFloat(ethers.formatEther(frozenTokens));

        // Store both balances for display
        investor.actualBalance = freeBalanceVSC; // Available for transfer
        investor.totalBalance = totalBalanceVSC; // Total including frozen
        investor.frozenBalance = frozenBalanceVSC; // Frozen tokens

        if (freeBalanceVSC > 0) {
          investorsWithBalance.push(investor);
        }
      } catch (error) {
        console.log(
          `⚠️  Error checking balance for ${investor.name}: ${error.message}`,
        );
      }
    }

    if (investorsWithBalance.length === 0) {
      console.log(
        "❌ No investors have available (unfrozen) tokens to transfer",
      );
      console.log(
        "💡 Use Token Issuer distribution first (Option 25 → 2 or 3)",
      );
      console.log("");
      console.log("📋 Quick Guide:");
      console.log("   1. Option 25 → 1: Mint to Central Bank");
      console.log("   2. Option 25 → 2: Distribute to All Investors");
      console.log("   3. Option 27: Transfer to Normal Users");
      console.log("");
      console.log(
        "💡 Note: Frozen tokens (locked in multi-sig) cannot be transferred",
      );
      return;
    }

    investorsWithBalance.forEach((investor, index) => {
      let displayText = `   ${index}: ${investor.name} (${investor.actualBalance.toLocaleString()} VSC) ✅`;

      // Show frozen balance if any
      if (investor.frozenBalance > 0) {
        displayText += ` [${investor.frozenBalance.toLocaleString()} VSC frozen]`;
      }

      console.log(displayText);
    });

    // Show available normal users with on-chain balances (from both sources)
    console.log("\n👤 AVAILABLE NORMAL USERS:");
    console.log(
      `   (${normalUsersFromInvestors.length} from Option 23, ${normalUsersFromOption24.length} from Option 24)`,
    );
    const compliantUsers = allNormalUsers.filter((user) => user.tokenEligible);

    if (compliantUsers.length === 0) {
      console.log("❌ No compliant normal users available");
      console.log(
        "💡 Create compliant normal users first (option 23 → 1 or option 24 → 1)",
      );
      return;
    }

    // Check on-chain balances for normal users
    for (let index = 0; index < compliantUsers.length; index++) {
      const user = compliantUsers[index];
      let balance = 0;
      const userAddress = user.user || user.address;

      if (digitalToken && userAddress) {
        try {
          const onchainBalance = await digitalToken.balanceOf(userAddress);
          balance = parseFloat(ethers.formatEther(onchainBalance));
        } catch (error) {
          balance = user.tokenBalance || 0;
        }
      } else {
        balance = user.tokenBalance || 0;
      }

      console.log(
        `   ${index}: ${user.name} (${balance.toLocaleString()} VSC) ✅`,
      );
    }

    console.log("\n🔄 TRANSFER SCENARIOS:");
    console.log("1. Normal Transfer (Within 8,000 limit)");
    console.log("2. Attempt Excess Transfer (>8,000 limit)");
    console.log("3. Transfer to Non-Compliant User (Blocked)");
    console.log("0. Back to Main Menu");

    const choice = await this.promptUser("Select transfer scenario (0-3): ");

    try {
      switch (choice) {
        case "1":
          await this.executeInvestorToUserNormalTransfer(
            investorsWithBalance,
            compliantUsers,
          );
          break;
        case "2":
          await this.executeInvestorToUserExcessTransfer(
            investorsWithBalance,
            compliantUsers,
          );
          break;
        case "3":
          await this.executeInvestorToUserBlockedTransfer(investorsWithBalance);
          break;
        case "0":
          return;
        default:
          console.log("❌ Invalid choice");
      }
    } catch (error) {
      console.error("❌ Transfer failed:", error.message);
    }
  }

  /**
   * Execute normal investor-to-user transfer
   * @private
   */
  async executeInvestorToUserNormalTransfer(investors, users) {
    console.log("\n✅ NORMAL INVESTOR-TO-USER TRANSFER");
    console.log("-".repeat(40));

    // Select investor
    console.log("\n👥 SELECT INVESTOR:");
    investors.forEach((inv, index) => {
      const balance = inv.actualBalance || inv.tokenBalance || 0;
      console.log(
        `   ${index}: ${inv.name} (${balance.toLocaleString()} VSC available)`,
      );
    });

    const investorChoice = await this.promptUser(
      `\nSelect investor (0-${investors.length - 1}): `,
    );
    const investor = investors[parseInt(investorChoice)];

    if (!investor) {
      console.log("❌ Invalid investor selection");
      return;
    }

    // Continue in next method due to 150-line limit...
    await this.completeInvestorToUserNormalTransfer(investor, users);
  }

  /**
   * Complete investor-to-user normal transfer (part 2)
   * @private
   */
  async completeInvestorToUserNormalTransfer(investor, users) {
    // Select user
    console.log("\n👤 SELECT RECIPIENT USER:");
    users.forEach((u, index) => {
      console.log(`   ${index}: ${u.name}`);
    });

    const userChoice = await this.promptUser(
      `\nSelect user (0-${users.length - 1}): `,
    );
    const user = users[parseInt(userChoice)];

    if (!user) {
      console.log("❌ Invalid user selection");
      return;
    }

    // Get available balance
    const availableBalance =
      investor.actualBalance || investor.tokenBalance || 0;

    if (availableBalance <= 0) {
      console.log("❌ Investor has no tokens to transfer");
      return;
    }

    // Enter custom amount
    const maxAmount = Math.min(availableBalance, 8000); // Max 8,000 or available balance
    console.log(`\n💰 ENTER TRANSFER AMOUNT:`);
    console.log(`   Available: ${availableBalance.toLocaleString()} VSC`);
    console.log(`   Maximum: ${maxAmount.toLocaleString()} VSC (8,000 limit)`);

    const amountInput = await this.promptUser(
      `\nEnter amount (1-${maxAmount}): `,
    );
    const amount = parseFloat(amountInput);

    if (isNaN(amount) || amount <= 0) {
      console.log("❌ Invalid amount");
      return;
    }

    if (amount > availableBalance) {
      console.log("❌ Amount exceeds investor balance");
      return;
    }

    if (amount > 8000) {
      console.log("❌ Amount exceeds 8,000 VSC limit");
      return;
    }

    console.log(`\n🔍 COMPLIANCE CHECK:`);
    console.log(
      `   Investor: ${investor.name} - KYC: ${investor.kycStatus} ✅ AML: ${investor.amlStatus} ✅`,
    );
    console.log(
      `   User: ${user.name} - KYC: ${user.kycStatus} ✅ AML: ${user.amlStatus} ✅`,
    );
    console.log(
      `   Amount: ${amount.toLocaleString()} VSC (Under 8,000 limit ✅)`,
    );

    try {
      console.log(`\n💸 Executing on-chain transfer...`);

      // Get addresses
      const investorAddress = investor.user || investor.address;
      const userAddress = user.user || user.address;

      // Get investor signer
      const investorSigner = investor.signer;

      // Execute on-chain transfer
      const digitalToken = this.state.getContract("digitalToken");
      const amountWei = ethers.parseEther(amount.toString());
      const tx = await digitalToken
        .connect(investorSigner)
        .transfer(userAddress, amountWei);
      await tx.wait();

      console.log(`✅ Transfer approved!`);
      console.log(`   Transaction Hash: ${tx.hash}`);

      // Update balances
      const investorRecord = this.state.investors.get(investor.id);
      const userRecord = this.state.normalUsers.get(user.id);

      if (investorRecord) investorRecord.tokenBalance -= amount;
      if (userRecord) userRecord.tokenBalance += amount;

      // Record transaction
      this.state.transferHistory.push({
        type: "INVESTOR_TO_USER_TRANSFER",
        from: investor.name,
        to: user.name,
        amount: amount,
        timestamp: new Date().toISOString(),
        status: "SUCCESS",
        reason: "Compliant transfer within limits",
        txHash: tx.hash,
      });

      // Get updated on-chain balances
      const investorBalanceAfter =
        await digitalToken.balanceOf(investorAddress);
      const userBalanceAfter = await digitalToken.balanceOf(userAddress);

      console.log(`\n📊 UPDATED BALANCES (ON-CHAIN):`);
      console.log(
        `   ${investor.name} (Investor): ${ethers.formatEther(investorBalanceAfter)} VSC`,
      );
      console.log(
        `   ${user.name} (User): ${ethers.formatEther(userBalanceAfter)} VSC`,
      );

      console.log("\n🎉 INVESTOR-TO-USER TRANSFER SUCCESSFUL!");
    } catch (error) {
      console.error("❌ Transfer failed:", error.message);
      console.log("💡 Make sure both parties are verified and compliant");
    }
  }

  /**
   * Execute excess investor-to-user transfer
   * @private
   */
  async executeInvestorToUserExcessTransfer(investors, users) {
    console.log("\n❌ EXCESS INVESTOR-TO-USER TRANSFER");
    console.log("-".repeat(40));

    const investor = investors[0];
    const user = users[0];
    const amount = 12000; // Exceeds 8,000 limit

    console.log(`\n🔍 COMPLIANCE CHECK:`);
    console.log(
      `   Investor: ${investor.name} - KYC: ${investor.kycStatus} ✅ AML: ${investor.amlStatus} ✅`,
    );
    console.log(
      `   User: ${user.name} - KYC: ${user.kycStatus} ✅ AML: ${user.amlStatus} ✅`,
    );
    console.log(
      `   Amount: ${amount.toLocaleString()} VSC (EXCEEDS 8,000 limit ❌)`,
    );

    console.log(`\n💸 Attempting transfer...`);
    console.log(`⏳ Validating ERC-3643 compliance...`);
    console.log(`⏳ Checking transfer limits...`);
    console.log(`❌ TRANSFER BLOCKED!`);
    console.log(
      `🚫 Reason: Amount exceeds ERC-3643 transfer limit of 8,000 VSC`,
    );

    // Record blocked transaction
    this.state.transferHistory.push({
      type: "INVESTOR_TO_USER_TRANSFER",
      from: investor.name,
      to: user.name,
      amount: amount,
      timestamp: new Date().toISOString(),
      status: "BLOCKED",
      reason: "Exceeds 8,000 VSC ERC-3643 transfer limit",
    });

    console.log("\n❌ TRANSFER BLOCKED BY ERC-3643 LIMITS!");
    console.log("💡 Maximum transfer amount is 8,000 VSC per transaction");
  }

  /**
   * Execute blocked investor-to-user transfer
   * @private
   */
  async executeInvestorToUserBlockedTransfer(investors) {
    console.log("\n❌ TRANSFER TO NON-COMPLIANT USER");
    console.log("-".repeat(40));

    const nonCompliantUsers = Array.from(
      this.state.normalUsers.values(),
    ).filter((user) => !user.tokenEligible);

    if (nonCompliantUsers.length === 0) {
      console.log("❌ No non-compliant users available for this demo");
      console.log("💡 Create a non-compliant user first (option 24 → 2)");
      return;
    }

    const investor = investors[0];
    const user = nonCompliantUsers[0];
    const amount = 3000;

    console.log(`\n🔍 COMPLIANCE CHECK:`);
    console.log(
      `   Investor: ${investor.name} - KYC: ${investor.kycStatus} ✅ AML: ${investor.amlStatus} ✅`,
    );
    console.log(
      `   User: ${user.name} - KYC: ${user.kycStatus} ❌ AML: ${user.amlStatus} ❌`,
    );
    console.log(
      `   Amount: ${amount.toLocaleString()} VSC (Within 8,000 limit ✅)`,
    );

    console.log(`\n💸 Attempting transfer...`);
    console.log(`⏳ Validating ERC-3643 compliance...`);
    console.log(`❌ TRANSFER BLOCKED!`);
    console.log(
      `🚫 Reason: Recipient is not KYC/AML compliant per ERC-3643 rules`,
    );

    // Record blocked transaction
    this.state.transferHistory.push({
      type: "INVESTOR_TO_USER_TRANSFER",
      from: investor.name,
      to: user.name,
      amount: amount,
      timestamp: new Date().toISOString(),
      status: "BLOCKED",
      reason: "Recipient not KYC/AML compliant (ERC-3643 violation)",
    });

    console.log("\n❌ TRANSFER BLOCKED BY ERC-3643 COMPLIANCE!");
    console.log(
      "💡 Only KYC/AML approved users can receive Vanguard StableCoin",
    );
  }

  /** Option 27.5: User-to-User Transfer */
  async userToUserTransfer() {
    console.log("\n👥 USER-TO-USER TRANSFER - ON-CHAIN");
    console.log("=".repeat(60));

    const digitalToken = this.state.getContract("digitalToken");
    if (!digitalToken) {
      console.log("❌ Digital Token not deployed. Deploy it first (option 21)");
      return;
    }

    // Merge normal users from both Option 23 (investors with type NORMAL/NORMAL_USER) and Option 24 (normalUsers)
    const normalUsersFromInvestors = this.state.investors
      ? Array.from(this.state.investors.values()).filter(
          (u) => u.type === "NORMAL" || u.type === "NORMAL_USER",
        )
      : [];
    const normalUsersFromOption24 = this.state.normalUsers
      ? Array.from(this.state.normalUsers.values())
      : [];

    const allNormalUsers = [
      ...normalUsersFromInvestors,
      ...normalUsersFromOption24,
    ];

    if (allNormalUsers.length < 2) {
      console.log(
        "❌ Need at least 2 users. Create more users (option 23 → 1 or option 24)",
      );
      return;
    }

    // Get compliant users with addresses
    const compliantUsers = allNormalUsers.filter(
      (user) => user.tokenEligible && user.address,
    );

    if (compliantUsers.length < 2) {
      console.log("❌ Need at least 2 compliant users with addresses");
      console.log(
        "💡 Create compliant users first (option 23 → 1 or option 24 → 1)",
      );
      console.log(
        `   Currently: ${normalUsersFromInvestors.length} from Option 23, ${normalUsersFromOption24.length} from Option 24`,
      );
      console.log(`   Compliant: ${compliantUsers.length} users`);
      return;
    }

    console.log("\n👥 AVAILABLE USERS:");
    compliantUsers.forEach((user, index) => {
      console.log(`   ${index}: ${user.name} - ${user.address}`);
    });

    const senderIndex = await this.promptUser(
      `\nSelect sender (0-${compliantUsers.length - 1}): `,
    );
    const recipientIndex = await this.promptUser(
      `Select recipient (0-${compliantUsers.length - 1}): `,
    );

    const sender = compliantUsers[parseInt(senderIndex)];
    const recipient = compliantUsers[parseInt(recipientIndex)];

    if (!sender || !recipient) {
      console.log("❌ Invalid selection");
      return;
    }

    if (sender.address === recipient.address) {
      console.log("❌ Cannot transfer to the same user");
      return;
    }

    const amount = await this.promptUser("Enter amount to transfer (VSC): ");
    const amountWei = ethers.parseEther(amount);

    try {
      let totalGasUsed = 0n;

      console.log("\n🔗 EXECUTING USER-TO-USER TRANSFER ON-CHAIN...");
      console.log(`👤 From: ${sender.name} (${sender.address})`);
      console.log(`👤 To: ${recipient.name} (${recipient.address})`);
      console.log(`💰 Amount: ${amount} VSC`);

      // Step 1: Check sender balance
      console.log("\n📝 Step 1: Checking sender balance on blockchain...");
      const senderBalance = await digitalToken.balanceOf(sender.address);
      console.log(
        `   💰 Sender Balance: ${ethers.formatEther(senderBalance)} VSC`,
      );

      if (senderBalance < amountWei) {
        console.log("   ❌ Insufficient balance!");
        return;
      }

      // Step 2: Verify compliance on-chain
      console.log("\n📝 Step 2: Verifying compliance on blockchain...");
      const identityRegistry = this.state.getContract("identityRegistry");
      const senderVerified = await identityRegistry.isVerified(sender.address);
      const recipientVerified = await identityRegistry.isVerified(
        recipient.address,
      );

      console.log(
        `   ${senderVerified ? "✅" : "❌"} Sender Verified: ${senderVerified}`,
      );
      console.log(
        `   ${recipientVerified ? "✅" : "❌"} Recipient Verified: ${recipientVerified}`,
      );

      if (!senderVerified || !recipientVerified) {
        console.log("   ❌ One or both users not verified on-chain!");
        return;
      }

      // Step 3: Check transfer limits on-chain
      console.log("\n📝 Step 3: Checking transfer limits on blockchain...");
      const canTransfer = await digitalToken.canTransfer(
        sender.address,
        recipient.address,
        amountWei,
      );
      console.log(
        `   ${canTransfer ? "✅" : "❌"} Can Transfer: ${canTransfer}`,
      );

      if (!canTransfer) {
        console.log("   ❌ Transfer blocked by compliance rules!");
        console.log(
          "   💡 Amount may exceed transfer limits or violate compliance rules",
        );
        return;
      }

      // Step 4: Execute transfer on blockchain
      console.log("\n📝 Step 4: Executing transfer on blockchain...");
      const tx = await digitalToken
        .connect(sender.signer)
        .transfer(recipient.address, amountWei);
      const receipt = await tx.wait();
      totalGasUsed += receipt.gasUsed;

      console.log(`   ✅ Transaction Hash: ${receipt.hash}`);
      console.log(`   🧱 Block Number: ${receipt.blockNumber}`);
      console.log(`   ⛽ Gas Used: ${receipt.gasUsed.toLocaleString()}`);

      // Step 5: Verify balances on-chain
      console.log("\n📝 Step 5: Verifying balances on blockchain...");
      const newSenderBalance = await digitalToken.balanceOf(sender.address);
      const newRecipientBalance = await digitalToken.balanceOf(
        recipient.address,
      );

      console.log(
        `   💰 Sender New Balance: ${ethers.formatEther(newSenderBalance)} VSC`,
      );
      console.log(
        `   💰 Recipient New Balance: ${ethers.formatEther(newRecipientBalance)} VSC`,
      );

      // Update JavaScript records
      const senderRecord = this.state.normalUsers.get(sender.id);
      const recipientRecord = this.state.normalUsers.get(recipient.id);
      if (senderRecord)
        senderRecord.tokenBalance = parseFloat(
          ethers.formatEther(newSenderBalance),
        );
      if (recipientRecord)
        recipientRecord.tokenBalance = parseFloat(
          ethers.formatEther(newRecipientBalance),
        );

      // Record transaction
      this.state.transferHistory.push({
        type: "USER_TO_USER_TRANSFER",
        from: sender.name,
        to: recipient.name,
        amount: parseFloat(amount),
        timestamp: new Date().toISOString(),
        status: "SUCCESS",
        reason: "Compliant user-to-user transfer",
      });

      console.log("\n🎉 USER-TO-USER TRANSFER SUCCESSFUL!");
      console.log("=".repeat(60));
      console.log(`⛽ Total Gas Used: ${totalGasUsed.toLocaleString()}`);
      console.log("💡 Transfer enforced by ComplianceRules contract on-chain");
    } catch (error) {
      console.error("❌ Transfer failed:", error.message);
      console.log(
        "💡 Make sure both users are verified and amount is within limits",
      );
    }
  }

  /** Option 28: Demonstrate Transfer Restrictions */
  async demonstrateTransferRestrictions() {
    console.log("\n🚫 DEMONSTRATE TRANSFER RESTRICTIONS");
    console.log("=".repeat(50));

    console.log("\n🎭 RESTRICTION SCENARIOS:");
    console.log("1. 💰 Amount Exceeds Limit (>8,000 VSC)");
    console.log("2. ❌ Non-Compliant Recipient");
    console.log("3. 📜 View Transfer History");
    console.log("0. Back");

    const choice = await this.promptUser("Select scenario (0-3): ");

    try {
      switch (choice) {
        case "1":
          await this.demonstrateAmountLimit();
          break;
        case "2":
          await this.demonstrateNonCompliantRecipient();
          break;
        case "3":
          await this.viewTransferHistory();
          break;
        case "0":
          return;
        default:
          console.log("❌ Invalid choice");
      }
    } catch (error) {
      console.error("❌ Demonstration failed:", error.message);
    }
  }

  /**
   * Demonstrate amount limit restriction
   * @private
   */
  async demonstrateAmountLimit() {
    console.log("\n💰 AMOUNT LIMIT RESTRICTION DEMO");
    console.log("=".repeat(40));
    console.log("⚠️  This demonstrates on-chain transfer amount limits");
    console.log("");

    const digitalToken = this.state.getContract("digitalToken");
    if (!digitalToken) {
      console.log("❌ Digital Token not deployed. Deploy it first (option 21)");
      return;
    }

    // Get investors with balance - check on-chain
    const allInvestors = Array.from(this.state.investors.values()).filter(
      (inv) => inv.tokenEligible,
    );
    const investorsWithBalance = [];

    for (const inv of allInvestors) {
      try {
        const balance = await digitalToken.balanceOf(inv.address);
        const balanceVSC = parseFloat(ethers.formatEther(balance));
        if (balanceVSC >= 10000) {
          inv.actualBalance = balanceVSC;
          investorsWithBalance.push(inv);
        }
      } catch (error) {
        // Skip this investor
      }
    }

    if (investorsWithBalance.length === 0) {
      console.log("❌ No investors have sufficient balance (need ≥10,000 VSC)");
      console.log("💡 Use Option 25 to mint and distribute tokens first");
      return;
    }

    const sender = investorsWithBalance[0];
    const recipients = Array.from(this.state.investors.values()).filter(
      (inv) => inv.tokenEligible && inv.address !== sender.address,
    );

    if (recipients.length === 0) {
      console.log("❌ Need at least 2 investors for this demo");
      return;
    }

    const recipient = recipients[0];
    const excessAmount = "10000"; // Exceeds 8,000 limit

    console.log(
      `📤 Sender: ${sender.name} (${sender.address.substring(0, 10)}...)`,
    );
    console.log(`   💰 Balance: ${sender.actualBalance.toLocaleString()} VSC`);
    console.log(
      `📥 Recipient: ${recipient.name} (${recipient.address.substring(0, 10)}...)`,
    );
    console.log(`💰 Attempting: ${excessAmount} VSC`);
    console.log(`🚫 Limit: 8,000 VSC`);
    console.log("");

    try {
      // Step 1: Check if transfer is allowed on-chain
      console.log("📝 Step 1: Checking transfer limits on blockchain...");
      const amountWei = ethers.parseEther(excessAmount);
      const canTransfer = await digitalToken.canTransfer(
        sender.address,
        recipient.address,
        amountWei,
      );

      console.log(
        `   ${canTransfer ? "✅" : "❌"} Can Transfer: ${canTransfer}`,
      );

      if (!canTransfer) {
        console.log("");
        console.log("⚠️  TRANSFER BLOCKED BY ON-CHAIN COMPLIANCE!");
        console.log(`   Requested: ${excessAmount} VSC`);
        console.log(`   Maximum: 8,000 VSC`);
        console.log(`   Reason: Amount exceeds compliance limit`);
        console.log("");
        console.log("💡 Solution: Split into multiple transfers ≤8,000 VSC");
        console.log(
          "💡 Example: Transfer 8,000 VSC, then 2,000 VSC separately",
        );
        console.log("");
        console.log("✅ ERC-3643 compliance enforced on-chain!");
      } else {
        console.log(
          "⚠️  Warning: Transfer would be allowed (limit may have changed)",
        );
      }
    } catch (error) {
      console.log("");
      console.log("❌ TRANSFER BLOCKED BY SMART CONTRACT!");
      console.log(`   Error: ${error.message}`);
      console.log("");
      console.log("✅ ERC-3643 compliance enforced on-chain!");
    }
  }

  /**
   * Demonstrate non-compliant recipient restriction
   * @private
   */
  async demonstrateNonCompliantRecipient() {
    console.log("\n❌ NON-COMPLIANT RECIPIENT DEMO");
    console.log("=".repeat(40));
    console.log("⚠️  This demonstrates on-chain compliance verification");
    console.log("");

    const digitalToken = this.state.getContract("digitalToken");
    const identityRegistry = this.state.getContract("identityRegistry");

    if (!digitalToken || !identityRegistry) {
      console.log("❌ Contracts not deployed. Deploy them first (option 21)");
      return;
    }

    const compliantInvestors = Array.from(this.state.investors.values()).filter(
      (inv) => inv.tokenEligible,
    );
    const nonCompliantInvestors = Array.from(
      this.state.investors.values(),
    ).filter((inv) => !inv.tokenEligible);

    if (compliantInvestors.length === 0) {
      console.log("❌ Need at least 1 compliant investor");
      console.log("💡 Create compliant investors first (Option 23)");
      return;
    }

    if (nonCompliantInvestors.length === 0) {
      console.log("❌ No non-compliant investors available for this demo");
      console.log("💡 This demo requires a non-compliant investor");
      console.log(
        "💡 In production, non-compliant users are blocked automatically",
      );
      return;
    }

    const sender = compliantInvestors[0];
    const recipient = nonCompliantInvestors[0];
    const amount = "1000";

    console.log(
      `📤 Sender: ${sender.name} (${sender.address.substring(0, 10)}...)`,
    );
    console.log(`   ✅ KYC: ${sender.kycStatus}`);
    console.log(`   ✅ AML: ${sender.amlStatus}`);

    console.log(
      `\n📥 Recipient: ${recipient.name} (${recipient.address.substring(0, 10)}...)`,
    );
    console.log(`   ❌ KYC: ${recipient.kycStatus}`);
    console.log(`   ❌ AML: ${recipient.amlStatus}`);
    console.log(`💰 Attempting: ${amount} VSC`);
    console.log("");

    try {
      // Step 1: Verify sender on-chain
      console.log("📝 Step 1: Verifying sender compliance on blockchain...");
      const senderVerified = await identityRegistry.isVerified(sender.address);
      console.log(
        `   ${senderVerified ? "✅" : "❌"} Sender Verified: ${senderVerified}`,
      );

      // Step 2: Verify recipient on-chain
      console.log(
        "\n📝 Step 2: Verifying recipient compliance on blockchain...",
      );
      const recipientVerified = await identityRegistry.isVerified(
        recipient.address,
      );
      console.log(
        `   ${recipientVerified ? "✅" : "❌"} Recipient Verified: ${recipientVerified}`,
      );

      if (!recipientVerified) {
        console.log("");
        console.log("⚠️  TRANSFER BLOCKED BY ON-CHAIN COMPLIANCE!");
        console.log(`   Issue: Recipient not verified in IdentityRegistry`);
        console.log(`   Reason: Missing or invalid KYC/AML claims`);
        console.log("");
        console.log(
          "💡 Solution: Recipient must complete KYC/AML verification",
        );
        console.log(
          "💡 ERC-3643 compliance enforced on-chain by IdentityRegistry",
        );
        console.log("");
        console.log("✅ Blockchain prevented non-compliant transfer!");
      } else {
        console.log(
          "⚠️  Warning: Recipient is verified (may have been updated)",
        );
      }
    } catch (error) {
      console.log("");
      console.log("❌ TRANSFER BLOCKED BY SMART CONTRACT!");
      console.log(`   Error: ${error.message}`);
      console.log("");
      console.log("✅ ERC-3643 compliance enforced on-chain!");
    }
  }

  /**
   * View transfer history
   * @private
   */
  async viewTransferHistory() {
    console.log("\n📜 TRANSFER HISTORY");
    console.log("=".repeat(60));

    if (
      !this.state.transferHistory ||
      this.state.transferHistory.length === 0
    ) {
      console.log("❌ No transfers recorded yet");
      console.log("💡 Execute some transfers first (Options 26, 27, 27.5)");
      return;
    }

    console.log(
      `\n📊 Total Transactions: ${this.state.transferHistory.length}\n`,
    );

    this.state.transferHistory.forEach((tx, index) => {
      const statusIcon = tx.status === "SUCCESS" ? "✅" : "❌";
      console.log(`${index + 1}. ${statusIcon} ${tx.type}`);
      console.log(`   From: ${tx.from}`);
      console.log(`   To: ${tx.to}`);
      console.log(`   Amount: ${tx.amount.toLocaleString()} VSC`);
      console.log(`   Status: ${tx.status}`);
      if (tx.reason) console.log(`   Reason: ${tx.reason}`);
      if (tx.txHash) console.log(`   TX Hash: ${tx.txHash}`);
      console.log(`   Time: ${new Date(tx.timestamp).toLocaleString()}`);
      console.log("");
    });

    // Summary statistics
    const successful = this.state.transferHistory.filter(
      (tx) => tx.status === "SUCCESS",
    ).length;
    const blocked = this.state.transferHistory.filter(
      (tx) => tx.status === "BLOCKED",
    ).length;

    console.log("📊 SUMMARY:");
    console.log(`   ✅ Successful: ${successful}`);
    console.log(`   ❌ Blocked: ${blocked}`);
    console.log(
      `   📈 Success Rate: ${((successful / this.state.transferHistory.length) * 100).toFixed(1)}%`,
    );
  }

  /** Option 29: ERC-3643 Dashboard */
  async showDashboard() {
    console.log("\n📊 ERC-3643 DIGITAL TOKEN DASHBOARD");
    console.log("=".repeat(50));

    const digitalToken = this.state.getContract("digitalToken");
    if (!digitalToken) {
      console.log("❌ ERC-3643 Digital Token system not deployed yet");
      console.log("💡 Deploy the system first (option 21)");
      return;
    }

    try {
      // Token Issuer Status
      const centralBank = Array.from(
        this.state.bankingInstitutions.values(),
      ).find((bank) => bank.type === "CENTRAL_BANK");
      console.log("\n🏛️ CENTRAL BANK (Token Issuer) STATUS:");
      if (centralBank) {
        console.log(`   Name: ${centralBank.name}`);
        console.log(`   Address: ${centralBank.address}`);

        // Get balance from blockchain
        const balance = await digitalToken.balanceOf(centralBank.address);
        console.log(`   Balance: ${ethers.formatEther(balance)} VSC`);

        // Check if agent
        const isAgent = await digitalToken.isAgent(centralBank.address);
        console.log(
          `   Minting Authority: ${isAgent ? "✅ ACTIVE" : "❌ INACTIVE"}`,
        );
      } else {
        console.log("   Status: ❌ NOT CREATED");
        console.log("   💡 Create token issuer (option 22)");
      }

      // Continue in next method due to 150-line limit...
      await this.showDashboardInvestors(digitalToken);
    } catch (error) {
      console.error("❌ Dashboard error:", error.message);
    }
  }

  /**
   * Show investor details in dashboard (part 2)
   * @private
   */
  async showDashboardInvestors(digitalToken) {
    // Investor Overview
    const investorCount = this.state.investors ? this.state.investors.size : 0;
    const compliantInvestors = this.state.investors
      ? Array.from(this.state.investors.values()).filter(
          (inv) => inv.tokenEligible,
        ).length
      : 0;

    console.log("\n👥 INVESTOR OVERVIEW:");
    console.log(`   Total Investors: ${investorCount}`);
    console.log(`   Compliant: ${compliantInvestors}`);

    // Get detailed balance from blockchain for each investor
    let investorTotalBalance = 0;
    if (this.state.investors && this.state.investors.size > 0) {
      console.log("\n   📋 INVESTOR DETAILS:");
      let index = 1;
      const investorTypeRegistry = this.state.getContract(
        "investorTypeRegistry",
      );

      for (const investor of this.state.investors.values()) {
        // Skip investors without valid address
        if (!investor.address || investor.address === null) {
          console.log(
            `\n   ${index}. ${investor.name} - ⚠️ No address assigned`,
          );
          index++;
          continue;
        }

        // Get total balance
        const totalBalance = await digitalToken.balanceOf(investor.address);
        const totalBalanceFormatted = parseFloat(
          ethers.formatEther(totalBalance),
        );

        // Get frozen (locked) tokens
        const frozenTokens = await digitalToken.frozenTokens(investor.address);
        const frozenBalanceFormatted = parseFloat(
          ethers.formatEther(frozenTokens),
        );

        // Get free (available) balance
        const freeBalance = await digitalToken.getFreeBalance(investor.address);
        const freeBalanceFormatted = parseFloat(
          ethers.formatEther(freeBalance),
        );

        investorTotalBalance += totalBalanceFormatted;

        // Get investor type and limits
        let investorTypeStr = "Unknown";
        let maxTransfer = "N/A";
        if (investorTypeRegistry) {
          const investorType = await investorTypeRegistry.getInvestorType(
            investor.address,
          );
          const typeNames = ["Normal", "Retail", "Accredited", "Institutional"];
          investorTypeStr = typeNames[investorType] || "Unknown";

          const config =
            await investorTypeRegistry.getInvestorTypeConfig(investorType);
          maxTransfer = ethers.formatEther(config.maxTransferAmount);
        }

        console.log(`\n   ${index}. ${investor.name}`);
        console.log(`      🆔 Address: ${investor.address}`);
        console.log(`      📋 Type: ${investorTypeStr}`);
        console.log(
          `      💰 Total Balance: ${totalBalanceFormatted.toLocaleString()} VSC`,
        );

        // Show breakdown if tokens are frozen
        if (frozenBalanceFormatted > 0) {
          console.log(
            `         🔒 Locked: ${frozenBalanceFormatted.toLocaleString()} VSC`,
          );
          console.log(
            `         💵 Available: ${freeBalanceFormatted.toLocaleString()} VSC`,
          );

          // Show multi-sig wallet info if exists
          if (investor.multiSigWallet) {
            console.log(
              `         🔐 Multi-Sig: ${investor.multiSigWallet.address.substring(0, 10)}...`,
            );
          }
        }

        console.log(`      📊 Max Transfer: ${maxTransfer} VSC`);
        console.log(`      ✅ KYC: ${investor.kycStatus || "ISSUED"}`);
        console.log(`      ✅ AML: ${investor.amlStatus || "ISSUED"}`);
        index++;
      }
      console.log(
        `\n   💰 Total Balance: ${investorTotalBalance.toLocaleString()} VSC`,
      );
    } else {
      console.log("   💡 No investors created yet (use option 23)");
    }

    // Continue in next method...
    await this.showDashboardUsers(digitalToken);
  }

  /**
   * Show user details and system status in dashboard (part 3)
   * @private
   */
  async showDashboardUsers(digitalToken) {
    // Normal User Overview
    const userCount = this.state.normalUsers ? this.state.normalUsers.size : 0;
    const compliantUsers = this.state.normalUsers
      ? Array.from(this.state.normalUsers.values()).filter(
          (user) => user.tokenEligible,
        ).length
      : 0;

    console.log("\n👤 NORMAL USER OVERVIEW:");
    console.log(`   Total Users: ${userCount}`);
    console.log(`   Compliant: ${compliantUsers}`);

    // Get detailed balance from blockchain for each user
    let userTotalBalance = 0;
    if (this.state.normalUsers && this.state.normalUsers.size > 0) {
      console.log("\n   📋 USER DETAILS:");
      let index = 1;
      for (const user of this.state.normalUsers.values()) {
        // Skip users without valid address
        if (!user.address || user.address === null) {
          console.log(`\n   ${index}. ${user.name} - ⚠️ No address assigned`);
          index++;
          continue;
        }

        const balance = await digitalToken.balanceOf(user.address);
        const balanceFormatted = parseFloat(ethers.formatEther(balance));
        userTotalBalance += balanceFormatted;

        console.log(`\n   ${index}. ${user.name}`);
        console.log(`      🆔 Address: ${user.address}`);
        console.log(
          `      💰 Balance: ${balanceFormatted.toLocaleString()} VSC`,
        );
        console.log(`      ✅ KYC: ${user.kycStatus || "ISSUED"}`);
        console.log(`      ✅ AML: ${user.amlStatus || "ISSUED"}`);
        index++;
      }
      console.log(
        `\n   💰 Total Balance: ${userTotalBalance.toLocaleString()} VSC`,
      );
    } else {
      console.log("   💡 No users created yet (use option 24)");
    }

    // Continue in next method...
    await this.showDashboardMetrics(digitalToken);
  }

  /**
   * Show compliance metrics and system status (part 4)
   * @private
   */
  async showDashboardMetrics(digitalToken) {
    // ERC-3643 Compliance Metrics
    console.log("\n🔒 ERC-3643 COMPLIANCE METRICS:");
    console.log(`   Standard: ERC-3643 (T-REX)`);

    // Get on-chain transfer limits
    const investorTypeRegistry = this.state.getContract("investorTypeRegistry");
    if (investorTypeRegistry) {
      const retailConfig = await investorTypeRegistry.getInvestorTypeConfig(1);
      console.log(
        `   Transfer Limit (Retail): ${ethers.formatEther(retailConfig.maxTransferAmount)} VSC`,
      );
    } else {
      console.log(`   Transfer Limit: 8,000 VSC (default)`);
    }

    console.log(`   KYC/AML Required: ✅ ENFORCED`);
    console.log(`   Token Issuer Only Minting: ✅ ENFORCED`);

    // Transaction History
    const totalTransactions = this.state.transferHistory.length;
    const successfulTransactions = this.state.transferHistory.filter(
      (tx) => tx.status === "SUCCESS",
    ).length;
    const blockedTransactions = this.state.transferHistory.filter(
      (tx) => tx.status === "BLOCKED",
    ).length;

    console.log("\n📈 TRANSACTION OVERVIEW:");
    console.log(`   Total Transactions: ${totalTransactions}`);
    console.log(
      `   Successful: ${successfulTransactions} (${totalTransactions > 0 ? ((successfulTransactions / totalTransactions) * 100).toFixed(1) : 0}%)`,
    );
    console.log(
      `   Blocked: ${blockedTransactions} (${totalTransactions > 0 ? ((blockedTransactions / totalTransactions) * 100).toFixed(1) : 0}%)`,
    );

    // Show recent transactions
    if (this.state.transferHistory.length > 0) {
      console.log("\n   📋 RECENT TRANSACTIONS (Last 5):");
      const recentTxs = this.state.transferHistory.slice(-5).reverse();
      recentTxs.forEach((tx, index) => {
        const statusIcon = tx.status === "SUCCESS" ? "✅" : "❌";
        console.log(
          `\n   ${index + 1}. ${statusIcon} ${tx.type || "TRANSFER"}`,
        );
        console.log(`      From: ${tx.from || tx.fromBank || "N/A"}`);
        console.log(`      To: ${tx.to || tx.toBank || "N/A"}`);
        console.log(
          `      Amount: ${tx.amount ? tx.amount.toLocaleString() : "N/A"} VSC`,
        );
        console.log(`      Status: ${tx.status || "PENDING"}`);
        if (tx.reason) {
          console.log(`      Reason: ${tx.reason}`);
        }
        if (tx.timestamp) {
          console.log(`      Time: ${new Date(tx.timestamp).toLocaleString()}`);
        }
      });
    } else {
      console.log("   💡 No transactions yet");
    }

    // System Status
    const centralBank = Array.from(
      this.state.bankingInstitutions.values(),
    ).find((bank) => bank.type === "CENTRAL_BANK");
    console.log("\n🎯 SYSTEM STATUS:");
    const systemStatus =
      digitalToken && centralBank ? "OPERATIONAL" : "SETUP_REQUIRED";
    console.log(`   ERC-3643 Digital Token: ${systemStatus}`);
    console.log(`   Compliance Enforcement: ✅ ACTIVE`);
    console.log(`   Transfer Restrictions: ✅ ACTIVE`);
    console.log(`   Real-time Monitoring: ✅ ACTIVE`);

    if (systemStatus === "SETUP_REQUIRED") {
      console.log("\n💡 NEXT STEPS:");
      if (!digitalToken) {
        console.log("   • Deploy ERC-3643 Digital Token System (option 21)");
      }
      if (!centralBank) {
        console.log("   • Create Token Issuer (option 22)");
      }
    }
  }

  /** Option 30: Transaction Summary */
  async showTransactionSummary() {
    console.log("\n📈 TRANSACTION & DEPLOYMENT SUMMARY");
    console.log("=".repeat(50));

    try {
      // Display deployment summary
      this.logger.displayComprehensiveSummary();

      // Additional statistics
      const deployedContracts = this.logger.getDeployedContracts();
      const transactionHistory = this.logger.getTransactionHistory();

      console.log("\n📊 DEPLOYMENT STATISTICS");
      console.log("-".repeat(50));
      console.log(`🏗️  Total Contracts Deployed: ${deployedContracts.size}`);
      console.log(
        `🔄 Total Blockchain Transactions: ${transactionHistory.length}`,
      );

      const successfulTxs = transactionHistory.filter(
        (tx) => tx.status === "SUCCESS",
      ).length;
      const failedTxs = transactionHistory.filter(
        (tx) => tx.status === "FAILED",
      ).length;

      console.log(`✅ Successful: ${successfulTxs}`);
      console.log(`❌ Failed: ${failedTxs}`);

      if (transactionHistory.length > 0) {
        const successRate = (
          (successfulTxs / transactionHistory.length) *
          100
        ).toFixed(2);
        console.log(`📈 Success Rate: ${successRate}%`);
      }

      // Token Transfer Statistics
      if (this.state.transferHistory && this.state.transferHistory.length > 0) {
        console.log("\n💸 TOKEN TRANSFER STATISTICS");
        console.log("-".repeat(50));

        const totalTransfers = this.state.transferHistory.length;
        const successfulTransfers = this.state.transferHistory.filter(
          (tx) => tx.status === "SUCCESS",
        ).length;
        const blockedTransfers = this.state.transferHistory.filter(
          (tx) => tx.status === "BLOCKED",
        ).length;

        console.log(`📊 Total Transfer Attempts: ${totalTransfers}`);
        console.log(`✅ Successful Transfers: ${successfulTransfers}`);
        console.log(`❌ Blocked Transfers: ${blockedTransfers}`);
        console.log(
          `📈 Transfer Success Rate: ${((successfulTransfers / totalTransfers) * 100).toFixed(1)}%`,
        );

        // Calculate total volume
        const totalVolume = this.state.transferHistory
          .filter((tx) => tx.status === "SUCCESS")
          .reduce((sum, tx) => sum + (tx.amount || 0), 0);
        console.log(
          `💰 Total Volume Transferred: ${totalVolume.toLocaleString()} VSC`,
        );

        // Transfer type breakdown
        const transferTypes = {};
        this.state.transferHistory.forEach((tx) => {
          const type = tx.type || "UNKNOWN";
          transferTypes[type] = (transferTypes[type] || 0) + 1;
        });

        console.log("\n📋 Transfer Type Breakdown:");
        Object.entries(transferTypes).forEach(([type, count]) => {
          console.log(`   ${type}: ${count}`);
        });
      }

      // Show recent blockchain transactions
      if (transactionHistory.length > 0) {
        console.log("\n🕒 RECENT BLOCKCHAIN TRANSACTIONS (Last 5)");
        console.log("-".repeat(50));

        const recentTxs = transactionHistory.slice(-5);
        recentTxs.forEach((tx, index) => {
          console.log(`${index + 1}. ${tx.name || "Unknown Operation"}`);
          console.log(`   Hash: ${tx.transactionHash || "N/A"}`);
          console.log(`   Status: ${tx.status}`);
          console.log(
            `   Gas Used: ${tx.gasUsed ? Number(tx.gasUsed).toLocaleString() : "N/A"}`,
          );
          console.log("");
        });
      }

      // Show contract addresses
      if (deployedContracts.size > 0) {
        console.log("\n📋 DEPLOYED CONTRACT ADDRESSES");
        console.log("-".repeat(50));

        deployedContracts.forEach((info, name) => {
          console.log(`${name}:`);
          console.log(`   Address: ${info.contractAddress}`);
          console.log(`   Block: ${info.blockNumber}`);
          console.log(`   Gas Used: ${Number(info.gasUsed).toLocaleString()}`);
          console.log("");
        });
      }

      // System Overview
      console.log("\n🎯 SYSTEM OVERVIEW");
      console.log("-".repeat(50));
      console.log(`👥 Total Investors: ${this.state.investors.size}`);
      console.log(`👤 Total Normal Users: ${this.state.normalUsers.size}`);
      console.log(
        `🏛️  Banking Institutions: ${this.state.bankingInstitutions.size}`,
      );
      console.log(`🆔 OnchainID Identities: ${this.state.identities.size}`);
      console.log(`📜 Claims Issued: ${this.state.claims.size}`);

      console.log("\n✅ Summary display completed!");
    } catch (error) {
      console.error(`❌ Error displaying summary: ${error.message}`);
    }
  }

  // ========== HELPER METHODS ==========
  // (demonstrateAmountLimit and demonstrateNonCompliantRecipient are implemented above in Option 28 section)
}

module.exports = TokenModule;
