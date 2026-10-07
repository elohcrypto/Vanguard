/**
 * @fileoverview Dynamic list management module
 * @module DynamicListModule
 * @description Handles dynamic whitelist/blacklist management including list updates,
 * proposals, and user lifecycle tracking.
 * Covers menu options 84-88.
 */

const status = require("../utils/DynamicListStatusFlow");
const proposals = require("../utils/DynamicListProposalFlow");
const signer = require("../utils/DynamicListSignerFlow");

/**
 * @class DynamicListModule
 * @description Manages dynamic list operations.
 */
class DynamicListModule {
  constructor(state, logger, promptUser) {
    this.state = state;
    this.logger = logger;
    this.promptUser = promptUser;
  }

  /** Option 84: Deploy Dynamic List Manager */
  async deployDynamicListSystem() {
    return status.deployDynamicListSystem(this);
  }

  /** Option 84, plan 2D.1: the manager writes the WhitelistOracle/BlacklistOracle */
  async _wireOracles(manager, address) {
    return status._wireOracles(this, manager, address);
  }

  /** Prompt with a visible default; the oracles need a tier/severity. */
  async _askNumber(question, def, min, max) {
    return status._askNumber(this, question, def, min, max);
  }

  /** D20: a list write names its duration: whole days, or "never". */
  async _askDuration(label, def) {
    return status._askDuration(this, label, def);
  }

  /** Expiry of each oracle list add in a receipt, as a date or "never". */
  static listExpiries(state, receipt) {
    return status.listExpiries(this, state, receipt);
  }

  /** Option 85: Manage Whitelist/Blacklist Status */
  async manageWhitelistBlacklistStatus() {
    return status.manageWhitelistBlacklistStatus(this);
  }

  /** Helper: View single user status */
  async _viewUserStatus() {
    return status._viewUserStatus(this);
  }

  /** Helper: View all user statuses */
  async _viewAllStatuses() {
    return status._viewAllStatuses(this);
  }

  /** Helper: Check proof validity */
  async _checkProofValidity() {
    return status._checkProofValidity(this);
  }

  /** Option 86: Create List Update Proposal */
  async createListUpdateProposal() {
    return proposals.createListUpdateProposal(this);
  }

  /** Option 87: View User Status History */
  async viewUserStatusHistory() {
    return proposals.viewUserStatusHistory(this);
  }

  /** Option 88: Demo Complete User Lifecycle */
  async demoCompleteUserLifecycle() {
    return proposals.demoCompleteUserLifecycle(this);
  }

  /** Option 89: Quick Fix: Verify Existing Signer for Voting */
  async verifyExistingSigner() {
    return signer.verifyExistingSigner(this);
  }
}

module.exports = DynamicListModule;
