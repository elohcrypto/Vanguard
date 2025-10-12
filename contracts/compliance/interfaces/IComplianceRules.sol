// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title IComplianceRules
 * @dev Interface for configurable compliance rule engine
 */
interface IComplianceRules {
    /**
     * @dev Set jurisdiction-based validation rules
     * @param token Token contract address
     * @param allowedCountries Array of allowed country codes
     * @param blockedCountries Array of blocked country codes
     */
    function setJurisdictionRule(
        address token,
        uint256[] calldata allowedCountries,
        uint256[] calldata blockedCountries
    ) external;

    /**
     * @dev Set investor type validation rules
     * @param token Token contract address
     * @param allowedTypes Array of allowed investor types
     * @param blockedTypes Array of blocked investor types
     * @param minimumAccreditation Minimum accreditation level required
     */
    function setInvestorTypeRule(
        address token,
        uint8[] calldata allowedTypes,
        uint8[] calldata blockedTypes,
        uint256 minimumAccreditation
    ) external;

    /**
     * @dev Set holding period and transfer cooldown rules
     * @param token Token contract address
     * @param minimumHoldingPeriod Minimum time tokens must be held before transfer
     * @param transferCooldown Cooldown period between transfers
     */
    function setHoldingPeriodRule(address token, uint256 minimumHoldingPeriod, uint256 transferCooldown) external;

    /**
     * @dev Set compliance level aggregation and inheritance rules
     * @param token Token contract address
     * @param minimumLevel Minimum compliance level required
     * @param maximumLevel Maximum compliance level allowed
     * @param levels Array of compliance levels
     * @param inheritanceLevels Array of corresponding inheritance levels
     */
    function setComplianceLevelRule(
        address token,
        uint8 minimumLevel,
        uint8 maximumLevel,
        uint8[] calldata levels,
        uint8[] calldata inheritanceLevels
    ) external;

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
     * @dev Validate investor type compliance
     * @param token Token contract address
     * @param investorType Investor type to validate
     * @param accreditationLevel Accreditation level of investor
     * @return isValid Whether the investor type is valid
     * @return reason Reason for validation result
     */
    function validateInvestorType(
        address token,
        uint8 investorType,
        uint256 accreditationLevel
    ) external view returns (bool isValid, string memory reason);

    /**
     * @dev Validate holding period compliance
     * @param token Token contract address
     * @param investor Investor address
     * @param acquisitionTime Time when tokens were acquired
     * @return isValid Whether the holding period is satisfied
     * @return reason Reason for validation result
     */
    function validateHoldingPeriod(
        address token,
        address investor,
        uint256 acquisitionTime
    ) external view returns (bool isValid, string memory reason);

    /**
     * @dev Aggregate compliance levels from multiple inputs
     * @param token Token contract address
     * @param inputLevels Array of input compliance levels
     * @return aggregatedLevel Resulting aggregated compliance level
     * @return isValid Whether the aggregated level is valid
     */
    function aggregateComplianceLevels(
        address token,
        uint8[] calldata inputLevels
    ) external view returns (uint8 aggregatedLevel, bool isValid);

    /**
     * @dev Record transfer for holding period tracking
     * @param token Token contract address
     * @param from Sender address
     * @param to Recipient address
     * @param acquisitionTime Time when recipient acquired tokens
     */
    function recordTransfer(address token, address from, address to, uint256 acquisitionTime) external;

    /**
     * @dev Add a trusted contract (e.g., escrow wallet) that can bypass KYC/AML
     * @param contractAddress Address of the trusted contract
     */
    function addTrustedContract(address contractAddress) external;

    /**
     * @dev Remove a trusted contract
     * @param contractAddress Address of the contract to remove
     */
    function removeTrustedContract(address contractAddress) external;

    /**
     * @dev Check if an address is a trusted contract
     * @param contractAddress Address to check
     * @return isTrusted Whether the address is a trusted contract
     */
    function isTrustedContract(address contractAddress) external view returns (bool isTrusted);
}
