// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

/**
 * @title IDisputeResolver
 * @dev Interface for oracle-mediated dispute resolution in payment system
 */
interface IDisputeResolver {
    // Dispute states
    enum DisputeState {
        Filed, // Dispute filed, awaiting oracle review
        UnderReview, // Oracle reviewing evidence
        Resolved, // Dispute resolved by oracle consensus
        Appealed, // Dispute appealed for higher review
        Closed // Dispute closed (final)
    }

    // Dispute outcomes
    enum DisputeOutcome {
        Pending, // No decision yet
        FavorPayer, // Oracle rules in favor of payer (refund)
        FavorPayee, // Oracle rules in favor of payee (no refund)
        PartialRefund, // Partial refund awarded
        Escalated // Escalated to higher authority
    }

    // Dispute structure
    struct Dispute {
        uint256 disputeId;
        uint256 paymentId;
        address disputer;
        address respondent;
        DisputeState state;
        DisputeOutcome outcome;
        string reason;
        bytes32 evidenceHash;
        uint256 filedAt;
        uint256 reviewDeadline;
        uint256 resolvedAt;
        uint256 refundAmount;
        address[] assignedOracles;
        mapping(address => bool) oracleVotes;
        mapping(address => bool) oracleVoted;
        uint256 votesForPayer;
        uint256 votesForPayee;
    }

    // Events
    event DisputeFiled(
        uint256 indexed disputeId,
        uint256 indexed paymentId,
        address indexed disputer,
        address respondent,
        string reason
    );

    event DisputeAssigned(uint256 indexed disputeId, address[] oracles, uint256 reviewDeadline);

    event OracleVoteSubmitted(uint256 indexed disputeId, address indexed oracle, bool favorsPayer, string reasoning);

    event DisputeResolved(uint256 indexed disputeId, DisputeOutcome outcome, uint256 refundAmount, uint256 timestamp);

    event DisputeAppealed(uint256 indexed disputeId, address indexed appellant, string reason);

    event DisputeClosed(uint256 indexed disputeId, uint256 timestamp);

    // Core functions
    function fileDispute(
        uint256 paymentId,
        string calldata reason,
        bytes32 evidenceHash
    ) external returns (uint256 disputeId);

    function submitOracleVote(uint256 disputeId, bool favorsPayer, string calldata reasoning) external;

    function resolveDispute(uint256 disputeId) external;

    function appealDispute(uint256 disputeId, string calldata reason) external;

    function closeDispute(uint256 disputeId) external;

    function emergencyResolve(uint256 disputeId, DisputeOutcome outcome, uint256 refundAmount) external;

    // View functions
    function getDispute(
        uint256 disputeId
    )
        external
        view
        returns (
            uint256 disputeId_,
            uint256 paymentId,
            address disputer,
            address respondent,
            DisputeState state,
            DisputeOutcome outcome,
            string memory reason,
            bytes32 evidenceHash,
            uint256 filedAt,
            uint256 reviewDeadline,
            uint256 resolvedAt,
            uint256 refundAmount
        );

    function getDisputesByPayment(uint256 paymentId) external view returns (uint256[] memory);

    function getDisputesByDisputer(address disputer) external view returns (uint256[] memory);

    function canFileDispute(uint256 paymentId, address disputer) external view returns (bool);

    function isDisputeExpired(uint256 disputeId) external view returns (bool);

    function getAssignedOracles(uint256 disputeId) external view returns (address[] memory);

    function hasOracleVoted(uint256 disputeId, address oracle) external view returns (bool);

    function getVoteCounts(uint256 disputeId) external view returns (uint256 forPayer, uint256 forPayee);
}
