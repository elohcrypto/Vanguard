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

const issuer = require("../utils/TokenIssuerFlow");
const onboarding = require("../utils/TokenOnboardingFlow");
const investors = require("../utils/TokenInvestorFlow");
const users = require("../utils/TokenUserFlow");
const mint = require("../utils/TokenMintFlow");
const distribution = require("../utils/TokenDistributionFlow");
const investorTransfers = require("../utils/TokenInvestorTransferFlow");
const userTransfers = require("../utils/TokenUserTransferFlow");
const peerTransfers = require("../utils/TokenPeerTransferFlow");
const restrictions = require("../utils/TokenRestrictionFlow");
const dashboard = require("../utils/TokenDashboardFlow");

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
    return issuer.deployERC3643System(this);
  }

  /** Option 22: Create Token Issuer */
  async createTokenIssuer() {
    return issuer.createTokenIssuer(this);
  }

  /** Option 23: Investor Onboarding System */
  async investorOnboarding() {
    return onboarding.investorOnboarding(this);
  }

  /** Create normal user for investor onboarding system */
  async createNormalUserForOnboarding() {
    return onboarding.createNormalUserForOnboarding(this);
  }

  /** Request investor status upgrade */
  async requestInvestorStatus() {
    return onboarding.requestInvestorStatus(this);
  }

  /** Bank transfers tokens to user */
  async bankTransfersTokensToUser() {
    return investors.bankTransfersTokensToUser(this);
  }

  /**
   * Option 23 -> 4: the bank (ops) creates the user's 2-of-2 MultiSigWallet
   * through InvestorRequestManager (Task 4.3);
   */
  async createMultiSigWalletForInvestor() {
    return investors.createMultiSigWalletForInvestor(this);
  }

  /** Pick a tracked investor matching `filter`; */
  async _pickInvestor(filter, title, hint) {
    return investors._pickInvestor(this, filter, title, hint);
  }

  /**
   * Option 23 -> 5: the user approves the wallet and locks the required
   * amount;
   */
  async lockTokensInMultiSig() {
    return investors.lockTokensInMultiSig(this);
  }

  /**
   * Option 23 -> 6: the bank approves through InvestorRequestManager, which
   * checks the lock is still held and assigns the type.
   */
  async approveInvestorRequest() {
    return investors.approveInvestorRequest(this);
  }

  /**
   * Option 23 -> 8: the user proposes and signs, the bank signs: the
   * MultiSigWallet pays everything it holds back to the user (2-of-2, never
   * a bare unfreeze);
   */
  async downgradeToNormalUser() {
    return investors.downgradeToNormalUser(this);
  }

  /** View all investor requests */
  async viewInvestorRequests() {
    return investors.viewInvestorRequests(this);
  }

  /** View all investors and users */
  async viewAllInvestors() {
    return investors.viewAllInvestors(this);
  }

  /** Display signer allocation status */
  displaySignerAllocation() {
    return investors.displaySignerAllocation(this);
  }

  /** Option 24: Create Normal Users */
  async createNormalUsers() {
    return users.createNormalUsers(this);
  }

  /** Create a compliant normal user with KYC/AML claims */
  async createCompliantNormalUser() {
    return users.createCompliantNormalUser(this);
  }

  /** Create a non-compliant normal user with rejected KYC */
  async createNonCompliantNormalUser() {
    return users.createNonCompliantNormalUser(this);
  }

  /** View all normal users */
  async viewAllNormalUsers() {
    return users.viewAllNormalUsers(this);
  }

  /** Option 25: Mint and Distribute Tokens */
  async mintAndDistributeTokens() {
    return mint.mintAndDistributeTokens(this);
  }

  /** Mint tokens to Central Bank */
  async mintToCentralBank(centralBank) {
    return mint.mintToCentralBank(this, centralBank);
  }

  /**
   * Pre-check a mint with the token's own predicate (2E.3: mint and
   * canTransfer(0, to, amount) share one path).
   */
  async _mintRefusal(digitalToken, to, amountWei) {
    return mint._mintRefusal(this, digitalToken, to, amountWei);
  }

  /** D22 (a): the central bank is a treasury, not an investor. */
  async _ensureTreasuryExempt(centralBank) {
    return mint._ensureTreasuryExempt(this, centralBank);
  }

  /** Complete minting to Central Bank (part 2) */
  async completeMintToCentralBank(centralBank, digitalToken, mintAmount) {
    return mint.completeMintToCentralBank(
      this,
      centralBank,
      digitalToken,
      mintAmount,
    );
  }

  /** View Central Bank balance */
  async viewCentralBankBalance(centralBank) {
    return mint.viewCentralBankBalance(this, centralBank);
  }

  /** Distribute to all approved investors (menu wrapper) */
  async distributeToAllApprovedFromMenu(centralBank) {
    return distribution.distributeToAllApprovedFromMenu(this, centralBank);
  }

  /** Distribute to specific investor (menu wrapper) */
  async distributeToSpecificInvestorFromMenu(centralBank) {
    return distribution.distributeToSpecificInvestorFromMenu(this, centralBank);
  }

  /** Distribute to all approved investors */
  async distributeToAllApproved(centralBank, approvedInvestors) {
    return distribution.distributeToAllApproved(
      this,
      centralBank,
      approvedInvestors,
    );
  }

  /** Complete distribution to all approved investors (part 2) */
  async completeDistributeToAllApproved(
    centralBank,
    approvedInvestors,
    amountPerInvestor,
    digitalToken,
  ) {
    return distribution.completeDistributeToAllApproved(
      this,
      centralBank,
      approvedInvestors,
      amountPerInvestor,
      digitalToken,
    );
  }

  /** Distribute to specific investor */
  async distributeToSpecificInvestor(centralBank, approvedInvestors) {
    return distribution.distributeToSpecificInvestor(
      this,
      centralBank,
      approvedInvestors,
    );
  }

  /** Show distribution rules */
  async showDistributionRules() {
    return distribution.showDistributionRules(this);
  }

  /** Option 26: Investor-to-Investor Transfer */
  async investorToInvestorTransfer() {
    return investorTransfers.investorToInvestorTransfer(this);
  }

  /** Execute normal transfer (within 8,000 limit) */
  async executeNormalTransfer(compliantInvestors) {
    return investorTransfers.executeNormalTransfer(this, compliantInvestors);
  }

  /** Complete normal transfer (part 2) */
  async completeNormalTransfer(
    sender,
    recipient,
    amount,
    amountWei,
    senderBalanceBefore,
    digitalToken,
    totalGasUsed,
  ) {
    return investorTransfers.completeNormalTransfer(
      this,
      sender,
      recipient,
      amount,
      amountWei,
      senderBalanceBefore,
      digitalToken,
      totalGasUsed,
    );
  }

  /** Execute excess transfer (>8,000 limit) */
  async executeExcessTransfer(compliantInvestors) {
    return investorTransfers.executeExcessTransfer(this, compliantInvestors);
  }

  /** Execute blocked transfer (to non-compliant) */
  async executeBlockedTransfer(allInvestors) {
    return investorTransfers.executeBlockedTransfer(this, allInvestors);
  }

  /** Option 27: Investor-to-User Transfer */
  async investorToUserTransfer() {
    return userTransfers.investorToUserTransfer(this);
  }

  /** Execute normal investor-to-user transfer */
  async executeInvestorToUserNormalTransfer(investors, users) {
    return userTransfers.executeInvestorToUserNormalTransfer(
      this,
      investors,
      users,
    );
  }

  /** Complete investor-to-user normal transfer (part 2) */
  async completeInvestorToUserNormalTransfer(investor, users) {
    return userTransfers.completeInvestorToUserNormalTransfer(
      this,
      investor,
      users,
    );
  }

  /** Execute excess investor-to-user transfer */
  async executeInvestorToUserExcessTransfer(investors, users) {
    return userTransfers.executeInvestorToUserExcessTransfer(
      this,
      investors,
      users,
    );
  }

  /** Execute blocked investor-to-user transfer */
  async executeInvestorToUserBlockedTransfer(investors) {
    return userTransfers.executeInvestorToUserBlockedTransfer(this, investors);
  }

  /** Option 27.5: User-to-User Transfer */
  async userToUserTransfer() {
    return peerTransfers.userToUserTransfer(this);
  }

  /** Option 28: transfer restriction scenarios on VSC (sub-menu 1-3) */
  async restrictedTransferScenarios() {
    return restrictions.restrictedTransferScenarios(this);
  }

  /** Demonstrate amount limit restriction */
  async demonstrateAmountLimit() {
    return restrictions.demonstrateAmountLimit(this);
  }

  /** Demonstrate non-compliant recipient restriction */
  async demonstrateNonCompliantRecipient() {
    return restrictions.demonstrateNonCompliantRecipient(this);
  }

  /** View transfer history */
  async viewTransferHistory() {
    return peerTransfers.viewTransferHistory(this);
  }

  /** Option 29: ERC-3643 Dashboard */
  async showDashboard() {
    return dashboard.showDashboard(this);
  }

  /** Show investor details in dashboard (part 2) */
  async showDashboardInvestors(digitalToken) {
    return dashboard.showDashboardInvestors(this, digitalToken);
  }

  /** Show user details and system status in dashboard (part 3) */
  async showDashboardUsers(digitalToken) {
    return dashboard.showDashboardUsers(this, digitalToken);
  }

  /** Show compliance metrics and system status (part 4) */
  async showDashboardMetrics(digitalToken) {
    return dashboard.showDashboardMetrics(this, digitalToken);
  }

  /** Option 30: Transaction Summary */
  async showTransactionSummary() {
    return dashboard.showTransactionSummary(this);
  }
}

module.exports = TokenModule;
