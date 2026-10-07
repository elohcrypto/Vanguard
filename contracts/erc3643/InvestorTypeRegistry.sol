// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import {InvestorTypeGovernance, Ownable} from "./InvestorTypeGovernance.sol";

/**
 * @title InvestorTypeRegistry
 * @dev Registry for managing investor types and their associated limits and privileges
 * @author Vanguard StableCoin Team
 *
 * @custom:security Uses Ownable2Step, not Ownable. Ownership of this registry
 * is intended to move to VanguardGovernance, which is a CONTRACT: one-step
 * `transferOwnership` to an address that cannot call `acceptOwnership` — or to
 * a mistyped address — would permanently strand `updateInvestorTypeConfig`,
 * `setComplianceOfficer`, `authorizeToken` and `setGovernor`, with no recovery
 * path. Two-step transfer makes the new owner prove it can act.
 *
 * @custom:security NOTE ON TWO GOVERNANCE LAYERS. This contract has its own
 * proposal system (`createProposal` / `approveProposal` /
 * `executeProposal`) gated on `_governors` and `requiredApprovals`. But
 * `updateInvestorTypeConfig` is `onlyOwner` and bypasses it entirely. When
 * VanguardGovernance owns this registry it changes config through that
 * bypass — protected by the VanguardGovernance vote, NOT by the governors
 * here. Do not read the presence of `approveProposal` as a second layer of
 * protection on owner-initiated config changes. The proposal system lives in
 * the abstract base InvestorTypeGovernance (Task 4.10 split, one contract).
 */
