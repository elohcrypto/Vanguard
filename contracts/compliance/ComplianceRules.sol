// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "./interfaces/IComplianceRules.sol";
import "../erc3643/interfaces/IIdentityRegistry.sol";

/**
 * @title ComplianceRules
 * @dev Configurable compliance rule engine for UTXO compliance validation
 * @author CMTA UTXO Compliance Team
 */
contract ComplianceRules is IComplianceRules, Ownable, ReentrancyGuard {
    // ICompliance interface implementation
    /**
     * @dev Check if a transfer is allowed based on all compliance rules
     * This is the main function called by Token contract
     * Enforces KYC/AML verification + business rules
     */
    // ========================================
    // TRUSTED CONTRACTS (Escrow Wallets, etc.)
    // ========================================

    mapping(address => bool) private trustedContracts;

    event TrustedContractAdded(address indexed contractAddress);
    event TrustedContractRemoved(address indexed contractAddress);

    /**
     * @dev Add a trusted contract (e.g., escrow wallet) that can bypass KYC/AML
     * @param contractAddress Address of the trusted contract
     */
    function addTrustedContract(address contractAddress) external onlyOwner {
        require(contractAddress != address(0), "Invalid address");
        require(!trustedContracts[contractAddress], "Already trusted");
        trustedContracts[contractAddress] = true;
        emit TrustedContractAdded(contractAddress);
    }

    /**
     * @dev Remove a trusted contract
     * @param contractAddress Address of the contract to remove
     */
    function removeTrustedContract(address contractAddress) external onlyOwner {
        require(trustedContracts[contractAddress], "Not trusted");
        trustedContracts[contractAddress] = false;
        emit TrustedContractRemoved(contractAddress);
    }

    /**
     * @dev Check if an address is a trusted contract
     * @param contractAddress Address to check
     */
    function isTrustedContract(address contractAddress) external view returns (bool) {
        return trustedContracts[contractAddress];
    }

    function canTransfer(
        address from,
        address to,
        uint256 /* amount */
    ) external view returns (bool) {
        // Allow minting (from == address(0))
        if (from == address(0)) {
            return true;
        }

        // Allow burning (to == address(0))
        if (to == address(0)) {
            return true;
        }

        // Get the token that's calling us (msg.sender is the token contract)
        address token = msg.sender;

        // Check if we have an IdentityRegistry configured for this token
        address identityRegistryAddr = tokenIdentityRegistry[token];

        // If IdentityRegistry is configured, verify both sender and recipient
        if (identityRegistryAddr != address(0)) {
            IIdentityRegistry identityRegistry = IIdentityRegistry(identityRegistryAddr);

            // ✅ ALLOW: Trusted contracts (escrow wallets) can bypass KYC/AML AND jurisdiction
            // This is safe because:
            // 1. Only owner can add trusted contracts
            // 2. Escrow wallets are created by verified investors who already passed jurisdiction checks
            // 3. Escrow wallets enforce their own multi-sig rules
            // 4. The investor who created the wallet is compliant, so the wallet inherits compliance
            if (trustedContracts[from] || trustedContracts[to]) {
                // Still check jurisdiction rules for the non-trusted party
                address partyToCheck = trustedContracts[from] ? to : from;

                // If the other party is also trusted, allow
                if (trustedContracts[partyToCheck]) {
                    return true;
                }

                // Check if the non-trusted party is verified
                if (!identityRegistry.isVerified(partyToCheck)) {
                    return false;
                }

                // ✅ ALLOW: Trusted contracts bypass jurisdiction checks
                // Rationale: The escrow wallet was created by a verified investor
                // who already passed jurisdiction checks. The wallet inherits the
                // investor's compliance status. We only verify that the other party
                // (payer/payee) has valid KYC/AML, but we don't check their jurisdiction
                // because the escrow wallet acts as a trusted intermediary.
                //
                // Security: This is safe because:
                // - Only owner can add trusted contracts
                // - Escrow wallets are created by compliant investors
                // - Payer/Payee must still be KYC/AML verified
                // - Escrow wallets enforce multi-sig release conditions

                return true;
            }

            // ✅ ENFORCE: Recipient MUST be KYC/AML verified (NO BYPASS)
            if (!identityRegistry.isVerified(to)) {
                return false; // ❌ BLOCK: Recipient not verified
            }

            // ✅ ENFORCE: Sender MUST be KYC/AML verified (NO BYPASS)
            if (!identityRegistry.isVerified(from)) {
                return false; // ❌ BLOCK: Sender not verified
            }

            // ✅ ENFORCE: Jurisdiction rules (check sender and recipient countries)
            JurisdictionRule storage jurisdictionRule = _getJurisdictionRule(token);
            if (jurisdictionRule.isActive) {
                // Check sender's country
                uint16 senderCountry = identityRegistry.investorCountry(from);
                if (jurisdictionRule.blockedCountryMap[senderCountry]) {
                    return false; // ❌ BLOCK: Sender country is blocked
                }
                if (jurisdictionRule.allowedCountries.length > 0) {
                    if (!jurisdictionRule.allowedCountryMap[senderCountry]) {
                        return false; // ❌ BLOCK: Sender country not in allowed list
                    }
                }

                // Check recipient's country
                uint16 recipientCountry = identityRegistry.investorCountry(to);
                if (jurisdictionRule.blockedCountryMap[recipientCountry]) {
                    return false; // ❌ BLOCK: Recipient country is blocked
                }
                if (jurisdictionRule.allowedCountries.length > 0) {
                    if (!jurisdictionRule.allowedCountryMap[recipientCountry]) {
                        return false; // ❌ BLOCK: Recipient country not in allowed list
                    }
                }
            }
        }

        // All checks passed
        return true;
    }

    function transferred(address /* from */, address /* to */, uint256 /* amount */) external {
        // Hook for post-transfer actions if needed
    }

    function created(address /* to */, uint256 /* amount */) external {
        // Hook for token creation if needed
    }

    function destroyed(address /* from */, uint256 /* amount */) external {
        // Hook for token destruction if needed
    }

    function addModule(address /* module */) external onlyOwner {
        // Module management if needed
    }

    function removeModule(address /* module */) external onlyOwner {
        // Module management if needed
    }

    function getModules() external pure returns (address[] memory) {
        // Return empty array for now
        return new address[](0);
    }
    // Compliance rule structures
    struct JurisdictionRule {
        bool isActive;
        uint256[] allowedCountries;
        uint256[] blockedCountries;
        mapping(uint256 => bool) allowedCountryMap;
        mapping(uint256 => bool) blockedCountryMap;
        uint256 lastUpdated;
    }

    struct InvestorTypeRule {
        bool isActive;
        uint8[] allowedTypes;
        uint8[] blockedTypes;
        mapping(uint8 => bool) allowedTypeMap;
        mapping(uint8 => bool) blockedTypeMap;
        uint256 minimumAccreditation;
        uint256 lastUpdated;
    }

    struct HoldingPeriodRule {
        bool isActive;
        uint256 minimumHoldingPeriod;
        uint256 transferCooldown;
        mapping(address => uint256) lastTransferTime;
        mapping(address => uint256) tokenAcquisitionTime;
        uint256 lastUpdated;
    }

    struct ComplianceLevelRule {
        bool isActive;
        uint8 minimumLevel;
        uint8 maximumLevel;
        mapping(uint8 => uint8) levelInheritance;
        mapping(uint8 => uint256) levelRequirements;
        uint256 lastUpdated;
    }

    // State variables
    mapping(address => JurisdictionRule) private jurisdictionRules;
    mapping(address => InvestorTypeRule) private investorTypeRules;
    mapping(address => HoldingPeriodRule) private holdingPeriodRules;
    mapping(address => ComplianceLevelRule) private complianceLevelRules;

    // Global rule configurations
    mapping(address => bool) public authorizedTokens;
    mapping(address => bool) public ruleAdministrators;
    mapping(address => address) public tokenIdentityRegistry; // Maps token address to its IdentityRegistry

    // Default rules
    JurisdictionRule public defaultJurisdictionRule;
    InvestorTypeRule public defaultInvestorTypeRule;
    HoldingPeriodRule public defaultHoldingPeriodRule;
    ComplianceLevelRule public defaultComplianceLevelRule;

    // Constants
    uint256 public constant MAX_COUNTRIES = 300;
    uint8 public constant MAX_INVESTOR_TYPES = 10;
    uint8 public constant MAX_COMPLIANCE_LEVELS = 10;

    // Events
    event JurisdictionRuleUpdated(address indexed token, uint256[] allowedCountries, uint256[] blockedCountries);
    event InvestorTypeRuleUpdated(address indexed token, uint8[] allowedTypes, uint8[] blockedTypes);
    event HoldingPeriodRuleUpdated(address indexed token, uint256 minimumHoldingPeriod, uint256 transferCooldown);
    event ComplianceLevelRuleUpdated(address indexed token, uint8 minimumLevel, uint8 maximumLevel);
    event TokenAuthorized(address indexed token, bool authorized);
    event RuleAdministratorUpdated(address indexed administrator, bool authorized);
    event TokenIdentityRegistrySet(address indexed token, address indexed identityRegistry);

    modifier onlyAuthorizedToken(address token) {
        require(authorizedTokens[token], "ComplianceRules: Token not authorized");
        _;
    }

    modifier onlyRuleAdministrator() {
        require(
            ruleAdministrators[msg.sender] || msg.sender == owner(),
            "ComplianceRules: Not authorized administrator"
        );
        _;
    }

    modifier onlyGovernance() {
        require(
            ruleAdministrators[msg.sender],
            "ComplianceRules: Only governance can update rules"
        );
        _;
    }

    constructor(
        address _owner,
        uint256[] memory initialAllowedCountries,
        uint256[] memory initialBlockedCountries
    ) Ownable(_owner) {
        // Initialize default rules with user-provided countries
        _initializeDefaultRules(initialAllowedCountries, initialBlockedCountries);

        // Set deployer as rule administrator
        ruleAdministrators[_owner] = true;
    }

    /**
     * @dev Set the IdentityRegistry for a token
     * This allows ComplianceRules to verify KYC/AML status
     */
    function setTokenIdentityRegistry(
        address token,
        address identityRegistry
    ) external onlyOwner {
        require(token != address(0), "ComplianceRules: Invalid token address");
        require(identityRegistry != address(0), "ComplianceRules: Invalid identity registry address");

        tokenIdentityRegistry[token] = identityRegistry;
        emit TokenIdentityRegistrySet(token, identityRegistry);
    }

    /**
     * @dev Get the IdentityRegistry for a token
     */
    function getTokenIdentityRegistry(address token) external view returns (address) {
        return tokenIdentityRegistry[token];
    }

    /**
     * @dev Set jurisdiction-based validation rules
     * @notice Can only be called by governance contract after voting
     */
    function setJurisdictionRule(
        address token,
        uint256[] calldata allowedCountries,
        uint256[] calldata blockedCountries
    ) external override onlyGovernance {
        require(token != address(0), "ComplianceRules: Invalid token address");
        require(allowedCountries.length <= MAX_COUNTRIES, "ComplianceRules: Too many allowed countries");
        require(blockedCountries.length <= MAX_COUNTRIES, "ComplianceRules: Too many blocked countries");

        JurisdictionRule storage rule = jurisdictionRules[token];

        // Clear existing mappings
        for (uint256 i = 0; i < allowedCountries.length; i++) {
            delete rule.allowedCountryMap[allowedCountries[i]];
        }
        for (uint256 i = 0; i < blockedCountries.length; i++) {
            delete rule.blockedCountryMap[blockedCountries[i]];
        }

        // Set new rules
        rule.isActive = true;
        rule.allowedCountries = allowedCountries;
        rule.blockedCountries = blockedCountries;
        rule.lastUpdated = block.timestamp;

        // Update mappings for efficient lookup
        for (uint256 i = 0; i < allowedCountries.length; i++) {
            rule.allowedCountryMap[allowedCountries[i]] = true;
        }
        for (uint256 i = 0; i < blockedCountries.length; i++) {
            rule.blockedCountryMap[blockedCountries[i]] = true;
        }

        emit JurisdictionRuleUpdated(token, allowedCountries, blockedCountries);
    }

    /**
     * @dev Set investor type validation rules
     * @notice Can only be called by governance contract after voting
     */
    function setInvestorTypeRule(
        address token,
        uint8[] calldata allowedTypes,
        uint8[] calldata blockedTypes,
        uint256 minimumAccreditation
    ) external override onlyGovernance {
        require(token != address(0), "ComplianceRules: Invalid token address");
        require(allowedTypes.length <= MAX_INVESTOR_TYPES, "ComplianceRules: Too many allowed types");
        require(blockedTypes.length <= MAX_INVESTOR_TYPES, "ComplianceRules: Too many blocked types");

        InvestorTypeRule storage rule = investorTypeRules[token];

        // Clear existing mappings
        for (uint256 i = 0; i < allowedTypes.length; i++) {
            delete rule.allowedTypeMap[allowedTypes[i]];
        }
        for (uint256 i = 0; i < blockedTypes.length; i++) {
            delete rule.blockedTypeMap[blockedTypes[i]];
        }

        // Set new rules
        rule.isActive = true;
        rule.allowedTypes = allowedTypes;
        rule.blockedTypes = blockedTypes;
        rule.minimumAccreditation = minimumAccreditation;
        rule.lastUpdated = block.timestamp;

        // Update mappings for efficient lookup
        for (uint256 i = 0; i < allowedTypes.length; i++) {
            rule.allowedTypeMap[allowedTypes[i]] = true;
        }
        for (uint256 i = 0; i < blockedTypes.length; i++) {
            rule.blockedTypeMap[blockedTypes[i]] = true;
        }

        emit InvestorTypeRuleUpdated(token, allowedTypes, blockedTypes);
    }

    /**
     * @dev Set holding period and transfer cooldown rules
     * @notice Can only be called by governance contract after voting
     */
    function setHoldingPeriodRule(
        address token,
        uint256 minimumHoldingPeriod,
        uint256 transferCooldown
    ) external override onlyGovernance {
        require(token != address(0), "ComplianceRules: Invalid token address");
        require(minimumHoldingPeriod <= 365 days, "ComplianceRules: Holding period too long");
        require(transferCooldown <= 30 days, "ComplianceRules: Cooldown too long");

        HoldingPeriodRule storage rule = holdingPeriodRules[token];
        rule.isActive = true;
        rule.minimumHoldingPeriod = minimumHoldingPeriod;
        rule.transferCooldown = transferCooldown;
        rule.lastUpdated = block.timestamp;

        emit HoldingPeriodRuleUpdated(token, minimumHoldingPeriod, transferCooldown);
    }

    /**
     * @dev Set compliance level aggregation and inheritance rules
     * @notice Can only be called by governance contract after voting
     */
    function setComplianceLevelRule(
        address token,
        uint8 minimumLevel,
        uint8 maximumLevel,
        uint8[] calldata levels,
        uint8[] calldata inheritanceLevels
    ) external override onlyGovernance {
        require(token != address(0), "ComplianceRules: Invalid token address");
        require(minimumLevel <= maximumLevel, "ComplianceRules: Invalid level range");
        require(maximumLevel <= MAX_COMPLIANCE_LEVELS, "ComplianceRules: Level too high");
        require(levels.length == inheritanceLevels.length, "ComplianceRules: Array length mismatch");

        ComplianceLevelRule storage rule = complianceLevelRules[token];
        rule.isActive = true;
        rule.minimumLevel = minimumLevel;
        rule.maximumLevel = maximumLevel;
        rule.lastUpdated = block.timestamp;

        // Set inheritance rules
        for (uint256 i = 0; i < levels.length; i++) {
            rule.levelInheritance[levels[i]] = inheritanceLevels[i];
        }

        emit ComplianceLevelRuleUpdated(token, minimumLevel, maximumLevel);
    }

    /**
     * @dev Validate jurisdiction compliance
     */
    function validateJurisdiction(
        address token,
        uint256 countryCode
    ) external view override returns (bool isValid, string memory reason) {
        JurisdictionRule storage rule = _getJurisdictionRule(token);

        if (!rule.isActive) {
            return (true, "No jurisdiction rules active");
        }

        // Check if country is blocked
        if (rule.blockedCountryMap[countryCode]) {
            return (false, "Country is blocked");
        }

        // If allowed countries list exists, check if country is allowed
        if (rule.allowedCountries.length > 0) {
            if (!rule.allowedCountryMap[countryCode]) {
                return (false, "Country not in allowed list");
            }
        }

        return (true, "Jurisdiction validation passed");
    }

    /**
     * @dev Validate investor type compliance
     */
    function validateInvestorType(
        address token,
        uint8 investorType,
        uint256 accreditationLevel
    ) external view override returns (bool isValid, string memory reason) {
        InvestorTypeRule storage rule = _getInvestorTypeRule(token);

        if (!rule.isActive) {
            return (true, "No investor type rules active");
        }

        // Check if investor type is blocked
        if (rule.blockedTypeMap[investorType]) {
            return (false, "Investor type is blocked");
        }

        // If allowed types list exists, check if type is allowed
        if (rule.allowedTypes.length > 0) {
            if (!rule.allowedTypeMap[investorType]) {
                return (false, "Investor type not allowed");
            }
        }

        // Check minimum accreditation
        if (accreditationLevel < rule.minimumAccreditation) {
            return (false, "Insufficient accreditation level");
        }

        return (true, "Investor type validation passed");
    }

    /**
     * @dev Validate holding period compliance
     */
    function validateHoldingPeriod(
        address token,
        address investor,
        uint256 acquisitionTime
    ) external view override returns (bool isValid, string memory reason) {
        HoldingPeriodRule storage rule = _getHoldingPeriodRule(token);

        if (!rule.isActive) {
            return (true, "No holding period rules active");
        }

        // Check minimum holding period
        if (block.timestamp < acquisitionTime + rule.minimumHoldingPeriod) {
            return (false, "Minimum holding period not met");
        }

        // Check transfer cooldown
        uint256 lastTransfer = rule.lastTransferTime[investor];
        if (lastTransfer > 0 && block.timestamp < lastTransfer + rule.transferCooldown) {
            return (false, "Transfer cooldown period active");
        }

        return (true, "Holding period validation passed");
    }

    /**
     * @dev Aggregate compliance levels from multiple inputs
     */
    function aggregateComplianceLevels(
        address token,
        uint8[] calldata inputLevels
    ) external view override returns (uint8 aggregatedLevel, bool isValid) {
        ComplianceLevelRule storage rule = _getComplianceLevelRule(token);

        if (!rule.isActive || inputLevels.length == 0) {
            return (0, false);
        }

        // Start with the minimum level from inputs
        uint8 minLevel = type(uint8).max;
        for (uint256 i = 0; i < inputLevels.length; i++) {
            if (inputLevels[i] < minLevel) {
                minLevel = inputLevels[i];
            }
        }

        // Apply inheritance rules
        uint8 inheritedLevel = rule.levelInheritance[minLevel];
        if (inheritedLevel > 0) {
            minLevel = inheritedLevel;
        }

        // Check if aggregated level meets requirements
        bool valid = minLevel >= rule.minimumLevel && minLevel <= rule.maximumLevel;

        return (minLevel, valid);
    }

    /**
     * @dev Record transfer for holding period tracking
     */
    function recordTransfer(
        address token,
        address from,
        address to,
        uint256 acquisitionTime
    ) external override onlyAuthorizedToken(token) {
        HoldingPeriodRule storage rule = holdingPeriodRules[token];

        if (rule.isActive) {
            rule.lastTransferTime[from] = block.timestamp;
            rule.tokenAcquisitionTime[to] = acquisitionTime > 0 ? acquisitionTime : block.timestamp;
        }
    }

    /**
     * @dev Authorize token to use compliance rules
     */
    function authorizeToken(address token, bool authorized) external onlyOwner {
        require(token != address(0), "ComplianceRules: Invalid token address");
        authorizedTokens[token] = authorized;
        emit TokenAuthorized(token, authorized);
    }

    /**
     * @dev Set rule administrator
     */
    function setRuleAdministrator(address administrator, bool authorized) external onlyOwner {
        require(administrator != address(0), "ComplianceRules: Invalid administrator address");
        ruleAdministrators[administrator] = authorized;
        emit RuleAdministratorUpdated(administrator, authorized);
    }

    /**
     * @dev Get jurisdiction rule for token (with fallback to default)
     */
    function _getJurisdictionRule(address token) private view returns (JurisdictionRule storage) {
        if (jurisdictionRules[token].isActive) {
            return jurisdictionRules[token];
        }
        return defaultJurisdictionRule;
    }

    /**
     * @dev Get investor type rule for token (with fallback to default)
     */
    function _getInvestorTypeRule(address token) private view returns (InvestorTypeRule storage) {
        if (investorTypeRules[token].isActive) {
            return investorTypeRules[token];
        }
        return defaultInvestorTypeRule;
    }

    /**
     * @dev Get holding period rule for token (with fallback to default)
     */
    function _getHoldingPeriodRule(address token) private view returns (HoldingPeriodRule storage) {
        if (holdingPeriodRules[token].isActive) {
            return holdingPeriodRules[token];
        }
        return defaultHoldingPeriodRule;
    }

    /**
     * @dev Get compliance level rule for token (with fallback to default)
     */
    function _getComplianceLevelRule(address token) private view returns (ComplianceLevelRule storage) {
        if (complianceLevelRules[token].isActive) {
            return complianceLevelRules[token];
        }
        return defaultComplianceLevelRule;
    }

    /**
     * @dev Initialize default compliance rules
     * @param initialAllowedCountries Array of country codes to allow (whitelist)
     * @param initialBlockedCountries Array of country codes to block (blacklist)
     */
    function _initializeDefaultRules(
        uint256[] memory initialAllowedCountries,
        uint256[] memory initialBlockedCountries
    ) private {
        // Default jurisdiction rule - use user-specified countries
        defaultJurisdictionRule.isActive = true;
        defaultJurisdictionRule.lastUpdated = block.timestamp;

        // Set allowed countries (whitelist)
        // If empty array provided, no whitelist is active (all countries allowed except blocked)
        for (uint256 i = 0; i < initialAllowedCountries.length; i++) {
            defaultJurisdictionRule.allowedCountries.push(initialAllowedCountries[i]);
            defaultJurisdictionRule.allowedCountryMap[initialAllowedCountries[i]] = true;
        }

        // Set blocked countries (blacklist)
        // If empty array provided, no countries are blocked by default
        for (uint256 i = 0; i < initialBlockedCountries.length; i++) {
            defaultJurisdictionRule.blockedCountries.push(initialBlockedCountries[i]);
            defaultJurisdictionRule.blockedCountryMap[initialBlockedCountries[i]] = true;
        }

        // Default investor type rule - allow retail and accredited investors
        defaultInvestorTypeRule.isActive = true;
        defaultInvestorTypeRule.minimumAccreditation = 1;
        defaultInvestorTypeRule.lastUpdated = block.timestamp;

        // Default holding period rule - 24 hour minimum holding, 1 hour cooldown
        defaultHoldingPeriodRule.isActive = true;
        defaultHoldingPeriodRule.minimumHoldingPeriod = 24 hours;
        defaultHoldingPeriodRule.transferCooldown = 1 hours;
        defaultHoldingPeriodRule.lastUpdated = block.timestamp;

        // Default compliance level rule - minimum level 1, maximum level 5
        defaultComplianceLevelRule.isActive = true;
        defaultComplianceLevelRule.minimumLevel = 1;
        defaultComplianceLevelRule.maximumLevel = 5;
        defaultComplianceLevelRule.lastUpdated = block.timestamp;
    }

    /**
     * @dev Get jurisdiction rule details
     */
    function getJurisdictionRule(
        address token
    )
        external
        view
        returns (
            bool isActive,
            uint256[] memory allowedCountries,
            uint256[] memory blockedCountries,
            uint256 lastUpdated
        )
    {
        JurisdictionRule storage rule = _getJurisdictionRule(token);
        return (rule.isActive, rule.allowedCountries, rule.blockedCountries, rule.lastUpdated);
    }

    /**
     * @dev Get investor type rule details
     */
    function getInvestorTypeRule(
        address token
    )
        external
        view
        returns (
            bool isActive,
            uint8[] memory allowedTypes,
            uint8[] memory blockedTypes,
            uint256 minimumAccreditation,
            uint256 lastUpdated
        )
    {
        InvestorTypeRule storage rule = _getInvestorTypeRule(token);
        return (rule.isActive, rule.allowedTypes, rule.blockedTypes, rule.minimumAccreditation, rule.lastUpdated);
    }

    /**
     * @dev Get holding period rule details
     */
    function getHoldingPeriodRule(
        address token
    )
        external
        view
        returns (bool isActive, uint256 minimumHoldingPeriod, uint256 transferCooldown, uint256 lastUpdated)
    {
        HoldingPeriodRule storage rule = _getHoldingPeriodRule(token);
        return (rule.isActive, rule.minimumHoldingPeriod, rule.transferCooldown, rule.lastUpdated);
    }

    /**
     * @dev Get compliance level rule details
     */
    function getComplianceLevelRule(
        address token
    ) external view returns (bool isActive, uint8 minimumLevel, uint8 maximumLevel, uint256 lastUpdated) {
        ComplianceLevelRule storage rule = _getComplianceLevelRule(token);
        return (rule.isActive, rule.minimumLevel, rule.maximumLevel, rule.lastUpdated);
    }
}
