/**
 * @fileoverview OnchainID management module
 * @module OnchainIDModule
 * @description Handles all OnchainID-related operations including identity creation,
 * key management, claim issuance (KYC/AML), and identity recovery.
 * Covers menu options 1-12.
 *
 * @example
 * const OnchainIDModule = require('./modules/OnchainIDModule');
 * const module = new OnchainIDModule(state, logger, promptUser);
 * await module.createOnchainID();
 */

const creation = require("../utils/OnchainIDCreationFlow");
const keys = require("../utils/OnchainIDKeysFlow");
const recovery = require("../utils/OnchainIDRecoveryFlow");
const claimMenu = require("../utils/OnchainIDClaimMenuFlow");
const claims = require("../utils/OnchainIDClaimFlow");

/**
 * @class OnchainIDModule
 * @description Manages OnchainID operations for the demo system.
 * Handles identity creation, management keys, KYC/AML claims, and recovery.
 */
class OnchainIDModule {
  /**
   * Create an OnchainIDModule
   * @param {Object} state - DemoState instance
   * @param {Object} logger - EnhancedLogger instance
   * @param {Function} promptUser - Function to prompt user for input
   */
  constructor(state, logger, promptUser) {
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

    /**
     * @property {Function} promptUser - User input function
     * @private
     */
    this.promptUser = promptUser;
  }

  /** Option 3: Create OnchainID for a user */
  async createOnchainID() {
    return creation.createOnchainID(this);
  }

  /** Register identity in ERC-3643 registry */
  async registerInERC3643(signer, identityAddress) {
    return creation.registerInERC3643(this, signer, identityAddress);
  }

  /** Option 2: Create management keys */
  async createManagementKeys() {
    return keys.createManagementKeys(this);
  }

  /** Option 4: Review identity keys */
  async reviewIdentityKeys() {
    return keys.reviewIdentityKeys(this);
  }

  /** Option 5: Recover lost keys */
  async recoverLostKeys() {
    return recovery.recoverLostKeys(this);
  }

  /** Option 6: Manage KYC claims */
  async manageKYCClaims() {
    return claimMenu.manageKYCClaims(this);
  }

  /** Option 7: Manage AML claims */
  async manageAMLClaims() {
    return claimMenu.manageAMLClaims(this);
  }

  /** Option 8: Review claim status and history */
  async reviewClaimStatusHistory() {
    return claimMenu.reviewClaimStatusHistory(this);
  }

  /** Option 9: Create UTXO with KYC/AML data */
  async createUTXOWithCompliance() {
    return creation.createUTXOWithCompliance(this);
  }

  /**
   * Option 10: show a UTXO record option 9 stored in demo memory, with the
   * KYC/AML statuses copied into it then.
   */
  async showUTXORecord() {
    return creation.showUTXORecord(this);
  }

  /** Option 11: Demo claim expiry. */
  async demoClaimExpiry() {
    return claimMenu.demoClaimExpiry(this);
  }

  /** Issue KYC claim for an identity */
  async issueKYCClaimForIdentity(identity) {
    return claims.issueKYCClaimForIdentity(this, identity);
  }

  /** Reject KYC claim for an identity */
  async rejectKYCClaimForIdentity(identity) {
    return claims.rejectKYCClaimForIdentity(this, identity);
  }

  /** Update KYC status for an identity */
  async updateKYCStatusForIdentity(identity) {
    return claims.updateKYCStatusForIdentity(this, identity);
  }

  /** View KYC history for an identity */
  async viewKYCHistoryForIdentity(identity) {
    return claims.viewKYCHistoryForIdentity(this, identity);
  }

  /** Revoke KYC claim for an identity */
  async revokeKYCClaimForIdentity(identity) {
    return claims.revokeKYCClaimForIdentity(this, identity);
  }

  /** Issue AML claim for an identity */
  async issueAMLClaimForIdentity(identity) {
    return claims.issueAMLClaimForIdentity(this, identity);
  }

  /** Reject AML claim for an identity */
  async rejectAMLClaimForIdentity(identity) {
    return claims.rejectAMLClaimForIdentity(this, identity);
  }

  /** Update AML status for an identity */
  async updateAMLStatusForIdentity(identity) {
    return claims.updateAMLStatusForIdentity(this, identity);
  }

  /** View AML history for an identity */
  async viewAMLHistoryForIdentity(identity) {
    return claims.viewAMLHistoryForIdentity(this, identity);
  }

  /** Revoke AML claim for an identity */
  async revokeAMLClaimForIdentity(identity) {
    return claims.revokeAMLClaimForIdentity(this, identity);
  }

  /** Remove a compromised key from an identity */
  async removeCompromisedKey(onchainID, identity) {
    return recovery.removeCompromisedKey(this, onchainID, identity);
  }
}

module.exports = OnchainIDModule;
