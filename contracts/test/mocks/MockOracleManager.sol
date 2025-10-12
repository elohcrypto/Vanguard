// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

/**
 * @title MockOracleManager
 * @dev Mock implementation for testing
 */
contract MockOracleManager {
    mapping(address => bool) private _registeredOracles;
    mapping(address => bool) private _activeOracles;
    mapping(address => string) private _oracleNames;
    address[] private _oracleList;

    function registerOracle(address oracle, string memory name) external {
        if (!_registeredOracles[oracle]) {
            _oracleList.push(oracle);
        }
        _registeredOracles[oracle] = true;
        _activeOracles[oracle] = true;
        _oracleNames[oracle] = name;
    }

    function isRegisteredOracle(address oracle) external view returns (bool) {
        return _registeredOracles[oracle];
    }

    function isActiveOracle(address oracle) external view returns (bool) {
        return _activeOracles[oracle];
    }

    function getOracleCount() external view returns (uint256) {
        return _oracleList.length;
    }

    function checkConsensus(bytes32) external pure returns (bool, bool) {
        return (true, true); // Mock consensus result
    }
}
