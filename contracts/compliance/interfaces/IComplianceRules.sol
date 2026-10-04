// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title IComplianceRules
 * @dev The slice of ComplianceRules other contracts call (plan v2 Task 4.1):
 *      IdentityRegistry asks validateJurisdiction at registration, and
 *      PrivacyManager reads both functions through its own inline
 *      IJurisdictionRuleSource (same selectors and return shapes, which this
 *      interface pins on the deployed contract). Token and GovernanceToken
 *      use IComplianceHooks; governance reaches the setters by calldata.
 */
interface IComplianceRules {
    /**
     * @dev Validate jurisdiction compliance
     * @param token Token contract address
     * @param countryCode Country code to validate
     * @return isValid Whether the jurisdiction is valid
     * @return reason Reason for validation result
     */
    function validateJurisdiction(
        address token,
        uint256 countryCode
    ) external view returns (bool isValid, string memory reason);

    /**
     * @dev Bumped by every write to `token`'s jurisdiction verdict; never
     *      decreases. PrivacyManager folds it into its policy hash.
     */
    function jurisdictionRuleVersion(address token) external view returns (uint256);
}
