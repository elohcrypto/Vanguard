// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "./ListOracleBase.sol";

/**
 * @title BlacklistOracle
 * @dev Oracle contract for managing blacklist consensus and attestations
 */
contract BlacklistOracle is ListOracleBase {
    /// @dev OracleManager.QUERY_TYPE_BLACKLIST: the only query type whose verdict this oracle applies.
    uint8 private constant QUERY_TYPE_BLACKLIST = 2;

    enum SeverityLevel {
        LOW, // Minor compliance issues
        MEDIUM, // Moderate risk
        HIGH, // High risk, immediate action needed
        CRITICAL // Critical security threat, emergency blacklisting
    }

    struct BlacklistEntry {
        bool isBlacklisted;
        uint256 timestamp;
        uint256 expiryTime;
        SeverityLevel severity;
        string reason;
        address[] attestingOracles;
        bool emergencyListing; // True if added via emergency single-oracle process
    }

    struct Attestation {
        address subject;
        bool result;
        uint256 timestamp;
        bytes signature;
        bool isValid;
        SeverityLevel severity;
        string metadata;
    }

    // State variables
    mapping(address => BlacklistEntry) public blacklistEntries;
    /// @notice One record per (queryId, oracle): a second oracle no longer
    ///         overwrites the first. `lastAttester` serves `getAttestation`.
    mapping(bytes32 => mapping(address => Attestation)) public attestations;

    // Blacklist configuration
    uint256 public constant DEFAULT_BLACKLIST_DURATION = 30 days;
    uint256 public constant EMERGENCY_BLACKLIST_DURATION = 7 days;
    uint8 public minimumConsensusOracles = 2; // Lower threshold for blacklisting

    // Emergency blacklisting - one designated node for critical threats; the
    // designation is OracleManager.isEmergencyOracle (Task 4.4).
    uint256 public emergencyBlacklistCount;

    // Events
    event BlacklistUpdated(
        address indexed subject,
        bool indexed isBlacklisted,
        SeverityLevel severity,
        uint256 expiryTime,
        string reason,
        bool emergencyListing
    );

    event AttestationSubmitted(
        address indexed oracle,
        address indexed subject,
        bytes32 indexed queryId,
        bool result,
        SeverityLevel severity,
        uint256 timestamp
    );

    event EmergencyBlacklistAdded(
        address indexed subject,
        address indexed oracle,
        SeverityLevel severity,
        string reason
    );

    modifier onlyOracleManager() override {
        require(msg.sender == address(oracleManager), "BlacklistOracle: Only oracle manager");
        _;
    }

    modifier onlyOwnerOrListManager() {
        require(msg.sender == owner() || (listManager != address(0) && msg.sender == listManager),
            "BlacklistOracle: Only owner or list manager");
        _;
    }

    modifier onlyWhenActive() {
        require(active, "BlacklistOracle: Oracle not active");
        _;
    }

    /// @dev Task 4.4: one designation, OracleManager's (its owner or
    ///      operator sets it), plus a live node (review LOW-2), so a paused
    ///      or offboarded key loses the power without a revoke here.
    modifier onlyEmergencyOracle() {
        require(
            oracleManager.isEmergencyOracle(msg.sender) && oracleManager.isActiveOracle(msg.sender),
            "BlacklistOracle: Not an emergency oracle"
        );
        _;
    }

    constructor(address _oracleManager, string memory _name, string memory _description) Ownable(msg.sender) {
        require(_oracleManager != address(0), "BlacklistOracle: Invalid oracle manager");
        require(_oracleManager.code.length > 0, "BlacklistOracle: Oracle manager is not a contract");

        oracleManager = IOracleManager(_oracleManager);
        oracleName = _name;
        oracleDescription = _description;
        active = true;
        totalAttestations = 0;
        correctAttestations = 0;
        emergencyBlacklistCount = 0;
    }

    /**
     * @dev Provide attestation for blacklist status. `_data` is free metadata:
     *      the severity (so the duration) is the one fixed when the query was
     *      raised in OracleManager, MEDIUM if it carries none.
     */
    function provideAttestation(
        address _subject,
        bytes32 _queryId,
        bool _result,
        bytes calldata _signature,
        bytes calldata _data
    ) external override onlyWhenActive nonReentrant {
        require(_subject != address(0), "BlacklistOracle: Invalid subject");
        require(oracleManager.isActiveOracle(msg.sender), "BlacklistOracle: Not an active oracle");

        // Verify signature
        require(verifySignature(_subject, _queryId, _result, _signature), "BlacklistOracle: Invalid signature");

        // Bind the queryId to its subject AND query type before reading its data.
        // Without this, a single active oracle self-signs an attestation naming
        // any victim and replays a benign, already-resolved queryId (consensus
        // keys on queryId alone), or replays a resolved query of another kind
        // (identity, compliance, whitelist) for this subject as a blacklist verdict.
        (address boundSubject, uint8 boundType) = oracleManager.getQueryBinding(_queryId);
        if (boundSubject != _subject || boundType != QUERY_TYPE_BLACKLIST) revert QuerySubjectMismatch();

        bytes memory queryData = oracleManager.getQueryData(_queryId);
        SeverityLevel severity = queryData.length == 0
            ? SeverityLevel.MEDIUM
            : abi.decode(queryData, (SeverityLevel));

        // Store attestation
        lastAttester[_queryId] = msg.sender;
        attestations[_queryId][msg.sender] = Attestation({
            subject: _subject,
            result: _result,
            timestamp: block.timestamp,
            signature: _signature,
            isValid: true,
            severity: severity,
            metadata: string(_data)
        });

        totalAttestations++;

        // Update blacklist based on consensus
        _updateBlacklistConsensus(_subject, _queryId, severity);

        emit AttestationProvided(msg.sender, _subject, _queryId, _result, block.timestamp, _signature);
        emit AttestationSubmitted(msg.sender, _subject, _queryId, _result, severity, block.timestamp);
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
        return (attestation.result, attestation.timestamp, attester, attestation.signature, attestation.isValid);
    }

    /**
     * @dev Add address to blacklist
     */
    function addToBlacklist(
        address _subject,
        SeverityLevel _severity,
        uint256 _duration,
        string calldata _reason
    ) external onlyOwnerOrListManager {
        require(_subject != address(0), "BlacklistOracle: Invalid subject");

        uint256 expiryTime = _expiry(_duration, DEFAULT_BLACKLIST_DURATION);

        blacklistEntries[_subject] = BlacklistEntry({
            isBlacklisted: true,
            timestamp: block.timestamp,
            expiryTime: expiryTime,
            severity: _severity,
            reason: _reason,
            attestingOracles: new address[](0),
            emergencyListing: false
        });

        lastWriteAt[_subject] = block.timestamp;
        emit BlacklistUpdated(_subject, true, _severity, expiryTime, _reason, false);
    }

    /**
     * @dev Emergency blacklist - single oracle can add for critical threats
     */
    function emergencyBlacklist(
        address _subject,
        SeverityLevel _severity,
        string calldata _reason
    ) external onlyEmergencyOracle onlyWhenActive {
        require(_subject != address(0), "BlacklistOracle: Invalid subject");
        require(_severity == SeverityLevel.CRITICAL, "BlacklistOracle: Only critical severity for emergency");

        uint256 expiryTime = block.timestamp + EMERGENCY_BLACKLIST_DURATION;
        // Review B N-a (recorded, not changed): calling again before expiry
        // renews a 7-day CRITICAL listing, so one emergency key can freeze a
        // holder indefinitely until the owner removes the entry or the role.
        // Never shorten a live entry: the longer expiry (0 = never) wins.
        BlacklistEntry storage prior = blacklistEntries[_subject];
        if (prior.isBlacklisted && (prior.expiryTime == 0 || prior.expiryTime > expiryTime))
            expiryTime = prior.expiryTime;

        blacklistEntries[_subject] = BlacklistEntry({
            isBlacklisted: true,
            timestamp: block.timestamp,
            expiryTime: expiryTime,
            severity: _severity,
            reason: _reason,
            attestingOracles: new address[](1),
            emergencyListing: true
        });

        blacklistEntries[_subject].attestingOracles[0] = msg.sender;
        lastWriteAt[_subject] = block.timestamp;
        emergencyBlacklistCount++;

        emit BlacklistUpdated(_subject, true, _severity, expiryTime, _reason, true);
        emit EmergencyBlacklistAdded(_subject, msg.sender, _severity, _reason);
    }

    /**
     * @dev Remove address from blacklist
     */
    function removeFromBlacklist(address _subject, string calldata _reason) external onlyOwnerOrListManager {
        require(_subject != address(0), "BlacklistOracle: Invalid subject");
        require(blacklistEntries[_subject].isBlacklisted, "BlacklistOracle: Not blacklisted");

        blacklistEntries[_subject].isBlacklisted = false;
        blacklistEntries[_subject].reason = _reason;
        // A removal is a write: a verdict resolved before it cannot undo it.
        blacklistEntries[_subject].timestamp = block.timestamp;
        lastWriteAt[_subject] = block.timestamp;

        emit BlacklistUpdated(_subject, false, SeverityLevel.LOW, 0, _reason, false);
    }

    /**
     * @dev Check if address is blacklisted
     */
    function isBlacklisted(address _subject) external view returns (bool) {
        BlacklistEntry storage entry = blacklistEntries[_subject];
        return entry.isBlacklisted && (entry.expiryTime == 0 || block.timestamp < entry.expiryTime);
    }

    /**
     * @dev Get blacklist information
     */
    function getBlacklistInfo(
        address _subject
    )
        external
        view
        returns (
            bool isBlacklistedStatus,
            uint256 timestamp,
            uint256 expiryTime,
            SeverityLevel severity,
            string memory reason,
            address[] memory attestingOracles,
            bool emergencyListing
        )
    {
        BlacklistEntry storage entry = blacklistEntries[_subject];
        return (
            entry.isBlacklisted && (entry.expiryTime == 0 || block.timestamp < entry.expiryTime),
            entry.timestamp,
            entry.expiryTime,
            entry.severity,
            entry.reason,
            entry.attestingOracles,
            entry.emergencyListing
        );
    }

    /**
     * @dev Apply a resolved oracle consensus (subject and type already bound).
     *      Open query: nothing. Resolved: refused if already applied, if the
     *      subject was written at or after the verdict resolved (lastWriteAt:
     *      a governance NO_EXPIRY sanction, an emergency listing, an owner
     *      write, a removal, or a consensus verdict that resolved later) or
     *      if older than maxVerdictAge; otherwise consumed, even when it
     *      changes nothing, and lastWriteAt moves to its resolvedAt.
     */
    function _updateBlacklistConsensus(address _subject, bytes32 _queryId, SeverityLevel _severity) internal {
        (bool hasConsensus, bool consensusResult, uint256 resolvedAt) = oracleManager.getQueryResolution(_queryId);
        if (!hasConsensus) return;
        _consumeVerdict(_queryId, _subject, resolvedAt);

        // Review B N-d (recorded, plan 3.3): the add branch reads the
        // stored flag, so a lapsed entry never removed (isBlacklisted()
        // false, flag still set) blocks a consensus re-listing.
        if (consensusResult && !blacklistEntries[_subject].isBlacklisted) {
            // Add to blacklist
            uint256 duration = _getDurationBySeverity(_severity);

            blacklistEntries[_subject] = BlacklistEntry({
                isBlacklisted: true,
                timestamp: block.timestamp,
                expiryTime: block.timestamp + duration,
                severity: _severity,
                reason: "Oracle consensus flagging",
                attestingOracles: new address[](0),
                emergencyListing: false
            });

            emit BlacklistUpdated(
                _subject,
                true,
                _severity,
                block.timestamp + duration,
                "Oracle consensus flagging",
                false
            );
            correctAttestations++;
        } else if (!consensusResult && blacklistEntries[_subject].isBlacklisted) {
            // D27 (owner decision, review N-1): a consensus that resolved
            // after a governance NO_EXPIRY sanction may clear it; the latest
            // write by resolution time wins. Unchanged by design.
            blacklistEntries[_subject].isBlacklisted = false;
            blacklistEntries[_subject].reason = "Oracle consensus clearing";
            blacklistEntries[_subject].timestamp = block.timestamp;

            emit BlacklistUpdated(_subject, false, SeverityLevel.LOW, 0, "Oracle consensus clearing", false);
            correctAttestations++;
        }
    }

    /**
     * @dev Expiry for a write: NO_EXPIRY stores 0 (never), 0 uses the fallback
     */
    function _expiry(uint256 _duration, uint256 _fallback) internal view returns (uint256) {
        if (_duration == NO_EXPIRY) return 0;
        return block.timestamp + (_duration > 0 ? _duration : _fallback);
    }

    /**
     * @dev Get blacklist duration based on severity
     */
    function _getDurationBySeverity(SeverityLevel _severity) internal pure returns (uint256) {
        if (_severity == SeverityLevel.LOW) {
            return 7 days;
        } else if (_severity == SeverityLevel.MEDIUM) {
            return 30 days;
        } else if (_severity == SeverityLevel.HIGH) {
            return 90 days;
        } else {
            // CRITICAL
            return 365 days;
        }
    }

    /**
     * @dev Set minimum consensus oracles required
     */
    function setMinimumConsensusOracles(uint8 _minimum) external onlyOwner {
        require(_minimum > 0, "BlacklistOracle: Minimum must be greater than 0");
        minimumConsensusOracles = _minimum;
    }

    /**
     * @dev Batch add addresses to blacklist
     */
    function batchAddToBlacklist(
        address[] calldata _subjects,
        SeverityLevel[] calldata _severities,
        uint256 _duration,
        string calldata _reason
    ) external onlyOwner {
        require(_subjects.length == _severities.length, "BlacklistOracle: Array length mismatch");

        for (uint256 i = 0; i < _subjects.length; i++) {
            require(_subjects[i] != address(0), "BlacklistOracle: Invalid subject");

            uint256 expiryTime = _expiry(_duration, _getDurationBySeverity(_severities[i]));

            blacklistEntries[_subjects[i]] = BlacklistEntry({
                isBlacklisted: true,
                timestamp: block.timestamp,
                expiryTime: expiryTime,
                severity: _severities[i],
                reason: _reason,
                attestingOracles: new address[](0),
                emergencyListing: false
            });

            lastWriteAt[_subjects[i]] = block.timestamp;
            emit BlacklistUpdated(_subjects[i], true, _severities[i], expiryTime, _reason, false);
        }
    }

    /**
     * @dev Clean up expired blacklist entries
     */
    function cleanupExpiredEntries(address[] calldata _subjects) external {
        for (uint256 i = 0; i < _subjects.length; i++) {
            BlacklistEntry storage entry = blacklistEntries[_subjects[i]];
            if (entry.isBlacklisted && entry.expiryTime != 0 && block.timestamp >= entry.expiryTime) {
                // Not a write for lastWriteAt: the entry had already lapsed
                // and anyone may call this, so it must not kill verdicts.
                entry.isBlacklisted = false;
                entry.reason = "Expired";
                emit BlacklistUpdated(_subjects[i], false, SeverityLevel.LOW, 0, "Expired", false);
            }
        }
    }

    /**
     * @dev Get emergency blacklist statistics
     */
    function getEmergencyStats()
        external
        view
        returns (uint256 totalEmergencyBlacklists, uint256 activeEmergencyBlacklists)
    {
        // This would require additional tracking in a production implementation
        return (emergencyBlacklistCount, 0);
    }
}
