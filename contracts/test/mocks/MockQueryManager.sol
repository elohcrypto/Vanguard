// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title MockQueryManager
 * @dev Test double for the OracleManager views a list oracle reads when it
 *      applies a verdict (isActiveOracle, getQueryResolution,
 *      getQueryBinding, getQueryData). It resolves any query YES now and
 *      returns whatever data the test set, so a test can hand
 *      WhitelistOracle a payload the real manager refuses at submit
 *      (Task 4.12: the oracle's own InvalidQueryTier re-check).
 */
contract MockQueryManager {
    address public subject;
    uint8 public queryType;
    bytes public data;

    function setQuery(address _subject, uint8 _queryType, bytes calldata _data) external {
        subject = _subject;
        queryType = _queryType;
        data = _data;
    }

    function isActiveOracle(address) external pure returns (bool) {
        return true;
    }

    function getQueryResolution(bytes32) external view returns (bool, bool, uint256) {
        return (true, true, block.timestamp);
    }

    function getQueryBinding(bytes32) external view returns (address, uint8) {
        return (subject, queryType);
    }

    function getQueryData(bytes32) external view returns (bytes memory) {
        return data;
    }
}
