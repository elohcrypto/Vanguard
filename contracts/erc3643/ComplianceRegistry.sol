// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./interfaces/ICompliance.sol";

/**
 * @title ComplianceRegistry
 * @dev Simple mock compliance registry for demo purposes
 */
contract ComplianceRegistry is ICompliance {
    mapping(address => bool) private _modules;
    address[] private _modulesList;

    event TokenBound(address indexed token);
    event TokenUnbound(address indexed token);
    event TokenAgentAdded(address indexed agent);
    event TokenAgentRemoved(address indexed agent);

    function canTransfer(
        address /* from */,
        address /* to */,
        uint256 /* amount */
    ) external pure override returns (bool) {
        // Simple mock - always allow transfers
        return true;
    }

    function transferred(address from, address to, uint256 amount) external override {
        // Mock implementation - do nothing
    }

    function created(address to, uint256 amount) external override {
        // Mock implementation - do nothing
    }

    function destroyed(address from, uint256 amount) external override {
        // Mock implementation - do nothing
    }

    function addModule(address module) external override {
        require(module != address(0), "Invalid module");
        require(!_modules[module], "Module already added");

        _modules[module] = true;
        _modulesList.push(module);
    }

    function removeModule(address module) external override {
        require(_modules[module], "Module not found");

        _modules[module] = false;

        // Remove from array
        for (uint256 i = 0; i < _modulesList.length; i++) {
            if (_modulesList[i] == module) {
                _modulesList[i] = _modulesList[_modulesList.length - 1];
                _modulesList.pop();
                break;
            }
        }
    }

    function getModules() external view override returns (address[] memory) {
        return _modulesList;
    }

    function isModuleBound(address module) external view override returns (bool) {
        return _modules[module];
    }

    function isTrustedContract(address /* contractAddress */) external pure override returns (bool) {
        // Mock implementation - no trusted contracts in this simple registry
        return false;
    }
}
