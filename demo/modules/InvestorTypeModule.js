/**
 * @fileoverview Investor type management module
 * @module InvestorTypeModule
 * @description Handles investor type system operations including deployment,
 * type configuration, and investor management.
 * Covers menu options 51-60.
 */

const setup = require("../utils/InvestorTypeSetupFlow");
const limits = require("../utils/InvestorTypeLimitsFlow");
const run = require("../utils/InvestorTypeRunFlow");

/**
 * @class InvestorTypeModule
 * @description Manages investor type operations.
 */
class InvestorTypeModule {
  constructor(state, logger, promptUser) {
    this.state = state;
    this.logger = logger;
    this.promptUser = promptUser;
  }

  /** Option 51: Deploy Investor Type System */
  async deployInvestorTypeSystem() {
    return setup.deployInvestorTypeSystem(this);
  }

  /** Option 52: Show Investor Type Configurations */
  async showInvestorTypeConfigurations() {
    return setup.showInvestorTypeConfigurations(this);
  }

  /** Option 53: Assign Investor Types */
  async assignInvestorTypes() {
    return setup.assignInvestorTypes(this);
  }

  /** Option 54: Upgrade/Downgrade Investor Types */
  async upgradeDowngradeInvestorTypes() {
    return limits.upgradeDowngradeInvestorTypes(this);
  }

  /** Option 55: Test Transfer Limits by Type */
  async testTransferLimits() {
    return limits.testTransferLimits(this);
  }

  /** Option 56: Test Holding Limits by Type */
  async testHoldingLimits() {
    return limits.testHoldingLimits(this);
  }

  /** Option 57: Test Large Transfer Detection */
  async testLargeTransferDetection() {
    return run.testLargeTransferDetection(this);
  }

  /** Option 58: prove the cooldown and the tier on chain (Task 4.10) */
  async testTransferCooldowns() {
    return run.testTransferCooldowns(this);
  }

  /** Option 59: Run Complete Investor Type Tests */
  async runCompleteTests() {
    return run.runCompleteTests(this);
  }

  /** Option 60: Investor Type System Dashboard */
  async showDashboard() {
    return run.showDashboard(this);
  }
}

module.exports = InvestorTypeModule;
