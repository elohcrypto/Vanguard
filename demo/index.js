#!/usr/bin/env node

/**
 * @fileoverview Main entry point for the Interactive KYC/AML Demo
 * @module InteractiveDemo
 * @description Orchestrates all demo modules and provides the main interactive loop.
 * This is the refactored entry point that replaces the monolithic 18,553-line file
 * with a clean, modular architecture.
 *
 * @example
 * // Run the demo
 * node demo/index.js
 * // or
 * npm run demo:interactive:proof
 */

const { ethers } = require("hardhat");
const readline = require("readline");
const path = require("path");

// Core Components
const DemoState = require("./core/DemoState");
const ContractDeployer = require("./core/ContractDeployer");
const MenuSystem = require("./core/MenuSystem");

// Feature Modules
const OnchainIDModule = require("./modules/OnchainIDModule");
const ComplianceModule = require("./modules/ComplianceModule");
const TokenModule = require("./modules/TokenModule");
const OracleModule = require("./modules/OracleModule");
const PrivacyModule = require("./modules/PrivacyModule");
const InvestorTypeModule = require("./modules/InvestorTypeModule");
const EscrowModule = require("./modules/EscrowModule");
const GovernanceModule = require("./modules/GovernanceModule");
const DynamicListModule = require("./modules/DynamicListModule");
const HandoverModule = require("./modules/HandoverModule");

// Utilities
const SignerManager = require("./utils/SignerManager");
const ProofGenerator = require("./utils/ProofGenerator");
const {
  displaySection,
  displaySuccess,
  displayError,
} = require("./utils/DisplayHelpers");

// Logging
const { EnhancedLogger } = require("./logging");

/**
 * @class InteractiveDemo
 * @description Main demo orchestrator that manages all modules and the interactive loop.
 */
class InteractiveDemo {
  /**
   * Create an InteractiveDemo instance
   */
  constructor() {
    /**
     * @property {DemoState} state - Centralized state management
     * @private
     */
    this.state = new DemoState();

    /**
     * @property {EnhancedLogger} logger - Enhanced logging system
     * @private
     */
    this.logger = new EnhancedLogger();

    /**
     * @property {SignerManager} signerManager - Signer allocation manager
     * @private
     */
    this.signerManager = null;

    /**
     * @property {ProofGenerator} proofGenerator - ZK proof generator
     * @private
     */
    this.proofGenerator = null;

    /**
     * @property {readline.Interface} rl - Readline interface for user input
     * @private
     */
    this.rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    /**
     * @property {Object} modules - Feature modules
     * @private
     */
    this.modules = {};

    /**
     * @property {MenuSystem} menuSystem - Menu system instance
     * @private
     */
    this.menuSystem = null;
  }

  /**
   * Initialize the demo system
   *
   * @returns {Promise<void>}
   * @private
   */
  async initialize() {
    console.log("🎯 COMPLETE INTERACTIVE KYC/AML + DIGITAL TOKEN DEMO");
    console.log("=".repeat(70));
    console.log("Modular architecture with comprehensive functionality");
    console.log("");

    try {
      // Get signers from Hardhat
      this.state.signers = await ethers.getSigners();
      console.log(
        `✅ Loaded ${this.state.signers.length} signers from Hardhat`,
      );

      // Initialize managers
      this.signerManager = new SignerManager(this.state);
      this.proofGenerator = new ProofGenerator(this.state);

      // Initialize logger
      this.logger.initialize(ethers.provider);

      // Load all feature modules dynamically
      await this.loadModules();

      console.log("✅ Demo system initialized successfully");
      console.log("");
    } catch (error) {
      console.error("❌ Initialization failed:", error.message);
      throw error;
    }
  }

  /**
   * Load all feature modules
   *
   * @returns {Promise<void>}
   * @private
   */
  async loadModules() {
    console.log("📦 Loading demo modules...");

    // Initialize ContractDeployer
    const deployer = new ContractDeployer(this.state, this.logger);

    // Initialize all feature modules with dependency injection
    const onchainID = new OnchainIDModule(
      this.state,
      this.logger,
      this.promptUser.bind(this),
    );
    const compliance = new ComplianceModule(
      this.state,
      this.logger,
      this.promptUser.bind(this),
      deployer,
    );
    const token = new TokenModule(
      this.state,
      this.logger,
      this.promptUser.bind(this),
      deployer,
      this.signerManager,
    );
    const oracle = new OracleModule(
      this.state,
      this.logger,
      this.promptUser.bind(this),
      deployer,
    );
    const privacy = new PrivacyModule(
      this.state,
      this.logger,
      this.promptUser.bind(this),
      this.proofGenerator,
    );
    const investorType = new InvestorTypeModule(
      this.state,
      this.logger,
      this.promptUser.bind(this),
    );
    const escrow = new EscrowModule(
      this.state,
      this.logger,
      this.promptUser.bind(this),
    );
    const governance = new GovernanceModule(
      this.state,
      this.logger,
      this.promptUser.bind(this),
    );
    const dynamicList = new DynamicListModule(
      this.state,
      this.logger,
      this.promptUser.bind(this),
    );
    const handover = new HandoverModule(
      this.state,
      this.logger,
      this.promptUser.bind(this),
    );

    // Store modules
    this.modules = {
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
    };

    // Initialize MenuSystem
    this.menuSystem = new MenuSystem(
      this.state,
      this.modules,
      this.promptUser.bind(this),
    );

    console.log("✅ All modules loaded successfully");
    console.log("   ✓ ContractDeployer");
    console.log("   ✓ OnchainIDModule");
    console.log("   ✓ ComplianceModule");
    console.log("   ✓ TokenModule");
    console.log("   ✓ OracleModule");
    console.log("   ✓ PrivacyModule");
    console.log("   ✓ InvestorTypeModule");
    console.log("   ✓ EscrowModule");
    console.log("   ✓ GovernanceModule");
    console.log("   ✓ DynamicListModule");
    console.log("   ✓ MenuSystem");
  }

  /**
   * Prompt user for input
   *
   * @param {string} question - Question to ask
   * @returns {Promise<string>} User's answer
   * @private
   */
  async promptUser(question) {
    return new Promise((resolve) => {
      this.rl.question(question, (answer) => {
        resolve(answer.trim());
      });
    });
  }

  /**
   * Run the interactive demo loop
   *
   * @returns {Promise<void>}
   */
  async run() {
    await this.initialize();

    console.log("🚀 Starting interactive demo with modular architecture...");
    console.log("");

    // Run the modular menu system
    await this.menuSystem.runInteractiveLoop();

    // Close readline interface
    this.rl.close();

    // Exit the process
    console.log("🔚 Exiting...");
    process.exit(0);
  }
}

/**
 * Main execution
 */
async function main() {
  const demo = new InteractiveDemo();

  try {
    await demo.run();
  } catch (error) {
    console.error("❌ Demo failed:", error);
    process.exit(1);
  }
}

// Run if executed directly
if (require.main === module) {
  main().catch(console.error);
}

module.exports = { InteractiveDemo };
