// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {IInvestorTypeRegistry} from "./interfaces/IInvestorTypeRegistry.sol";

/**
 * @title InvestorTypeGovernance
 * @dev The governance half of InvestorTypeRegistry (plan v2 Task 4.10,
 *      split by inheritance under the 500-line rule as 4.5 and 4.9 did):
 *      the registry's own config proposals, its governors and their
 *      epoch. One deployed contract, one address: InvestorTypeRegistry
 *      inherits this and supplies the config store through
 *      `_applyProposedConfig`. See InvestorTypeRegistry for the note on
 *      the two governance layers.
 */
abstract contract InvestorTypeGovernance is IInvestorTypeRegistry, Ownable2Step {
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
        // The governor set it was created under (plan 2F.5, L2).
        uint256 governorEpoch;
    }

    mapping(uint256 => Proposal) private _proposals;
    mapping(address => bool) private _governors;
    mapping(address => uint256) private _governorWeights;

    uint256 private _nextProposalId = 1;
    uint256 public governanceDelay = 2 days;
    uint256 public requiredApprovals = 2;
    uint256 public totalGovernorWeight = 0;
    /// @notice Bumped by every setGovernor: a proposal created under an older
    ///         governor set can no longer be approved or executed, so
    ///         approvals from removed governors do not survive (2F.5, L2).
    uint256 public governorEpoch;
    /// @notice A proposal not executed within this window after its
    ///         executionTime is dead.
    uint256 public constant PROPOSAL_LIFETIME = 7 days;

    error GovernorSetChanged(uint256 proposalId);
    error ProposalExpired(uint256 proposalId);

    modifier onlyGovernor() {
        require(_governors[msg.sender] || msg.sender == owner(), "Not authorized governor");
        _;
    }

    /// @dev Writes an executed proposal's config into the registry's store.
    function _applyProposedConfig(InvestorType investorType, InvestorTypeConfig memory config) internal virtual;

    // ===== GOVERNANCE FUNCTIONS =====

    /// @dev Create a proposal to update investor type configuration
    function createProposal(
        InvestorType investorType,
        InvestorTypeConfig calldata config,
        string calldata description
    ) external onlyGovernor returns (uint256) {
        require(uint8(investorType) <= uint8(InvestorType.Institutional), "Invalid investor type");
        require(config.maxTransferAmount > 0, "Invalid max transfer amount");
        require(config.maxHoldingAmount > 0, "Invalid max holding amount");
        require(config.requiredWhitelistTier >= 1 && config.requiredWhitelistTier <= 5, "Invalid whitelist tier");

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
        proposal.governorEpoch = governorEpoch;

        emit ProposalCreated(proposalId, msg.sender, investorType, description);
        return proposalId;
    }

    /// @dev Approve a proposal (governors only)
    function approveProposal(uint256 proposalId) external onlyGovernor {
        Proposal storage proposal = _proposals[proposalId];
        require(proposal.id != 0, "Proposal does not exist");
        require(proposal.status == ProposalStatus.Pending, "Proposal not active");
        if (proposal.governorEpoch != governorEpoch) revert GovernorSetChanged(proposalId);
        require(!proposal.approvals[msg.sender], "Already approved");

        proposal.approvals[msg.sender] = true;
        proposal.approvalsCount++;

        // Update status to Approved if we have enough approvals
        if (proposal.approvalsCount >= requiredApprovals) {
            proposal.status = ProposalStatus.Approved;
        }

        emit ProposalApproved(proposalId, msg.sender);
    }

    /// @dev Execute a proposal after approval and delay
    function executeProposal(uint256 proposalId) external {
        Proposal storage proposal = _proposals[proposalId];
        require(proposal.id != 0, "Proposal does not exist");
        require(
            proposal.status == ProposalStatus.Approved || proposal.status == ProposalStatus.Pending,
            "Proposal not executable"
        );
        if (proposal.governorEpoch != governorEpoch) revert GovernorSetChanged(proposalId);
        require(block.timestamp >= proposal.executionTime, "Execution delay not met");
        if (block.timestamp > proposal.executionTime + PROPOSAL_LIFETIME) revert ProposalExpired(proposalId);
        require(proposal.approvalsCount >= requiredApprovals, "Insufficient approvals");

        proposal.status = ProposalStatus.Executed;

        // Execute the configuration update
        _applyProposedConfig(proposal.investorType, proposal.proposedConfig);

        emit ProposalExecuted(proposalId);
        emit InvestorTypeConfigUpdated(proposal.investorType, proposal.proposedConfig);
    }

    /// @dev Cancel a proposal (owner only)
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

    /// @dev Set governor authorization and voting weight
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
        governorEpoch++;

        emit GovernorUpdated(governor, authorized, weight);
    }

    /// @dev Update governance parameters
    function updateGovernanceParameters(uint256 delay, uint256 requiredApprovals_) external onlyOwner {
        require(delay >= 1 hours, "Delay too short");
        require(delay <= 30 days, "Delay too long");
        require(requiredApprovals_ >= 1, "Need at least 1 approval");

        governanceDelay = delay;
        requiredApprovals = requiredApprovals_;

        emit GovernanceParametersUpdated(delay, requiredApprovals_);
    }

    /// @dev Get proposal details
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

    /// @notice True while a proposal could still execute: Pending or
    ///         Approved, created under the current governor set, not expired.
    function isProposalOpen(uint256 proposalId) external view returns (bool) {
        Proposal storage p = _proposals[proposalId];
        return
            p.id != 0 &&
            (p.status == ProposalStatus.Pending || p.status == ProposalStatus.Approved) &&
            p.governorEpoch == governorEpoch &&
            block.timestamp <= p.executionTime + PROPOSAL_LIFETIME;
    }

    /// @notice Number of proposals ever created (ids 1..proposalCount).
    function proposalCount() external view returns (uint256) {
        return _nextProposalId - 1;
    }

    /// @dev Check if address is governor
    function isGovernor(address account) external view returns (bool) {
        return _governors[account];
    }

    /// @dev Get governor voting weight
    function getGovernorWeight(address governor) external view returns (uint256) {
        return _governorWeights[governor];
    }

    /// @dev Check if governor has approved proposal
    function hasApproved(uint256 proposalId, address governor) external view returns (bool) {
        return _proposals[proposalId].approvals[governor];
    }
}
