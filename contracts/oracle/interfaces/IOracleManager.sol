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
    event EmergencyOracleSet(address indexed oracle, bool isEmergency);
    event OracleReputationUpdated(address indexed oracle, uint256 newReputation);

    // Oracle lifecycle (plan v2 Task 4.4): pause, unpause and the emergency
    // designation are owner-or-operator actions; removal is the owner's.
    function removeOracle(address oracle, string calldata reason) external;

    function pauseOracle(address oracle) external;

    function unpauseOracle(address oracle) external;

    function setEmergencyOracle(address oracle, bool isEmergency) external;

    // Oracle Status Functions
    function isRegisteredOracle(address oracle) external view returns (bool);

    function isActiveOracle(address oracle) external view returns (bool);

    /// @notice The single emergency designation BlacklistOracle.emergencyBlacklist
    ///         checks (together with isActiveOracle).
    function isEmergencyOracle(address oracle) external view returns (bool);

    function getOracleName(address oracle) external view returns (string memory);

    function getOracleReputation(address oracle) external view returns (uint256);

    // Oracle Query Functions
    function getRegisteredOracles() external view returns (address[] memory);

    function getActiveOracles() external view returns (address[] memory);

    function getOracleCount() external view returns (uint256);

    /// @notice The engine's threshold, a percent of the active weight.
    function getConsensusThreshold() external view returns (uint256);

    // Consensus Functions
    function validateOracleConsensus(
        address[] memory oracles,
        bytes[] memory signatures,
        bytes32 messageHash
    ) external view returns (bool);

    /// @notice Subject and type an existing query was raised for; (address(0), 0)
    ///         if unknown. Consumers bind a resolved consensus to the address AND
    ///         the kind of question it answered, so one queryId cannot be replayed
    ///         against another subject or another policy (a blacklist verdict is
    ///         not a whitelist verdict).
    function getQueryBinding(bytes32 queryId) external view returns (address subject, uint8 queryType);

    /// @notice Resolution state of a query. `resolvedAt` is the block time the
    ///         verdict first resolved (0 while open); it never moves, so
    ///         consumers can refuse a stale verdict or one older than their
    ///         current entry.
    function getQueryResolution(
        bytes32 queryId
    ) external view returns (bool hasResult, bool result, uint256 resolvedAt);

    /// @notice The `data` the query was raised with (for a blacklist query:
    ///         empty or abi.encode(uint8 severity)).
    function getQueryData(bytes32 queryId) external view returns (bytes memory);

    function submitQuery(address subject, uint8 queryType, bytes calldata data) external returns (bytes32 queryId);
}
