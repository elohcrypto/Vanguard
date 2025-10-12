// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "./interfaces/IComplianceValidator.sol";
import "./interfaces/IUTXOCompliance.sol";
import "../erc3643/interfaces/IIdentityRegistry.sol";
import "../erc3643/interfaces/ICompliance.sol";
import "../onchain_id/interfaces/IOnchainID.sol";
import "../oracle/interfaces/IOracleManager.sol";

/**
 * @title ComplianceValidator
 * @dev Implementation of compliance validation logic for UTXO transactions
 * @author CMTA UTXO Compliance Team
 */
contract ComplianceValidator is IComplianceValidator, Ownable, Pausable {
    // State variables
    mapping(address => ComplianceLevel) private _userComplianceLevels;
    mapping(uint16 => bool) private _restrictedJurisdictions;
    mapping(address => uint256) private _holdingPeriods;
    mapping(address => uint256) private _investorCounts;
    mapping(address => uint256) private _maxInvestorCounts;

    uint256[] private _requiredClaims;
    ComplianceLevel private _minimumComplianceLevel;

    IOracleManager public oracleManager;
    IIdentityRegistry public identityRegistry;
    ICompliance public complianceRegistry;

    uint256 public constant CLAIM_VALIDITY_PERIOD = 365 days;
    uint256 public constant DEFAULT_HOLDING_PERIOD = 30 days;

    /**
     * @dev Constructor
     */
    constructor(
        address _oracleManager,
        address _identityRegistry,
        address _complianceRegistry,
        address _owner
    ) Ownable(_owner) {
        require(_oracleManager != address(0), "Invalid oracle manager");
        require(_identityRegistry != address(0), "Invalid identity registry");
        require(_complianceRegistry != address(0), "Invalid compliance registry");

        oracleManager = IOracleManager(_oracleManager);
        identityRegistry = IIdentityRegistry(_identityRegistry);
        complianceRegistry = ICompliance(_complianceRegistry);

        _minimumComplianceLevel = ComplianceLevel.BASIC;
    }

    /**
     * @dev Validates a complete transaction
     */
    function validateTransaction(
        IUTXOCompliance.UTXOMetadata[] calldata /* inputs */,
        IUTXOCompliance.UTXOMetadata[] calldata /* outputs */,
        ValidationContext calldata context
    ) external override whenNotPaused returns (ValidationResult result, string memory reason) {
        // Validate sender identity
        IdentityValidation memory senderIdentity = validateIdentity(context.sender, address(0));
        if (!senderIdentity.hasValidIdentity) {
            return (ValidationResult.INVALID_IDENTITY, "Sender identity validation failed");
        }

        // Validate receiver identity
        IdentityValidation memory receiverIdentity = validateIdentity(context.receiver, address(0));
        if (!receiverIdentity.hasValidIdentity) {
            return (ValidationResult.INVALID_IDENTITY, "Receiver identity validation failed");
        }

        // Check oracle validation for both parties
        OracleValidation memory senderOracle = validateOracle(context.sender);
        OracleValidation memory receiverOracle = validateOracle(context.receiver);

        // Priority check: blacklist status
        if (senderOracle.isBlacklisted) {
            return (ValidationResult.BLACKLISTED, "Sender is blacklisted");
        }
        if (receiverOracle.isBlacklisted) {
            return (ValidationResult.BLACKLISTED, "Receiver is blacklisted");
        }

        // Check whitelist status
        if (!senderOracle.isWhitelisted) {
            return (ValidationResult.NOT_WHITELISTED, "Sender not whitelisted");
        }
        if (!receiverOracle.isWhitelisted) {
            return (ValidationResult.NOT_WHITELISTED, "Receiver not whitelisted");
        }

        // Check jurisdiction restrictions
        if (_restrictedJurisdictions[senderIdentity.countryCode]) {
            return (ValidationResult.JURISDICTION_RESTRICTED, "Sender jurisdiction restricted");
        }
        if (_restrictedJurisdictions[receiverIdentity.countryCode]) {
            return (ValidationResult.JURISDICTION_RESTRICTED, "Receiver jurisdiction restricted");
        }

        // Validate compliance levels
        ComplianceLevel senderLevel = _calculateComplianceLevelInternal(senderIdentity, senderOracle);
        ComplianceLevel receiverLevel = _calculateComplianceLevelInternal(receiverIdentity, receiverOracle);

        if (senderLevel < _minimumComplianceLevel) {
            return (ValidationResult.INSUFFICIENT_COMPLIANCE_LEVEL, "Sender compliance level insufficient");
        }
        if (receiverLevel < _minimumComplianceLevel) {
            return (ValidationResult.INSUFFICIENT_COMPLIANCE_LEVEL, "Receiver compliance level insufficient");
        }

        // Validate claims expiry
        if (senderIdentity.claimsExpiry < block.timestamp) {
            return (ValidationResult.EXPIRED_CLAIMS, "Sender claims expired");
        }
        if (receiverIdentity.claimsExpiry < block.timestamp) {
            return (ValidationResult.EXPIRED_CLAIMS, "Receiver claims expired");
        }

        // Simplified transfer restriction validation for demo
        bool transferAllowed = true;
        string memory transferReason = "Transfer validation passed";

        if (!transferAllowed) {
            return (ValidationResult.INVALID_IDENTITY, transferReason);
        }

        emit ValidationPerformed(
            context.transactionHash,
            context.sender,
            context.receiver,
            ValidationResult.VALID,
            "Transaction validation successful"
        );

        return (ValidationResult.VALID, "Transaction validation successful");
    }

    /**
     * @dev Validates user identity
     */
    function validateIdentity(
        address user,
        address onchainId
    ) public view override returns (IdentityValidation memory) {
        // If onchainId not provided, try to get from identity registry
        address userOnchainId = onchainId;
        if (userOnchainId == address(0)) {
            userOnchainId = identityRegistry.identity(user);
        }

        if (userOnchainId == address(0)) {
            return
                IdentityValidation({
                    hasValidIdentity: false,
                    onchainId: address(0),
                    countryCode: 0,
                    investorType: 0,
                    validClaims: new uint256[](0),
                    claimsExpiry: 0
                });
        }

        // Get country code and investor type from OnchainID claims
        IOnchainID onchainIdContract = IOnchainID(userOnchainId);

        // Simplified claim validation - in production would check specific claim topics
        uint256[] memory validClaims = new uint256[](_requiredClaims.length);
        uint256 validClaimCount = 0;
        uint256 earliestExpiry = type(uint256).max;

        for (uint256 i = 0; i < _requiredClaims.length; i++) {
            // Check if claim exists and is valid
            // This is simplified - actual implementation would verify claim signatures
            try onchainIdContract.getClaimIdsByTopic(_requiredClaims[i]) returns (bytes32[] memory claimIds) {
                if (claimIds.length > 0) {
                    validClaims[validClaimCount] = _requiredClaims[i];
                    validClaimCount++;

                    // Set expiry to current time + validity period for simplification
                    uint256 claimExpiry = block.timestamp + CLAIM_VALIDITY_PERIOD;
                    if (claimExpiry < earliestExpiry) {
                        earliestExpiry = claimExpiry;
                    }
                }
            } catch {
                // Claim not found or invalid
            }
        }

        // Resize valid claims array
        uint256[] memory finalValidClaims = new uint256[](validClaimCount);
        for (uint256 i = 0; i < validClaimCount; i++) {
            finalValidClaims[i] = validClaims[i];
        }

        return
            IdentityValidation({
                hasValidIdentity: userOnchainId != address(0),
                onchainId: userOnchainId,
                countryCode: 840, // Default to US for simplification
                investorType: 1, // Default to retail investor
                validClaims: finalValidClaims,
                claimsExpiry: earliestExpiry == type(uint256).max ? 0 : earliestExpiry
            });
    }

    /**
     * @dev Validates claims for an OnchainID
     */
    function validateClaims(
        address onchainId,
        uint256[] calldata requiredClaims
    ) external view override returns (bool isValid, uint256 expiryTime) {
        if (onchainId == address(0)) {
            return (false, 0);
        }

        IOnchainID onchainIdContract = IOnchainID(onchainId);
        uint256 earliestExpiry = type(uint256).max;

        for (uint256 i = 0; i < requiredClaims.length; i++) {
            try onchainIdContract.getClaimIdsByTopic(requiredClaims[i]) returns (bytes32[] memory claimIds) {
                if (claimIds.length == 0) {
                    return (false, 0);
                }

                // Set expiry to current time + validity period for simplification
                uint256 claimExpiry = block.timestamp + CLAIM_VALIDITY_PERIOD;
                if (claimExpiry < earliestExpiry) {
                    earliestExpiry = claimExpiry;
                }
            } catch {
                return (false, 0);
            }
        }

        return (true, earliestExpiry == type(uint256).max ? 0 : earliestExpiry);
    }

    /**
     * @dev Validates oracle status for a user
     */
    function validateOracle(address /* user */) public pure override returns (OracleValidation memory) {
        // Query oracle manager for whitelist/blacklist status
        // This is simplified - actual implementation would query multiple oracles

        return
            OracleValidation({
                isWhitelisted: true, // Simplified - would query actual oracles
                whitelistTier: 1,
                isBlacklisted: false,
                blacklistSeverity: 0,
                consensusCount: 3,
                signingOracles: new address[](0)
            });
    }

    /**
     * @dev Gets compliance level for a user
     */
    function getComplianceLevel(address user) external view override returns (ComplianceLevel) {
        return _userComplianceLevels[user];
    }

    /**
     * @dev Internal function to calculate compliance level
     */
    function _calculateComplianceLevelInternal(
        IdentityValidation memory identity,
        OracleValidation memory oracle
    ) internal pure returns (ComplianceLevel) {
        if (!identity.hasValidIdentity || oracle.isBlacklisted) {
            return ComplianceLevel.NONE;
        }

        if (!oracle.isWhitelisted) {
            return ComplianceLevel.BASIC;
        }

        // Calculate level based on whitelist tier and claims
        if (oracle.whitelistTier >= 3 && identity.validClaims.length >= 3) {
            return ComplianceLevel.INSTITUTIONAL;
        } else if (oracle.whitelistTier >= 2 && identity.validClaims.length >= 2) {
            return ComplianceLevel.PREMIUM;
        } else if (oracle.whitelistTier >= 1 && identity.validClaims.length >= 1) {
            return ComplianceLevel.ENHANCED;
        } else {
            return ComplianceLevel.BASIC;
        }
    }

    /**
     * @dev Calculates compliance level based on identity and oracle validation
     */
    function calculateComplianceLevel(
        IdentityValidation calldata identity,
        OracleValidation calldata oracle
    ) public pure override returns (ComplianceLevel) {
        if (!identity.hasValidIdentity || oracle.isBlacklisted) {
            return ComplianceLevel.NONE;
        }

        if (!oracle.isWhitelisted) {
            return ComplianceLevel.BASIC;
        }

        // Calculate level based on whitelist tier and claims
        if (oracle.whitelistTier >= 3 && identity.validClaims.length >= 3) {
            return ComplianceLevel.INSTITUTIONAL;
        } else if (oracle.whitelistTier >= 2 && identity.validClaims.length >= 2) {
            return ComplianceLevel.PREMIUM;
        } else if (oracle.whitelistTier >= 1 && identity.validClaims.length >= 1) {
            return ComplianceLevel.ENHANCED;
        } else {
            return ComplianceLevel.BASIC;
        }
    }

    /**
     * @dev Aggregates multiple compliance levels
     */
    function aggregateComplianceLevel(
        ComplianceLevel[] calldata levels
    ) external pure override returns (ComplianceLevel) {
        if (levels.length == 0) {
            return ComplianceLevel.NONE;
        }

        ComplianceLevel minLevel = levels[0];
        for (uint256 i = 1; i < levels.length; i++) {
            if (levels[i] < minLevel) {
                minLevel = levels[i];
            }
        }

        return minLevel;
    }

    /**
     * @dev Checks if jurisdiction is allowed
     */
    function isJurisdictionAllowed(uint16 countryCode) external view override returns (bool) {
        return !_restrictedJurisdictions[countryCode];
    }

    /**
     * @dev Sets jurisdiction restriction
     */
    function setJurisdictionRestriction(
        uint16 countryCode,
        bool isRestricted,
        string calldata reason
    ) external override onlyOwner {
        _restrictedJurisdictions[countryCode] = isRestricted;

        emit JurisdictionRestrictionUpdated(countryCode, isRestricted, reason);
    }

    /**
     * @dev Gets all restricted jurisdictions
     */
    function getRestrictedJurisdictions() external pure override returns (uint16[] memory) {
        // This is simplified - would need to track restricted jurisdictions in an array
        uint16[] memory restricted = new uint16[](0);
        return restricted;
    }

    /**
     * @dev Validates transfer restrictions
     */
    function validateTransferRestrictions(
        address /* from */,
        address /* to */,
        uint256 /* amount */,
        IUTXOCompliance.UTXOMetadata calldata metadata
    ) public view override returns (bool isAllowed, string memory reason) {
        // Check holding period
        uint256 holdingPeriod = _holdingPeriods[metadata.tokenAddress];
        if (holdingPeriod == 0) {
            holdingPeriod = DEFAULT_HOLDING_PERIOD;
        }

        // Simplified holding period check
        if (block.timestamp < metadata.lastValidated + holdingPeriod) {
            return (false, "Holding period not met");
        }

        // Check investor limits
        uint256 currentCount = _investorCounts[metadata.tokenAddress];
        uint256 maxCount = _maxInvestorCounts[metadata.tokenAddress];

        if (maxCount > 0 && currentCount >= maxCount) {
            return (false, "Maximum investor count reached");
        }

        return (true, "Transfer restrictions validated");
    }

    /**
     * @dev Gets holding period for a token
     */
    function getHoldingPeriod(
        address token,
        address /* investor */
    ) external view override returns (uint256 holdingPeriod) {
        holdingPeriod = _holdingPeriods[token];
        if (holdingPeriod == 0) {
            holdingPeriod = DEFAULT_HOLDING_PERIOD;
        }
        return holdingPeriod;
    }

    /**
     * @dev Gets investor limit for a token
     */
    function getInvestorLimit(address token) external view override returns (uint256 currentCount, uint256 maxCount) {
        return (_investorCounts[token], _maxInvestorCounts[token]);
    }

    /**
     * @dev Sets required claims
     */
    function setRequiredClaims(uint256[] calldata claimTopics) external override onlyOwner {
        _requiredClaims = claimTopics;
    }

    /**
     * @dev Gets required claims
     */
    function getRequiredClaims() external view override returns (uint256[] memory) {
        return _requiredClaims;
    }

    /**
     * @dev Sets minimum compliance level
     */
    function setMinimumComplianceLevel(ComplianceLevel level) external override onlyOwner {
        ComplianceLevel oldLevel = _minimumComplianceLevel;
        _minimumComplianceLevel = level;

        emit ComplianceLevelUpdated(address(0), oldLevel, level, "Minimum compliance level updated");
    }

    /**
     * @dev Gets minimum compliance level
     */
    function getMinimumComplianceLevel() external view override returns (ComplianceLevel) {
        return _minimumComplianceLevel;
    }

    /**
     * @dev Sets holding period for a token
     */
    function setHoldingPeriod(address token, uint256 period) external onlyOwner {
        _holdingPeriods[token] = period;
    }

    /**
     * @dev Sets investor limits for a token
     */
    function setInvestorLimit(address token, uint256 maxCount) external onlyOwner {
        _maxInvestorCounts[token] = maxCount;
    }

    /**
     * @dev Updates investor count for a token
     */
    function updateInvestorCount(address token, uint256 count) external onlyOwner {
        _investorCounts[token] = count;
    }

    /**
     * @dev Pauses the contract
     */
    function pause() external onlyOwner {
        _pause();
    }

    /**
     * @dev Unpauses the contract
     */
    function unpause() external onlyOwner {
        _unpause();
    }
}
