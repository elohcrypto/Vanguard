// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

/**
 * @title MockIdentityRegistry
 * @dev Mock implementation for testing identity verification
 */
contract MockIdentityRegistry {
    mapping(address => address) public identity;
    mapping(address => uint256) public investorCountry;
    mapping(address => bool) private _verified;

    function registerIdentity(address user, address identityContract, uint256 country) external {
        identity[user] = identityContract;
        investorCountry[user] = country;
        _verified[user] = true;
    }

    function isVerified(address user) external view returns (bool) {
        return _verified[user];
    }

    function setVerified(address user, bool verified) external {
        _verified[user] = verified;
    }

    function getIdentity(address user) external view returns (address) {
        return identity[user];
    }

    function getInvestorCountry(address user) external view returns (uint256) {
        return investorCountry[user];
    }
}
