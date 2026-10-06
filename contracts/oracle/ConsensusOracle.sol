// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "./interfaces/IOracleManager.sol";

/**
 * @title ConsensusOracle
 * @notice The weighted consensus engine of one OracleManager (plan v2 Task
 *         4.4, D11 = a). It has no owner and no front door: the manager it
 *         is bound to at construction opens every query, records every vote
 *         and sets every parameter (governance after the handover, through
 *         the manager). The name is kept from before 4.4, when this was a
 *         second, standalone weighted-vote oracle that nothing read.
 *
 * The one rule: when a query opens the engine snapshots the total weight of
 * the manager's ACTIVE nodes (a node without a weight counts
 * DEFAULT_ORACLE_WEIGHT). Each vote counts the voter's weight at cast time.
 * YES resolves when yesWeight * 100 >= snapshotWeight * consensusThreshold,
 * NO symmetrically; the threshold is a percent in (50, 100], so both sides
 * can never resolve and a 1-1 split of three equal nodes resolves nothing.
 * A query expires `queryExpiryTime` after it opened: later votes are
 * refused and it closes without a verdict (a new query must be raised).
 */
contract ConsensusOracle {
    /// @notice Every write comes from the bound OracleManager.
    error OnlyOracleManager();
    error QueryExists();
    error UnknownQuery();
    error QueryResolved();
    error QueryExpired();
    error AlreadyVoted();
    /// @notice No active node, so no weight to snapshot: fail closed.
    error NoActiveWeight();
    error InvalidThreshold();
    error InvalidWeight();
    error InvalidExpiry();

    struct ConsensusQuery {
        uint256 openedAt;
        uint256 expiresAt;
        uint256 snapshotWeight;
        uint256 yesWeight;
        uint256 noWeight;
        bool resolved;
        bool result;
        mapping(address => bool) hasVoted;
        mapping(address => bool) votes;
        address[] voters;
    }

    uint256 public constant DEFAULT_ORACLE_WEIGHT = 100;
    uint256 public constant MAX_ORACLE_WEIGHT = 1000;
    uint256 public constant MIN_EXPIRY = 10 minutes;
    uint256 public constant MAX_EXPIRY = 24 hours;

    /// @notice The manager this engine serves; fixed at construction.
    IOracleManager public immutable oracleManager;

    /// @notice Percent of the snapshot weight one side needs, in (50, 100].
    ///         66 makes two of three equal nodes a verdict (200/300 = 66.7%);
    ///         67 would need all three.
    uint256 public consensusThreshold = 66;
    uint256 public queryExpiryTime = 1 hours;
    /// @notice Explicit node weight; 0 means DEFAULT_ORACLE_WEIGHT.
    mapping(address => uint256) public oracleWeights;

    mapping(bytes32 => ConsensusQuery) private _queries;

    event ConsensusQueryCreated(bytes32 indexed queryId, uint256 snapshotWeight, uint256 expiresAt);
    event ConsensusVoteSubmitted(bytes32 indexed queryId, address indexed oracle, bool vote, uint256 weight);
    event ConsensusReached(
        bytes32 indexed queryId,
        bool result,
        uint256 yesWeight,
        uint256 noWeight,
        uint256 snapshotWeight,
        uint256 timestamp
    );
    event OracleWeightUpdated(address indexed oracle, uint256 oldWeight, uint256 newWeight);
    event ConsensusThresholdUpdated(uint256 oldThreshold, uint256 newThreshold);
    event QueryExpiryTimeUpdated(uint256 oldExpiry, uint256 newExpiry);

    modifier onlyOracleManager() {
        if (msg.sender != address(oracleManager)) revert OnlyOracleManager();
        _;
    }

    constructor(address _oracleManager) {
        require(_oracleManager.code.length > 0, "ConsensusOracle: Oracle manager is not a contract");
        oracleManager = IOracleManager(_oracleManager);
    }

    /// @notice Open `queryId` and snapshot the active weight (manager only).
    function openQuery(bytes32 queryId) external onlyOracleManager {
        ConsensusQuery storage q = _queries[queryId];
        if (q.openedAt != 0) revert QueryExists();
        uint256 snapshot = activeWeight();
        if (snapshot == 0) revert NoActiveWeight();
        q.openedAt = block.timestamp;
        q.expiresAt = block.timestamp + queryExpiryTime;
        q.snapshotWeight = snapshot;
        emit ConsensusQueryCreated(queryId, snapshot, q.expiresAt);
    }

    /**
     * @notice Record `voter`'s vote (manager only; the manager has checked the
     *         voter is an active node). Returns the verdict once it resolves.
     */
    function recordVote(
        bytes32 queryId,
        address voter,
        bool vote
    ) external onlyOracleManager returns (bool resolved, bool result) {
        ConsensusQuery storage q = _queries[queryId];
        if (q.openedAt == 0) revert UnknownQuery();
        if (q.resolved) revert QueryResolved();
        if (block.timestamp >= q.expiresAt) revert QueryExpired();
        if (q.hasVoted[voter]) revert AlreadyVoted();

        uint256 weight = weightOf(voter);
        q.hasVoted[voter] = true;
        q.votes[voter] = vote;
        q.voters.push(voter);
        if (vote) q.yesWeight += weight;
        else q.noWeight += weight;
        emit ConsensusVoteSubmitted(queryId, voter, vote, weight);

        uint256 bar = q.snapshotWeight * consensusThreshold;
        if (q.yesWeight * 100 >= bar) {
            q.resolved = true;
            q.result = true;
        } else if (q.noWeight * 100 >= bar) {
            q.resolved = true;
        }
        if (q.resolved) {
            emit ConsensusReached(queryId, q.result, q.yesWeight, q.noWeight, q.snapshotWeight, block.timestamp);
        }
        return (q.resolved, q.result);
    }

    function setConsensusThreshold(uint256 percent) external onlyOracleManager {
        if (percent <= 50 || percent > 100) revert InvalidThreshold();
        emit ConsensusThresholdUpdated(consensusThreshold, percent);
        consensusThreshold = percent;
    }

    /// @notice 1..MAX_ORACLE_WEIGHT, or 0 to fall back to the default.
    function setOracleWeight(address oracle, uint256 weight) external onlyOracleManager {
        if (weight > MAX_ORACLE_WEIGHT) revert InvalidWeight();
        emit OracleWeightUpdated(oracle, oracleWeights[oracle], weight);
        oracleWeights[oracle] = weight;
    }

    function setQueryExpiryTime(uint256 expiry) external onlyOracleManager {
        if (expiry < MIN_EXPIRY || expiry > MAX_EXPIRY) revert InvalidExpiry();
        emit QueryExpiryTimeUpdated(queryExpiryTime, expiry);
        queryExpiryTime = expiry;
    }

    /// @notice A node's weight whether or not it is active.
    function weightOf(address oracle) public view returns (uint256) {
        uint256 w = oracleWeights[oracle];
        return w > 0 ? w : DEFAULT_ORACLE_WEIGHT;
    }

    /// @notice A node's voting weight now: 0 unless it is active.
    function getOracleWeight(address oracle) external view returns (uint256) {
        return oracleManager.isActiveOracle(oracle) ? weightOf(oracle) : 0;
    }

    /// @notice Total weight of the manager's active nodes now.
    function activeWeight() public view returns (uint256 total) {
        address[] memory active = oracleManager.getActiveOracles();
        for (uint256 i = 0; i < active.length; i++) total += weightOf(active[i]);
    }

    /// @notice True when `weight` meets the threshold against the live active
    ///         total (OracleManager.validateOracleConsensus); false with none.
    function meetsThreshold(uint256 weight) external view returns (bool) {
        uint256 total = activeWeight();
        return total > 0 && weight * 100 >= total * consensusThreshold;
    }

    /**
     * @notice A query's tally. `expired` is true once votes are refused
     *         without a verdict; positive/negative are weights.
     */
    function getConsensusResult(
        bytes32 queryId
    )
        external
        view
        returns (
            bool isResolved,
            bool result,
            uint256 positiveVotes,
            uint256 negativeVotes,
            uint256 snapshotWeight,
            uint256 expiresAt,
            bool expired
        )
    {
        ConsensusQuery storage q = _queries[queryId];
        return (
            q.resolved,
            q.result,
            q.yesWeight,
            q.noWeight,
            q.snapshotWeight,
            q.expiresAt,
            q.openedAt != 0 && !q.resolved && block.timestamp >= q.expiresAt
        );
    }

    function getQueryVoters(bytes32 queryId) external view returns (address[] memory) {
        return _queries[queryId].voters;
    }

    /// @notice (voted, vote) of `oracle` on `queryId`.
    function getVote(bytes32 queryId, address oracle) external view returns (bool voted, bool vote) {
        ConsensusQuery storage q = _queries[queryId];
        return (q.hasVoted[oracle], q.votes[oracle]);
    }
}
