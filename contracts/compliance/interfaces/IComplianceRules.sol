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
     * @dev Add a trusted contract (e.g., escrow wallet). Must have code; its own
     * identity check is skipped, the counterparty's is not.
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
