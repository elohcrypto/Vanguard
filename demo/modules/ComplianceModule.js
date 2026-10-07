/**
 * @fileoverview Compliance rules management module
 * @module ComplianceModule
 * @description ComplianceRules jurisdiction rules and access control, plus
 * read-only views of the investor-type limits, cooldowns and whitelist tiers
 * that live in InvestorTypeRegistry (enforced since Task 4.10) (plan v2 Task 4.1 removed the inert
 * copies ComplianceRules kept). Covers menu options 13-20.
 *
 * @example
 * const ComplianceModule = require('./modules/ComplianceModule');
 * const module = new ComplianceModule(state, logger, promptUser);
 * await module.configureJurisdictionRules();
 */

const setup = require("../utils/ComplianceSetupFlow");
const views = require("../utils/ComplianceViewsFlow");

/**
 * @class ComplianceModule
 * @description Manages compliance rules for the demo system.
 */
class ComplianceModule {
  /**
   * Create a ComplianceModule
   * @param {Object} state - DemoState instance
   * @param {Object} logger - EnhancedLogger instance
   * @param {Function} promptUser - Function to prompt user for input
   * @param {Object} deployer - ContractDeployer instance
   */
  constructor(state, logger, promptUser, deployer) {
    this.state = state;
    this.logger = logger;
    this.promptUser = promptUser;
    this.deployer = deployer;
  }

  /** Option 13: Deploy ComplianceRules contract */
  async deployComplianceRules() {
    return setup.deployComplianceRules(this);
  }

  /** Option 14: Configure jurisdiction rules */
  async configureJurisdictionRules() {
    return setup.configureJurisdictionRules(this);
  }

  /** The registry Token enforces investor-type limits from, or null after */
  async _investorTypeContext() {
    return views._investorTypeContext(this);
  }

  /** @private The four type configs, in enum order. */
  async _typeConfigs(registry) {
    return views._typeConfigs(this, registry);
  }

  /** Options 15 and 20b: investor-type limits, read from InvestorTypeRegistry, */
  async showInvestorTypeLimits() {
    return views.showInvestorTypeLimits(this);
  }

  /** Options 16 and 20c: the per-type transfer cooldowns Token enforces */
  async showTransferCooldowns() {
    return views.showTransferCooldowns(this);
  }

  /** Options 17 and 20d: the whitelist tier each investor type requires, */
  async showWhitelistTiers() {
    return views.showWhitelistTiers(this);
  }

  /** Option 18: every check this menu can evaluate against live state: the */
  async testAllComplianceValidations() {
    return views.testAllComplianceValidations(this);
  }

  /** Option 19: ComplianceRules access control on VSC, counted from chain */
  async testAccessControl() {
    return views.testAccessControl(this);
  }

  /** Option 20: Show ComplianceRules dashboard */
  async showComplianceRulesDashboard() {
    return views.showComplianceRulesDashboard(this);
  }

  /** Option 20a: View jurisdiction rules */
  async viewJurisdictionRules() {
    return views.viewJurisdictionRules(this);
  }
}

module.exports = ComplianceModule;
