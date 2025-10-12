// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

/**
 * @title MockComplianceRules
 * @dev Mock implementation for testing
 */
contract MockComplianceRules {
    mapping(address => bool) private _compliant;

    function setCompliant(address user, bool compliant) external {
        _compliant[user] = compliant;
    }

    function isCompliant(address user) external view returns (bool) {
        return _compliant[user];
    }

    // Mock validation functions
    function validateJurisdiction(address, uint256) external pure returns (bool, string memory) {
        return (true, "Valid");
    }

    function validateInvestorType(address, uint8, uint256) external pure returns (bool, string memory) {
        return (true, "Valid");
    }

    function canTransfer(address from, address to, uint256 /* amount */) external view returns (bool) {
        // For testing, allow transfer if both parties are compliant
        return _compliant[from] && _compliant[to];
    }
}
