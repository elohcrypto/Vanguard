/**
 * @fileoverview Governance system module
 * @module GovernanceModule
 * @description Handles governance operations including token deployment, proposal creation,
 * voting operations, and proposal execution.
 * Covers menu options 74-83.
 */

const deploy = require("../utils/GovernanceDeployFlow");
const vgt = require("../utils/GovernanceTokenFlow");
const distribution = require("../utils/GovernanceDistributionFlow");
const proposals = require("../utils/GovernanceProposalFlow");
const voting = require("../utils/GovernanceVotingFlow");
const views = require("../utils/GovernanceViewsFlow");
const admin = require("../utils/GovernanceAdminFlow");

/**
 * @class GovernanceModule
 * @description Manages governance system operations.
 */
class GovernanceModule {
  constructor(state, logger, promptUser) {
    this.state = state;
    this.logger = logger;
    this.promptUser = promptUser;
  }

  /** Name a proposal type, tolerating types this demo predates. */
  _proposalTypeName(typeNum) {
    return proposals._proposalTypeName(this, typeNum);
  }

  /**
   * Read the configured quorum/approval thresholds for a proposal type and
   * render them as percentages.
   */
  async _thresholdsFor(vanguardGovernance, typeNum) {
    return proposals._thresholdsFor(this, vanguardGovernance, typeNum);
  }

  /** Option 74: Deploy Governance System */
  async deployGovernanceSystem() {
    return deploy.deployGovernanceSystem(this);
  }

  /** Option 75a: Mint Governance Tokens */
  async mintGovernanceTokens() {
    return vgt.mintGovernanceTokens(this);
  }

  /** Option 75b: Burn Governance Tokens */
  async burnGovernanceTokens() {
    return vgt.burnGovernanceTokens(this);
  }

  /** Option 75c: Approve Governance Contract to Spend VGT */
  async approveGovernanceSpending() {
    return vgt.approveGovernanceSpending(this);
  }

  /** Option 75: Distribute Governance Tokens */
  async distributeGovernanceTokens() {
    return distribution.distributeGovernanceTokens(this);
  }

  /** Helper: Distribute to selected investors */
  async _distributeToSelectedInvestors() {
    return distribution._distributeToSelectedInvestors(this);
  }

  /** Helper: Distribute to specific addresses */
  async _distributeToSpecificAddresses() {
    return distribution._distributeToSpecificAddresses(this);
  }

  /** Helper: Distribute equal amounts */
  async _distributeEqualAmounts() {
    return distribution._distributeEqualAmounts(this);
  }

  /** Option 76: Create Proposal */
  async createProposal() {
    return proposals.createProposal(this);
  }

  /** Helper: Create InvestorTypeConfig proposal */
  async _createInvestorTypeConfigProposal() {
    return proposals._createInvestorTypeConfigProposal(this);
  }

  /** Helper: InvestorTypeConfig proposal calling setInvestorLimitExempt. */
  async _createTreasuryExemptionProposal(investorTypeRegistry) {
    return proposals._createTreasuryExemptionProposal(
      this,
      investorTypeRegistry,
    );
  }

  /** Helper: Create ComplianceRules proposal */
  async _createComplianceRulesProposal() {
    return proposals._createComplianceRulesProposal(this);
  }

  /** Option 77: Vote on Proposal */
  async voteOnProposal() {
    return voting.voteOnProposal(this);
  }

  /** Option 78: Execute Proposal */
  async executeProposal() {
    return voting.executeProposal(this);
  }

  /** Option 79: Time Travel (Fast Forward 9 Days) */
  async timeTravel9Days() {
    return deploy.timeTravel9Days(this);
  }

  /** Option 80: Governance Dashboard */
  async showDashboard() {
    return views.showDashboard(this);
  }

  /** Option 81: Test Compliance Enforcement */
  async testComplianceEnforcement() {
    return views.testComplianceEnforcement(this);
  }

  /**
   * Option 82: Demo Complete Governance Workflow (demo/utils/
   * GovernanceWorkflow.js).
   */
  async demoCompleteWorkflow() {
    return admin.demoCompleteWorkflow(this);
  }

  /**
   * Option 83b: governance accepts the InvestorTypeRegistry nomination made
   * by option 74 — by an actual vote.
   */
  async acceptRegistryOwnershipByVote() {
    return admin.acceptRegistryOwnershipByVote(this);
  }

  /** Option 83: Manage InvestorTypeRegistry via Governance */
  async manageInvestorTypeRegistry() {
    return admin.manageInvestorTypeRegistry(this);
  }

  /** Option 83a: Change Governance Costs */
  async changeGovernanceCosts() {
    return admin.changeGovernanceCosts(this);
  }

  /** Helper: Change proposal creation cost */
  async _changeProposalCreationCost(currentCost) {
    return admin._changeProposalCreationCost(this, currentCost);
  }

  /** Helper: Change voting cost */
  async _changeVotingCost(currentCost) {
    return admin._changeVotingCost(this, currentCost);
  }

  /** Option 78a: Claim Refund. */
  async claimRefund() {
    return admin.claimRefund(this);
  }
}

module.exports = GovernanceModule;
