// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

/**
 * @title IInvestorTypeRegistry
 * @dev Interface for managing investor types and their associated limits and privileges
 */
interface IInvestorTypeRegistry {
    // Investor type enumeration
    enum InvestorType {
        Normal, // 0 - Basic investor
        Retail, // 1 - Retail investor
        Accredited, // 2 - Accredited investor
        Institutional // 3 - Institutional investor
    }

    // Investor type configuration
    struct InvestorTypeConfig {
        uint256 maxTransferAmount; // Maximum transfer amount per transaction
        uint256 maxHoldingAmount; // Maximum total holding amount
        uint8 requiredWhitelistTier; // Minimum whitelist tier required
        uint256 transferCooldownMinutes; // Transfer cooldown in minutes
        uint256 largeTransferThreshold; // Threshold for large transfer notifications
        bool enhancedLogging; // Whether enhanced logging is enabled
        bool enhancedPrivacy; // Whether enhanced privacy features are available
    }

    // Events
    event InvestorTypeAssigned(address indexed investor, InvestorType investorType, address indexed officer);
    event InvestorTypeUpgraded(
        address indexed investor,
        InvestorType oldType,
        InvestorType newType,
        address indexed officer
    );
    event InvestorTypeDowngraded(
        address indexed investor,
        InvestorType oldType,
        InvestorType newType,
        address indexed officer
    );
    event InvestorTypeConfigUpdated(InvestorType investorType, InvestorTypeConfig config);
    event ComplianceOfficerUpdated(address indexed officer, bool authorized);
    event TokenAuthorized(address indexed token, bool authorized);

    // Governance events
    event ProposalCreated(
        uint256 indexed proposalId,
        address indexed proposer,
        InvestorType investorType,
        string description
    );
    event ProposalApproved(uint256 indexed proposalId, address indexed governor);
    event ProposalExecuted(uint256 indexed proposalId);
    event ProposalCancelled(uint256 indexed proposalId);
    event GovernorUpdated(address indexed governor, bool authorized, uint256 weight);
    event GovernanceParametersUpdated(uint256 delay, uint256 requiredApprovals);

    /**
     * @dev Assign investor type to an address
     */
    function assignInvestorType(address investor, InvestorType investorType) external;

    /**
     * @dev Upgrade investor type (requires compliance officer approval)
     */
    function upgradeInvestorType(address investor, InvestorType newType) external;

    /**
     * @dev Downgrade investor type (requires compliance officer approval)
     */
    function downgradeInvestorType(address investor, InvestorType newType) external;

    /**
     * @dev Get investor type for an address
     */
    function getInvestorType(address investor) external view returns (InvestorType);

    /**
     * @dev Get investor type configuration
     */
    function getInvestorTypeConfig(InvestorType investorType) external view returns (InvestorTypeConfig memory);

    /**
     * @dev Check if investor can transfer specified amount
     */
    function canTransferAmount(address investor, uint256 amount) external view returns (bool);

    /**
     * @dev Check if investor can hold specified amount
     */
    function canHoldAmount(address investor, uint256 amount) external view returns (bool);

    /**
     * @dev Get required whitelist tier for investor
     */
    function getRequiredWhitelistTier(address investor) external view returns (uint8);

    /**
     * @dev Get transfer cooldown for investor type
     */
    function getTransferCooldown(address investor) external view returns (uint256);

    /**
     * @dev Check if transfer amount requires large transfer notification
     */
    function isLargeTransfer(address investor, uint256 amount) external view returns (bool);

    /**
     * @dev Check if investor has enhanced logging enabled
     */
    function hasEnhancedLogging(address investor) external view returns (bool);

    /**
     * @dev Check if investor has enhanced privacy features
     */
    function hasEnhancedPrivacy(address investor) external view returns (bool);

    // Governance functions
    function createProposal(
        InvestorType investorType,
        InvestorTypeConfig calldata config,
        string calldata description
    ) external returns (uint256);

    function approveProposal(uint256 proposalId) external;

    function executeProposal(uint256 proposalId) external;

    function cancelProposal(uint256 proposalId) external;

    function setGovernor(address governor, bool authorized, uint256 weight) external;

    function updateGovernanceParameters(uint256 delay, uint256 requiredApprovals) external;

    /**
     * @dev Update investor type configuration (only owner)
     */
    function updateInvestorTypeConfig(InvestorType investorType, InvestorTypeConfig calldata config) external;
}
