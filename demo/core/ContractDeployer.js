/**
 * @fileoverview Contract deployment module for the Interactive KYC/AML Demo
 * @module ContractDeployer
 * @description Handles deployment of all smart contracts including OnchainID,
 * ERC-3643 registries, compliance rules, oracles, privacy systems, and more.
 *
 * @example
 * const ContractDeployer = require('./core/ContractDeployer');
 * const deployer = new ContractDeployer(state, logger);
 * await deployer.deployAllContracts();
 */

const everything = require("../utils/DeployEverythingFlow");
const core = require("../utils/DeployCoreFlow");
const tokenSystem = require("../utils/DeployTokenFlow");
const oracles = require("../utils/DeployOracleFlow");

/**
 * @class ContractDeployer
 * @description Manages deployment of all smart contracts for the demo system.
 */
class ContractDeployer {
  /**
   * Create a ContractDeployer
   * @param {Object} state - DemoState instance
   * @param {Object} logger - EnhancedLogger instance
   */
  constructor(state, logger) {
    /**
     * @property {Object} state - Reference to DemoState
     * @private
     */
    this.state = state;

    /**
     * @property {Object} logger - Reference to EnhancedLogger
     * @private
     */
    this.logger = logger;
  }

  /** Option 1a: One-click deployment of the full stack, in dependency order. */
  async deployEverything(modules) {
    return everything.deployEverything(this, modules);
  }

  /** Print what deployed and what did not. */
  _reportDeploySummary(done, steps, reached) {
    return everything._reportDeploySummary(this, done, steps, reached);
  }

  /** Deploy all contracts for the demo */
  async deployAllContracts() {
    return everything.deployAllContracts(this);
  }

  /** Deploy OnchainID contracts (Factory, KYC Issuer, AML Issuer) */
  async deployOnchainIDContracts() {
    return core.deployOnchainIDContracts(this);
  }

  /** Deploy ERC-3643 registries */
  async deployERC3643Registries() {
    return core.deployERC3643Registries(this);
  }

  /** Deploy ZKVerifierIntegrated(testingMode = false) and PrivacyManager on */
  async deployPrivacyPair() {
    return core.deployPrivacyPair(this);
  }

  /** Point ComplianceRules at the PrivacyManager for VSC, leaving the */
  async wirePrivacyManager() {
    return core.wirePrivacyManager(this);
  }

  /** Deploy ComplianceRules contract with user-provided configuration */
  async deployComplianceRulesWithConfig(allowedCountries, blockedCountries) {
    return core.deployComplianceRulesWithConfig(
      this,
      allowedCountries,
      blockedCountries,
    );
  }

  /** Deploy ComplianceRules contract with default configuration */
  async deployComplianceRules() {
    return core.deployComplianceRules(this);
  }

  /** Deploy ERC-3643 Digital Token System with full configuration */
  async deployDigitalTokenSystem() {
    return tokenSystem.deployDigitalTokenSystem(this);
  }

  /** Plan v2 Task 4.3: deploy InvestorRequestManager for VSC (bank = ops, */
  async deployInvestorCustody() {
    return tokenSystem.deployInvestorCustody(this);
  }

  /** Deploy Oracle Management System */
  async deployOracleSystem() {
    return oracles.deployOracleSystem(this);
  }
}

module.exports = ContractDeployer;
