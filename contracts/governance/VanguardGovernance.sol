// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable2Step.sol";
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
contract VanguardGovernance is Ownable2Step, ReentrancyGuard {
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
        // Eligible-voter count captured when the proposal was created.
        //
        // Quorum previously read identityRegistry.registeredIdentityCount() at
        // EXECUTION time. Agents can register and delete identities while a
        // vote is open, so the denominator — and therefore the outcome of an
        // already-cast vote — could be changed after the fact: register
        // identities to push a proposal below quorum, or delete them to lift
        // it above. Freezing the count at creation makes the bar fixed for the
        // life of the proposal.
        uint256 eligibleVotersAtCreation;
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

    /// @notice Divisor applied to every proposal type's votingPeriod and
    ///         executionDelay at construction. 1 = the mainnet schedule.
    uint256 public immutable TIME_SCALE;

    // Economic parameters (governance-controlled)
    uint256 public proposalCreationCost = 10 * 10**18; // 10 VGT to create proposal
    uint256 public votingCost = 10 * 10**18; // 10 VGT per vote

    /// @dev Upper bound for both costs. Without it the owner could set a
    ///      cost above every holder's balance and freeze governance with
    ///      one call. 1000 VGT is 100x the default; the exact ceiling is a
    ///      product decision and only needs to block the freeze.
    uint256 public constant MAX_COST = 1000 * 10**18;

    // Token locking tracking.
    //
    // _lockedTokens is the aggregate: burned on pass, zeroed on settlement.
    // _voterLockedTokens is per person. While the proposal is Active it is
    // the deposit; once the proposal is Rejected or Cancelled it is the
    // amount that person may claim via claimRefund(). Settlement never
    // transfers VGT (see _settleWithRefund), so it cannot fail on a
    // recipient the token refuses to pay.
    mapping(uint256 => uint256) private _lockedTokens; // proposalId => total locked tokens
    mapping(uint256 => mapping(address => uint256)) private _voterLockedTokens; // proposalId => voter => locked amount
    
    // Events
    event ProposalCreated(
        uint256 indexed proposalId,
        address indexed proposer,
        ProposalType proposalType,
        string title
    );
    event VoteCast(
        uint256 indexed proposalId,
        address indexed voter,
        bool support,
        uint256 votingPower,
        string reason
    );
    event ProposalExecuted(uint256 indexed proposalId);
    /// @notice A passed proposal's target call reverted; deposits were refunded.
    /// @param reason Raw revert data from the target (selector + args, or a
    ///        reason string), preserved so the cause can be decoded off-chain.
    event ProposalExecutionFailed(uint256 indexed proposalId, bytes reason);
    /// @notice The proposal failed a threshold; deposits are claimable.
    event ProposalRejected(uint256 indexed proposalId);
    event ProposalCancelled(uint256 indexed proposalId);
    /// @notice A participant pulled their refund after settlement.
    event RefundClaimed(uint256 indexed proposalId, address indexed claimant, uint256 amount);
    event ProposalThresholdsUpdated(ProposalType indexed proposalType);
    event ProposalCreationCostUpdated(uint256 oldCost, uint256 newCost);

    error CostOutOfRange(uint256 requested, uint256 max);
    error TimeScaleOutOfRange(uint256 requested);
    event VotingCostUpdated(uint256 oldCost, uint256 newCost);
    
    /**
     * @dev Constructor
     */
    constructor(
        address _governanceToken,
        address _identityRegistry,
        address _investorTypeRegistry,
        address _complianceRules,
        address _oracleManager,
        address _token,
        uint256 _timeScale
    ) Ownable(msg.sender) {
        // Divides every voting period and execution delay. 1 on mainnet.
        // A testnet has no evm_increaseTime, so a 7-day vote would take
        // 7 days; scale 336 makes it 30 minutes. Percentages are untouched.
        if (_timeScale < 1 || _timeScale > 100_000) revert TimeScaleOutOfRange(_timeScale);
        TIME_SCALE = _timeScale;
        // Only the two parameters cast to contract types are checked here. The
        // rest are stored as plain addresses, so requiring code on them could
        // reject a legitimate configuration.
        require(_governanceToken != address(0), "VanguardGovernance: Governance token is zero address");
        require(
            _governanceToken.code.length > 0,
            "VanguardGovernance: Governance token is not a contract"
        );
        require(_identityRegistry != address(0), "VanguardGovernance: Identity registry is zero address");
        require(
            _identityRegistry.code.length > 0,
            "VanguardGovernance: Identity registry is not a contract"
        );

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
            votingPeriod: 7 days / TIME_SCALE,
            executionDelay: 2 days / TIME_SCALE
        });
        
        // ComplianceRules: 25% quorum, 65% approval, 7 days voting, 2 days delay
        proposalThresholds[ProposalType.ComplianceRules] = ProposalThresholds({
            quorumPercentage: 2500,
            approvalPercentage: 6500,
            votingPeriod: 7 days / TIME_SCALE,
            executionDelay: 2 days / TIME_SCALE
        });
        
        // OracleParameters: 20% quorum, 60% approval, 7 days voting, 2 days delay
        proposalThresholds[ProposalType.OracleParameters] = ProposalThresholds({
            quorumPercentage: 2000,
            approvalPercentage: 6000,
            votingPeriod: 7 days / TIME_SCALE,
            executionDelay: 2 days / TIME_SCALE
        });
        
        // TokenParameters: 30% quorum, 70% approval, 7 days voting, 3 days delay
        proposalThresholds[ProposalType.TokenParameters] = ProposalThresholds({
            quorumPercentage: 3000,
            approvalPercentage: 7000,
            votingPeriod: 7 days / TIME_SCALE,
            executionDelay: 3 days / TIME_SCALE
        });
        
        // SystemParameters: 25% quorum, 65% approval, 7 days voting, 2 days delay
        proposalThresholds[ProposalType.SystemParameters] = ProposalThresholds({
            quorumPercentage: 2500,
            approvalPercentage: 6500,
            votingPeriod: 7 days / TIME_SCALE,
            executionDelay: 2 days / TIME_SCALE
        });
        
        // EmergencyAction: 10% quorum, 75% approval, 3 days voting, 1 day delay
        proposalThresholds[ProposalType.EmergencyAction] = ProposalThresholds({
            quorumPercentage: 1000,
            approvalPercentage: 7500,
            votingPeriod: 3 days / TIME_SCALE,
            executionDelay: 1 days / TIME_SCALE
        });

        // AddToWhitelist: 15% quorum, 60% approval, 5 days voting, 1 day delay
        proposalThresholds[ProposalType.AddToWhitelist] = ProposalThresholds({
            quorumPercentage: 1500,
            approvalPercentage: 6000,
            votingPeriod: 5 days / TIME_SCALE,
            executionDelay: 1 days / TIME_SCALE
        });

        // RemoveFromWhitelist: 15% quorum, 60% approval, 5 days voting, 1 day delay
        proposalThresholds[ProposalType.RemoveFromWhitelist] = ProposalThresholds({
            quorumPercentage: 1500,
            approvalPercentage: 6000,
            votingPeriod: 5 days / TIME_SCALE,
            executionDelay: 1 days / TIME_SCALE
        });

        // AddToBlacklist: 20% quorum, 70% approval, 5 days voting, 1 day delay
        proposalThresholds[ProposalType.AddToBlacklist] = ProposalThresholds({
            quorumPercentage: 2000,
            approvalPercentage: 7000,
            votingPeriod: 5 days / TIME_SCALE,
            executionDelay: 1 days / TIME_SCALE
        });

        // RemoveFromBlacklist: 20% quorum, 65% approval, 5 days voting, 1 day delay
        proposalThresholds[ProposalType.RemoveFromBlacklist] = ProposalThresholds({
            quorumPercentage: 2000,
            approvalPercentage: 6500,
            votingPeriod: 5 days / TIME_SCALE,
            executionDelay: 1 days / TIME_SCALE
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
            eligibleVotersAtCreation: identityRegistry.registeredIdentityCount()
        });

        // Track locked tokens
        _lockedTokens[proposalId] = proposalCreationCost;
        _voterLockedTokens[proposalId][msg.sender] = proposalCreationCost;

        emit ProposalCreated(proposalId, msg.sender, proposalType, title);

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
     * @dev Settle a proposal after its voting period.
     * @notice Passes (quorum and approval for its type met, target call
     *         succeeds): locked tokens are burned. Fails a threshold, or the
     *         target call reverts: the proposal is closed and every
     *         participant's deposit becomes claimable via claimRefund().
     */
    function executeProposal(uint256 proposalId) external nonReentrant {
        Proposal storage proposal = _proposals[proposalId];

        require(proposal.status == ProposalStatus.Active, "Proposal not active");
        require(block.timestamp > proposal.votingEnds, "Voting period not ended");

        uint256 totalVotes = proposal.votesFor + proposal.votesAgainst;

        // Enforce the quorum and approval thresholds configured for this
        // proposal type. Previously both were ignored: the check was a
        // hardcoded 51% of votes cast, so a single voter was a 100% approval
        // and could execute an arbitrary target.call(callData) below.
        ProposalThresholds memory thresholds = proposalThresholds[proposal.proposalType];

        // FAILING A THRESHOLD IS AN OUTCOME, NOT AN INVALID CALL.
        //
        // Quorum and "no votes cast" were both `require`s, which revert BEFORE
        // the rejection branch below — the branch that returns every voter's
        // and the proposer's locked VGT. A proposal with low turnout could
        // therefore never be settled, and its deposits were trapped forever.
        // That fires on the ordinary path: any proposal nobody bothers to vote
        // on locked the proposer's stake permanently.
        //
        // Both are now folded into `passed`, so a failing proposal takes the
        // refund branch and is marked Rejected. Only genuinely invalid calls
        // (wrong status, voting still open) still revert.
        //
        // Quorum is a share of ELIGIBLE VOTERS, not of token supply: votes are
        // counted one per verified person (votesFor += 1), so the denominator
        // is the registered identity count — FROZEN AT CREATION, so that
        // registering or deleting identities mid-vote cannot move the bar for
        // a proposal already being voted on.
        uint256 eligibleVoters = proposal.eligibleVotersAtCreation;
        bool quorumMet = totalVotes * 10000 >= eligibleVoters * thresholds.quorumPercentage;

        // Thresholds are basis points (2000 = 20%), so scale votes to match.
        // Guard the division: totalVotes == 0 means nobody voted, which is a
        // rejection, not a division by zero.
        bool approvalMet = totalVotes > 0 &&
            (proposal.votesFor * 10000) / totalVotes >= thresholds.approvalPercentage;

        bool passed = totalVotes > 0 && quorumMet && approvalMet;

        if (passed) {
            // Proposal passed: Execute and BURN locked tokens
            require(block.timestamp >= proposal.executionTime, "Execution delay not met");

            bool success;
            bytes memory reason;
            if (proposal.proposalType == ProposalType.AddToWhitelist ||
                proposal.proposalType == ProposalType.RemoveFromWhitelist ||
                proposal.proposalType == ProposalType.AddToBlacklist ||
                proposal.proposalType == ProposalType.RemoveFromBlacklist) {
                (success, reason) = _executeListUpdate(proposalId);
            } else {
                (success, reason) = proposal.target.call(proposal.callData);
            }

            if (!success) {
                // A PASSED VOTE WHOSE TARGET CALL REVERTS IS AN OUTCOME.
                //
                // Both branches used to revert here (require(success) on
                // the regular path; the list path re-raised the manager's
                // revert). That left the proposal Active with every deposit
                // locked and no path out: re-executing hit the same revert,
                // and a rescue vote calling cancelProposal() also reverted
                // because executeProposal and cancelProposal share one
                // reentrancy lock, and OpenZeppelin's guard refuses
                // guarded-calls-guarded.
                //
                // Settle it instead: Rejected, deposits claimable, and log
                // the target's revert data so the failure is diagnosable.
                // This makes a failed execution terminal rather than
                // retryable; the proposer submits a new proposal.
                _settleWithRefund(proposalId, ProposalStatus.Rejected);
                emit ProposalExecutionFailed(proposalId, reason);
                return;
            }

            // Burn all locked tokens
            uint256 tokensToBurn = _lockedTokens[proposalId];
            if (tokensToBurn > 0) {
                governanceToken.burn(tokensToBurn);
            }

            proposal.status = ProposalStatus.Executed;
            emit ProposalExecuted(proposalId);
        } else {
            _settleWithRefund(proposalId, ProposalStatus.Rejected);
            emit ProposalRejected(proposalId);
        }
    }

    /**
     * @dev Close a proposal without burning: set the terminal status and zero
     *      the aggregate lock. Per-person deposits in _voterLockedTokens are
     *      left in place and become claimable through claimRefund().
     *
     *      PULL, NOT PUSH. The previous helper transferred VGT to the
     *      proposer and every voter inside settlement. Each VGT transfer
     *      runs the token's compliance gate, so a single recipient the token
     *      refused to pay (identity deleted, address frozen) reverted the
     *      whole settlement and left EVERY participant's deposit locked
     *      with no path out. Reproduced for the reject branch, the cancel
     *      path and the execution-failure path. Recording claims instead
     *      means settlement has no external call and cannot be blocked;
     *      an unpayable participant blocks only their own claim, until
     *      they are payable again.
     */
    function _settleWithRefund(uint256 proposalId, ProposalStatus terminal) internal {
        _proposals[proposalId].status = terminal;
        _lockedTokens[proposalId] = 0;
    }

    /**
     * @notice Pull your deposit from a Rejected or Cancelled proposal.
     * @dev Anyone with a recorded deposit may call. Once. The slot is zeroed
     *      before the transfer (checks-effects-interactions); the guard is
     *      belt and braces against a token that re-enters on transfer.
     */
    function claimRefund(uint256 proposalId) external nonReentrant {
        ProposalStatus status = _proposals[proposalId].status;
        require(
            status == ProposalStatus.Rejected || status == ProposalStatus.Cancelled,
            "Proposal not settled"
        );
        uint256 amount = _voterLockedTokens[proposalId][msg.sender];
        require(amount > 0, "Nothing to claim");
        _voterLockedTokens[proposalId][msg.sender] = 0;
        require(governanceToken.transfer(msg.sender, amount), "Refund transfer failed");
        emit RefundClaimed(proposalId, msg.sender, amount);
    }

    /**
     * @notice VGT `account` may still pull from `proposalId`. Zero while the
     *         proposal is Active (deposit not yet claimable), after a claim,
     *         or on a proposal that passed (deposits were burned).
     */
    function getClaimableRefund(uint256 proposalId, address account) external view returns (uint256) {
        ProposalStatus status = _proposals[proposalId].status;
        if (status != ProposalStatus.Rejected && status != ProposalStatus.Cancelled) return 0;
        return _voterLockedTokens[proposalId][account];
    }
    
    /**
     * @dev Cancel a proposal (owner only)
     */
    function cancelProposal(uint256 proposalId) external onlyOwner nonReentrant {
        Proposal storage proposal = _proposals[proposalId];
        require(
            proposal.status == ProposalStatus.Active || proposal.status == ProposalStatus.Pending,
            "Cannot cancel proposal"
        );
        
        _settleWithRefund(proposalId, ProposalStatus.Cancelled);

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

        // Turnout is a share of ELIGIBLE VOTERS. Votes are counted one per
        // verified person (votesFor += 1), so the denominator must be the
        // registered identity count. It was previously getTotalVotingPower()
        // (== totalSupply(), in wei), which made this a headcount divided by
        // a wei amount: with 1e24 wei supply the result was always 0.
        //
        // Read the SNAPSHOT, not the live count — the same value
        // executeProposal uses. Reading live here would let this view drift
        // from enforcement as identities are added or removed, which is the
        // advisory/enforcement divergence this function was fixed for once
        // already.
        uint256 eligibleVoters = proposal.eligibleVotersAtCreation;
        participationRate = eligibleVoters > 0 ? (totalVotes * 10000) / eligibleVoters : 0;

        // This is the ADVISORY view a UI reads. It applies the same gates as
        // executeProposal, so the two cannot disagree. It previously used a
        // hardcoded 51% of votes cast and no quorum at all, while execution
        // enforced the per-type thresholds.
        //
        // canExecute means "this proposal will PASS and run its callData". It
        // does NOT mean "executeProposal will revert otherwise": a proposal
        // that fails quorum or approval executes successfully via the refund
        // branch and is marked Rejected. A UI must therefore keep offering the
        // call when canExecute is false, or locked VGT can never be reclaimed.
        ProposalThresholds memory thresholds = proposalThresholds[proposal.proposalType];

        bool quorumMet = totalVotes * 10000 >= eligibleVoters * thresholds.quorumPercentage;
        bool approved = totalVotes > 0 &&
            (proposal.votesFor * 10000) / totalVotes >= thresholds.approvalPercentage;

        canExecute = proposal.status == ProposalStatus.Active &&
            block.timestamp > proposal.votingEnds &&
            block.timestamp >= proposal.executionTime &&
            totalVotes > 0 &&
            quorumMet &&
            approved;
    }

    /**
     * @dev Update proposal creation cost (governance-controlled)
     * @param newCost New cost in VGT tokens
     */
    function setProposalCreationCost(uint256 newCost) external onlyOwner {
        if (newCost == 0 || newCost > MAX_COST) revert CostOutOfRange(newCost, MAX_COST);
        emit ProposalCreationCostUpdated(proposalCreationCost, newCost);
        proposalCreationCost = newCost;
    }

    /**
     * @dev Update voting cost (governance-controlled)
     * @param newCost New cost in VGT tokens
     */
    function setVotingCost(uint256 newCost) external onlyOwner {
        if (newCost == 0 || newCost > MAX_COST) revert CostOutOfRange(newCost, MAX_COST);
        emit VotingCostUpdated(votingCost, newCost);
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
    /**
     * @dev Call the list manager for a list-update proposal and report the
     *      outcome. Does NOT revert on a failed call: the caller settles the
     *      proposal and logs `reason`, exactly as for a regular target call.
     *
     *      An unset manager is different in kind. Nothing was voted on that
     *      could ever succeed, and the owner can fix it with
     *      setDynamicListManager, so that case stays a revert and the
     *      proposal stays Active: retryable once wired.
     */
    function _executeListUpdate(uint256 proposalId)
        internal
        returns (bool success, bytes memory reason)
    {
        require(dynamicListManager != address(0), "DynamicListManager not set");

        Proposal storage proposal = _proposals[proposalId];
        ListUpdateProposal storage listUpdate = listUpdateProposals[proposalId];

        (success, reason) = dynamicListManager.call(
            abi.encodeWithSignature(
                _getListUpdateFunctionSignature(proposal.proposalType),
                listUpdate.targetUser,
                listUpdate.targetIdentity,
                listUpdate.reason
            )
        );
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
            eligibleVotersAtCreation: identityRegistry.registeredIdentityCount()
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

        emit ProposalCreated(proposalId, msg.sender, proposalType, title);

        return proposalId;
    }
}

