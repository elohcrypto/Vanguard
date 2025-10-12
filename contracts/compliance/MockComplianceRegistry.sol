// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title MockComplianceRegistry
 * @dev Mock implementation for demo purposes
 */
contract MockComplianceRegistry {
    function canTransfer(address /* from */, address /* to */, uint256 /* amount */) external pure returns (bool) {
        return true; // Always allow for demo
    }

    function transferred(address from, address to, uint256 amount) external {
        // Mock implementation - do nothing
    }

    function created(address to, uint256 amount) external {
        // Mock implementation - do nothing
    }

    function destroyed(address from, uint256 amount) external {
        // Mock implementation - do nothing
    }

    function addModule(address module) external {
        // Mock implementation - do nothing
    }

    function removeModule(address module) external {
        // Mock implementation - do nothing
    }

    function getModules() external pure returns (address[] memory) {
        return new address[](0);
    }

    function isModuleBound(address /* module */) external pure returns (bool) {
        return false;
    }
}
