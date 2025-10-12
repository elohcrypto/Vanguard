// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title IUTXOCompliance
 * @dev Interface for UTXO compliance management with ERC-3643 integration
 * @author CMTA UTXO Compliance Team
 */
interface IUTXOCompliance {
    // Structs
    struct UTXOMetadata {
        uint256 value;
        bytes32 scriptPubkey;
        address tokenAddress;
        address onchainId;
        address identityRegistry;
        address complianceRegistry;
        address trustedIssuersRegistry;
        address claimTopicsRegistry;
        bytes32 complianceHash;
        uint8 whitelistTier;
        uint256 jurisdictionMask;
        uint256 expiryBlock;
        uint256 requiredClaims;
        uint16 countryCode;
        uint8 investorType;
        bool isWhitelisted;
        bool isBlacklisted;
        uint8 blacklistSeverity;
        uint256 lastValidated;
    }

    struct ComplianceValidation {
        bool isValid;
        string reason;
        uint256 validUntil;
        bytes32 validationHash;
        address[] oracleSigners;
    }

    // Events
    event UTXOCreated(bytes32 indexed utxoId, address indexed owner, uint256 value, bytes32 complianceHash);

    event UTXOSpent(bytes32 indexed utxoId, address indexed spender, bytes32 indexed transactionHash);

    event ComplianceUpdated(
        bytes32 indexed utxoId,
        bytes32 oldComplianceHash,
        bytes32 newComplianceHash,
        address updatedBy
    );

    event WhitelistStatusChanged(address indexed user, bool isWhitelisted, uint8 tier, address[] oracles);

    event BlacklistStatusChanged(
        address indexed user,
        bool isBlacklisted,
        uint8 severity,
        string reason,
        address oracle
    );

    // Core Functions
    function createUTXO(
        address owner,
        uint256 value,
        bytes32 scriptPubkey,
        UTXOMetadata calldata metadata
    ) external returns (bytes32 utxoId);

    function spendUTXO(bytes32 utxoId, bytes32 transactionHash, bytes calldata signature) external;

    function validateUTXO(bytes32 utxoId) external view returns (ComplianceValidation memory);

    function updateCompliance(bytes32 utxoId, bytes32 newComplianceHash, bytes calldata proof) external;

    // Query Functions
    function getUTXOMetadata(bytes32 utxoId) external view returns (UTXOMetadata memory);

    function isUTXOValid(bytes32 utxoId) external view returns (bool);

    function getUTXOsByOwner(address owner) external view returns (bytes32[] memory);

    function getTotalValue(address owner) external view returns (uint256);

    // Compliance Functions
    function validateTransaction(
        bytes32[] calldata inputUTXOs,
        UTXOMetadata[] calldata outputMetadata
    ) external view returns (bool isValid, string memory reason);

    function aggregateCompliance(UTXOMetadata[] calldata inputs) external pure returns (UTXOMetadata memory aggregated);

    // Oracle Integration
    function updateWhitelistStatus(
        address user,
        bool isWhitelisted,
        uint8 tier,
        bytes[] calldata oracleSignatures
    ) external;

    function updateBlacklistStatus(
        address user,
        bool isBlacklisted,
        uint8 severity,
        string calldata reason,
        bytes calldata oracleSignature
    ) external;

    function getWhitelistStatus(
        address user
    ) external view returns (bool isWhitelisted, uint8 tier, uint256 lastUpdated);

    function getBlacklistStatus(
        address user
    ) external view returns (bool isBlacklisted, uint8 severity, string memory reason);
}