contract InvestorTypeRegistry is InvestorTypeGovernance {
    // State variables
    mapping(address => InvestorType) private _investorTypes;
    mapping(InvestorType => InvestorTypeConfig) private _typeConfigs;
    mapping(address => bool) private _complianceOfficers;
    mapping(address => bool) private _authorizedTokens;
    // D22 (a): a treasury is not an investor; exempt accounts skip type caps.
    mapping(address => bool) public investorLimitExempt;
    /// @notice When an authorized token last recorded a transfer SENT by the
    ///         account (D37 = a, Task 4.10). Written only by recordTransfer.
    mapping(address => uint256) public lastTransferAt;

    modifier onlyComplianceOfficer() {
        require(_complianceOfficers[msg.sender] || msg.sender == owner(), "Not authorized compliance officer");
        _;
    }

    modifier onlyAuthorizedToken() {
        require(_authorizedTokens[msg.sender], "Token not authorized");
        _;
    }

    constructor() Ownable(msg.sender) {
        _complianceOfficers[msg.sender] = true;
        _initializeDefaultConfigs();
    }

    /**
     * @dev Assign investor type to an address
     */
    function assignInvestorType(address investor, InvestorType investorType) external onlyComplianceOfficer {
        require(investor != address(0), "Invalid investor address");
        require(uint8(investorType) <= uint8(InvestorType.Institutional), "Invalid investor type");

        _investorTypes[investor] = investorType;
        emit InvestorTypeAssigned(investor, investorType, msg.sender);
    }

    /**
     * @dev Upgrade investor type (requires compliance officer approval)
     */
    function upgradeInvestorType(address investor, InvestorType newType) external onlyComplianceOfficer {
        require(investor != address(0), "Invalid investor address");
        require(uint8(newType) <= uint8(InvestorType.Institutional), "Invalid investor type");

        InvestorType oldType = _investorTypes[investor];
        require(uint8(newType) > uint8(oldType), "Not an upgrade");

        _investorTypes[investor] = newType;
        emit InvestorTypeUpgraded(investor, oldType, newType, msg.sender);
    }

    /**
     * @dev Downgrade investor type (requires compliance officer approval)
     */
    function downgradeInvestorType(address investor, InvestorType newType) external onlyComplianceOfficer {
        require(investor != address(0), "Invalid investor address");

        InvestorType oldType = _investorTypes[investor];
        require(uint8(newType) < uint8(oldType), "Not a downgrade");

        _investorTypes[investor] = newType;
        emit InvestorTypeDowngraded(investor, oldType, newType, msg.sender);
    }

    /**
     * @dev Get investor type for an address
     */
    function getInvestorType(address investor) external view returns (InvestorType) {
        return _investorTypes[investor];
    }

    /**
     * @dev Get investor type configuration
     */
    function getInvestorTypeConfig(InvestorType investorType) external view returns (InvestorTypeConfig memory) {
        return _typeConfigs[investorType];
    }

    /**
     * @dev Check if investor can transfer specified amount
     */
    function canTransferAmount(address investor, uint256 amount) external view returns (bool) {
        if (investorLimitExempt[investor]) return true;
        // One field from storage, not a memory copy of all seven (Task 4.10).
        return amount <= _typeConfigs[_investorTypes[investor]].maxTransferAmount;
    }

    /**
     * @dev Check if investor can hold specified amount
     */
    function canHoldAmount(address investor, uint256 amount) external view returns (bool) {
        if (investorLimitExempt[investor]) return true;
        return amount <= _typeConfigs[_investorTypes[investor]].maxHoldingAmount;
    }

    /**
     * @dev Get required whitelist tier for investor
     */
    function getRequiredWhitelistTier(address investor) external view returns (uint8) {
        InvestorType investorType = _investorTypes[investor];
        return _typeConfigs[investorType].requiredWhitelistTier;
    }

    /**
     * @dev Get transfer cooldown for investor type
     */
    function getTransferCooldown(address investor) external view returns (uint256) {
        InvestorType investorType = _investorTypes[investor];
        return _typeConfigs[investorType].transferCooldownMinutes;
    }

    /**
     * @notice False while `sender` is inside its investor type's transfer
     *         cooldown: true when the sender is investorLimitExempt (D22),
     *         when its type's cooldown is 0, or when at least
     *         `transferCooldownMinutes` minutes have passed since an
     *         authorized token last recorded a transfer it sent. Token asks
     *         this for a non-trusted sender next to canTransferAmount
     *         (D37 = a, Task 4.10). Receiving starts no cooldown.
     * @dev Compared in whole minutes elapsed, which equals
     *      `elapsed >= cooldown * 60` without the multiplication, so no
     *      configured cooldown can overflow into a reason-less revert.
     */
    function canTransferNow(address sender) external view returns (bool) {
        if (investorLimitExempt[sender]) return true;
        uint256 cooldown = _typeConfigs[_investorTypes[sender]].transferCooldownMinutes;
        if (cooldown == 0) return true;
        return (block.timestamp - lastTransferAt[sender]) / 60 >= cooldown;
    }

    /**
     * @notice Start `sender`'s cooldown now. Only a token this registry
     *         authorized (authorizeToken) may call it: the authorization
     *         list is the hook through which a token writes the clock.
     *         Token calls it after a user transfer (transfer/transferFrom)
     *         by a non-trusted sender; mint, burn, recovery and trusted
     *         contract senders never write it.
     */
    function recordTransfer(address sender) external onlyAuthorizedToken {
        lastTransferAt[sender] = block.timestamp;
    }

    /**
     * @dev Check if transfer amount requires large transfer notification
     */
    function isLargeTransfer(address investor, uint256 amount) external view returns (bool) {
        return amount > _typeConfigs[_investorTypes[investor]].largeTransferThreshold;
    }

    /**
     * @dev Check if investor has enhanced logging enabled
     */
    function hasEnhancedLogging(address investor) external view returns (bool) {
        InvestorType investorType = _investorTypes[investor];
        return _typeConfigs[investorType].enhancedLogging;
    }

    /**
     * @dev Check if investor has enhanced privacy features
     */
    function hasEnhancedPrivacy(address investor) external view returns (bool) {
        InvestorType investorType = _investorTypes[investor];
        return _typeConfigs[investorType].enhancedPrivacy;
    }

    /**
     * @dev Update investor type configuration (only owner)
     */
    function updateInvestorTypeConfig(
        InvestorType investorType,
        InvestorTypeConfig calldata config
    ) external onlyOwner {
        require(uint8(investorType) <= uint8(InvestorType.Institutional), "Invalid investor type");
        require(config.maxTransferAmount > 0, "Invalid max transfer amount");
        require(config.maxHoldingAmount > 0, "Invalid max holding amount");
        require(config.requiredWhitelistTier >= 1 && config.requiredWhitelistTier <= 5, "Invalid whitelist tier");

        _typeConfigs[investorType] = config;
        emit InvestorTypeConfigUpdated(investorType, config);
    }

    /// @dev Exempt a treasury from investor-type caps (logged). D22 (a): a
    /// governance decision, so owner only (an InvestorTypeConfig vote after handover).
    function setInvestorLimitExempt(address account, bool exempt) external onlyOwner {
        require(account != address(0), "Invalid account address");
        investorLimitExempt[account] = exempt;
        emit InvestorLimitExemptionUpdated(account, exempt);
    }

    /// @dev Set compliance officer authorization
    function setComplianceOfficer(address officer, bool authorized) external onlyOwner {
        require(officer != address(0), "Invalid officer address");
        _complianceOfficers[officer] = authorized;
        emit ComplianceOfficerUpdated(officer, authorized);
    }

    /**
     * @dev Authorize token to use this registry: an authorized token may
     *      write the cooldown clock (recordTransfer), and Token refuses every
     *      mint and transfer with "Token not authorized by investor registry"
     *      while its registry is set but has not authorized it (Task 4.10).
     */
    function authorizeToken(address token, bool authorized) external onlyOwner {
        require(token != address(0), "Invalid token address");
        _authorizedTokens[token] = authorized;
        emit TokenAuthorized(token, authorized);
    }

    /**
     * @dev Check if address is compliance officer
     */
    function isComplianceOfficer(address officer) external view returns (bool) {
        return _complianceOfficers[officer];
    }

    /**
     * @dev Check if token is authorized
     */
    function isTokenAuthorized(address token) external view returns (bool) {
        return _authorizedTokens[token];
    }

    /**
     * @dev Initialize default investor type configurations
     */
    function _initializeDefaultConfigs() private {
        // Normal Investor Configuration
        _typeConfigs[InvestorType.Normal] = InvestorTypeConfig({
            maxTransferAmount: 8_000 * 10 ** 18, // 8,000 VSC
            maxHoldingAmount: 50_000 * 10 ** 18, // 50,000 VSC
            requiredWhitelistTier: 1, // Tier 1+
            transferCooldownMinutes: 60, // 1 hour
            largeTransferThreshold: 3_000 * 10 ** 18, // ✅ UPDATED: >3,000 VSC
            enhancedLogging: false, // Basic logging
            enhancedPrivacy: false // Standard privacy
        });

        // Retail Investor Configuration
        _typeConfigs[InvestorType.Retail] = InvestorTypeConfig({
            maxTransferAmount: 8_000 * 10 ** 18, // 8,000 VSC
            maxHoldingAmount: 50_000 * 10 ** 18, // 50,000 VSC
            requiredWhitelistTier: 2, // Tier 2+
            transferCooldownMinutes: 60, // 1 hour
            largeTransferThreshold: 5_000 * 10 ** 18, // ✅ UPDATED: >5,000 VSC
            enhancedLogging: false, // Basic logging
            enhancedPrivacy: false // Standard privacy
        });

        // Accredited Investor Configuration
        _typeConfigs[InvestorType.Accredited] = InvestorTypeConfig({
            maxTransferAmount: 50_000 * 10 ** 18, // 50,000 VSC
            maxHoldingAmount: 500_000 * 10 ** 18, // 500,000 VSC
            requiredWhitelistTier: 3, // Tier 3+
            transferCooldownMinutes: 30, // 30 minutes
            largeTransferThreshold: 10_000 * 10 ** 18, // >10,000 VSC
            enhancedLogging: true, // Enhanced logging
            enhancedPrivacy: true // Enhanced privacy
        });

        // Institutional Investor Configuration
        _typeConfigs[InvestorType.Institutional] = InvestorTypeConfig({
            maxTransferAmount: 500_000 * 10 ** 18, // 500,000 VSC
            maxHoldingAmount: 5_000_000 * 10 ** 18, // 5,000,000 VSC
            requiredWhitelistTier: 4, // Tier 4+
            transferCooldownMinutes: 15, // 15 minutes
            largeTransferThreshold: 100_000 * 10 ** 18, // >100,000 VSC
            enhancedLogging: true, // Enhanced logging
            enhancedPrivacy: true // Premium privacy
        });
    }

    /**
     * @dev Get all investor type configurations
     */
    function getAllInvestorTypeConfigs()
        external
        view
        returns (
            InvestorTypeConfig memory normalConfig,
            InvestorTypeConfig memory retailConfig,
            InvestorTypeConfig memory accreditedConfig,
            InvestorTypeConfig memory institutionalConfig
        )
    {
        return (
            _typeConfigs[InvestorType.Normal],
            _typeConfigs[InvestorType.Retail],
            _typeConfigs[InvestorType.Accredited],
            _typeConfigs[InvestorType.Institutional]
        );
    }

    /// @dev InvestorTypeGovernance.executeProposal writes through here.
    function _applyProposedConfig(InvestorType investorType, InvestorTypeConfig memory config) internal override {
        _typeConfigs[investorType] = config;
    }
}
