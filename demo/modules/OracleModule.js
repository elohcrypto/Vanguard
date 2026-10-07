/**
 * @fileoverview Oracle management module
 * @module OracleModule
 * @description Handles oracle network operations including deployment, registration,
 * whitelist/blacklist management, and consensus operations.
 * Covers menu options 31-40.
 */

const setup = require("../utils/OracleSetupFlow");
const whitelist = require("../utils/OracleWhitelistFlow");
const blacklist = require("../utils/OracleBlacklistFlow");
const reputation = require("../utils/OracleReputationFlow");
const dashboard = require("../utils/OracleDashboardFlow");

/**
 * @class OracleModule
 * @description Manages oracle network operations.
 */
class OracleModule {
  constructor(state, logger, promptUser, deployer) {
    this.state = state;
    this.logger = logger;
    this.promptUser = promptUser;
    this.deployer = deployer;
  }

  /** Option 31: Deploy Oracle Management System */
  async deployOracleSystem() {
    return setup.deployOracleSystem(this);
  }

  /** Option 32: Register & Configure Oracles */
  async registerOracles() {
    return setup.registerOracles(this);
  }

  /** Option 33: Manage Oracle Whitelist */
  async manageWhitelist() {
    return whitelist.manageWhitelist(this);
  }

  async addUserToWhitelist() {
    return whitelist.addUserToWhitelist(this);
  }

  async upgradeWhitelistTier() {
    return whitelist.upgradeWhitelistTier(this);
  }

  async removeFromWhitelist() {
    return whitelist.removeFromWhitelist(this);
  }

  async viewWhitelistStatus() {
    return whitelist.viewWhitelistStatus(this);
  }

  async batchWhitelistOperations() {
    return whitelist.batchWhitelistOperations(this);
  }

  /** Option 34: Manage Oracle Blacklist */
  async manageBlacklist() {
    return blacklist.manageBlacklist(this);
  }

  async addUserToBlacklist() {
    return blacklist.addUserToBlacklist(this);
  }

  async emergencyBlacklist() {
    return blacklist.emergencyBlacklist(this);
  }

  async removeFromBlacklist() {
    return blacklist.removeFromBlacklist(this);
  }

  async viewBlacklistStatus() {
    return blacklist.viewBlacklistStatus(this);
  }

  async updateBlacklistSeverity() {
    return blacklist.updateBlacklistSeverity(this);
  }

  /** Option 35: Emergency Oracle Actions */
  async emergencyActions() {
    return blacklist.emergencyActions(this);
  }

  /** Option 36: Oracle Reputation Management */
  async manageReputation() {
    return reputation.manageReputation(this);
  }

  async rewardOracle() {
    return reputation.rewardOracle(this);
  }

  async penalizeOracle() {
    return reputation.penalizeOracle(this);
  }

  async viewDetailedOracleStats() {
    return reputation.viewDetailedOracleStats(this);
  }

  /** Option 37: Oracle Consensus Operations */
  async consensusOperations() {
    return reputation.consensusOperations(this);
  }

  async createConsensusQuery() {
    return reputation.createConsensusQuery(this);
  }

  async submitOracleVote() {
    return reputation.submitOracleVote(this);
  }

  async checkConsensusResult() {
    return reputation.checkConsensusResult(this);
  }

  async viewActiveQueries() {
    return reputation.viewActiveQueries(this);
  }

  /** Option 38: Integrate Oracles with Token */
  async integrateWithToken() {
    return dashboard.integrateWithToken(this);
  }

  /** Option 39: Oracle System Dashboard */
  async showDashboard() {
    return dashboard.showDashboard(this);
  }

  /** Option 40: Test Complete Oracle Integration */
  async testIntegration() {
    return dashboard.testIntegration(this);
  }
}

module.exports = OracleModule;
