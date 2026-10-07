/**
 * @fileoverview Enhanced escrow system module
 * @module EscrowModule
 * @description Handles escrow operations including wallet creation, payment workflows,
 * dispute resolution, and investor mediation.
 * Covers menu options 61-73.
 */

const setup = require("../utils/EscrowSetupFlow");
const wallets = require("../utils/EscrowWalletFlow");
const disputes = require("../utils/EscrowDisputeFlow");
const release = require("../utils/EscrowReleaseFlow");
const escrowStatus = require("../utils/EscrowStatusFlow");
const balances = require("../utils/EscrowBalancesFlow");

/**
 * @class EscrowModule
 * @description Manages enhanced escrow operations.
 */
class EscrowModule {
  constructor(state, logger, promptUser) {
    this.state = state;
    this.logger = logger;
    this.promptUser = promptUser;
  }

  /** Option 61: Deploy Enhanced Escrow System */
  async deployEscrowSystem() {
    return setup.deployEscrowSystem(this);
  }

  /** Helper: Get signer for a specific address */
  async getSignerForAddress(address) {
    return setup.getSignerForAddress(this, address);
  }

  /**
   * Helper: make a human party a verified identity (OnchainID, KYC + AML
   * claims, registry entry).
   */
  async _ensureVerified(address, label) {
    return setup._ensureVerified(this, address, label);
  }

  /**
   * Helper: D26 caps the human side of every escrow leg, and each release
   * pays the fee wallets, so on a registry-bound VSC their holding cap would
   * eventually refuse every release.
   */
  async _ensureFeeExempt(address, label) {
    return setup._ensureFeeExempt(this, address, label);
  }

  /** Helper: who signs registerInvestor (ADMIN_ROLE). */
  async _investorAdmin(escrowFactory) {
    return setup._investorAdmin(this, escrowFactory);
  }

  /** Option 62: Register Investor (from Option 23) */
  async registerInvestor() {
    return setup.registerInvestor(this);
  }

  /** Option 63: Investor: Create Escrow Wallet */
  async createEscrowWallet() {
    return wallets.createEscrowWallet(this);
  }

  /** Option 64: Payer: Fund Escrow Wallet */
  async fundEscrowWallet() {
    return wallets.fundEscrowWallet(this);
  }

  /** Option 65: Payee: Submit Shipment Proof */
  async submitShipmentProof() {
    return disputes.submitShipmentProof(this);
  }

  /** Option 66: Payer: Raise Dispute */
  async raiseDispute() {
    return disputes.raiseDispute(this);
  }

  /** Option 67: Investor: Resolve Dispute */
  async resolveDispute() {
    return disputes.resolveDispute(this);
  }

  /** Option 68: Payee: Sign Release */
  async payeeSignRelease() {
    return disputes.payeeSignRelease(this);
  }

  /** Option 69: Investor: Sign Release */
  async investorSignRelease() {
    return release.investorSignRelease(this);
  }

  /** Option 70: Investor: Manual Refund */
  async manualRefund() {
    return disputes.manualRefund(this);
  }

  /** Option 70a: Sweep tokens stranded in a settled escrow */
  async sweepExcess() {
    return disputes.sweepExcess(this);
  }

  /** Helper: Get state emoji */
  getStateEmoji(state) {
    return escrowStatus.getStateEmoji(this, state);
  }

  /** Option 71: View Escrow Wallet Status */
  async viewEscrowStatus() {
    return escrowStatus.viewEscrowStatus(this);
  }

  /** Helper: View Escrow Status Part 2 (continuation) */
  async _viewEscrowStatusPart2(
    wallet,
    status,
    shipmentProof,
    amount,
    investorFee,
    ownerFee,
    selectedWallet,
    payer,
    payee,
    investor,
    token,
  ) {
    return escrowStatus._viewEscrowStatusPart2(
      this,
      wallet,
      status,
      shipmentProof,
      amount,
      investorFee,
      ownerFee,
      selectedWallet,
      payer,
      payee,
      investor,
      token,
    );
  }

  /** Option 71a: View All Parties Balances */
  async viewAllPartiesBalances() {
    return balances.viewAllPartiesBalances(this);
  }

  /** Option 72: Enhanced Escrow Dashboard */
  async showDashboard() {
    return balances.showDashboard(this);
  }

  /** Option 73: Demo Complete Enhanced Escrow Workflow */
  async demoCompleteWorkflow() {
    return release.demoCompleteWorkflow(this);
  }

  /** Option 73a: Time Travel (13 Days) */
  async timeTravel13Days() {
    return release.timeTravel13Days(this);
  }

  /** Option 73b: Time Travel (14 Days) */
  async timeTravel14Days() {
    return release.timeTravel14Days(this);
  }
}

module.exports = EscrowModule;
