// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title ICompliance
 * @dev Interface for ERC-3643 Compliance Registry
 */
interface ICompliance {
    // Events
    event ComplianceAdded(address indexed compliance);
    event ComplianceRemoved(address indexed compliance);

    // Core Functions
    function canTransfer(address from, address to, uint256 amount) external view returns (bool);

    function transferred(address from, address to, uint256 amount) external;

    function created(address to, uint256 amount) external;

    function destroyed(address from, uint256 amount) external;

    // Compliance Module Management
    function addModule(address module) external;

    function removeModule(address module) external;

    function getModules() external view returns (address[] memory);

    function isModuleBound(address module) external view returns (bool);

    // Trusted Contracts Management
    function isTrustedContract(address contractAddress) external view returns (bool);
}
