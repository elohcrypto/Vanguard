// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./IUTXOCompliance.sol";

/**
 * @title IComplianceValidator
 * @dev Interface for transaction compliance validation logic
 * @author CMTA UTXO Compliance Team
 */
interface IComplianceValidator {
    // Enums
    enum ValidationResult {
        VALID,
        INVALID_IDENTITY,
        INVALID_CLAIMS,
        BLACKLISTED,
        NOT_WHITELISTED,
        JURISDICTION_RESTRICTED,
        INSUFFICIENT_COMPLIANCE_LEVEL,
        EXPIRED_CLAIMS,
        ORACLE_CONSENSUS_FAILED
    }

    enum ComplianceLevel {
        NONE,
        BASIC,
        ENHANCED,
        PREMIUM,
        INSTITUTIONAL
    }

    // Structs
    struct ValidationContext {
        address sender;
        address receiver;
        uint256 amount;
        bytes32 transactionHash;
        uint256 blockNumber;
        uint256 timestamp;
    }

    struct IdentityValidation {
        bool hasValidIdentity;
        address onchainId;
        uint16 countryCode;
        uint8 investorType;
        uint256[] validClaims;
        uint256 claimsExpiry;
    }

    struct OracleValidation {
        bool isWhitelisted;
        uint8 whitelistTier;
        bool isBlacklisted;
        uint8 blacklistSeverity;
        uint256 consensusCount;
        address[] signingOracles;
    }

    // Events
    event ValidationPerformed(
        bytes32 indexed transactionHash,
        address indexed sender,
        address indexed receiver,
        ValidationResult result,
        string reason
    );

    event ComplianceLevelUpdated(
        address indexed user,
        ComplianceLevel oldLevel,
        ComplianceLevel newLevel,
        string reason
    );

    event JurisdictionRestrictionUpdated(uint16 indexed countryCode, bool isRestricted, string reason);

    // Core Validation Functions
    function validateTransaction(
        IUTXOCompliance.UTXOMetadata[] calldata inputs,
        IUTXOCompliance.UTXOMetadata[] calldata outputs,
        ValidationContext calldata context
    ) external returns (ValidationResult result, string memory reason);

    function validateIdentity(address user, address onchainId) external view returns (IdentityValidation memory);

    function validateClaims(
        address onchainId,
        uint256[] calldata requiredClaims
    ) external view returns (bool isValid, uint256 expiryTime);

    function validateOracle(address user) external view returns (OracleValidation memory);

    // Compliance Level Functions
    function getComplianceLevel(address user) external view returns (ComplianceLevel);

    function calculateComplianceLevel(
        IdentityValidation calldata identity,
        OracleValidation calldata oracle
    ) external pure returns (ComplianceLevel);

    function aggregateComplianceLevel(ComplianceLevel[] calldata levels) external pure returns (ComplianceLevel);

    // Jurisdiction Functions
    function isJurisdictionAllowed(uint16 countryCode) external view returns (bool);

    function setJurisdictionRestriction(uint16 countryCode, bool isRestricted, string calldata reason) external;

    function getRestrictedJurisdictions() external view returns (uint16[] memory);

    // Transfer Restriction Functions
    function validateTransferRestrictions(
        address from,
        address to,
        uint256 amount,
        IUTXOCompliance.UTXOMetadata calldata metadata
    ) external view returns (bool isAllowed, string memory reason);

    function getHoldingPeriod(address token, address investor) external view returns (uint256 holdingPeriod);

    function getInvestorLimit(address token) external view returns (uint256 currentCount, uint256 maxCount);

    // Configuration Functions
    function setRequiredClaims(uint256[] calldata claimTopics) external;

    function getRequiredClaims() external view returns (uint256[] memory);

    function setMinimumComplianceLevel(ComplianceLevel level) external;

    function getMinimumComplianceLevel() external view returns (ComplianceLevel);
}
