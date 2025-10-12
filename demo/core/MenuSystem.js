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

const { displaySection } = require('../utils/DisplayHelpers');

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

    /**
     * Display the main menu
     * 
     * @private
     */
    displayMenu() {
        console.log('\n🎮 INTERACTIVE MENU');
        console.log('='.repeat(70));
        console.log('');
        console.log('🏗️  === CORE SYSTEM ===');
        console.log('1.  Deploy All Contracts');
        console.log('');
        console.log('🆔 === ONCHAINID MANAGEMENT (Options 2-10) ===');
        console.log('2.  Create Management Keys');
        console.log('3.  Create OnchainID for User');
        console.log('4.  Review Identity Keys');
        console.log('5.  Recover Lost Keys');
        console.log('6.  Manage KYC Claims');
        console.log('7.  Manage AML Claims');
        console.log('8.  Review Claim Status & History');
        console.log('9.  Create UTXO with KYC/AML Data');
        console.log('10. Verify UTXO Contains Compliance Data');
        console.log('');
        console.log('⚖️  === COMPLIANCE RULES ENGINE (Options 13-20) ===');
        console.log('13. Deploy ComplianceRules Contract');
        console.log('14. Configure Jurisdiction Rules');
        console.log('15. Configure Investor Type Rules');
        console.log('16. Configure Holding Period Rules');
        console.log('17. Configure Compliance Level Rules');
        console.log('18. Test All Compliance Validations');
        console.log('19. Test Access Control');
        console.log('20. Show ComplianceRules Dashboard');
        console.log('20a. View Jurisdiction Rules (Whitelist/Blacklist)');
        console.log('20b. View Investor Type Rules');
        console.log('20c. View Holding Period Rules');
        console.log('20d. View Compliance Level Rules');
        console.log('');
        console.log('🏛️  === ERC-3643 DIGITAL TOKEN SYSTEM (Options 21-30) ===');
        console.log('21. Deploy ERC-3643 Vanguard StableCoin System');
        console.log('22. Create Token Issuer');
        console.log('23. INVESTOR ONBOARDING SYSTEM');
        console.log('24. Create Normal Users (OnchainID)');
        console.log('25. Token Issuer: Mint & Distribute ERC-3643 VSC');
        console.log('26. Investor-to-Investor Transfer');
        console.log('27. Investor-to-User Transfer');
        console.log('27.5 User-to-User Transfer');
        console.log('28. Demonstrate Transfer Restrictions');
        console.log('29. ERC-3643 Dashboard');
        console.log('30. Transaction Summary');
        console.log('');
        console.log('🔮 === ORACLE MANAGEMENT SYSTEM (Options 31-40) ===');
        console.log('31. Deploy Oracle Management System');
        console.log('32. Register & Configure Oracles');
        console.log('33. Manage Oracle Whitelist (Access Approval)');
        console.log('34. Manage Oracle Blacklist (Access Restriction)');
        console.log('35. Emergency Oracle Actions');
        console.log('36. Oracle Reputation Management');
        console.log('37. Oracle Consensus Operations');
        console.log('38. Integrate Oracles with Vanguard StableCoin');
        console.log('39. Oracle System Dashboard');
        console.log('40. Test Complete Oracle Integration');
        console.log('');
        console.log('🔐 === PRIVACY & ZK VERIFICATION (Options 41-50) ===');

        // Display current ZK mode status
        const modeIcon = this.state.zkMode === 'real' ? '🔐' : '🔧';
        const modeText = this.state.zkMode === 'real' ? 'REAL (production cryptography)' : 'MOCK (fast, for demonstration)';
        console.log(`${modeIcon} Current ZK Mode: ${modeText}`);
        if (this.state.zkMode === 'mock') {
            console.log('💡 Tip: Use option 41a to switch to REAL mode for production ZK proofs');
        }
        console.log('');

        console.log('41. Deploy Privacy & ZK Verification System');
        console.log('41a. Toggle ZK Mode (Mock ↔ Real)');
        console.log('41b. View ZK Mode Status & Performance');
        console.log('41c. Demo Phase 5: Batch Verification & Gas Savings');
        console.log('42. Submit Private Compliance Proofs');
        console.log('43. Verify Private Whitelist Membership');
        console.log('44. Verify Private Jurisdiction Eligibility');
        console.log('45. Verify Private Accreditation Status');
        console.log('46. Privacy-Preserving Compliance Validation');
        console.log('47. Manage Privacy Settings');
        console.log('48. ZK Statistics & Analytics Dashboard');
        console.log('49. Test Complete Privacy Integration');
        console.log('50. Integrate Privacy with Vanguard StableCoin');
        console.log('');
        console.log('👥 === INVESTOR TYPE SYSTEM (Options 51-60) ===');
        console.log('51. Deploy Investor Type System');
        console.log('52. Show Investor Type Configurations');
        console.log('53. Assign Investor Types');
        console.log('54. Upgrade/Downgrade Investor Types');
        console.log('55. Test Transfer Limits by Type');
        console.log('56. Test Holding Limits by Type');
        console.log('57. Test Large Transfer Detection');
        console.log('58. Test Transfer Cooldowns');
        console.log('59. Run Complete Investor Type Tests');
        console.log('60. Investor Type System Dashboard');
        console.log('');
        console.log('💼 === ENHANCED ESCROW SYSTEM (Options 61-73) ===');
        console.log('61. Deploy Enhanced Escrow System');
        console.log('62. Register Investor (from Option 23)');
        console.log('63. Investor: Create Escrow Wallet');
        console.log('64. Payer: Fund Escrow Wallet');
        console.log('65. Payee: Submit Shipment Proof');
        console.log('66. Payer: Raise Dispute');
        console.log('67. Investor: Resolve Dispute');
        console.log('68. Payee: Sign Release');
        console.log('69. Investor: Sign Release');
        console.log('70. Investor: Manual Refund');
        console.log('71. View Escrow Wallet Status');
        console.log('71a. View All Parties Balances');
        console.log('72. Enhanced Escrow Dashboard');
        console.log('73. Demo Complete Enhanced Escrow Workflow');
        console.log('');
        console.log('⏰ Escrow Time Travel:');
        console.log('73a. Time Travel (13 Days - Test Dispute Window)');
        console.log('73b. Time Travel (14 Days - Test Auto Settlement)');
        console.log('');
        console.log('🗳️  === GOVERNANCE SYSTEM (Options 74-83) ===');
        console.log('74. Deploy Governance System');
        console.log('75. Distribute Governance Tokens');
        console.log('75a. 🏭 Mint Governance Tokens (Owner Only)');
        console.log('75b. 🔥 Burn Governance Tokens (Owner Only)');
        console.log('75c. ✅ Approve Governance Spending (Required for Proposals/Voting)');
        console.log('76. Create Proposal');
        console.log('77. Vote on Proposal');
        console.log('78. Execute Proposal');
        console.log('79. Time Travel (Fast Forward 9 Days)');
        console.log('');
        console.log('📈 Governance Tools:');
        console.log('80. Governance Dashboard');
        console.log('81. Test Compliance Enforcement (VSC & VGT)');
        console.log('82. Demo Complete Governance Workflow');
        console.log('83. Manage InvestorTypeRegistry via Governance');
        console.log('83a. Change Governance Costs (Proposal & Voting)');
        console.log('');
        console.log('📋 === DYNAMIC LIST MANAGEMENT (Options 84-88) ===');
        console.log('84. Deploy Dynamic List Manager');
        console.log('85. Manage Whitelist/Blacklist Status');
        console.log('86. Create List Update Proposal');
        console.log('87. View User Status History');
        console.log('88. Demo Complete User Lifecycle (Whitelist ↔ Blacklist)');
        console.log('89. Quick Fix: Verify Existing Signer for Voting');
        console.log('');
        console.log('0.  ❌ Exit');
        console.log('');
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

        const { deployer, onchainID, compliance, token, oracle, privacy, investorType, escrow, governance, dynamicList } = this.modules;

        switch (choice) {
            // Core
            case '1': await deployer.deployAllContracts(); break;
            
            // OnchainID (2-12)
            case '2': await onchainID.createManagementKeys(); break;
            case '3': await onchainID.createOnchainID(); break;
            case '4': await onchainID.reviewIdentityKeys(); break;
            case '5': await onchainID.recoverLostKeys(); break;
            case '6': await onchainID.manageKYCClaims(); break;
            case '7': await onchainID.manageAMLClaims(); break;
            case '8': await onchainID.reviewClaimStatusHistory(); break;
            case '9': await onchainID.createUTXOWithCompliance(); break;
            case '10': await onchainID.verifyUTXOCompliance(); break;

            // Compliance (13-20)
            case '13': await compliance.deployComplianceRules(); break;
            case '14': await compliance.configureJurisdictionRules(); break;
            case '15': await compliance.configureInvestorTypeRules(); break;
            case '16': await compliance.configureHoldingPeriodRules(); break;
            case '17': await compliance.configureComplianceLevelRules(); break;
            case '18': await compliance.testAllComplianceValidations(); break;
            case '19': await compliance.testAccessControl(); break;
            case '20': await compliance.showComplianceRulesDashboard(); break;
            case '20a': await compliance.viewJurisdictionRules(); break;
            case '20b': await compliance.viewInvestorTypeRules(); break;
            case '20c': await compliance.viewHoldingPeriodRules(); break;
            case '20d': await compliance.viewComplianceLevelRules(); break;
            
            // Token (21-30)
            case '21': await token.deployERC3643System(); break;
            case '22': await token.createTokenIssuer(); break;
            case '23': await token.investorOnboarding(); break;
            case '24': await token.createNormalUsers(); break;
            case '25': await token.mintAndDistributeTokens(); break;
            case '26': await token.investorToInvestorTransfer(); break;
            case '27': await token.investorToUserTransfer(); break;
            case '27.5': await token.userToUserTransfer(); break;
            case '28': await token.demonstrateTransferRestrictions(); break;
            case '29': await token.showDashboard(); break;
            case '30': await token.showTransactionSummary(); break;
            
            // Oracle (31-40)
            case '31': await oracle.deployOracleSystem(); break;
            case '32': await oracle.registerOracles(); break;
            case '33': await oracle.manageWhitelist(); break;
            case '34': await oracle.manageBlacklist(); break;
            case '35': await oracle.emergencyActions(); break;
            case '36': await oracle.manageReputation(); break;
            case '37': await oracle.consensusOperations(); break;
            case '38': await oracle.integrateWithToken(); break;
            case '39': await oracle.showDashboard(); break;
            case '40': await oracle.testIntegration(); break;

            // Privacy (41-50)
            case '41': await privacy.deployPrivacySystem(); break;
            case '41a': await privacy.toggleZKMode(); break;
            case '41b': await privacy.viewZKModeStatus(); break;
            case '41c': await privacy.demoBatchVerification(); break;
            case '42': await privacy.submitPrivateProofs(); break;
            case '43': await privacy.verifyWhitelistMembership(); break;
            case '44': await privacy.verifyJurisdiction(); break;
            case '45': await privacy.verifyAccreditation(); break;
            case '46': await privacy.privacyPreservingValidation(); break;
            case '47': await privacy.managePrivacySettings(); break;
            case '48': await privacy.showStatistics(); break;
            case '49': await privacy.testIntegration(); break;
            case '50': await privacy.integrateWithToken(); break;

            // Investor Type (51-60)
            case '51': await investorType.deployInvestorTypeSystem(); break;
            case '52': await investorType.showInvestorTypeConfigurations(); break;
            case '53': await investorType.assignInvestorTypes(); break;
            case '54': await investorType.upgradeDowngradeInvestorTypes(); break;
            case '55': await investorType.testTransferLimits(); break;
            case '56': await investorType.testHoldingLimits(); break;
            case '57': await investorType.testLargeTransferDetection(); break;
            case '58': await investorType.testTransferCooldowns(); break;
            case '59': await investorType.runCompleteTests(); break;
            case '60': await investorType.showDashboard(); break;

            // Escrow (61-73)
            case '61': await escrow.deployEscrowSystem(); break;
            case '62': await escrow.registerInvestor(); break;
            case '63': await escrow.createEscrowWallet(); break;
            case '64': await escrow.fundEscrowWallet(); break;
            case '65': await escrow.submitShipmentProof(); break;
            case '66': await escrow.raiseDispute(); break;
            case '67': await escrow.resolveDispute(); break;
            case '68': await escrow.payeeSignRelease(); break;
            case '69': await escrow.investorSignRelease(); break;
            case '70': await escrow.manualRefund(); break;
            case '71': await escrow.viewEscrowStatus(); break;
            case '71a': await escrow.viewAllPartiesBalances(); break;
            case '72': await escrow.showDashboard(); break;
            case '73': await escrow.demoCompleteWorkflow(); break;
            case '73a': await escrow.timeTravel13Days(); break;
            case '73b': await escrow.timeTravel14Days(); break;

            // Governance (74-83)
            case '74': await governance.deployGovernanceSystem(); break;
            case '75': await governance.distributeGovernanceTokens(); break;
            case '75a': await governance.mintGovernanceTokens(); break;
            case '75b': await governance.burnGovernanceTokens(); break;
            case '75c': await governance.approveGovernanceSpending(); break;
            case '76': await governance.createProposal(); break;
            case '77': await governance.voteOnProposal(); break;
            case '78': await governance.executeProposal(); break;
            case '79': await governance.timeTravel9Days(); break;
            case '80': await governance.showDashboard(); break;
            case '81': await governance.testComplianceEnforcement(); break;
            case '82': await governance.demoCompleteWorkflow(); break;
            case '83': await governance.manageInvestorTypeRegistry(); break;
            case '83a': await governance.changeGovernanceCosts(); break;

            // Dynamic List (84-89)
            case '84': await dynamicList.deployDynamicListSystem(); break;
            case '85': await dynamicList.manageWhitelistBlacklistStatus(); break;
            case '86': await dynamicList.createListUpdateProposal(); break;
            case '87': await dynamicList.viewUserStatusHistory(); break;
            case '88': await dynamicList.demoCompleteUserLifecycle(); break;
            case '89': await dynamicList.verifyExistingSigner(); break;

            // Exit
            case '0':
                console.log('\n👋 Goodbye!');
                console.log('✨ Thank you for using the Vanguard StableCoin Demo!');
                console.log('');
                return false;

            default:
                console.log('\n⚠️  Invalid option. Please try again.');
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
            const choice = await this.promptUser('Select an option: ');
            continueLoop = await this.routeChoice(choice);
        }
    }
}

module.exports = MenuSystem;

