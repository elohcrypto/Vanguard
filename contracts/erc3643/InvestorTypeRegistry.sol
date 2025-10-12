// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "@openzeppelin/contracts/access/Ownable.sol";
import "./interfaces/IInvestorTypeRegistry.sol";

/**
 * @title InvestorTypeRegistry
 * @dev Registry for managing investor types and their associated limits and privileges
 * @author Vanguard StableCoin Team
 */
contract InvestorTypeRegistry is IInvestorTypeRegistry, Ownable {
    // State variables
    mapping(address => InvestorType) private _investorTypes;
    mapping(InvestorType => InvestorTypeConfig) private _typeConfigs;
    mapping(address => bool) private _complianceOfficers;
    mapping(address => bool) private _authorizedTokens;

    // Proposal status enumeration
    enum ProposalStatus {
        Pending, // 0 - Proposal is pending approval
        Approved, // 1 - Proposal has enough approvals but not executed
        Executed, // 2 - Proposal has been executed
        Cancelled // 3 - Proposal has been cancelled
    }

    // Governance state variables
    struct Proposal {
        uint256 id;
        InvestorType investorType;
        InvestorTypeConfig proposedConfig;
        address proposer;
        uint256 createdAt;
        uint256 executionTime;
        ProposalStatus status;
        string description;
        uint256 approvalsCount;
        mapping(address => bool) approvals;
    }

    mapping(uint256 => Proposal) private _proposals;
    mapping(address => bool) private _governors;
    mapping(address => uint256) private _governorWeights;

    uint256 private _nextProposalId = 1;
    uint256 public governanceDelay = 2 days;
    uint256 public requiredApprovals = 2;
    uint256 public totalGovernorWeight = 0;

    modifier onlyComplianceOfficer() {
        require(_complianceOfficers[msg.sender] || msg.sender == owner(), "Not authorized compliance officer");
        _;
    }

    modifier onlyGovernor() {
        require(_governors[msg.sender] || msg.sender == owner(), "Not authorized governor");
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
        InvestorType investorType = _investorTypes[investor]; // Defaults to Normal (0) if not set
        InvestorTypeConfig memory config = _typeConfigs[investorType];
        return amount <= config.maxTransferAmount;
    }

    /**
     * @dev Check if investor can hold specified amount
     */
    function canHoldAmount(address investor, uint256 amount) external view returns (bool) {
        InvestorType investorType = _investorTypes[investor];
        InvestorTypeConfig memory config = _typeConfigs[investorType];
        return amount <= config.maxHoldingAmount;
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
     * @dev Check if transfer amount requires large transfer notification
     */
    function isLargeTransfer(address investor, uint256 amount) external view returns (bool) {
        InvestorType investorType = _investorTypes[investor];
        InvestorTypeConfig memory config = _typeConfigs[investorType];
        return amount > config.largeTransferThreshold;
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

    /**
     * @dev Set compliance officer authorization
     */
    function setComplianceOfficer(address officer, bool authorized) external onlyOwner {
        require(officer != address(0), "Invalid officer address");
        _complianceOfficers[officer] = authorized;
        emit ComplianceOfficerUpdated(officer, authorized);
    }

    /**
     * @dev Authorize token to use this registry
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

    // ===== GOVERNANCE FUNCTIONS =====

    /**
     * @dev Create a proposal to update investor type configuration
     */
    function createProposal(
        InvestorType investorType,
        InvestorTypeConfig calldata config,
        string calldata description
    ) external onlyGovernor returns (uint256) {
        require(uint8(investorType) <= uint8(InvestorType.Institutional), "Invalid investor type");
        require(config.maxTransferAmount > 0, "Invalid max transfer amount");
        require(config.maxHoldingAmount > 0, "Invalid max holding amount");

        uint256 proposalId = _nextProposalId++;
        Proposal storage proposal = _proposals[proposalId];

        proposal.id = proposalId;
        proposal.investorType = investorType;
        proposal.proposedConfig = config;
        proposal.proposer = msg.sender;
        proposal.createdAt = block.timestamp;
        proposal.executionTime = block.timestamp + governanceDelay;
        proposal.status = ProposalStatus.Pending;
        proposal.description = description;
        proposal.approvalsCount = 0;

        emit ProposalCreated(proposalId, msg.sender, investorType, description);
        return proposalId;
    }

    /**
     * @dev Approve a proposal (governors only)
     */
    function approveProposal(uint256 proposalId) external onlyGovernor {
        Proposal storage proposal = _proposals[proposalId];
        require(proposal.id != 0, "Proposal does not exist");
        require(proposal.status == ProposalStatus.Pending, "Proposal not active");
        require(!proposal.approvals[msg.sender], "Already approved");

        proposal.approvals[msg.sender] = true;
        proposal.approvalsCount++;

        // Update status to Approved if we have enough approvals
        if (proposal.approvalsCount >= requiredApprovals) {
            proposal.status = ProposalStatus.Approved;
        }

        emit ProposalApproved(proposalId, msg.sender);
    }

    /**
     * @dev Execute a proposal after approval and delay
     */
    function executeProposal(uint256 proposalId) external {
        Proposal storage proposal = _proposals[proposalId];
        require(proposal.id != 0, "Proposal does not exist");
        require(
            proposal.status == ProposalStatus.Approved || proposal.status == ProposalStatus.Pending,
            "Proposal not executable"
        );
        require(block.timestamp >= proposal.executionTime, "Execution delay not met");
        require(proposal.approvalsCount >= requiredApprovals, "Insufficient approvals");

        proposal.status = ProposalStatus.Executed;

        // Execute the configuration update
        _typeConfigs[proposal.investorType] = proposal.proposedConfig;

        emit ProposalExecuted(proposalId);
        emit InvestorTypeConfigUpdated(proposal.investorType, proposal.proposedConfig);
    }

    /**
     * @dev Cancel a proposal (owner only)
     */
    function cancelProposal(uint256 proposalId) external onlyOwner {
        Proposal storage proposal = _proposals[proposalId];
        require(proposal.id != 0, "Proposal does not exist");
        require(
            proposal.status == ProposalStatus.Pending || proposal.status == ProposalStatus.Approved,
            "Proposal not cancellable"
        );

        proposal.status = ProposalStatus.Cancelled;
        emit ProposalCancelled(proposalId);
    }

    /**
     * @dev Set governor authorization and voting weight
     */
    function setGovernor(address governor, bool authorized, uint256 weight) external onlyOwner {
        require(governor != address(0), "Invalid governor address");

        if (_governors[governor] && !authorized) {
            // Removing governor
            totalGovernorWeight -= _governorWeights[governor];
        } else if (!_governors[governor] && authorized) {
            // Adding governor
            totalGovernorWeight += weight;
        } else if (_governors[governor] && authorized) {
            // Updating weight
            totalGovernorWeight = totalGovernorWeight - _governorWeights[governor] + weight;
        }

        _governors[governor] = authorized;
        _governorWeights[governor] = authorized ? weight : 0;

        emit GovernorUpdated(governor, authorized, weight);
    }

    /**
     * @dev Update governance parameters
     */
    function updateGovernanceParameters(uint256 delay, uint256 requiredApprovals_) external onlyOwner {
        require(delay >= 1 hours, "Delay too short");
        require(delay <= 30 days, "Delay too long");
        require(requiredApprovals_ >= 1, "Need at least 1 approval");

        governanceDelay = delay;
        requiredApprovals = requiredApprovals_;

        emit GovernanceParametersUpdated(delay, requiredApprovals_);
    }

    /**
     * @dev Get proposal details
     */
    function getProposal(
        uint256 proposalId
    )
        external
        view
        returns (
            uint256 id,
            InvestorType investorType,
            InvestorTypeConfig memory proposedConfig,
            address proposer,
            uint256 createdAt,
            uint256 executionTime,
            ProposalStatus status,
            string memory description,
            uint256 approvalsCount
        )
    {
        Proposal storage proposal = _proposals[proposalId];
        return (
            proposal.id,
            proposal.investorType,
            proposal.proposedConfig,
            proposal.proposer,
            proposal.createdAt,
            proposal.executionTime,
            proposal.status,
            proposal.description,
            proposal.approvalsCount
        );
    }

    /**
     * @dev Check if address is governor
     */
    function isGovernor(address account) external view returns (bool) {
        return _governors[account];
    }

    /**
     * @dev Get governor voting weight
     */
    function getGovernorWeight(address governor) external view returns (uint256) {
        return _governorWeights[governor];
    }

    /**
     * @dev Check if governor has approved proposal
     */
    function hasApproved(uint256 proposalId, address governor) external view returns (bool) {
        return _proposals[proposalId].approvals[governor];
    }
}
