// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

/**
 * @title IOracle Interface
 * @dev Interface for oracle contracts in the ERC-3643 compliance system
 */
interface IOracle {
    // Events
    event AttestationProvided(
        address indexed oracle,
        address indexed subject,
        bytes32 indexed queryId,
        bool result,
        uint256 timestamp,
        bytes signature
    );

    event OracleStatusChanged(address indexed oracle, bool active);
    event OracleReputationUpdated(address indexed oracle, uint256 reputation);

    // Core oracle functions
    function provideAttestation(
        address _subject,
        bytes32 _queryId,
        bool _result,
        bytes calldata _signature,
        bytes calldata _data
    ) external;

    function getAttestation(
        address _subject,
        bytes32 _queryId
    ) external view returns (bool result, uint256 timestamp, address oracle, bytes memory signature, bool isValid);

    // Oracle status
    function isActive() external view returns (bool);

    function getReputation() external view returns (uint256);

    function getOracleInfo()
        external
        view
        returns (
            address oracleAddress,
            string memory name,
            string memory description,
            uint256 reputation,
            bool active,
            uint256 totalAttestations
        );

    // Oracle management
    function setActive(bool _active) external;

    function updateReputation(uint256 _reputation) external;

    // Verification
    function verifySignature(
        address _subject,
        bytes32 _queryId,
        bool _result,
        bytes calldata _signature
    ) external view returns (bool);
}
