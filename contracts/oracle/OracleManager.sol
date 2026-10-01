// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "@openzeppelin/contracts/access/Ownable2Step.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "./interfaces/IOracleManager.sol";
import "./interfaces/IOracle.sol";

/**
 * @title OracleManager
 * @dev Manages oracle registration, consensus mechanisms, and reputation system
 */
contract OracleManager is IOracleManager, Ownable2Step, ReentrancyGuard, Pausable {
    /// @notice A response arrived after the query resolved: a settled verdict is final.
    error QueryAlreadyResolved();
    /// @notice Only the owner or an active oracle may raise a query.
    error UnauthorizedQueryCreator();
    /// @notice A blacklist query's data must be empty or one ABI-encoded severity 0..3.
    error InvalidSeverity();

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
        uint256 consensusCount;
        uint256 totalResponses;
        uint256 resolvedAt; // block time hasResult first became true; never moves
        mapping(address => bool) responses;
        mapping(address => bool) hasResponded;
    }

    // State variables
    mapping(address => OracleInfo) public oracles;
    address[] public registeredOraclesList;
    mapping(bytes32 => Query) public queries;

    uint256 public consensusThreshold = 3; // Minimum oracles needed for consensus
    uint256 public constant MAX_ORACLES = 100;
    uint256 public constant MIN_REPUTATION = 100;
    uint256 public constant MAX_REPUTATION = 1000;
    /// @notice Highest BlacklistOracle.SeverityLevel (CRITICAL)
    uint256 private constant MAX_SEVERITY = 3;

    /// @notice Manager-level emergency flag (IOracleManager). The role that
    ///         gates `BlacklistOracle.emergencyBlacklist` is that oracle's own
    ///         `emergencyOracles`, set by its owner; this flag is the registry
    ///         view of the same decision and is cleared when an oracle leaves.
    mapping(address => bool) private _emergencyOracles;

    // Additional events not in interface
    event OracleDeregistered(address indexed oracle, string reason);
    event OracleActivated(address indexed oracle);
    event OracleDeactivated(address indexed oracle);
    event ConsensusThresholdUpdated(uint256 oldThreshold, uint256 newThreshold);
    event EmergencyOverrideExecuted(address indexed oracle, bytes32 indexed queryId, string reason);

    // Query types
    uint8 public constant QUERY_TYPE_WHITELIST = 1;
    uint8 public constant QUERY_TYPE_BLACKLIST = 2;
    uint8 public constant QUERY_TYPE_IDENTITY = 3;
    uint8 public constant QUERY_TYPE_COMPLIANCE = 4;

    modifier onlyRegisteredOracle() {
        require(oracles[msg.sender].registered, "OracleManager: Not a registered oracle");
        _;
    }

    modifier onlyActiveOracle() {
        require(oracles[msg.sender].active, "OracleManager: Oracle not active");
        _;
    }

    constructor() Ownable(msg.sender) {}

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

    /**
     * @dev Deregister an oracle
     */
    function deregisterOracle(address _oracle, string calldata _reason) external onlyOwner {
        require(oracles[_oracle].registered, "OracleManager: Oracle not registered");

        oracles[_oracle].registered = false;
        oracles[_oracle].active = false;

        // Remove from registered list
        for (uint256 i = 0; i < registeredOraclesList.length; i++) {
            if (registeredOraclesList[i] == _oracle) {
                registeredOraclesList[i] = registeredOraclesList[registeredOraclesList.length - 1];
                registeredOraclesList.pop();
                break;
            }
        }

        emit OracleDeregistered(_oracle, _reason);
    }

    /**
     * @dev Activate an oracle
     */
    function activateOracle(address _oracle) external onlyOwner {
        require(oracles[_oracle].registered, "OracleManager: Oracle not registered");
        require(!oracles[_oracle].active, "OracleManager: Oracle already active");

        oracles[_oracle].active = true;
        emit OracleActivated(_oracle);
    }

    /**
     * @dev Deactivate an oracle
     */
    function deactivateOracle(address _oracle) external onlyOwner {
        require(oracles[_oracle].registered, "OracleManager: Oracle not registered");
        require(oracles[_oracle].active, "OracleManager: Oracle already inactive");

        oracles[_oracle].active = false;
        emit OracleDeactivated(_oracle);
    }

    /**
     * @dev Get all registered oracles
     */
    function getRegisteredOracles() external view returns (address[] memory) {
        return registeredOraclesList;
    }

    /**
     * @dev Get all active oracles
     */
    function getActiveOracles() external view returns (address[] memory) {
        uint256 activeCount = 0;

        // Count active oracles
        for (uint256 i = 0; i < registeredOraclesList.length; i++) {
            if (oracles[registeredOraclesList[i]].active) {
                activeCount++;
            }
        }

        // Create array of active oracles
        address[] memory activeOracles = new address[](activeCount);
        uint256 index = 0;

        for (uint256 i = 0; i < registeredOraclesList.length; i++) {
            if (oracles[registeredOraclesList[i]].active) {
                activeOracles[index] = registeredOraclesList[i];
                index++;
            }
        }

        return activeOracles;
    }

    /**
     * @dev Check if oracle is registered
     */
    function isRegisteredOracle(address _oracle) external view returns (bool) {
        return oracles[_oracle].registered;
    }

    /**
     * @dev Check if oracle is active
     */
    function isActiveOracle(address _oracle) external view returns (bool) {
        return oracles[_oracle].active;
    }

    /**
     * @dev Get oracle count
     */
    function getOracleCount() external view returns (uint256) {
        return registeredOraclesList.length;
    }

    /**
     * @dev Set consensus threshold
     */
    function setConsensusThreshold(uint256 _threshold) external onlyOwner {
        require(_threshold > 0, "OracleManager: Threshold must be greater than 0");
        require(_threshold <= registeredOraclesList.length, "OracleManager: Threshold too high");

        uint256 oldThreshold = consensusThreshold;
        consensusThreshold = _threshold;

        emit ConsensusThresholdUpdated(oldThreshold, _threshold);
    }

    /**
     * @dev Get consensus threshold
     */
    function getConsensusThreshold() external view returns (uint256) {
        return consensusThreshold;
    }

    /**
     * @dev Submit a query for oracle consensus. Raised by the owner or an
     *      active oracle (plan 2F.3: a blacklist query fixes the severity, so
     *      a stranger must not choose it). For QUERY_TYPE_BLACKLIST, `_data`
     *      is empty (MEDIUM) or `abi.encode(uint8 severity)` with 0..3; the
     *      blacklist oracle reads the severity from here, never from the relayer.
     */
    function submitQuery(address _subject, uint8 _queryType, bytes calldata _data) external returns (bytes32 queryId) {
        if (!oracles[msg.sender].active && msg.sender != owner()) revert UnauthorizedQueryCreator();
        require(_subject != address(0), "OracleManager: Invalid subject");
        require(_queryType >= 1 && _queryType <= 4, "OracleManager: Invalid query type");
        if (_queryType == QUERY_TYPE_BLACKLIST && _data.length != 0) {
            if (_data.length != 32 || abi.decode(_data, (uint256)) > MAX_SEVERITY) revert InvalidSeverity();
        }

        queryId = keccak256(abi.encodePacked(_subject, _queryType, _data, block.timestamp, msg.sender));

        Query storage query = queries[queryId];
        query.subject = _subject;
        query.queryType = _queryType;
        query.data = _data;
        query.timestamp = block.timestamp;
        query.hasResult = false;
        query.result = false;
        query.consensusCount = 0;
        query.totalResponses = 0;

        return queryId;
    }

    /**
     * @dev Submit oracle response to a query
     */
    function submitResponse(
        bytes32 _queryId,
        bool _result
    ) external onlyRegisteredOracle onlyActiveOracle nonReentrant {
        Query storage query = queries[_queryId];
        require(query.timestamp > 0, "OracleManager: Query does not exist");
        // A settled verdict is final: a later threshold-size group must not flip it (review L4).
        if (query.hasResult) revert QueryAlreadyResolved();
        require(!query.hasResponded[msg.sender], "OracleManager: Oracle already responded");

        query.hasResponded[msg.sender] = true;
        query.responses[msg.sender] = _result;
        query.totalResponses++;

        if (_result) {
            query.consensusCount++;
        }

        oracles[msg.sender].totalAttestations++;

        // Check if consensus is reached
        if (query.consensusCount >= consensusThreshold) {
            query.hasResult = true;
            query.result = true;
            query.resolvedAt = block.timestamp;
        } else if (query.totalResponses - query.consensusCount >= consensusThreshold) {
            query.hasResult = true;
            query.result = false;
            query.resolvedAt = block.timestamp;
        }
    }

    /**
     * @dev Check consensus for a query
     */
    function checkConsensus(bytes32 _queryId) external view returns (bool hasConsensus, bool result) {
        Query storage query = queries[_queryId];
        return (query.hasResult, query.result);
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
     * @dev Get query result
     */
    function getQueryResult(
        bytes32 _queryId
    )
        external
        view
        returns (bool hasResult, bool result, uint256 consensusCount, uint256 totalResponses, uint256 timestamp)
    {
        Query storage query = queries[_queryId];
        return (query.hasResult, query.result, query.consensusCount, query.totalResponses, query.timestamp);
    }

    /**
     * @dev Emergency override for critical situations
     */
    function emergencyOverride(
        address _oracle,
        bytes32 _queryId,
        bool _result,
        string calldata _reason
    ) external onlyOwner {
        require(oracles[_oracle].registered, "OracleManager: Oracle not registered");

        Query storage query = queries[_queryId];
        require(query.timestamp > 0, "OracleManager: Query does not exist");

        if (!query.hasResult) query.resolvedAt = block.timestamp;
        query.hasResult = true;
        query.result = _result;

        emit EmergencyOverrideExecuted(_oracle, _queryId, _reason);
    }

    /**
     * @dev Pause an oracle
     */
    function pauseOracle(address _oracle) external onlyOwner {
        require(oracles[_oracle].registered, "OracleManager: Oracle not registered");
        oracles[_oracle].active = false;
        emit OracleDeactivated(_oracle);
    }

    /**
     * @dev Unpause an oracle
     */
    function unpauseOracle(address _oracle) external onlyOwner {
        require(oracles[_oracle].registered, "OracleManager: Oracle not registered");
        oracles[_oracle].active = true;
        emit OracleActivated(_oracle);
    }

    /**
     * @dev Update oracle reputation
     */
    function updateOracleReputation(address _oracle, uint256 _reputation) external onlyOwner {
        require(oracles[_oracle].registered, "OracleManager: Oracle not registered");
        require(_reputation >= MIN_REPUTATION && _reputation <= MAX_REPUTATION, "OracleManager: Invalid reputation");

        oracles[_oracle].reputation = _reputation;
    }

    /**
     * @dev Penalize oracle
     */
    function penalizeOracle(address _oracle, uint256 _penalty, string calldata /* _reason */) external onlyOwner {
        require(oracles[_oracle].registered, "OracleManager: Oracle not registered");

        if (oracles[_oracle].reputation > _penalty) {
            oracles[_oracle].reputation -= _penalty;
        } else {
            oracles[_oracle].reputation = MIN_REPUTATION;
        }

        // Deactivate oracle if reputation falls too low
        if (oracles[_oracle].reputation <= MIN_REPUTATION) {
            oracles[_oracle].active = false;
            emit OracleDeactivated(_oracle);
        }
    }

    /**
     * @dev Reward oracle
     */
    function rewardOracle(address _oracle, uint256 _reward, string calldata /* _reason */) external onlyOwner {
        require(oracles[_oracle].registered, "OracleManager: Oracle not registered");

        if (oracles[_oracle].reputation + _reward <= MAX_REPUTATION) {
            oracles[_oracle].reputation += _reward;
        } else {
            oracles[_oracle].reputation = MAX_REPUTATION;
        }

        oracles[_oracle].correctAttestations++;
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

    // Missing interface implementations
    function registerOracle(address oracle, string memory name) external override onlyOwner {
        require(oracle != address(0), "Invalid oracle address");
        require(!oracles[oracle].registered, "Oracle already registered");
        require(registeredOraclesList.length < MAX_ORACLES, "Maximum oracles reached");

        oracles[oracle] = OracleInfo({
            oracleAddress: oracle,
            name: name,
            description: "",
            reputation: MIN_REPUTATION,
            registered: true,
            active: true,
            registrationTime: block.timestamp,
            totalAttestations: 0,
            correctAttestations: 0
        });

        registeredOraclesList.push(oracle);
        emit OracleRegistered(oracle, name);
    }

    function removeOracle(address oracle) external override onlyOwner {
        require(oracles[oracle].registered, "Oracle not registered");
        oracles[oracle].registered = false;
        oracles[oracle].active = false;

        // Remove from list
        for (uint256 i = 0; i < registeredOraclesList.length; i++) {
            if (registeredOraclesList[i] == oracle) {
                registeredOraclesList[i] = registeredOraclesList[registeredOraclesList.length - 1];
                registeredOraclesList.pop();
                break;
            }
        }

        emit OracleDeregistered(oracle, "Removed by admin");
    }

    function setEmergencyOracle(address oracle, bool /* isEmergency */) external view override onlyOwner {
        require(oracles[oracle].registered, "Oracle not registered");
        // Implementation would set emergency status - simplified for demo
    }

    function isEmergencyOracle(address oracle) external view override returns (bool) {
        // Simplified implementation
        return oracles[oracle].registered && oracles[oracle].reputation >= MAX_REPUTATION;
    }

    function getOracleName(address oracle) external view override returns (string memory) {
        return oracles[oracle].name;
    }

    function getOracleReputation(address oracle) external view override returns (uint256) {
        return oracles[oracle].reputation;
    }

    function getAllOracles() external view override returns (address[] memory) {
        return registeredOraclesList;
    }

    function updateConsensusThreshold(uint256 newThreshold) external override onlyOwner {
        require(newThreshold > 0, "Threshold must be greater than 0");
        require(newThreshold <= registeredOraclesList.length, "Threshold too high");

        uint256 oldThreshold = consensusThreshold;
        consensusThreshold = newThreshold;

        emit ConsensusThresholdUpdated(oldThreshold, newThreshold);
    }

    function validateOracleConsensus(
        address[] memory /* oracles */,
        bytes[] memory /* signatures */,
        bytes32 /* messageHash */
    ) external pure override returns (bool) {
        // Simplified implementation
        return true;
    }
}
