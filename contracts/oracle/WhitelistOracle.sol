// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "./ListOracleBase.sol";

/**
 * @title WhitelistOracle
 * @dev Oracle contract for managing whitelist consensus and attestations
 */
contract WhitelistOracle is ListOracleBase {
    /// @dev OracleManager.QUERY_TYPE_WHITELIST: the only query type whose verdict this oracle applies.
    uint8 private constant QUERY_TYPE_WHITELIST = 1;

    /// @notice The resolved whitelist query carries no tier in 1..5 (the
    ///         manager refuses one at submit; Task 4.12).
    error InvalidQueryTier();

    struct WhitelistEntry {
        bool isWhitelisted;
        uint256 timestamp;
        uint256 expiryTime;
        uint8 tier; // Whitelist tier (1-5, higher is better)
        string reason;
        address[] attestingOracles;
    }

    struct Attestation {
        address subject;
        bool result;
        uint256 timestamp;
        bytes signature;
        bool isValid;
        string metadata;
    }

    // State variables
    mapping(address => WhitelistEntry) public whitelistEntries;
    /// @notice One record per (queryId, oracle): a second oracle no longer
    ///         overwrites the first. `lastAttester` serves `getAttestation`.
    mapping(bytes32 => mapping(address => Attestation)) public attestations;

    // Whitelist configuration
    uint256 public constant DEFAULT_WHITELIST_DURATION = 365 days;
    uint256 public constant MIN_TIER = 1;
    uint256 public constant MAX_TIER = 5;
    uint8 public minimumConsensusOracles = 3;

    // Events
    event WhitelistUpdated(
        address indexed subject,
        bool indexed isWhitelisted,
        uint8 tier,
        uint256 expiryTime,
        string reason
    );

    event AttestationSubmitted(
        address indexed oracle,
        address indexed subject,
        bytes32 indexed queryId,
        bool result,
        uint256 timestamp
    );

    modifier onlyOracleManager() override {
        require(msg.sender == address(oracleManager), "WhitelistOracle: Only oracle manager");
        _;
    }

    modifier onlyOwnerOrListManager() {
        require(
            msg.sender == owner() || (listManager != address(0) && msg.sender == listManager),
            "WhitelistOracle: Only owner or list manager"
        );
        _;
    }

    modifier onlyWhenActive() {
        require(active, "WhitelistOracle: Oracle not active");
        _;
    }

    constructor(address _oracleManager, string memory _name, string memory _description) Ownable(msg.sender) {
        require(_oracleManager != address(0), "WhitelistOracle: Invalid oracle manager");
        require(_oracleManager.code.length > 0, "WhitelistOracle: Oracle manager is not a contract");

        oracleManager = IOracleManager(_oracleManager);
        oracleName = _name;
        oracleDescription = _description;
        active = true;
        totalAttestations = 0;
        correctAttestations = 0;
    }

    /**
     * @dev Provide attestation for whitelist status (`_data` is free metadata)
     */
    function provideAttestation(
        address _subject,
        bytes32 _queryId,
        bool _result,
        bytes calldata _signature,
        bytes calldata _data
    ) external override onlyWhenActive nonReentrant {
        require(_subject != address(0), "WhitelistOracle: Invalid subject");
        require(oracleManager.isActiveOracle(msg.sender), "WhitelistOracle: Not an active oracle");

        // Verify signature
        require(verifySignature(_subject, _queryId, _result, _signature), "WhitelistOracle: Invalid signature");

        // Store attestation
        lastAttester[_queryId] = msg.sender;
        attestations[_queryId][msg.sender] = Attestation({
            subject: _subject,
            result: _result,
            timestamp: block.timestamp,
            signature: _signature,
            isValid: true,
            metadata: string(_data)
        });

        totalAttestations++;

        // Update whitelist based on consensus
        _updateWhitelistConsensus(_subject, _queryId);

        emit AttestationProvided(msg.sender, _subject, _queryId, _result, block.timestamp, _signature);
        emit AttestationSubmitted(msg.sender, _subject, _queryId, _result, block.timestamp);
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
        address attester = lastAttester[_queryId];
        Attestation storage attestation = attestations[_queryId][attester];
        return (
            attestation.result,
            attestation.timestamp,
            attester,
            attestation.signature,
            attestation.isValid
        );
    }

    /**
     * @dev Add address to whitelist with tier
     */
    function addToWhitelist(
        address _subject,
        uint8 _tier,
        uint256 _duration,
        string calldata _reason
    ) external onlyOwnerOrListManager {
        require(_subject != address(0), "WhitelistOracle: Invalid subject");
        require(_tier >= MIN_TIER && _tier <= MAX_TIER, "WhitelistOracle: Invalid tier");

        uint256 expiryTime = _expiry(_duration);

        whitelistEntries[_subject] = WhitelistEntry({
            isWhitelisted: true,
            timestamp: block.timestamp,
            expiryTime: expiryTime,
            tier: _tier,
            reason: _reason,
            attestingOracles: new address[](0)
        });

        lastWriteAt[_subject] = block.timestamp;
        emit WhitelistUpdated(_subject, true, _tier, expiryTime, _reason);
    }

    /**
     * @dev Expiry for a write: NO_EXPIRY stores 0 (never), 0 uses the default
     */
    function _expiry(uint256 _duration) internal view returns (uint256) {
        if (_duration == NO_EXPIRY) return 0;
        return block.timestamp + (_duration > 0 ? _duration : DEFAULT_WHITELIST_DURATION);
    }

    /**
     * @dev Remove address from whitelist
     */

    /**
     * @dev Get whitelist information
     */
    function getWhitelistInfo(
        address _subject
    )
        external
        view
        returns (
            bool isWhitelistedStatus,
            uint256 timestamp,
            uint256 expiryTime,
            uint8 tier,
            string memory reason,
            address[] memory attestingOracles
        )
    {
        WhitelistEntry storage entry = whitelistEntries[_subject];
        return (
            entry.isWhitelisted && (entry.expiryTime == 0 || block.timestamp < entry.expiryTime),
            entry.timestamp,
            entry.expiryTime,
            entry.tier,
            entry.reason,
            entry.attestingOracles
        );
    }

    /**
     * @dev Check if address is whitelisted
     */
    function isWhitelisted(address _subject) external view returns (bool) {
        WhitelistEntry memory entry = whitelistEntries[_subject];
        return entry.isWhitelisted && (entry.expiryTime == 0 || block.timestamp < entry.expiryTime);
    }

    /**
     * @dev Remove address from whitelist
     */
    function removeFromWhitelist(address _subject, string calldata _reason) external onlyOwnerOrListManager {
        require(whitelistEntries[_subject].isWhitelisted, "WhitelistOracle: Not whitelisted");

        whitelistEntries[_subject].isWhitelisted = false;
        whitelistEntries[_subject].reason = _reason;
        whitelistEntries[_subject].timestamp = block.timestamp;
        lastWriteAt[_subject] = block.timestamp;

        emit WhitelistUpdated(_subject, false, 0, 0, _reason);
    }

    /**
     * @dev Apply a resolved whitelist verdict (Task 4.12). The query names
     *      (wallet, tier): the tier is the one the manager stored with the
     *      query, which its id commits to and the nodes voted on, never the
     *      relayer's. An approval means "qualifies for at least T"
     *      (R-412-7): it lists a wallet with no live entry at T for
     *      DEFAULT_WHITELIST_DURATION, raises a live entry below T to T with
     *      its expiry capped at that same duration from now (R-412-L1), and
     *      is a consumed no-op on an entry at T or above: it never lowers
     *      (lowering is the owner's or list manager's, addToWhitelist). A
     *      rejection of (wallet, T) delists an entry at tier T or above (the
     *      wallet does not qualify for T); an entry below T stays.
     */
    function _updateWhitelistConsensus(address _subject, bytes32 _queryId) internal {
        (bool hasConsensus, bool consensusResult, uint256 resolvedAt) = oracleManager.getQueryResolution(_queryId);
        // Bind the resolved consensus to the subject AND the query type: a
        // resolution keys on queryId alone, so a node could otherwise replay
        // a benign resolved query (of any kind) at a victim.
        (address boundSubject, uint8 boundType) = oracleManager.getQueryBinding(_queryId);
        if (boundSubject != _subject || boundType != QUERY_TYPE_WHITELIST) revert QuerySubjectMismatch();
        if (!hasConsensus) return;

        // Plan 2F.3: a resolved verdict applies once, only while fresh and only
        // if it resolved after the subject's last write (lastWriteAt), so an
        // older verdict never undoes a newer write. Consumed even when it
        // changes nothing; lastWriteAt moves to its resolvedAt.
        _consumeVerdict(_queryId, _subject, resolvedAt);
        uint8 tier = _queryTier(_queryId);
        WhitelistEntry storage entry = whitelistEntries[_subject];
        bool live = entry.isWhitelisted && (entry.expiryTime == 0 || block.timestamp < entry.expiryTime);

        if (consensusResult && !live) {
            // Fresh listing (review B N-d closed: a lapsed entry re-lists).
            uint256 expiryTime = block.timestamp + DEFAULT_WHITELIST_DURATION;
            whitelistEntries[_subject] = WhitelistEntry({
                isWhitelisted: true,
                timestamp: block.timestamp,
                expiryTime: expiryTime,
                tier: tier,
                reason: "Oracle consensus approval",
                attestingOracles: new address[](0)
            });
            emit WhitelistUpdated(_subject, true, tier, expiryTime, "Oracle consensus approval");
            correctAttestations++;
        } else if (consensusResult && entry.tier < tier) {
            // Raise only; the consensus grant lasts no longer than a fresh one.
            uint256 cap = block.timestamp + DEFAULT_WHITELIST_DURATION;
            if (entry.expiryTime == 0 || entry.expiryTime > cap) entry.expiryTime = cap;
            entry.tier = tier;
            entry.timestamp = block.timestamp;
            entry.reason = "Oracle consensus tier raise";
            emit WhitelistUpdated(_subject, true, tier, entry.expiryTime, "Oracle consensus tier raise");
            correctAttestations++;
        } else if (!consensusResult && entry.isWhitelisted && entry.tier >= tier) {
            entry.isWhitelisted = false;
            entry.reason = "Oracle consensus rejection";
            entry.timestamp = block.timestamp;
            emit WhitelistUpdated(_subject, false, 0, 0, "Oracle consensus rejection");
            correctAttestations++;
        }
    }

    /// @dev The tier the whitelist query was raised with (abi.encode(tier)).
    function _queryTier(bytes32 _queryId) internal view returns (uint8) {
        bytes memory data = oracleManager.getQueryData(_queryId);
        uint256 tier = data.length == 32 ? abi.decode(data, (uint256)) : 0;
        if (tier < MIN_TIER || tier > MAX_TIER) revert InvalidQueryTier();
        return uint8(tier);
    }

    /**
     * @dev Set minimum consensus oracles required
     */
    function setMinimumConsensusOracles(uint8 _minimum) external onlyOwner {
        require(_minimum > 0, "WhitelistOracle: Minimum must be greater than 0");
        minimumConsensusOracles = _minimum;
    }

    /**
     * @dev Batch add addresses to whitelist
     */
    function batchAddToWhitelist(
        address[] calldata _subjects,
        uint8[] calldata _tiers,
        uint256 _duration,
        string calldata _reason
    ) external onlyOwner {
        require(_subjects.length == _tiers.length, "WhitelistOracle: Array length mismatch");

        for (uint256 i = 0; i < _subjects.length; i++) {
            require(_subjects[i] != address(0), "WhitelistOracle: Invalid subject");
            require(_tiers[i] >= MIN_TIER && _tiers[i] <= MAX_TIER, "WhitelistOracle: Invalid tier");

            uint256 expiryTime = _expiry(_duration);

            whitelistEntries[_subjects[i]] = WhitelistEntry({
                isWhitelisted: true,
                timestamp: block.timestamp,
                expiryTime: expiryTime,
                tier: _tiers[i],
                reason: _reason,
                attestingOracles: new address[](0)
            });

            lastWriteAt[_subjects[i]] = block.timestamp;
            emit WhitelistUpdated(_subjects[i], true, _tiers[i], expiryTime, _reason);
        }
    }
}
