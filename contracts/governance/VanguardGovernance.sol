// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./GovernanceProposals.sol";
import "../erc3643/interfaces/IIdentityRegistry.sol";
import "../erc3643/interfaces/IInvestorTypeRegistry.sol";

/**
 * @title VanguardGovernance
 * @dev Unified governance contract using GovernanceToken for voting
 * @notice Voting power is based on governance token ownership
 * @notice Only approved addresses (holding governance tokens) can vote
 */
contract VanguardGovernance is GovernanceProposals {
    /// @notice executeProposal refuses to run a passed proposal's target call
    ///         with less gas left than this (M1). Without it anyone could send
    ///         the call with just enough gas to reach the target, let the
    ///         target run out (it gets 63/64 of what is left), and settle a
    ///         PASSED proposal as Rejected, terminally.
    uint256 public constant MIN_EXECUTION_GAS = 3_000_000;

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
    /// @notice executeProposal: the passed proposal's target ran out of gas.
    ///         The proposal stays Active; retry with a higher gas limit.
    error InsufficientExecutionGas();
    
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
    ) Ownable(msg.sender) GovernanceConfig(_timeScale) {
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
        minVoterAge = 7 days / _timeScale;
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
        // A zero electorate makes the right-hand side 0, so ANY vote count
        // would clear quorum. That is never a legitimate pass: an electorate of
        // nobody cannot approve anything. Treat it as unmet, so the proposal
        // settles as Rejected and deposits are refunded.
        bool quorumMet = eligibleVoters > 0 &&
            totalVotes * 10000 >= eligibleVoters * thresholds.quorumPercentage;

        // Thresholds are basis points (2000 = 20%), so scale votes to match.
        // Guard the division: totalVotes == 0 means nobody voted, which is a
        // rejection, not a division by zero.
        bool approvalMet = totalVotes > 0 &&
            (proposal.votesFor * 10000) / totalVotes >= thresholds.approvalPercentage;

        bool passed = totalVotes > 0 && quorumMet && approvalMet;

        if (passed) {
            // Proposal passed: Execute and BURN locked tokens
            require(block.timestamp >= proposal.executionTime, "Execution delay not met");
            // Before any state change, so an under-gassed call reverts and
            // the proposal stays Active and executable (M1). The floor lets
            // eth_estimateGas land on a working limit for light targets.
            require(gasleft() >= MIN_EXECUTION_GAS, "Insufficient gas for execution");

            bytes memory data = proposal.callData;
            address target = proposal.target;
            uint256 gasBefore = gasleft();
            (bool success, bytes memory reason) = target.call(data);

            if (!success) {
                // OUT OF GAS IS NOT AN OUTCOME (L-1). EIP-150 gives the
                // target at most 63/64 of gasBefore, so a failed call that
                // leaves at most 1/63 of it ran the target out of gas: revert,
                // the proposal stays Active, and anyone retries with more gas.
                // This covers targets heavier than the floor (a 35-wallet
                // batchRegisterIdentity needs ~3.5M), both against a griefer
                // who under-gasses and an honest executor whose
                // eth_estimateGas used to return a limit the target ran out
                // at. Cost: a target that burns everything it is given now
                // reverts at every gas limit, and its deposits stay locked
                // until a rescue vote calls cancelProposal on it (reachable:
                // onlyOwner but not nonReentrant, see its comment).
                if (gasleft() <= gasBefore / 63) revert InsufficientExecutionGas();

                // A PASSED VOTE WHOSE TARGET CALL REVERTS IS AN OUTCOME.
                //
                // This used to revert (require(success)). That left the proposal Active with every deposit
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

            // The target call may have settled THIS proposal. A self-owned
            // governance cancels by vote through this very function, and a
            // proposal whose callData is cancelProposal(itself) re-enters
            // here: the inner call marks it Cancelled and zeroes the lock.
            // Stamping Executed over that would strand every deposit —
            // claimRefund only pays Rejected/Cancelled, and the lock is
            // already 0 so nothing burns. Honour the inner settlement.
            if (proposal.status != ProposalStatus.Active) {
                emit ProposalExecuted(proposalId);
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
     * @dev Cancel a proposal (owner only).
     *
     * Deliberately NOT nonReentrant. executeProposal holds the same lock, so a
     * self-owned governance — whose only way to call an onlyOwner function is
     * through executeProposal — could never reach this, leaving the emergency
     * brake permanently unreachable.
     *
     * Dropping the guard does open one re-entry: a proposal whose callData is
     * cancelProposal(itself). executeProposal handles that by re-reading the
     * status after the target call and honouring an inner settlement rather
     * than overwriting it with Executed. See the check before the burn.
     */
    function cancelProposal(uint256 proposalId) external onlyOwner {
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
}
