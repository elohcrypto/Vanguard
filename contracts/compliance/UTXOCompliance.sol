// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import "./interfaces/IUTXOCompliance.sol";
import "./interfaces/IComplianceValidator.sol";
import "./interfaces/IComplianceRules.sol";
import "../oracle/interfaces/IOracleManager.sol";

/**
 * @title UTXOCompliance
 * @dev Main contract for UTXO compliance management with ERC-3643 integration
 * @author CMTA UTXO Compliance Team
 */
contract UTXOCompliance is IUTXOCompliance, Ownable, ReentrancyGuard {
    using ECDSA for bytes32;
    using MessageHashUtils for bytes32;

    // State variables
    mapping(bytes32 => UTXOMetadata) private _utxos;
    mapping(bytes32 => bool) private _spentUTXOs;
    mapping(address => bytes32[]) private _ownerUTXOs;
    mapping(address => bool) private _whitelistedUsers;
    mapping(address => uint8) private _whitelistTiers;
    mapping(address => uint256) private _whitelistUpdated;
    mapping(address => bool) private _blacklistedUsers;
    mapping(address => uint8) private _blacklistSeverity;
    mapping(address => string) private _blacklistReasons;
    mapping(address => uint256) private _blacklistUpdated;

    IComplianceValidator public complianceValidator;
    IOracleManager public oracleManager;
    IComplianceRules public complianceRules;

    uint256 private _utxoCounter;
    uint256 public constant ORACLE_CONSENSUS_THRESHOLD = 2;
    uint256 public constant EMERGENCY_ORACLE_THRESHOLD = 1;

    // Modifiers
    modifier onlyValidUTXO(bytes32 utxoId) {
        require(_utxos[utxoId].value > 0, "UTXO does not exist");
        require(!_spentUTXOs[utxoId], "UTXO already spent");
        _;
    }

    modifier onlyAuthorizedOracle() {
        require(
            address(oracleManager) != address(0) && oracleManager.isRegisteredOracle(msg.sender),
            "Unauthorized oracle"
        );
        _;
    }

    /**
     * @dev Constructor
     */
    constructor(
        address _complianceValidator,
        address _oracleManager,
        address _complianceRules,
        address _owner
    ) Ownable(_owner) {
        require(_complianceValidator != address(0), "Invalid compliance validator");
        require(_oracleManager != address(0), "Invalid oracle manager");
        require(_complianceRules != address(0), "Invalid compliance rules");

        complianceValidator = IComplianceValidator(_complianceValidator);
        oracleManager = IOracleManager(_oracleManager);
        complianceRules = IComplianceRules(_complianceRules);
    }

    /**
     * @dev Creates a new UTXO with compliance metadata
     */
    function createUTXO(
        address owner,
        uint256 value,
        bytes32 scriptPubkey,
        UTXOMetadata calldata metadata
    ) external override nonReentrant returns (bytes32 utxoId) {
        require(owner != address(0), "Invalid owner");
        require(value > 0, "Invalid value");
        require(scriptPubkey != bytes32(0), "Invalid script pubkey");

        // Generate unique UTXO ID
        utxoId = keccak256(abi.encodePacked(owner, value, scriptPubkey, block.timestamp, _utxoCounter++));

        // Create UTXO metadata
        UTXOMetadata memory utxo = UTXOMetadata({
            value: value,
            scriptPubkey: scriptPubkey,
            tokenAddress: metadata.tokenAddress,
            onchainId: metadata.onchainId,
            identityRegistry: metadata.identityRegistry,
            complianceRegistry: metadata.complianceRegistry,
            trustedIssuersRegistry: metadata.trustedIssuersRegistry,
            claimTopicsRegistry: metadata.claimTopicsRegistry,
            complianceHash: metadata.complianceHash,
            whitelistTier: _whitelistedUsers[owner] ? _whitelistTiers[owner] : 0,
            jurisdictionMask: metadata.jurisdictionMask,
            expiryBlock: metadata.expiryBlock,
            requiredClaims: metadata.requiredClaims,
            countryCode: metadata.countryCode,
            investorType: metadata.investorType,
            isWhitelisted: _whitelistedUsers[owner],
            isBlacklisted: _blacklistedUsers[owner],
            blacklistSeverity: _blacklistedUsers[owner] ? _blacklistSeverity[owner] : 0,
            lastValidated: block.timestamp
        });

        // Store UTXO
        _utxos[utxoId] = utxo;
        _ownerUTXOs[owner].push(utxoId);

        emit UTXOCreated(utxoId, owner, value, metadata.complianceHash);

        return utxoId;
    }

    /**
     * @dev Spends a UTXO
     */
    function spendUTXO(
        bytes32 utxoId,
        bytes32 transactionHash,
        bytes calldata signature
    ) external override onlyValidUTXO(utxoId) nonReentrant {
        UTXOMetadata memory utxo = _utxos[utxoId];

        // Verify signature (simplified - in production would verify against script)
        bytes32 messageHash = keccak256(abi.encodePacked(utxoId, transactionHash, msg.sender)).toEthSignedMessageHash();

        address signer = messageHash.recover(signature);
        require(signer == msg.sender, "Invalid signature");

        // Enhanced compliance validation with holding period check (skip for zero address tokens)
        if (address(complianceRules) != address(0) && utxo.tokenAddress != address(0)) {
            (bool holdingValid, string memory holdingReason) = complianceRules.validateHoldingPeriod(
                utxo.tokenAddress,
                msg.sender,
                utxo.lastValidated // Using lastValidated as acquisition time
            );
            require(holdingValid, string(abi.encodePacked("Holding period validation failed: ", holdingReason)));
        }

        // Mark as spent
        _spentUTXOs[utxoId] = true;

        emit UTXOSpent(utxoId, msg.sender, transactionHash);
    }

    /**
     * @dev Validates a UTXO for compliance
     */
    function validateUTXO(
        bytes32 utxoId
    ) external view override onlyValidUTXO(utxoId) returns (ComplianceValidation memory) {
        UTXOMetadata memory utxo = _utxos[utxoId];

        // Check if blacklisted (priority over whitelist)
        if (utxo.isBlacklisted) {
            return
                ComplianceValidation({
                    isValid: false,
                    reason: "Address is blacklisted",
                    validUntil: 0,
                    validationHash: bytes32(0),
                    oracleSigners: new address[](0)
                });
        }

        // Check expiry
        if (utxo.expiryBlock > 0 && block.number > utxo.expiryBlock) {
            return
                ComplianceValidation({
                    isValid: false,
                    reason: "UTXO compliance expired",
                    validUntil: 0,
                    validationHash: bytes32(0),
                    oracleSigners: new address[](0)
                });
        }

        // Enhanced compliance rules validation (skip for zero address tokens)
        if (address(complianceRules) != address(0) && utxo.tokenAddress != address(0)) {
            // Validate jurisdiction
            (bool jurisdictionValid, string memory jurisdictionReason) = complianceRules.validateJurisdiction(
                utxo.tokenAddress,
                utxo.countryCode
            );
            if (!jurisdictionValid) {
                return
                    ComplianceValidation({
                        isValid: false,
                        reason: string(abi.encodePacked("Jurisdiction validation failed: ", jurisdictionReason)),
                        validUntil: 0,
                        validationHash: bytes32(0),
                        oracleSigners: new address[](0)
                    });
            }

            // Validate investor type
            (bool investorTypeValid, string memory investorTypeReason) = complianceRules.validateInvestorType(
                utxo.tokenAddress,
                utxo.investorType,
                utxo.whitelistTier // Using whitelist tier as accreditation level
            );
            if (!investorTypeValid) {
                return
                    ComplianceValidation({
                        isValid: false,
                        reason: string(abi.encodePacked("Investor type validation failed: ", investorTypeReason)),
                        validUntil: 0,
                        validationHash: bytes32(0),
                        oracleSigners: new address[](0)
                    });
            }
        }

        // Basic validation passed
        return
            ComplianceValidation({
                isValid: true,
                reason: "Compliance validation passed",
                validUntil: utxo.expiryBlock,
                validationHash: utxo.complianceHash,
                oracleSigners: new address[](0)
            });
    }

    /**
     * @dev Updates compliance metadata for a UTXO
     */
    function updateCompliance(
        bytes32 utxoId,
        bytes32 newComplianceHash,
        bytes calldata /* proof */
    ) external override onlyValidUTXO(utxoId) {
        require(newComplianceHash != bytes32(0), "Invalid compliance hash");

        UTXOMetadata storage utxo = _utxos[utxoId];
        bytes32 oldHash = utxo.complianceHash;

        // Update compliance hash
        utxo.complianceHash = newComplianceHash;
        utxo.lastValidated = block.timestamp;

        emit ComplianceUpdated(utxoId, oldHash, newComplianceHash, msg.sender);
    } /**
   
  * @dev Gets UTXO metadata
     */

    function getUTXOMetadata(bytes32 utxoId) external view override returns (UTXOMetadata memory) {
        return _utxos[utxoId];
    }

    /**
     * @dev Checks if UTXO is valid (exists and not spent)
     */
    function isUTXOValid(bytes32 utxoId) external view override returns (bool) {
        return _utxos[utxoId].value > 0 && !_spentUTXOs[utxoId];
    }

    /**
     * @dev Gets all UTXOs owned by an address
     */
    function getUTXOsByOwner(address owner) external view override returns (bytes32[] memory) {
        return _ownerUTXOs[owner];
    }

    /**
     * @dev Gets total value of UTXOs owned by an address
     */
    function getTotalValue(address owner) external view override returns (uint256) {
        bytes32[] memory utxos = _ownerUTXOs[owner];
        uint256 totalValue = 0;

        for (uint256 i = 0; i < utxos.length; i++) {
            if (!_spentUTXOs[utxos[i]]) {
                totalValue += _utxos[utxos[i]].value;
            }
        }

        return totalValue;
    }

    /**
     * @dev Validates a transaction with input and output UTXOs
     */
    function validateTransaction(
        bytes32[] calldata inputUTXOs,
        UTXOMetadata[] calldata /* outputMetadata */
    ) external view override returns (bool isValid, string memory reason) {
        // Validate all input UTXOs exist and are unspent
        for (uint256 i = 0; i < inputUTXOs.length; i++) {
            if (_utxos[inputUTXOs[i]].value == 0) {
                return (false, "Input UTXO does not exist");
            }
            if (_spentUTXOs[inputUTXOs[i]]) {
                return (false, "Input UTXO already spent");
            }
        }

        return (true, "Transaction validation passed");
    }

    /**
     * @dev Aggregates compliance metadata from multiple inputs
     */
    function aggregateCompliance(
        UTXOMetadata[] calldata inputs
    ) external pure override returns (UTXOMetadata memory aggregated) {
        require(inputs.length > 0, "No inputs provided");

        // Start with first input as base
        aggregated = inputs[0];

        // Aggregate compliance levels (take minimum)
        for (uint256 i = 1; i < inputs.length; i++) {
            if (inputs[i].whitelistTier < aggregated.whitelistTier) {
                aggregated.whitelistTier = inputs[i].whitelistTier;
            }

            // Combine jurisdiction masks (intersection)
            aggregated.jurisdictionMask &= inputs[i].jurisdictionMask;

            // Take earliest expiry
            if (inputs[i].expiryBlock < aggregated.expiryBlock) {
                aggregated.expiryBlock = inputs[i].expiryBlock;
            }

            // Combine required claims (union)
            aggregated.requiredClaims |= inputs[i].requiredClaims;

            // If any input is blacklisted, output is blacklisted
            if (inputs[i].isBlacklisted) {
                aggregated.isBlacklisted = true;
                if (inputs[i].blacklistSeverity > aggregated.blacklistSeverity) {
                    aggregated.blacklistSeverity = inputs[i].blacklistSeverity;
                }
            }

            // All inputs must be whitelisted for output to be whitelisted
            if (!inputs[i].isWhitelisted) {
                aggregated.isWhitelisted = false;
            }
        }

        return aggregated;
    }

    /**
     * @dev Enhanced compliance aggregation using ComplianceRules
     */
    function aggregateComplianceWithRules(
        UTXOMetadata[] calldata inputs,
        address tokenAddress
    ) external view returns (UTXOMetadata memory aggregated, bool isValid) {
        require(inputs.length > 0, "No inputs provided");

        // Start with basic aggregation
        aggregated = this.aggregateCompliance(inputs);

        // Enhanced aggregation using ComplianceRules
        if (address(complianceRules) != address(0)) {
            // Collect whitelist tiers for aggregation
            uint8[] memory inputLevels = new uint8[](inputs.length);
            for (uint256 i = 0; i < inputs.length; i++) {
                inputLevels[i] = inputs[i].whitelistTier;
            }

            // Use ComplianceRules for level aggregation
            (uint8 aggregatedLevel, bool levelValid) = complianceRules.aggregateComplianceLevels(
                tokenAddress,
                inputLevels
            );

            aggregated.whitelistTier = aggregatedLevel;
            isValid = levelValid;
        } else {
            isValid = true; // Default to valid if no rules engine
        }

        return (aggregated, isValid);
    }

    /**
     * @dev Updates whitelist status for a user (requires oracle consensus)
     */
    function updateWhitelistStatus(
        address user,
        bool isWhitelisted,
        uint8 tier,
        bytes[] calldata oracleSignatures
    ) external override {
        require(user != address(0), "Invalid user address");
        require(oracleSignatures.length >= ORACLE_CONSENSUS_THRESHOLD, "Insufficient oracle consensus");

        // Verify oracle signatures
        address[] memory signingOracles = new address[](oracleSignatures.length);
        // Create message hash without timestamp to avoid timing issues
        bytes32 messageHash = keccak256(abi.encodePacked(user, isWhitelisted, tier)).toEthSignedMessageHash();

        for (uint256 i = 0; i < oracleSignatures.length; i++) {
            address oracle = messageHash.recover(oracleSignatures[i]);
            require(oracleManager.isRegisteredOracle(oracle), "Invalid oracle signature");
            signingOracles[i] = oracle;
        }

        // Update whitelist status
        _whitelistedUsers[user] = isWhitelisted;
        _whitelistTiers[user] = tier;
        _whitelistUpdated[user] = block.timestamp;

        emit WhitelistStatusChanged(user, isWhitelisted, tier, signingOracles);
    }

    /**
     * @dev Updates blacklist status for a user
     */
    function updateBlacklistStatus(
        address user,
        bool isBlacklisted,
        uint8 severity,
        string calldata reason,
        bytes calldata oracleSignature
    ) external override {
        require(user != address(0), "Invalid user address");

        // Verify oracle signature
        // Create message hash without timestamp to avoid timing issues
        bytes32 messageHash = keccak256(abi.encodePacked(user, isBlacklisted, severity, reason))
            .toEthSignedMessageHash();

        address oracle = messageHash.recover(oracleSignature);
        require(oracleManager.isRegisteredOracle(oracle), "Invalid oracle signature");

        // For critical severity, allow single oracle (emergency)
        if (severity < 4) {
            require(oracleManager.isEmergencyOracle(oracle), "Non-emergency oracle cannot blacklist without consensus");
        }

        // Update blacklist status
        _blacklistedUsers[user] = isBlacklisted;
        _blacklistSeverity[user] = severity;
        _blacklistReasons[user] = reason;
        _blacklistUpdated[user] = block.timestamp;

        emit BlacklistStatusChanged(user, isBlacklisted, severity, reason, oracle);
    }

    /**
     * @dev Gets whitelist status for a user
     */
    function getWhitelistStatus(
        address user
    ) external view override returns (bool isWhitelisted, uint8 tier, uint256 lastUpdated) {
        return (_whitelistedUsers[user], _whitelistTiers[user], _whitelistUpdated[user]);
    }

    /**
     * @dev Gets blacklist status for a user
     */
    function getBlacklistStatus(
        address user
    ) external view override returns (bool isBlacklisted, uint8 severity, string memory reason) {
        return (_blacklistedUsers[user], _blacklistSeverity[user], _blacklistReasons[user]);
    }

    /**
     * @dev Updates the compliance validator contract
     */
    function setComplianceValidator(address _complianceValidator) external onlyOwner {
        require(_complianceValidator != address(0), "Invalid compliance validator");
        complianceValidator = IComplianceValidator(_complianceValidator);
    }

    /**
     * @dev Updates the oracle manager contract
     */
    function setOracleManager(address _oracleManager) external onlyOwner {
        require(_oracleManager != address(0), "Invalid oracle manager");
        oracleManager = IOracleManager(_oracleManager);
    }

    /**
     * @dev Updates the compliance rules contract
     */
    function setComplianceRules(address _complianceRules) external onlyOwner {
        require(_complianceRules != address(0), "Invalid compliance rules");
        complianceRules = IComplianceRules(_complianceRules);
    }
}
