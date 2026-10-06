// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "@openzeppelin/contracts/access/Ownable2Step.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import "./interfaces/IOracleManager.sol";
import "./ConsensusOracle.sol";

/**
 * @title OracleManager
 * @notice The oracle gate (plan v2 Task 4.4, D11 = a): node registry and
 *         lifecycle, the query registry the Whitelist and Blacklist oracles
 *         read, and the one vote entry, `submitResponse`. The weighted tally
 *         is the bound ConsensusOracle engine's; this contract stamps the
 *         verdict it returns. Owner: governance after the handover
 *         (OracleParameters proposals). The operator (ops after the
 *         handover) may pause, unpause and emergency-designate nodes.
 */
contract OracleManager is IOracleManager, Ownable2Step, ReentrancyGuard {
    /// @notice A response arrived after the query resolved: a settled verdict is final.
    error QueryAlreadyResolved();
    /// @notice Only the owner or an active oracle may raise a query.
    error UnauthorizedQueryCreator();
    /// @notice A blacklist query's data must be empty or one ABI-encoded severity 0..3.
    error InvalidSeverity();
    /// @notice A CRITICAL (365-day) blacklist query is raised by the owner only.
    error SeverityRequiresOwner();
    /// @notice No engine bound: no query may open, fail closed.
    error NoConsensusEngine();
    /// @notice The engine has no code or serves another manager.
    error InvalidConsensusEngine();
    error NotOwnerOrOperator();
    /// @notice A node at MIN_REPUTATION (where penalizeOracle parks it) is
    ///         not unpaused; the owner raises its reputation first.
    error ReputationTooLow();
    /// @notice The owner (governance) paused this node: only it unpauses.
    error PausedByOwner();

    struct OracleInfo {
        address oracleAddress;
        string name;
        string description;
        uint256 reputation;
        bool registered;
        bool active;
        uint256 registrationTime;
        uint256 totalAttestations;
        uint256 correctAttestations;
    }

    struct Query {
        address subject;
        uint8 queryType;
        bytes data;
        uint256 timestamp;
        bool hasResult;
        bool result;
        uint256 resolvedAt; // block time hasResult first became true; never moves
    }

    // State variables
    mapping(address => OracleInfo) public oracles;
    address[] public registeredOraclesList;
    mapping(bytes32 => Query) public queries;

    /// @notice The weighted tally (ConsensusOracle bound to this manager).
    ConsensusOracle public consensusEngine;
    /// @notice May pause, unpause and emergency-designate nodes (ops).
    address public operator;

    uint256 public constant MAX_ORACLES = 100;
    uint256 public constant MIN_REPUTATION = 100;
    uint256 public constant MAX_REPUTATION = 1000;
    /// @notice Highest BlacklistOracle.SeverityLevel (CRITICAL)
    uint256 private constant MAX_SEVERITY = 3;

    /// @notice The emergency designation: BlacklistOracle.emergencyBlacklist
    ///         requires it and an active node (R-2F3-3); cleared on removal.
    mapping(address => bool) private _emergencyOracles;
    /// @notice Paused by the owner, so the operator cannot undo the pause.
    mapping(address => bool) public pausedByOwner;

    event OracleDeregistered(address indexed oracle, string reason);
    event OracleActivated(address indexed oracle);
    event OracleDeactivated(address indexed oracle);
    event EmergencyOverrideExecuted(address indexed oracle, bytes32 indexed queryId, string reason);
    event ConsensusEngineSet(address indexed engine);
    event OperatorUpdated(address indexed previous, address indexed current);
    /// @notice The owner adopted a pause already in place (pausedByOwner).
    event OwnerPauseAdopted(address indexed oracle);

    // Query types
    uint8 public constant QUERY_TYPE_WHITELIST = 1;
    uint8 public constant QUERY_TYPE_BLACKLIST = 2;
    uint8 public constant QUERY_TYPE_IDENTITY = 3;
    uint8 public constant QUERY_TYPE_COMPLIANCE = 4;

    modifier onlyActiveOracle() {
        require(oracles[msg.sender].active, "OracleManager: Oracle not active");
        _;
    }

    modifier onlyOwnerOrOperator() {
        if (msg.sender != owner() && (operator == address(0) || msg.sender != operator)) revert NotOwnerOrOperator();
        _;
    }

    modifier onlyRegistered(address _oracle) {
        require(oracles[_oracle].registered, "OracleManager: Oracle not registered");
        _;
    }

    constructor() Ownable(msg.sender) {}

    /// @notice Bind the engine; it must be a contract built for this manager.
    ///         Re-binding strands queries open in the old engine (their votes
    ///         revert UnknownQuery: raise them again). Only the handover
    ///         ceremony pins the engine's code hash; this checks code and
    ///         binding only.
    function setConsensusEngine(address _engine) external onlyOwner {
        if (_engine.code.length == 0) revert InvalidConsensusEngine();
        if (address(ConsensusOracle(_engine).oracleManager()) != address(this)) revert InvalidConsensusEngine();
        consensusEngine = ConsensusOracle(_engine);
        emit ConsensusEngineSet(_engine);
    }

    /// @notice Grant (or clear, with address(0)) the operator role.
    function setOperator(address _operator) external onlyOwner {
        emit OperatorUpdated(operator, _operator);
        operator = _operator;
    }

    function _boundEngine() internal view returns (ConsensusOracle e) {
        e = consensusEngine;
        if (address(e) == address(0)) revert NoConsensusEngine();
    }

    /**
     * @dev Register a new oracle
     */
    function registerOracle(
        address _oracle,
        string calldata _name,
        string calldata _description,
        uint256 _initialReputation
    ) external onlyOwner {
        require(_oracle != address(0), "OracleManager: Invalid oracle address");
        require(!oracles[_oracle].registered, "OracleManager: Oracle already registered");
        require(registeredOraclesList.length < MAX_ORACLES, "OracleManager: Max oracles reached");
        require(
            _initialReputation >= MIN_REPUTATION && _initialReputation <= MAX_REPUTATION,
            "OracleManager: Invalid reputation"
        );

        oracles[_oracle] = OracleInfo({
            oracleAddress: _oracle,
            name: _name,
            description: _description,
            reputation: _initialReputation,
            registered: true,
            active: true,
            registrationTime: block.timestamp,
            totalAttestations: 0,
            correctAttestations: 0
        });

        registeredOraclesList.push(_oracle);

        emit OracleRegistered(_oracle, _name);
    }

    /// @notice Offboard a node: it stops voting, attesting and holding the
    ///         emergency designation at once; its engine weight resets.
    function removeOracle(address _oracle, string calldata _reason) external onlyOwner onlyRegistered(_oracle) {
        oracles[_oracle].registered = false;
        oracles[_oracle].active = false;
        delete _emergencyOracles[_oracle];
        delete pausedByOwner[_oracle];
        if (address(consensusEngine) != address(0)) consensusEngine.setOracleWeight(_oracle, 0);

        for (uint256 i = 0; i < registeredOraclesList.length; i++) {
            if (registeredOraclesList[i] == _oracle) {
                registeredOraclesList[i] = registeredOraclesList[registeredOraclesList.length - 1];
                registeredOraclesList.pop();
                break;
            }
        }

        emit OracleDeregistered(_oracle, _reason);
    }

    /// @notice Stop a node voting and attesting; owner or operator. The owner
    ///         may also adopt an existing pause (an operator's or a parked
    ///         node's), so the operator cannot undo it later.
    function pauseOracle(address _oracle) external onlyOwnerOrOperator onlyRegistered(_oracle) {
        bool byOwner = msg.sender == owner();
        if (!oracles[_oracle].active) {
            require(byOwner, "OracleManager: Oracle already inactive");
            pausedByOwner[_oracle] = true;
            emit OwnerPauseAdopted(_oracle);
            return;
        }
        oracles[_oracle].active = false;
        if (byOwner) pausedByOwner[_oracle] = true;
        emit OracleDeactivated(_oracle);
    }

    /// @notice Resume a paused node; owner or operator. Refused at
    ///         MIN_REPUTATION, and to the operator when the owner paused it.
    function unpauseOracle(address _oracle) external onlyOwnerOrOperator onlyRegistered(_oracle) {
        require(!oracles[_oracle].active, "OracleManager: Oracle already active");
        if (oracles[_oracle].reputation <= MIN_REPUTATION) revert ReputationTooLow();
        if (pausedByOwner[_oracle] && msg.sender != owner()) revert PausedByOwner();
        delete pausedByOwner[_oracle];
        oracles[_oracle].active = true;
        emit OracleActivated(_oracle);
    }

    /// @notice Set or clear the emergency designation; owner or operator.
    function setEmergencyOracle(
        address _oracle,
        bool _isEmergency
    ) external override onlyOwnerOrOperator onlyRegistered(_oracle) {
        _emergencyOracles[_oracle] = _isEmergency;
        emit EmergencyOracleSet(_oracle, _isEmergency);
    }

    function getRegisteredOracles() external view returns (address[] memory) {
        return registeredOraclesList;
    }

    function getActiveOracles() external view returns (address[] memory) {
        uint256 activeCount = 0;
        for (uint256 i = 0; i < registeredOraclesList.length; i++) {
            if (oracles[registeredOraclesList[i]].active) activeCount++;
        }
        address[] memory activeOracles = new address[](activeCount);
        uint256 index = 0;
        for (uint256 i = 0; i < registeredOraclesList.length; i++) {
            if (oracles[registeredOraclesList[i]].active) activeOracles[index++] = registeredOraclesList[i];
        }
        return activeOracles;
    }

    function isRegisteredOracle(address _oracle) external view returns (bool) {
        return oracles[_oracle].registered;
    }

    function isActiveOracle(address _oracle) external view returns (bool) {
        return oracles[_oracle].active;
    }

    function isEmergencyOracle(address oracle) external view override returns (bool) {
        return _emergencyOracles[oracle];
    }

    function getOracleCount() external view returns (uint256) {
        return registeredOraclesList.length;
    }

    function getOracleName(address oracle) external view override returns (string memory) {
        return oracles[oracle].name;
    }

    function getOracleReputation(address oracle) external view override returns (uint256) {
        return oracles[oracle].reputation;
    }

    // Engine parameters, set through the manager (governance after the handover).

    /// @notice Percent of the active weight one side needs, in (50, 100].
    function setConsensusThreshold(uint256 _percent) external onlyOwner {
        _boundEngine().setConsensusThreshold(_percent);
    }

    /// @notice 0 when no engine is bound.
    function getConsensusThreshold() external view returns (uint256) {
        return address(consensusEngine) == address(0) ? 0 : consensusEngine.consensusThreshold();
    }

    function setOracleWeight(address _oracle, uint256 _weight) public onlyOwner onlyRegistered(_oracle) {
        require(_weight > 0, "OracleManager: Invalid weight");
        _boundEngine().setOracleWeight(_oracle, _weight);
    }

    function batchSetOracleWeights(address[] calldata _oracles, uint256[] calldata _weights) external onlyOwner {
        require(_oracles.length == _weights.length, "OracleManager: Array length mismatch");
        for (uint256 i = 0; i < _oracles.length; i++) setOracleWeight(_oracles[i], _weights[i]);
    }

    function setQueryExpiryTime(uint256 _expiry) external onlyOwner {
        _boundEngine().setQueryExpiryTime(_expiry);
    }

    /**
     * @dev Submit a query for oracle consensus. Raised by the owner or an
     *      active oracle (plan 2F.3: a blacklist query fixes the severity, so
     *      a stranger must not choose it). For QUERY_TYPE_BLACKLIST, `_data`
     *      is empty (MEDIUM) or `abi.encode(uint8 severity)` with 0..3; the
     *      blacklist oracle reads the severity from here, never from the relayer.
     *      Responders vote a bare bool, so answering yes accepts the raiser's
     *      severity: an active oracle may raise at most HIGH, only the owner
     *      CRITICAL (review LOW-1). The id hashes the raiser and block time;
     *      an existing id is refused by the engine (Task 4.4, was review N-8's
     *      self-griefing reset). The engine snapshots the active weight now.
     */
    function submitQuery(address _subject, uint8 _queryType, bytes calldata _data) external returns (bytes32 queryId) {
        if (!oracles[msg.sender].active && msg.sender != owner()) revert UnauthorizedQueryCreator();
        require(_subject != address(0), "OracleManager: Invalid subject");
        require(_queryType >= 1 && _queryType <= 4, "OracleManager: Invalid query type");
        if (_queryType == QUERY_TYPE_BLACKLIST && _data.length != 0) {
            uint256 severity = _data.length == 32 ? abi.decode(_data, (uint256)) : type(uint256).max;
            if (severity > MAX_SEVERITY) revert InvalidSeverity();
            if (severity == MAX_SEVERITY && msg.sender != owner()) revert SeverityRequiresOwner();
        }

        queryId = keccak256(abi.encodePacked(_subject, _queryType, _data, block.timestamp, msg.sender));
        _boundEngine().openQuery(queryId);

        Query storage query = queries[queryId];
        query.subject = _subject;
        query.queryType = _queryType;
        query.data = _data;
        query.timestamp = block.timestamp;
        return queryId;
    }

    /**
     * @notice The one vote entry: an active node answers `_queryId`. The
     *         engine records the vote with the node's weight and returns the
     *         verdict once a side reaches the threshold; it refuses a second
     *         vote and any vote after the query expired.
     */
    function submitResponse(bytes32 _queryId, bool _result) external onlyActiveOracle nonReentrant {
        Query storage query = queries[_queryId];
        require(query.timestamp > 0, "OracleManager: Query does not exist");
        // A settled verdict is final: a later group must not flip it (review L4).
        if (query.hasResult) revert QueryAlreadyResolved();

        (bool resolved, bool result) = _boundEngine().recordVote(_queryId, msg.sender, _result);
        oracles[msg.sender].totalAttestations++;

        if (resolved) {
            query.hasResult = true;
            query.result = result;
            query.resolvedAt = block.timestamp;
        }
    }

    /**
     * @dev Subject and type a query was raised for ((address(0), 0) if the query
     *      never existed). Lets consumers reject a resolved consensus replayed at
     *      another subject or under another policy.
     */
    function getQueryBinding(bytes32 _queryId) external view returns (address subject, uint8 queryType) {
        Query storage query = queries[_queryId];
        return (query.subject, query.queryType);
    }

    /// @inheritdoc IOracleManager
    function getQueryResolution(
        bytes32 _queryId
    ) external view returns (bool hasResult, bool result, uint256 resolvedAt) {
        Query storage query = queries[_queryId];
        return (query.hasResult, query.result, query.resolvedAt);
    }

    /// @inheritdoc IOracleManager
    function getQueryData(bytes32 _queryId) external view returns (bytes memory) {
        return queries[_queryId].data;
    }

    /**
     * @dev Emergency override for critical situations
     */
    function emergencyOverride(
        address _oracle,
        bytes32 _queryId,
        bool _result,
        string calldata _reason
    ) external onlyOwner onlyRegistered(_oracle) {
        Query storage query = queries[_queryId];
        require(query.timestamp > 0, "OracleManager: Query does not exist");

        if (!query.hasResult) query.resolvedAt = block.timestamp;
        query.hasResult = true;
        query.result = _result;

        emit EmergencyOverrideExecuted(_oracle, _queryId, _reason);
    }

    /**
     * @dev Update oracle reputation
     */
    function updateOracleReputation(address _oracle, uint256 _reputation) external onlyOwner onlyRegistered(_oracle) {
        require(_reputation >= MIN_REPUTATION && _reputation <= MAX_REPUTATION, "OracleManager: Invalid reputation");
        oracles[_oracle].reputation = _reputation;
        emit OracleReputationUpdated(_oracle, _reputation);
    }

    /**
     * @dev Penalize oracle; at MIN_REPUTATION it is deactivated (parked).
     */
    function penalizeOracle(
        address _oracle,
        uint256 _penalty,
        string calldata /* _reason */
    ) external onlyOwner onlyRegistered(_oracle) {
        OracleInfo storage info = oracles[_oracle];
        info.reputation = info.reputation > _penalty ? info.reputation - _penalty : MIN_REPUTATION;
        emit OracleReputationUpdated(_oracle, info.reputation);

        if (info.reputation <= MIN_REPUTATION && info.active) {
            info.active = false;
            emit OracleDeactivated(_oracle);
        }
    }

    /**
     * @dev Reward oracle
     */
    function rewardOracle(
        address _oracle,
        uint256 _reward,
        string calldata /* _reason */
    ) external onlyOwner onlyRegistered(_oracle) {
        OracleInfo storage info = oracles[_oracle];
        info.reputation = info.reputation + _reward <= MAX_REPUTATION ? info.reputation + _reward : MAX_REPUTATION;
        info.correctAttestations++;
        emit OracleReputationUpdated(_oracle, info.reputation);
    }

    /**
     * @dev Get oracle information
     */
    function getOracleInfo(
        address _oracle
    )
        external
        view
        returns (
            string memory name,
            string memory description,
            uint256 reputation,
            bool registered,
            bool active,
            uint256 registrationTime,
            uint256 totalAttestations,
            uint256 correctAttestations
        )
    {
        OracleInfo storage info = oracles[_oracle];
        return (
            info.name,
            info.description,
            info.reputation,
            info.registered,
            info.active,
            info.registrationTime,
            info.totalAttestations,
            info.correctAttestations
        );
    }

    /// @notice True when distinct, currently active oracles that each signed
    ///         `messageHash` (EIP-191 personal sign; `signatures[i]` recovers
    ///         to `oracles[i]`) hold the engine's threshold of the live
    ///         REGISTERED weight (pausing nodes never lowers it). A duplicate, inactive, mismatched or malformed entry
    ///         does not count; a length mismatch or no engine is false.
    function validateOracleConsensus(
        address[] memory _oracles,
        bytes[] memory _signatures,
        bytes32 _messageHash
    ) external view override returns (bool) {
        ConsensusOracle engine = consensusEngine;
        if (address(engine) == address(0) || _oracles.length != _signatures.length) return false;
        bytes32 digest = MessageHashUtils.toEthSignedMessageHash(_messageHash);
        uint256 weight = 0;
        for (uint256 i = 0; i < _oracles.length; i++) {
            if (!oracles[_oracles[i]].active) continue;
            bool duplicate = false;
            for (uint256 j = 0; j < i; j++) {
                if (_oracles[j] == _oracles[i]) {
                    duplicate = true;
                    break;
                }
            }
            if (duplicate) continue;
            (address signer, ECDSA.RecoverError err, ) = ECDSA.tryRecover(digest, _signatures[i]);
            if (err == ECDSA.RecoverError.NoError && signer == _oracles[i]) weight += engine.weightOf(signer);
        }
        return engine.meetsThreshold(weight);
    }
}
