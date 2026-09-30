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

    /// @notice Move an existing registration to a new wallet (recovery path).
    /// @dev Does not re-run jurisdiction validation: the user is already
    ///      admitted, and re-validating would strand a since-sanctioned user.
    function moveIdentity(address fromWallet, address toWallet) external;

    /// @notice Identity a wallet held before moveIdentity relocated it, or
    ///         address(0). Cleared when the wallet is registered again.
    function formerIdentity(address wallet) external view returns (address);

    function updateCountry(address user, uint16 country) external;

    // Query Functions
    function identity(address user) external view returns (address);

    function investorCountry(address user) external view returns (uint16);

    function isVerified(address user) external view returns (bool);

    /// @notice Number of registered identities — the eligible-voter denominator
    ///         for 1-person-1-vote governance quorum.
    function registeredIdentityCount() external view returns (uint256);

    /// @notice registeredIdentityCount as it stood at `timestamp` (the last
    ///         change at or before it). Governance reads it at a proposal's
    ///         voter-age cutoff so fresh identities do not raise quorum.
    function registeredIdentityCountAt(uint48 timestamp) external view returns (uint256);

    /// @notice Start of `identity`'s current binding, or 0 if never bound.
    ///         Restarted by every bind of an unbound identity; kept by
    ///         moveIdentity (recovery).
    function identityRegisteredAt(address identity) external view returns (uint64);

    /// @notice The one wallet `identity` is bound to, or address(0).
    function walletOf(address identity) external view returns (address);

    // Batch Functions
    function batchRegisterIdentity(
        address[] memory users,
        address[] memory identities,
        uint16[] memory countries
    ) external;
}
