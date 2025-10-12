// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "./GovernanceToken.sol";
import "../erc3643/interfaces/IIdentityRegistry.sol";
import "../compliance/interfaces/IComplianceRules.sol";
import "../erc3643/interfaces/IInvestorTypeRegistry.sol";

/**
 * @title VanguardGovernance
 * @dev Unified governance contract using GovernanceToken for voting
 * @notice Voting power is based on governance token ownership
 * @notice Only approved addresses (holding governance tokens) can vote
 */
contract VanguardGovernance is Ownable, ReentrancyGuard {
    // Enums
    enum ProposalType {
        InvestorTypeConfig,
        ComplianceRules,
        OracleParameters,
        TokenParameters,
        SystemParameters,
        EmergencyAction,
        AddToWhitelist,      // Add user to whitelist
        RemoveFromWhitelist, // Remove user from whitelist
        AddToBlacklist,      // Add user to blacklist
        RemoveFromBlacklist  // Remove user from blacklist
    }
    
    enum ProposalStatus {
        Pending,
        Active,
        Approved,
        Rejected,
        Executed,
        Cancelled
    }
    
    // Structures
    struct ProposalThresholds {
        uint256 quorumPercentage;      // Percentage of total voting power required (basis points)
        uint256 approvalPercentage;    // Percentage of votes needed to approve (basis points)
        uint256 votingPeriod;          // Voting period in seconds
        uint256 executionDelay;        // Delay before execution in seconds
    }
    
    struct Proposal {
        uint256 id;
        ProposalType proposalType;
        string title;
        string description;
        address target;
        bytes callData;
        address proposer;
        uint256 createdAt;
        uint256 votingEnds;
        uint256 executionTime;
        ProposalStatus status;
        uint256 votesFor;
        uint256 votesAgainst;
        uint256 snapshotId;
    }
    
    // State variables
    GovernanceToken public governanceToken;
    IIdentityRegistry public identityRegistry;

    mapping(uint256 => Proposal) private _proposals;
    mapping(uint256 => mapping(address => bool)) private _hasVoted;
    mapping(uint256 => mapping(address => bool)) private _voteChoice; // true = for, false = against
    mapping(uint256 => address[]) private _proposalVoters; // Track voters for token return

    uint256 private _nextProposalId = 1;

    // Proposal type thresholds
    mapping(ProposalType => ProposalThresholds) public proposalThresholds;

    /**
     * @dev Get the total number of proposals created
     * @return The current proposal count
     */
    function proposalCount() external view returns (uint256) {
        return _nextProposalId - 1;
    }

    /**
     * @dev Check if an address has voted on a proposal
     * @param proposalId The proposal ID
     * @param voter The voter address
     * @return True if the voter has voted, false otherwise
     */
    function hasVoted(uint256 proposalId, address voter) external view returns (bool) {
        return _hasVoted[proposalId][voter];
    }

    // Target contracts
    address public investorTypeRegistry;
    address public complianceRules;
    address public oracleManager;
    address public token;
    address public dynamicListManager; // DynamicListManager contract

    // List update proposal data
    struct ListUpdateProposal {
        address targetUser;
        uint256 targetIdentity;
        string reason;
    }

    mapping(uint256 => ListUpdateProposal) public listUpdateProposals;

    // Economic parameters (governance-controlled)
    uint256 public proposalCreationCost = 10 * 10**18; // 10 VGT to create proposal
    uint256 public votingCost = 10 * 10**18; // 10 VGT per vote

    // Token locking tracking
    mapping(uint256 => uint256) private _lockedTokens; // proposalId => total locked tokens
    mapping(uint256 => mapping(address => uint256)) private _voterLockedTokens; // proposalId => voter => locked amount
    
    // Events
    event ProposalCreated(
        uint256 indexed proposalId,
        address indexed proposer,
        ProposalType proposalType,
        string title,
        uint256 snapshotId
    );
    event VoteCast(
        uint256 indexed proposalId,
        address indexed voter,
        bool support,
        uint256 votingPower,
        string reason
    );
    event ProposalExecuted(uint256 indexed proposalId);
    event ProposalCancelled(uint256 indexed proposalId);
    event ProposalThresholdsUpdated(ProposalType indexed proposalType);
    
    /**
     * @dev Constructor
     */
    constructor(
        address _governanceToken,
        address _identityRegistry,
        address _investorTypeRegistry,
        address _complianceRules,
        address _oracleManager,
        address _token
    ) Ownable(msg.sender) {
        governanceToken = GovernanceToken(_governanceToken);
        identityRegistry = IIdentityRegistry(_identityRegistry);
        investorTypeRegistry = _investorTypeRegistry;
        complianceRules = _complianceRules;
        oracleManager = _oracleManager;
        token = _token;

        _initializeThresholds();
    }
    
    /**
     * @dev Initialize default thresholds for each proposal type
     */
    function _initializeThresholds() private {
        // InvestorTypeConfig: 20% quorum, 60% approval, 7 days voting, 2 days delay
        proposalThresholds[ProposalType.InvestorTypeConfig] = ProposalThresholds({
            quorumPercentage: 2000,
            approvalPercentage: 6000,
            votingPeriod: 7 days,
            executionDelay: 2 days
        });
        
        // ComplianceRules: 25% quorum, 65% approval, 7 days voting, 2 days delay
        proposalThresholds[ProposalType.ComplianceRules] = ProposalThresholds({
            quorumPercentage: 2500,
            approvalPercentage: 6500,
            votingPeriod: 7 days,
            executionDelay: 2 days
        });
        
        // OracleParameters: 20% quorum, 60% approval, 7 days voting, 2 days delay
        proposalThresholds[ProposalType.OracleParameters] = ProposalThresholds({
            quorumPercentage: 2000,
            approvalPercentage: 6000,
            votingPeriod: 7 days,
            executionDelay: 2 days
        });
        
        // TokenParameters: 30% quorum, 70% approval, 7 days voting, 3 days delay
        proposalThresholds[ProposalType.TokenParameters] = ProposalThresholds({
            quorumPercentage: 3000,
            approvalPercentage: 7000,
            votingPeriod: 7 days,
            executionDelay: 3 days
        });
        
        // SystemParameters: 25% quorum, 65% approval, 7 days voting, 2 days delay
        proposalThresholds[ProposalType.SystemParameters] = ProposalThresholds({
            quorumPercentage: 2500,
            approvalPercentage: 6500,
            votingPeriod: 7 days,
            executionDelay: 2 days
        });
        
        // EmergencyAction: 10% quorum, 75% approval, 3 days voting, 1 day delay
        proposalThresholds[ProposalType.EmergencyAction] = ProposalThresholds({
            quorumPercentage: 1000,
            approvalPercentage: 7500,
            votingPeriod: 3 days,
            executionDelay: 1 days
        });

        // AddToWhitelist: 15% quorum, 60% approval, 5 days voting, 1 day delay
        proposalThresholds[ProposalType.AddToWhitelist] = ProposalThresholds({
            quorumPercentage: 1500,
            approvalPercentage: 6000,
            votingPeriod: 5 days,
            executionDelay: 1 days
        });

        // RemoveFromWhitelist: 15% quorum, 60% approval, 5 days voting, 1 day delay
        proposalThresholds[ProposalType.RemoveFromWhitelist] = ProposalThresholds({
            quorumPercentage: 1500,
            approvalPercentage: 6000,
            votingPeriod: 5 days,
            executionDelay: 1 days
        });

        // AddToBlacklist: 20% quorum, 70% approval, 5 days voting, 1 day delay
        proposalThresholds[ProposalType.AddToBlacklist] = ProposalThresholds({
            quorumPercentage: 2000,
            approvalPercentage: 7000,
            votingPeriod: 5 days,
            executionDelay: 1 days
        });

        // RemoveFromBlacklist: 20% quorum, 65% approval, 5 days voting, 1 day delay
        proposalThresholds[ProposalType.RemoveFromBlacklist] = ProposalThresholds({
            quorumPercentage: 2000,
            approvalPercentage: 6500,
            votingPeriod: 5 days,
            executionDelay: 1 days
        });
    }
    
    /**
     * @dev Create a new proposal
     * @notice Requires payment of proposalCreationCost in VGT tokens
     */
    function createProposal(
        ProposalType proposalType,
        string calldata title,
        string calldata description,
        address target,
        bytes calldata callData
    ) external nonReentrant returns (uint256) {
        // Check KYC/AML verification
        require(identityRegistry.isVerified(msg.sender), "Must be KYC/AML verified");

        // Check proposer has enough tokens for creation cost
        require(
            governanceToken.balanceOf(msg.sender) >= proposalCreationCost,
            "Insufficient tokens for proposal creation"
        );

        // Transfer and lock proposal creation cost
        require(
            governanceToken.transferFrom(msg.sender, address(this), proposalCreationCost),
            "Token transfer failed"
        );

        // Create snapshot of current voting power
        uint256 snapshotId = governanceToken.snapshot();

        ProposalThresholds memory thresholds = proposalThresholds[proposalType];

        uint256 proposalId = _nextProposalId++;

        _proposals[proposalId] = Proposal({
            id: proposalId,
            proposalType: proposalType,
            title: title,
            description: description,
            target: target,
            callData: callData,
            proposer: msg.sender,
            createdAt: block.timestamp,
            votingEnds: block.timestamp + thresholds.votingPeriod,
            executionTime: block.timestamp + thresholds.votingPeriod + thresholds.executionDelay,
            status: ProposalStatus.Active,
            votesFor: 0,
            votesAgainst: 0,
            snapshotId: snapshotId
        });

        // Track locked tokens
        _lockedTokens[proposalId] = proposalCreationCost;
        _voterLockedTokens[proposalId][msg.sender] = proposalCreationCost;

        emit ProposalCreated(proposalId, msg.sender, proposalType, title, snapshotId);

        return proposalId;
    }
    
    /**
     * @dev Cast a vote on a proposal
     * @notice 1 Person = 1 Vote (KYC/AML verified only)
     * @notice Requires payment of votingCost in VGT tokens
     */
    function castVote(
        uint256 proposalId,
        bool support,
        string calldata reason
    ) external nonReentrant {
        Proposal storage proposal = _proposals[proposalId];

        require(proposal.status == ProposalStatus.Active, "Proposal not active");
        require(block.timestamp <= proposal.votingEnds, "Voting period ended");
        require(!_hasVoted[proposalId][msg.sender], "Already voted");
        require(msg.sender != proposal.proposer, "Proposer cannot vote on own proposal");

        // Check KYC/AML verification
        require(identityRegistry.isVerified(msg.sender), "Must be KYC/AML verified");

        // Check voter has enough tokens for voting cost
        require(
            governanceToken.balanceOf(msg.sender) >= votingCost,
            "Insufficient tokens for voting"
        );

        // Transfer and lock voting cost
        require(
            governanceToken.transferFrom(msg.sender, address(this), votingCost),
            "Token transfer failed"
        );

        // Mark as voted
        _hasVoted[proposalId][msg.sender] = true;
        _voteChoice[proposalId][msg.sender] = support;

        // Track voter for potential token return
        _proposalVoters[proposalId].push(msg.sender);

        // Track locked tokens
        _lockedTokens[proposalId] += votingCost;
        _voterLockedTokens[proposalId][msg.sender] = votingCost;

        // 1 Person = 1 Vote (equal voting power)
        if (support) {
            proposal.votesFor += 1;
        } else {
            proposal.votesAgainst += 1;
        }

        emit VoteCast(proposalId, msg.sender, support, 1, reason);
    }
    
    /**
     * @dev Execute an approved proposal
     * @notice If proposal passes (≥51%), locked tokens are burned
     * @notice If proposal fails (<51%), locked tokens are returned to voters
     */
    function executeProposal(uint256 proposalId) external nonReentrant {
        Proposal storage proposal = _proposals[proposalId];

        require(proposal.status == ProposalStatus.Active, "Proposal not active");
        require(block.timestamp > proposal.votingEnds, "Voting period not ended");

        uint256 totalVotes = proposal.votesFor + proposal.votesAgainst;
        require(totalVotes > 0, "No votes cast");

        // Calculate approval percentage (51% threshold)
        uint256 approvalPercentage = (proposal.votesFor * 100) / totalVotes;
        bool passed = approvalPercentage >= 51;

        if (passed) {
            // Proposal passed: Execute and BURN locked tokens
            require(block.timestamp >= proposal.executionTime, "Execution delay not met");

            // Check if this is a list update proposal
            if (proposal.proposalType == ProposalType.AddToWhitelist ||
                proposal.proposalType == ProposalType.RemoveFromWhitelist ||
                proposal.proposalType == ProposalType.AddToBlacklist ||
                proposal.proposalType == ProposalType.RemoveFromBlacklist) {

                // Execute list update
                _executeListUpdate(proposalId);
            } else {
                // Execute regular proposal
                (bool success, ) = proposal.target.call(proposal.callData);
                require(success, "Proposal execution failed");
            }

            // Burn all locked tokens
            uint256 tokensToBurn = _lockedTokens[proposalId];
            if (tokensToBurn > 0) {
                governanceToken.burn(tokensToBurn);
            }

            proposal.status = ProposalStatus.Executed;
            emit ProposalExecuted(proposalId);
        } else {
            // Proposal failed: RETURN locked tokens to voters
            proposal.status = ProposalStatus.Rejected;

            // Return tokens to proposer
            uint256 proposerTokens = _voterLockedTokens[proposalId][proposal.proposer];
            if (proposerTokens > 0) {
                require(
                    governanceToken.transfer(proposal.proposer, proposerTokens),
                    "Token return to proposer failed"
                );
            }

            // Return tokens to all voters
            address[] memory voters = _proposalVoters[proposalId];
            for (uint256 i = 0; i < voters.length; i++) {
                address voter = voters[i];
                uint256 voterTokens = _voterLockedTokens[proposalId][voter];
                if (voterTokens > 0 && voter != proposal.proposer) {
                    require(
                        governanceToken.transfer(voter, voterTokens),
                        "Token return to voter failed"
                    );
                }
            }
        }
    }
    
    /**
     * @dev Cancel a proposal (owner only)
     */
    function cancelProposal(uint256 proposalId) external onlyOwner {
        Proposal storage proposal = _proposals[proposalId];
        require(
            proposal.status == ProposalStatus.Active || proposal.status == ProposalStatus.Pending,
            "Cannot cancel proposal"
        );
        
        proposal.status = ProposalStatus.Cancelled;
        
        emit ProposalCancelled(proposalId);
    }
    
    /**
     * @dev Get proposal details
     */
    function getProposal(uint256 proposalId) external view returns (
        Proposal memory proposal,
        uint256 totalVotes,
        uint256 participationRate,
        bool canExecute
    ) {
        proposal = _proposals[proposalId];
        totalVotes = proposal.votesFor + proposal.votesAgainst;

        uint256 totalVotingPower = governanceToken.getTotalVotingPower();
        participationRate = totalVotingPower > 0 ? (totalVotes * 10000) / totalVotingPower : 0;

        // Check if proposal passed (≥51%)
        bool passed = totalVotes > 0 && (proposal.votesFor * 100 / totalVotes) >= 51;

        canExecute = proposal.status == ProposalStatus.Active &&
            block.timestamp > proposal.votingEnds &&
            passed;
    }

    /**
     * @dev Update proposal creation cost (governance-controlled)
     * @param newCost New cost in VGT tokens
     */
    function setProposalCreationCost(uint256 newCost) external onlyOwner {
        proposalCreationCost = newCost;
    }

    /**
     * @dev Update voting cost (governance-controlled)
     * @param newCost New cost in VGT tokens
     */
    function setVotingCost(uint256 newCost) external onlyOwner {
        votingCost = newCost;
    }

    /**
     * @dev Get locked tokens for a proposal
     * @param proposalId Proposal ID
     * @return Total locked tokens
     */
    function getLockedTokens(uint256 proposalId) external view returns (uint256) {
        return _lockedTokens[proposalId];
    }

    /**
     * @dev Get voter's locked tokens for a proposal
     * @param proposalId Proposal ID
     * @param voter Voter address
     * @return Locked tokens for this voter
     */
    function getVoterLockedTokens(uint256 proposalId, address voter) external view returns (uint256) {
        return _voterLockedTokens[proposalId][voter];
    }

    /**
     * @dev Set DynamicListManager contract address
     * @param _dynamicListManager DynamicListManager contract address
     */
    function setDynamicListManager(address _dynamicListManager) external onlyOwner {
        require(_dynamicListManager != address(0), "Invalid address");
        dynamicListManager = _dynamicListManager;
    }

    /**
     * @dev Internal function to execute list update
     * @param proposalId Proposal ID
     */
    function _executeListUpdate(uint256 proposalId) internal {
        require(dynamicListManager != address(0), "DynamicListManager not set");

        Proposal storage proposal = _proposals[proposalId];
        ListUpdateProposal storage listUpdate = listUpdateProposals[proposalId];

        // Import DynamicListManager interface
        (bool success, bytes memory returnData) = dynamicListManager.call(
            abi.encodeWithSignature(
                _getListUpdateFunctionSignature(proposal.proposalType),
                listUpdate.targetUser,
                listUpdate.targetIdentity,
                listUpdate.reason
            )
        );

        if (!success) {
            // If call failed, try to decode the error message
            if (returnData.length > 0) {
                // Bubble up the revert reason
                assembly {
                    let returndata_size := mload(returnData)
                    revert(add(32, returnData), returndata_size)
                }
            } else {
                revert("List update execution failed");
            }
        }
    }

    /**
     * @dev Get function signature for list update
     * @param proposalType Proposal type
     * @return Function signature string
     */
    function _getListUpdateFunctionSignature(ProposalType proposalType) internal pure returns (string memory) {
        if (proposalType == ProposalType.AddToWhitelist) {
            return "addToWhitelist(address,uint256,string)";
        } else if (proposalType == ProposalType.RemoveFromWhitelist) {
            return "removeFromWhitelist(address,uint256,string)";
        } else if (proposalType == ProposalType.AddToBlacklist) {
            return "addToBlacklist(address,uint256,string)";
        } else if (proposalType == ProposalType.RemoveFromBlacklist) {
            return "removeFromBlacklist(address,uint256,string)";
        } else {
            revert("Invalid proposal type");
        }
    }

    /**
     * @dev Create a list update proposal
     * @param proposalType Type of list update (AddToWhitelist, RemoveFromWhitelist, AddToBlacklist, RemoveFromBlacklist)
     * @param title Proposal title
     * @param description Proposal description
     * @param targetUser Target user address
     * @param targetIdentity Target user identity ID
     * @param reason Reason for the list update
     * @return proposalId The created proposal ID
     */
    function createListUpdateProposal(
        ProposalType proposalType,
        string calldata title,
        string calldata description,
        address targetUser,
        uint256 targetIdentity,
        string calldata reason
    ) external nonReentrant returns (uint256) {
        // Validate proposal type
        require(
            proposalType == ProposalType.AddToWhitelist ||
            proposalType == ProposalType.RemoveFromWhitelist ||
            proposalType == ProposalType.AddToBlacklist ||
            proposalType == ProposalType.RemoveFromBlacklist,
            "Invalid list update proposal type"
        );

        // Check KYC/AML verification
        require(identityRegistry.isVerified(msg.sender), "Must be KYC/AML verified");

        // Check proposer has enough tokens for creation cost
        require(
            governanceToken.balanceOf(msg.sender) >= proposalCreationCost,
            "Insufficient VGT balance for proposal creation"
        );

        // Transfer and lock proposal creation cost
        require(
            governanceToken.transferFrom(msg.sender, address(this), proposalCreationCost),
            "Token transfer failed"
        );

        // Create snapshot for voting
        uint256 snapshotId = governanceToken.snapshot();

        // Get thresholds for this proposal type
        ProposalThresholds memory thresholds = proposalThresholds[proposalType];

        // Create proposal
        uint256 proposalId = _nextProposalId++;
        _proposals[proposalId] = Proposal({
            id: proposalId,
            proposalType: proposalType,
            title: title,
            description: description,
            target: dynamicListManager,
            callData: "", // Will be constructed during execution
            proposer: msg.sender,
            createdAt: block.timestamp,
            votingEnds: block.timestamp + thresholds.votingPeriod,
            executionTime: 0,
            status: ProposalStatus.Active,
            votesFor: 0,
            votesAgainst: 0,
            snapshotId: snapshotId
        });

        // Store list update data
        listUpdateProposals[proposalId] = ListUpdateProposal({
            targetUser: targetUser,
            targetIdentity: targetIdentity,
            reason: reason
        });

        // Track locked tokens
        _lockedTokens[proposalId] = proposalCreationCost;
        _voterLockedTokens[proposalId][msg.sender] = proposalCreationCost;

        emit ProposalCreated(proposalId, msg.sender, proposalType, title, snapshotId);

        return proposalId;
    }
}

