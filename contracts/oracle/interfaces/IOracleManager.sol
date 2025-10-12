// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title IOracleManager
 * @dev Interface for oracle management system
 * @author CMTA UTXO Compliance Team
 */
interface IOracleManager {
    // Events
    event OracleRegistered(address indexed oracle, string name);
    event OracleRemoved(address indexed oracle);
    event EmergencyOracleSet(address indexed oracle, bool isEmergency);
    event OracleReputationUpdated(address indexed oracle, uint256 newReputation);

    // Oracle Management Functions
    function registerOracle(address oracle, string memory name) external;

    function removeOracle(address oracle) external;

    function setEmergencyOracle(address oracle, bool isEmergency) external;

    // Oracle Status Functions
    function isRegisteredOracle(address oracle) external view returns (bool);

    function isActiveOracle(address oracle) external view returns (bool);

    function isEmergencyOracle(address oracle) external view returns (bool);

    function getOracleName(address oracle) external view returns (string memory);

    function getOracleReputation(address oracle) external view returns (uint256);

    // Oracle Query Functions
    function getAllOracles() external view returns (address[] memory);

    function getActiveOracles() external view returns (address[] memory);

    function getOracleCount() external view returns (uint256);

    function getConsensusThreshold() external view returns (uint256);

    // Consensus Functions
    function updateConsensusThreshold(uint256 newThreshold) external;

    function validateOracleConsensus(
        address[] memory oracles,
        bytes[] memory signatures,
        bytes32 messageHash
    ) external view returns (bool);

    function checkConsensus(bytes32 queryId) external view returns (bool hasConsensus, bool result);

    function submitQuery(address subject, uint8 queryType, bytes calldata data) external returns (bytes32 queryId);
}
