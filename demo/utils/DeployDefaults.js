/**
 * @fileoverview Default jurisdiction lists for the demo's ComplianceRules deployments
 * @module DeployDefaults
 * @description The two country lists every automated ComplianceRules deploy
 * uses. Moved out of demo/core/ContractDeployer.js (plan v2 Task 4.8) so the
 * deploy helpers share one definition.
 */

"use strict";

/**
 * Default jurisdiction rules for every automated ComplianceRules deployment.
 *
 * ISO 3166-1 numeric codes, matching the list the demo prints at
 * demo/utils/ComplianceSetupFlow.js:48-58 (option 13).
 *
 * WHITELIST SEMANTICS: a NON-EMPTY allow list is EXCLUSIVE — ComplianceRules
 * .sol:138-140 blocks any country not in it. So adding Hong Kong here does not
 * merely permit HK, it restricts transfers to these ten jurisdictions only.
 * An empty list means "everywhere except the blocked list".
 *
 * Defined once because ContractDeployer.js previously held TWO different defaults:
 * `deployComplianceRules()` used this whitelist, while the fallback inside
 * `deployDigitalTokenSystem()` used an EMPTY allow list. Which rules you got
 * depended on which code path happened to deploy the contract first.
 */
const DEFAULT_ALLOWED_COUNTRIES = [
  840, // United States
  826, // United Kingdom
  124, // Canada
  276, // Germany
  250, // France
  392, // Japan
  702, // Singapore
  36, // Australia
  344, // Hong Kong
  756, // Switzerland
];

/** Blocked regardless of the whitelist (ComplianceRules.sol checks these first). */
const DEFAULT_BLOCKED_COUNTRIES = [
  156, // China
  643, // Russia
  850, // North Korea
  364, // Iran
  760, // Syria
];

module.exports = { DEFAULT_ALLOWED_COUNTRIES, DEFAULT_BLOCKED_COUNTRIES };
