// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title MockTarget
 * @dev Mock contract for testing OnchainID execute functionality
 * @author CMTA UTXO Compliance Team
 */
contract MockTarget {
    uint256 public value;
    address public lastCaller;
    bytes public lastData;

    event ValueSet(uint256 newValue, address caller);
    event FunctionCalled(string functionName, address caller, bytes data);

    function setValue(uint256 _value) external {
        value = _value;
        lastCaller = msg.sender;
        emit ValueSet(_value, msg.sender);
    }

    function setValueWithData(uint256 _value, bytes calldata _data) external {
        value = _value;
        lastCaller = msg.sender;
        lastData = _data;
        emit FunctionCalled("setValueWithData", msg.sender, _data);
    }

    function revertFunction() external pure {
        revert("MockTarget: Intentional revert");
    }

    function getValue() external view returns (uint256) {
        return value;
    }

    function getLastCaller() external view returns (address) {
        return lastCaller;
    }

    function getLastData() external view returns (bytes memory) {
        return lastData;
    }
}
