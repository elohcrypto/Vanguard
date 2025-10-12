// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import "./interfaces/IOracle.sol";
import "./interfaces/IOracleManager.sol";

/**
 * @title ConsensusOracle
 * @dev Oracle contract implementing M-of-N consensus mechanism for oracle attestations
 */
contract ConsensusOracle is IOracle, Ownable, ReentrancyGuard, Pausable {
    using ECDSA for bytes32;

    struct ConsensusQuery {
        bytes32 queryId;
        address subject;
        uint8 queryType;
        bytes data;
        uint256 timestamp;
        uint256 expiryTime;
        bool isResolved;
        bool consensusResult;
        uint256 positiveVotes;
        uint256 negativeVotes;
        uint256 totalVotes;
        mapping(address => bool) hasVoted;
        mapping(address => bool) votes;
        address[] voters;
    }

    struct OracleWeight {
        uint256 weight;
        uint256 reputation;
        bool isActive;
    }

    struct Attestation {
        address subject;
        bool result;
        uint256 timestamp;
        bytes signature;
        bool isValid;
        uint256 weight;
    }

    // State variables
    IOracleManager public oracleManager;
    mapping(bytes32 => ConsensusQuery) public consensusQueries;
    mapping(address => OracleWeight) public oracleWeights;
    mapping(bytes32 => Attestation) public attestations;

    string public oracleName;
    string public oracleDescription;
    bool public active;
    uint256 public totalAttestations;
    uint256 public correctAttestations;

    // Consensus configuration
    uint256 public consensusThreshold = 66; // 66% threshold for consensus
    uint256 public minimumOracles = 3;
    uint256 public maximumOracles = 21;
    uint256 public queryExpiryTime = 1 hours;
    uint256 public defaultOracleWeight = 100;

    // Query types
    uint8 public constant QUERY_TYPE_WHITELIST = 1;
    uint8 public constant QUERY_TYPE_BLACKLIST = 2;
    uint8 public constant QUERY_TYPE_IDENTITY = 3;
    uint8 public constant QUERY_TYPE_COMPLIANCE = 4;
    uint8 public constant QUERY_TYPE_REPUTATION = 5;

    // Events
    event ConsensusQueryCreated(
        bytes32 indexed queryId,
        address indexed subject,
        uint8 queryType,
        uint256 timestamp,
        uint256 expiryTime
    );

    event ConsensusVoteSubmitted(
        bytes32 indexed queryId,
        address indexed oracle,
        bool vote,
        uint256 weight,
        uint256 timestamp
    );

    event ConsensusReached(
        bytes32 indexed queryId,
        bool result,
        uint256 positiveVotes,
        uint256 negativeVotes,
        uint256 totalWeight,
        uint256 timestamp
    );

    event OracleWeightUpdated(address indexed oracle, uint256 oldWeight, uint256 newWeight);
    event ConsensusThresholdUpdated(uint256 oldThreshold, uint256 newThreshold);

    modifier onlyOracleManager() {
        require(msg.sender == address(oracleManager), "ConsensusOracle: Only oracle manager");
        _;
    }

    modifier onlyWhenActive() {
        require(active, "ConsensusOracle: Oracle not active");
        _;
    }

    modifier onlyActiveOracle() {
        require(oracleManager.isActiveOracle(msg.sender), "ConsensusOracle: Not an active oracle");
        _;
    }

    constructor(address _oracleManager, string memory _name, string memory _description) Ownable(msg.sender) {
        require(_oracleManager != address(0), "ConsensusOracle: Invalid oracle manager");

        oracleManager = IOracleManager(_oracleManager);
        oracleName = _name;
        oracleDescription = _description;
        active = true;
        totalAttestations = 0;
        correctAttestations = 0;
    }

    /**
     * @dev Create a new consensus query
     */
    function createConsensusQuery(
        address _subject,
        uint8 _queryType,
        bytes calldata _data
    ) external onlyWhenActive returns (bytes32 queryId) {
        require(_subject != address(0), "ConsensusOracle: Invalid subject");
        require(_queryType >= 1 && _queryType <= 5, "ConsensusOracle: Invalid query type");

        queryId = keccak256(abi.encodePacked(_subject, _queryType, _data, block.timestamp, msg.sender));

        ConsensusQuery storage query = consensusQueries[queryId];
        query.queryId = queryId;
        query.subject = _subject;
        query.queryType = _queryType;
        query.data = _data;
        query.timestamp = block.timestamp;
        query.expiryTime = block.timestamp + queryExpiryTime;
        query.isResolved = false;
        query.consensusResult = false;
        query.positiveVotes = 0;
        query.negativeVotes = 0;
        query.totalVotes = 0;

        emit ConsensusQueryCreated(queryId, _subject, _queryType, block.timestamp, query.expiryTime);
        return queryId;
    }

    /**
     * @dev Submit vote for consensus query
     */
    function submitVote(
        bytes32 _queryId,
        bool _vote,
        bytes calldata _signature
    ) external onlyActiveOracle onlyWhenActive nonReentrant {
        ConsensusQuery storage query = consensusQueries[_queryId];
        require(query.timestamp > 0, "ConsensusOracle: Query does not exist");
        require(block.timestamp < query.expiryTime, "ConsensusOracle: Query expired");
        require(!query.isResolved, "ConsensusOracle: Query already resolved");
        require(!query.hasVoted[msg.sender], "ConsensusOracle: Oracle already voted");

        // Verify signature
        require(verifySignature(query.subject, _queryId, _vote, _signature), "ConsensusOracle: Invalid signature");

        // Get oracle weight
        uint256 weight = getOracleWeight(msg.sender);
        require(weight > 0, "ConsensusOracle: Oracle has no weight");

        // Record vote
        query.hasVoted[msg.sender] = true;
        query.votes[msg.sender] = _vote;
        query.voters.push(msg.sender);
        query.totalVotes += weight;

        if (_vote) {
            query.positiveVotes += weight;
        } else {
            query.negativeVotes += weight;
        }

        emit ConsensusVoteSubmitted(_queryId, msg.sender, _vote, weight, block.timestamp);

        // Check if consensus is reached
        _checkConsensus(_queryId);
    }

    /**
     * @dev Provide attestation (implements IOracle interface)
     */
    function provideAttestation(
        address _subject,
        bytes32 _queryId,
        bool _result,
        bytes calldata _signature,
        bytes calldata /* _data */
    ) external override onlyWhenActive nonReentrant {
        require(_subject != address(0), "ConsensusOracle: Invalid subject");
        require(oracleManager.isActiveOracle(msg.sender), "ConsensusOracle: Not an active oracle");

        // Verify signature
        require(verifySignature(_subject, _queryId, _result, _signature), "ConsensusOracle: Invalid signature");

        // Get oracle weight
        uint256 weight = getOracleWeight(msg.sender);

        // Store attestation
        attestations[_queryId] = Attestation({
            subject: _subject,
            result: _result,
            timestamp: block.timestamp,
            signature: _signature,
            isValid: true,
            weight: weight
        });

        totalAttestations++;

        emit AttestationProvided(msg.sender, _subject, _queryId, _result, block.timestamp, _signature);
    }

    /**
     * @dev Get attestation information
     */
    function getAttestation(
        address /* _subject */,
        bytes32 _queryId
    )
        external
        view
        override
        returns (bool result, uint256 timestamp, address oracle, bytes memory signature, bool isValid)
    {
        Attestation storage attestation = attestations[_queryId];
        return (attestation.result, attestation.timestamp, msg.sender, attestation.signature, attestation.isValid);
    }

    /**
     * @dev Check if oracle is active
     */
    function isActive() external view override returns (bool) {
        return active;
    }

    /**
     * @dev Get oracle reputation
     */
    function getReputation() external view override returns (uint256) {
        return oracleWeights[address(this)].reputation;
    }

    /**
     * @dev Get oracle information
     */
    function getOracleInfo()
        external
        view
        override
        returns (
            address oracleAddress,
            string memory name,
            string memory description,
            uint256 reputation,
            bool oracleActive,
            uint256 totalAttestationsCount
        )
    {
        return (
            address(this),
            oracleName,
            oracleDescription,
            oracleWeights[address(this)].reputation,
            active,
            totalAttestations
        );
    }

    /**
     * @dev Set oracle active status
     */
    function setActive(bool _active) external override onlyOwner {
        active = _active;
        emit OracleStatusChanged(address(this), _active);
    }

    /**
     * @dev Update oracle reputation
     */
    function updateReputation(uint256 _reputation) external override onlyOracleManager {
        oracleWeights[address(this)].reputation = _reputation;
        emit OracleReputationUpdated(address(this), _reputation);
    }

    /**
     * @dev Verify signature for attestation
     */
    function verifySignature(
        address _subject,
        bytes32 _queryId,
        bool _result,
        bytes calldata _signature
    ) public view override returns (bool) {
        bytes32 messageHash = keccak256(abi.encodePacked(_subject, _queryId, _result, block.chainid));
        bytes32 ethSignedMessageHash = MessageHashUtils.toEthSignedMessageHash(messageHash);

        address signer = ECDSA.recover(ethSignedMessageHash, _signature);
        return oracleManager.isActiveOracle(signer);
    }

    /**
     * @dev Get oracle weight
     */
    function getOracleWeight(address _oracle) public view returns (uint256) {
        if (!oracleManager.isActiveOracle(_oracle)) {
            return 0;
        }

        uint256 weight = oracleWeights[_oracle].weight;
        return weight > 0 ? weight : defaultOracleWeight;
    }

    /**
     * @dev Set oracle weight
     */
    function setOracleWeight(address _oracle, uint256 _weight) external onlyOwner {
        require(_oracle != address(0), "ConsensusOracle: Invalid oracle");
        require(oracleManager.isRegisteredOracle(_oracle), "ConsensusOracle: Oracle not registered");
        require(_weight > 0 && _weight <= 1000, "ConsensusOracle: Invalid weight");

        uint256 oldWeight = oracleWeights[_oracle].weight;
        oracleWeights[_oracle].weight = _weight;
        oracleWeights[_oracle].isActive = true;

        emit OracleWeightUpdated(_oracle, oldWeight, _weight);
    }

    /**
     * @dev Check consensus for a query
     */
    function _checkConsensus(bytes32 _queryId) internal {
        ConsensusQuery storage query = consensusQueries[_queryId];

        // Calculate total possible weight from active oracles
        address[] memory activeOracles = oracleManager.getActiveOracles();
        uint256 totalPossibleWeight = 0;

        for (uint256 i = 0; i < activeOracles.length; i++) {
            totalPossibleWeight += getOracleWeight(activeOracles[i]);
        }

        // Check if minimum participation is met
        if (query.totalVotes < (totalPossibleWeight * minimumOracles) / activeOracles.length) {
            return; // Not enough participation yet
        }

        // Check consensus threshold
        uint256 requiredVotes = (query.totalVotes * consensusThreshold) / 100;

        if (query.positiveVotes >= requiredVotes) {
            query.isResolved = true;
            query.consensusResult = true;
            correctAttestations++;

            emit ConsensusReached(
                _queryId,
                true,
                query.positiveVotes,
                query.negativeVotes,
                query.totalVotes,
                block.timestamp
            );
        } else if (query.negativeVotes >= requiredVotes) {
            query.isResolved = true;
            query.consensusResult = false;
            correctAttestations++;

            emit ConsensusReached(
                _queryId,
                false,
                query.positiveVotes,
                query.negativeVotes,
                query.totalVotes,
                block.timestamp
            );
        }
    }

    /**
     * @dev Get consensus result
     */
    function getConsensusResult(
        bytes32 _queryId
    )
        external
        view
        returns (
            bool isResolved,
            bool result,
            uint256 positiveVotes,
            uint256 negativeVotes,
            uint256 totalVotes,
            uint256 timestamp
        )
    {
        ConsensusQuery storage query = consensusQueries[_queryId];
        return (
            query.isResolved,
            query.consensusResult,
            query.positiveVotes,
            query.negativeVotes,
            query.totalVotes,
            query.timestamp
        );
    }

    /**
     * @dev Force resolve expired query
     */
    function forceResolveExpiredQuery(bytes32 _queryId) external {
        ConsensusQuery storage query = consensusQueries[_queryId];
        require(query.timestamp > 0, "ConsensusOracle: Query does not exist");
        require(block.timestamp >= query.expiryTime, "ConsensusOracle: Query not expired");
        require(!query.isResolved, "ConsensusOracle: Query already resolved");

        // Resolve based on current votes
        query.isResolved = true;
        query.consensusResult = query.positiveVotes > query.negativeVotes;

        emit ConsensusReached(
            _queryId,
            query.consensusResult,
            query.positiveVotes,
            query.negativeVotes,
            query.totalVotes,
            block.timestamp
        );
    }

    /**
     * @dev Set consensus threshold
     */
    function setConsensusThreshold(uint256 _threshold) external onlyOwner {
        require(_threshold > 50 && _threshold <= 100, "ConsensusOracle: Invalid threshold");

        uint256 oldThreshold = consensusThreshold;
        consensusThreshold = _threshold;

        emit ConsensusThresholdUpdated(oldThreshold, _threshold);
    }

    /**
     * @dev Set minimum oracles required
     */
    function setMinimumOracles(uint256 _minimum) external onlyOwner {
        require(_minimum > 0 && _minimum <= maximumOracles, "ConsensusOracle: Invalid minimum");
        minimumOracles = _minimum;
    }

    /**
     * @dev Set query expiry time
     */
    function setQueryExpiryTime(uint256 _expiryTime) external onlyOwner {
        require(_expiryTime >= 10 minutes && _expiryTime <= 24 hours, "ConsensusOracle: Invalid expiry time");
        queryExpiryTime = _expiryTime;
    }

    /**
     * @dev Batch set oracle weights
     */
    function batchSetOracleWeights(address[] calldata _oracles, uint256[] calldata _weights) external onlyOwner {
        require(_oracles.length == _weights.length, "ConsensusOracle: Array length mismatch");

        for (uint256 i = 0; i < _oracles.length; i++) {
            require(_oracles[i] != address(0), "ConsensusOracle: Invalid oracle");
            require(oracleManager.isRegisteredOracle(_oracles[i]), "ConsensusOracle: Oracle not registered");
            require(_weights[i] > 0 && _weights[i] <= 1000, "ConsensusOracle: Invalid weight");

            uint256 oldWeight = oracleWeights[_oracles[i]].weight;
            oracleWeights[_oracles[i]].weight = _weights[i];
            oracleWeights[_oracles[i]].isActive = true;

            emit OracleWeightUpdated(_oracles[i], oldWeight, _weights[i]);
        }
    }

    /**
     * @dev Get query voters
     */
    function getQueryVoters(bytes32 _queryId) external view returns (address[] memory) {
        return consensusQueries[_queryId].voters;
    }

    /**
     * @dev Emergency pause function
     */
    function emergencyPause() external onlyOwner {
        _pause();
        active = false;
        emit OracleStatusChanged(address(this), false);
    }

    /**
     * @dev Unpause function
     */
    function unpause() external onlyOwner {
        _unpause();
        active = true;
        emit OracleStatusChanged(address(this), true);
    }
}
