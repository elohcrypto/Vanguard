// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title IComplianceHooks
 * @dev The exact surface Token depends on. Any contract bound via
 *      Token.setCompliance must implement this so the compiler, not a
 *      runtime revert, catches a missing or renamed function.
 */
interface IComplianceHooks {
    function canTransfer(address from, address to, uint256 amount) external view returns (bool);

    /// @notice Wallet-recovery target check for the calling token on `to`:
    ///         the oracle blacklist/whitelist gate, no identity or jurisdiction.
    ///         ComplianceRules also refuses any account trusted on ANY token,
    ///         so a recovery never moves a shared identity onto a contract
    ///         another token trusts. Token calls it only in recoveryAddress.
    function canReceive(address to) external view returns (bool);

    function transferred(address from, address to, uint256 amount) external;

    function created(address to, uint256 amount) external;

    function destroyed(address from, uint256 amount) external;

    /// @notice Whether `contractAddress` is trusted on the calling token
    ///         (msg.sender); trust is per token in ComplianceRules.
    function isTrustedContract(address contractAddress) external view returns (bool);
}

/**
 * @title ICompliance
 * @dev Interface for ERC-3643 Compliance Registry: the hooks Token needs
 *      plus optional compliance-module management.
 */
interface ICompliance is IComplianceHooks {
    // Events
    event ComplianceAdded(address indexed compliance);
    event ComplianceRemoved(address indexed compliance);

    // Compliance Module Management
    function addModule(address module) external;

    function removeModule(address module) external;

    function getModules() external view returns (address[] memory);

    function isModuleBound(address module) external view returns (bool);
}
