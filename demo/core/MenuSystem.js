/**
 * @fileoverview Menu system and routing for the Interactive KYC/AML Demo
 * @module MenuSystem
 * @description Displays the interactive menu and routes user selections to appropriate modules.
 *
 * @example
 * const MenuSystem = require('./core/MenuSystem');
 * const menu = new MenuSystem(state, modules, promptUser);
 * await menu.runInteractiveLoop();
 */

const keyLifecycle = require("../utils/KeyLifecycleFlow");
const keyOptions = require("../utils/KeyLifecycleOptions");
const keyRemoval = require("../utils/KeyRemovalFlow");
const oracleFlow = require("../utils/OracleLifecycleFlow");
const menuText = require("./MenuText");

/**
 * @class MenuSystem
 * @description Manages menu display and routing for the demo system.
 */
class MenuSystem {
  /**
   * Create a MenuSystem
   * @param {Object} state - DemoState instance
   * @param {Object} modules - Object containing all feature modules
   * @param {Function} promptUser - Function to prompt user for input
   */
  constructor(state, modules, promptUser) {
    this.state = state;
    this.modules = modules;
    this.promptUser = promptUser;
  }

  /** Display the main menu */
  displayMenu() {
    return menuText.displayMenu(this);
  }

  /**
   * Route user choice to appropriate module method
   *
   * @param {string} choice - User's menu choice
   * @returns {Promise<boolean>} True to continue, false to exit
   * @private
   */
  async routeChoice(choice) {
    // Trim whitespace from choice
    choice = choice.trim();

    const {
      deployer,
      onchainID,
      compliance,
      token,
      oracle,
      privacy,
      investorType,
      escrow,
      governance,
      handover,
      dynamicList,
    } = this.modules;

    try {
      switch (choice) {
        // Core
        case "1":
          await deployer.deployAllContracts();
          break;
        case "1a":
          // One-click full stack. Needs the module registry because the
          // investor-type and governance steps live outside ContractDeployer.
          await deployer.deployEverything(this.modules);
          break;

        // OnchainID (2-12)
        case "2":
          await onchainID.createManagementKeys();
          break;
        case "3":
          await onchainID.createOnchainID();
          break;
        case "4":
          await onchainID.reviewIdentityKeys();
          break;
        case "5":
          await onchainID.recoverLostKeys();
          break;
        case "5a":
          await keyRemoval.runRemovalDemo(this.state);
          break;
        case "6":
          await onchainID.manageKYCClaims();
          break;
        case "7":
          await onchainID.manageAMLClaims();
          break;
        case "8":
          await onchainID.reviewClaimStatusHistory();
          break;
        case "9":
          await onchainID.createUTXOWithCompliance();
          break;
        case "10":
          await onchainID.showUTXORecord();
          break;
        case "11":
          await onchainID.demoClaimExpiry();
          break;
        case "12":
          await keyLifecycle.runKeyLifecycle(this.state);
          break;
        case "12a":
          await keyLifecycle.toggleAuthorization(this.state);
          break;
        case "12b":
          await keyOptions.setTimelockInteractive(this.state, this.promptUser);
          break;

        // Compliance (13-20)
        case "13":
          await compliance.deployComplianceRules();
          break;
        case "14":
          await compliance.configureJurisdictionRules();
          break;
        case "15":
          await compliance.showInvestorTypeLimits();
          break;
        case "16":
          await compliance.showTransferCooldowns();
          break;
        case "17":
          await compliance.showWhitelistTiers();
          break;
        case "18":
          await compliance.testAllComplianceValidations();
          break;
        case "19":
          await compliance.testAccessControl();
          break;
        case "20":
          await compliance.showComplianceRulesDashboard();
          break;
        case "20a":
          await compliance.viewJurisdictionRules();
          break;
        case "20b":
          await compliance.showInvestorTypeLimits();
          break;
        case "20c":
          await compliance.showTransferCooldowns();
          break;
        case "20d":
          await compliance.showWhitelistTiers();
          break;

        // Token (21-30)
        case "21":
          await token.deployERC3643System();
          break;
        case "22":
          await token.createTokenIssuer();
          break;
        case "23":
          await token.investorOnboarding();
          break;
        case "24":
          await token.createNormalUsers();
          break;
        case "25":
          await token.mintAndDistributeTokens();
          break;
        case "26":
          await token.investorToInvestorTransfer();
          break;
        case "27":
          await token.investorToUserTransfer();
          break;
        case "27.5":
          await token.userToUserTransfer();
          break;
        case "28":
          await token.restrictedTransferScenarios();
          break;
        case "29":
          await token.showDashboard();
          break;
        case "30":
          await token.showTransactionSummary();
          break;

        // Oracle (31-40)
        case "31":
          await oracle.deployOracleSystem();
          break;
        case "32":
          await oracle.registerOracles();
          break;
        case "33":
          await oracle.manageWhitelist();
          break;
        case "33a":
          await oracleFlow.runWhitelistRound(this.state);
          break;
        case "34":
          await oracle.manageBlacklist();
          break;
        case "34a":
          await oracleFlow.runBlacklistRound(this.state);
          break;
        case "35":
          await oracle.emergencyActions();
          break;
        case "35a":
          await oracleFlow.runLifecycle(this.state);
          break;
        case "36":
          await oracle.manageReputation();
          break;
        case "37":
          await oracle.consensusOperations();
          break;
        case "38":
          await oracle.integrateWithToken();
          break;
        case "39":
          await oracle.showDashboard();
          break;
        case "40":
          await oracle.testIntegration();
          break;

        // Privacy (41-50)
        case "41":
          await privacy.deployPrivacySystem();
          break;
        case "41b":
          await privacy.viewZKModeStatus();
          break;
        case "42":
          await privacy.submitPrivateProofs();
          break;
        case "43":
          await privacy.verifyWhitelistMembership();
          break;
        case "44":
          await privacy.verifyJurisdiction();
          break;
        case "45":
          await privacy.verifyAccreditation();
          break;
        case "46":
          await privacy.privacyPreservingValidation();
          break;
        case "47":
          await privacy.managePrivacySettings();
          break;
        case "48":
          await privacy.showStatistics();
          break;
        case "49":
          await privacy.testIntegration();
          break;
        case "50":
          await privacy.integrateWithToken();
          break;

        // Investor Type (51-60)
        case "51":
          await investorType.deployInvestorTypeSystem();
          break;
        case "52":
          await investorType.showInvestorTypeConfigurations();
          break;
        case "53":
          await investorType.assignInvestorTypes();
          break;
        case "54":
          await investorType.upgradeDowngradeInvestorTypes();
          break;
        case "55":
          await investorType.testTransferLimits();
          break;
        case "56":
          await investorType.testHoldingLimits();
          break;
        case "57":
          await investorType.testLargeTransferDetection();
          break;
        case "58":
          await investorType.testTransferCooldowns();
          break;
        case "59":
          await investorType.runCompleteTests();
          break;
        case "60":
          await investorType.showDashboard();
          break;

        // Escrow (61-73)
        case "61":
          await escrow.deployEscrowSystem();
          break;
        case "62":
          await escrow.registerInvestor();
          break;
        case "63":
          await escrow.createEscrowWallet();
          break;
        case "64":
          await escrow.fundEscrowWallet();
          break;
        case "65":
          await escrow.submitShipmentProof();
          break;
        case "66":
          await escrow.raiseDispute();
          break;
        case "67":
          await escrow.resolveDispute();
          break;
        case "68":
          await escrow.payeeSignRelease();
          break;
        case "69":
          await escrow.investorSignRelease();
          break;
        case "70":
          await escrow.manualRefund();
          break;
        case "70a":
          await escrow.sweepExcess();
          break;
        case "71":
          await escrow.viewEscrowStatus();
          break;
        case "71a":
          await escrow.viewAllPartiesBalances();
          break;
        case "72":
          await escrow.showDashboard();
          break;
        case "73":
          await escrow.demoCompleteWorkflow();
          break;
        case "73a":
          await escrow.timeTravel13Days();
          break;
        case "73b":
          await escrow.timeTravel14Days();
          break;

        // Governance (74-83)
        case "74":
          await governance.deployGovernanceSystem();
          break;
        case "75":
          await governance.distributeGovernanceTokens();
          break;
        case "75a":
          await governance.mintGovernanceTokens();
          break;
        case "75b":
          await governance.burnGovernanceTokens();
          break;
        case "75c":
          await governance.approveGovernanceSpending();
          break;
        case "76":
          await governance.createProposal();
          break;
        case "77":
          await governance.voteOnProposal();
          break;
        case "78":
          await governance.executeProposal();
          break;
        case "78a":
          await governance.claimRefund();
          break;
        case "79":
          await governance.timeTravel9Days();
          break;
        case "80":
          await governance.showDashboard();
          break;
        case "81":
          await governance.testComplianceEnforcement();
          break;
        case "82":
          await governance.demoCompleteWorkflow();
          break;
        case "83":
          await governance.manageInvestorTypeRegistry();
          break;
        case "83a":
          await governance.changeGovernanceCosts();
          break;
        case "83b":
          await governance.acceptRegistryOwnershipByVote();
          break;
        case "83c":
          await handover.handoverStep1();
          break;
        case "83d":
          await handover.acceptAllOwnershipByVote();
          break;
        case "83e":
          await handover.verifyHandover();
          break;

        // Dynamic List (84-89)
        case "84":
          await dynamicList.deployDynamicListSystem();
          break;
        case "85":
          await dynamicList.manageWhitelistBlacklistStatus();
          break;
        case "86":
          await dynamicList.createListUpdateProposal();
          break;
        case "87":
          await dynamicList.viewUserStatusHistory();
          break;
        case "88":
          await dynamicList.demoCompleteUserLifecycle();
          break;
        case "89":
          await dynamicList.verifyExistingSigner();
          break;

        // Exit
        case "0":
          console.log("\n👋 Goodbye!");
          console.log("✨ Thank you for using the Vanguard StableCoin Demo!");
          console.log("");
          return false;

        default:
          console.log("\n⚠️  Invalid option. Please try again.");
      }
    } catch (error) {
      console.log("\n❌ ERROR EXECUTING MENU OPTION");
      console.log("=".repeat(50));
      console.log(`Option: ${choice}`);
      console.log(`Error: ${error.message}`);
      console.log("\nStack trace:");
      console.log(error.stack);
      console.log("=".repeat(50));
      console.log("\n💡 Please try again or select a different option.");
    }

    return true;
  }

  /**
   * Run the interactive menu loop
   *
   * @returns {Promise<void>}
   */
  async runInteractiveLoop() {
    let continueLoop = true;

    while (continueLoop) {
      this.displayMenu();
      const choice = await this.promptUser("Select an option: ");
      continueLoop = await this.routeChoice(choice);
    }
  }
}

module.exports = MenuSystem;
