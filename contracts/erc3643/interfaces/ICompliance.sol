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

    function transferred(address from, address to, uint256 amount) external;

    function created(address to, uint256 amount) external;

    function destroyed(address from, uint256 amount) external;

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
