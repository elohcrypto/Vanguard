/**
 * @fileoverview Privacy and ZK verification module
 * @module PrivacyModule
 * @description Handles privacy-preserving compliance operations including ZK proof
 * generation, verification, and privacy settings management.
 * Covers menu options 41-50.
 */

const options = require("../utils/PrivacyOptionsFlow");
const jurisdiction = require("../utils/PrivacyJurisdictionFlow");
const jurisdictionEdits = require("../utils/PrivacyJurisdictionEdits");
const proofs = require("../utils/PrivacyProofFlow");

/**
 * @class PrivacyModule
 * @description Manages privacy and ZK verification operations.
 */
class PrivacyModule {
  constructor(state, logger, promptUser, proofGenerator) {
    this.state = state;
    this.logger = logger;
    this.promptUser = promptUser;
    this.proofGenerator = proofGenerator;
  }

  /** Initialise the real proof generator (idempotent) and return it. */
  async realGenerator() {
    return options.realGenerator(this);
  }

  /** Option 41: attach the privacy system. */
  async deployPrivacySystem() {
    return options.deployPrivacySystem(this);
  }

  /** Option 41b: ZK status (real proofs only; */
  async viewZKModeStatus() {
    return options.viewZKModeStatus(this);
  }

  /** Option 42: Submit Private Compliance Proofs */
  async submitPrivateProofs() {
    return options.submitPrivateProofs(this);
  }

  /** Option 42 -> 7: Manage Jurisdiction Lists */
  async manageJurisdictionLists() {
    return jurisdiction.manageJurisdictionLists(this);
  }

  /** Helper: Validate jurisdiction lists for conflicts */
  validateJurisdictionLists() {
    return jurisdiction.validateJurisdictionLists(this);
  }

  /** Helper: Load jurisdiction lists from on-chain ComplianceRules contract */
  async loadJurisdictionListsFromContract() {
    return jurisdiction.loadJurisdictionListsFromContract(this);
  }

  /** Helper: Update jurisdiction rule on-chain via governance proposal */
  async updateJurisdictionRuleOnChain() {
    return jurisdiction.updateJurisdictionRuleOnChain(this);
  }

  /** Helper: Create governance proposal for jurisdiction rule update */
  async createJurisdictionProposal() {
    return jurisdiction.createJurisdictionProposal(this);
  }

  /** Helper: Direct update (owner only - for testing) */
  async directUpdateJurisdictionRule() {
    return jurisdiction.directUpdateJurisdictionRule(this);
  }

  async viewJurisdictionLists() {
    return jurisdictionEdits.viewJurisdictionLists(this);
  }

  async addToAllowedJurisdictions() {
    return jurisdictionEdits.addToAllowedJurisdictions(this);
  }

  async removeFromAllowedJurisdictions() {
    return jurisdictionEdits.removeFromAllowedJurisdictions(this);
  }

  async addToDisallowedJurisdictions() {
    return jurisdictionEdits.addToDisallowedJurisdictions(this);
  }

  async removeFromDisallowedJurisdictions() {
    return jurisdictionEdits.removeFromDisallowedJurisdictions(this);
  }

  async resetJurisdictionLists() {
    return jurisdictionEdits.resetJurisdictionLists(this);
  }

  /** Option 43: whitelist status as ComplianceRules reads it. */
  async verifyWhitelistMembership() {
    return options.verifyWhitelistMembership(this);
  }

  /**
   * Options 44 and 45: the attestation records on PrivacyManager for every
   * demo wallet, with the validator's answer (Task 3.7b).
   */
  async attestationView(circuit, title, emoji, option) {
    return options.attestationView(this, circuit, title, emoji, option);
  }

  /** Option 44: Verify Private Jurisdiction Eligibility */
  async verifyJurisdiction() {
    return options.verifyJurisdiction(this);
  }

  /** Option 45: Verify Private Accreditation Status */
  async verifyAccreditation() {
    return options.verifyAccreditation(this);
  }

  /**
   * Option 46: Privacy-Preserving Compliance Validation, read from
   * PrivacyManager.validateAllPrivateCompliance for every demo wallet with
   * any status: the whitelist binding and the three attestation records
   * (each under the user's preference flags).
   */
  async privacyPreservingValidation() {
    return options.privacyPreservingValidation(this);
  }

  /**
   * Option 47: privacy settings, read and set on chain
   * (PrivacySettingsFlow.js)
   */
  async managePrivacySettings() {
    return options.managePrivacySettings(this);
  }

  /** Option 48: verifier counters and wiring, read from chain */
  async showStatistics() {
    return options.showStatistics(this);
  }

  /** Option 49: eight privacy integration checks read from chain */
  async testIntegration() {
    return options.testIntegration(this);
  }

  /** Option 50: wire VSC's ComplianceRules to PrivacyManager; */
  async integrateWithToken() {
    return options.integrateWithToken(this);
  }

  async submitWhitelistMembershipProof() {
    return proofs.submitWhitelistMembershipProof(this);
  }

  /**
   * Option 42 -> 2 (Task 3.7): prove the bound wallet's holder owns a
   * commitment in the current whitelist root whose identity is not on the
   * BlacklistOracle's list, verify it through the wrapper, then show a
   * listed identity cannot prove.
   */
  async submitBlacklistNonMembershipProof() {
    return proofs.submitBlacklistNonMembershipProof(this);
  }

  /**
   * The wallet that signs-then-proves in 42 -> 3/4/5: a typed index, else
   * the first KYC/AML verified wallet after the deployer, else wallet 1.
   */
  async pickAttestationUser() {
    return proofs.pickAttestationUser(this);
  }

  /**
   * Shared tail of 42 -> 3/4/5 (Task 3.7b): the demo issuer signs, the user
   * proves through scripts/zk/prove-attestation.js and binds the record on
   * PrivacyManager;
   */
  async attest(circuit, user, attributes, label) {
    return proofs.attest(this, circuit, user, attributes, label);
  }

  /**
   * Option 42 -> 3: an issuer attests the user's jurisdiction as its
   * country's PrivacyManager bit;
   */
  async submitJurisdictionEligibilityProof() {
    return proofs.submitJurisdictionEligibilityProof(this);
  }

  /** Option 42 -> 4: an issuer attests the user's accreditation amount; */
  async submitAccreditationStatusProof() {
    return proofs.submitAccreditationStatusProof(this);
  }

  /**
   * Option 42 -> 5: an issuer attests four compliance scores in one
   * attestation;
   */
  async submitComplianceAggregationProof() {
    return proofs.submitComplianceAggregationProof(this);
  }

  /**
   * Option 42 -> 6: all five real proofs for one wallet
   * (PrivacyBatchFlow.js)
   */
  async submitAllPrivateProofs() {
    return proofs.submitAllPrivateProofs(this);
  }
}

module.exports = PrivacyModule;
