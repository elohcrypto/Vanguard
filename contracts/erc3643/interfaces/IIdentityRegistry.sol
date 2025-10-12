// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title IIdentityRegistry
 * @dev Interface for ERC-3643 Identity Registry
 */
interface IIdentityRegistry {
    // Events
    event IdentityStored(address indexed investorAddress, address indexed identity);
    event IdentityRemoved(address indexed investorAddress, address indexed identity);
    event CountryUpdated(address indexed investorAddress, uint16 country);

    // Core Functions
    function registerIdentity(address user, address identity, uint16 country) external;

    function deleteIdentity(address user) external;

    function updateCountry(address user, uint16 country) external;

    // Query Functions
    function identity(address user) external view returns (address);

    function investorCountry(address user) external view returns (uint16);

    function isVerified(address user) external view returns (bool);

    // Batch Functions
    function batchRegisterIdentity(
        address[] memory users,
        address[] memory identities,
        uint16[] memory countries
    ) external;
}
