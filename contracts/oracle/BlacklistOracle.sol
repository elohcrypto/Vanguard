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
 * @title BlacklistOracle
 * @dev Oracle contract for managing blacklist consensus and attestations
 */
contract BlacklistOracle is IOracle, Ownable, ReentrancyGuard, Pausable {
    using ECDSA for bytes32;

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
    IOracleManager public oracleManager;
    mapping(address => BlacklistEntry) public blacklistEntries;
    mapping(bytes32 => Attestation) public attestations;
    mapping(address => uint256) public oracleReputation;

    string public oracleName;
    string public oracleDescription;
    bool public active;
    uint256 public totalAttestations;
    uint256 public correctAttestations;

    // Blacklist configuration
    uint256 public constant DEFAULT_BLACKLIST_DURATION = 30 days;
    uint256 public constant EMERGENCY_BLACKLIST_DURATION = 7 days;
    uint8 public minimumConsensusOracles = 2; // Lower threshold for blacklisting

    // Emergency blacklisting - allows single oracle for critical threats
    mapping(address => bool) public emergencyOracles;
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

    event EmergencyOracleUpdated(address indexed oracle, bool isEmergencyOracle);

    modifier onlyOracleManager() {
        require(msg.sender == address(oracleManager), "BlacklistOracle: Only oracle manager");
        _;
    }

    modifier onlyWhenActive() {
        require(active, "BlacklistOracle: Oracle not active");
        _;
    }

    modifier onlyEmergencyOracle() {
        require(emergencyOracles[msg.sender], "BlacklistOracle: Not an emergency oracle");
        _;
    }

    constructor(address _oracleManager, string memory _name, string memory _description) Ownable(msg.sender) {
        require(_oracleManager != address(0), "BlacklistOracle: Invalid oracle manager");

        oracleManager = IOracleManager(_oracleManager);
        oracleName = _name;
        oracleDescription = _description;
        active = true;
        totalAttestations = 0;
        correctAttestations = 0;
        emergencyBlacklistCount = 0;
    }

    /**
     * @dev Provide attestation for blacklist status
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

        // Decode severity from data
        SeverityLevel severity = SeverityLevel.MEDIUM;
        if (_data.length > 0) {
            severity = abi.decode(_data, (SeverityLevel));
        }

        // Verify signature
        require(verifySignature(_subject, _queryId, _result, _signature), "BlacklistOracle: Invalid signature");

        // Store attestation
        attestations[_queryId] = Attestation({
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
        _updateBlacklistConsensus(_subject, _queryId, _result, severity);

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
        return oracleReputation[address(this)];
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
            oracleReputation[address(this)],
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
        oracleReputation[address(this)] = _reputation;
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
     * @dev Add address to blacklist
     */
    function addToBlacklist(
        address _subject,
        SeverityLevel _severity,
        uint256 _duration,
        string calldata _reason
    ) external onlyOwner {
        require(_subject != address(0), "BlacklistOracle: Invalid subject");

        uint256 expiryTime = block.timestamp + (_duration > 0 ? _duration : DEFAULT_BLACKLIST_DURATION);

        blacklistEntries[_subject] = BlacklistEntry({
            isBlacklisted: true,
            timestamp: block.timestamp,
            expiryTime: expiryTime,
            severity: _severity,
            reason: _reason,
            attestingOracles: new address[](0),
            emergencyListing: false
        });

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
        emergencyBlacklistCount++;

        emit BlacklistUpdated(_subject, true, _severity, expiryTime, _reason, true);
        emit EmergencyBlacklistAdded(_subject, msg.sender, _severity, _reason);
    }

    /**
     * @dev Remove address from blacklist
     */
    function removeFromBlacklist(address _subject, string calldata _reason) external onlyOwner {
        require(_subject != address(0), "BlacklistOracle: Invalid subject");
        require(blacklistEntries[_subject].isBlacklisted, "BlacklistOracle: Not blacklisted");

        blacklistEntries[_subject].isBlacklisted = false;
        blacklistEntries[_subject].reason = _reason;

        emit BlacklistUpdated(_subject, false, SeverityLevel.LOW, 0, _reason, false);
    }

    /**
     * @dev Check if address is blacklisted
     */
    function isBlacklisted(address _subject) external view returns (bool) {
        BlacklistEntry storage entry = blacklistEntries[_subject];
        return entry.isBlacklisted && block.timestamp < entry.expiryTime;
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
            entry.isBlacklisted && block.timestamp < entry.expiryTime,
            entry.timestamp,
            entry.expiryTime,
            entry.severity,
            entry.reason,
            entry.attestingOracles,
            entry.emergencyListing
        );
    }

    /**
     * @dev Update blacklist based on oracle consensus
     */
    function _updateBlacklistConsensus(
        address _subject,
        bytes32 _queryId,
        bool /* _result */,
        SeverityLevel _severity
    ) internal {
        // Get consensus from oracle manager
        (bool hasConsensus, bool consensusResult) = oracleManager.checkConsensus(_queryId);

        if (hasConsensus) {
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
                // Remove from blacklist
                blacklistEntries[_subject].isBlacklisted = false;
                blacklistEntries[_subject].reason = "Oracle consensus clearing";

                emit BlacklistUpdated(_subject, false, SeverityLevel.LOW, 0, "Oracle consensus clearing", false);
                correctAttestations++;
            }
        }
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
     * @dev Set emergency oracle status
     */
    function setEmergencyOracle(address _oracle, bool _isEmergencyOracle) external onlyOwner {
        require(_oracle != address(0), "BlacklistOracle: Invalid oracle");
        require(oracleManager.isRegisteredOracle(_oracle), "BlacklistOracle: Oracle not registered");

        emergencyOracles[_oracle] = _isEmergencyOracle;
        emit EmergencyOracleUpdated(_oracle, _isEmergencyOracle);
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

            uint256 expiryTime = block.timestamp + (_duration > 0 ? _duration : _getDurationBySeverity(_severities[i]));

            blacklistEntries[_subjects[i]] = BlacklistEntry({
                isBlacklisted: true,
                timestamp: block.timestamp,
                expiryTime: expiryTime,
                severity: _severities[i],
                reason: _reason,
                attestingOracles: new address[](0),
                emergencyListing: false
            });

            emit BlacklistUpdated(_subjects[i], true, _severities[i], expiryTime, _reason, false);
        }
    }

    /**
     * @dev Clean up expired blacklist entries
     */
    function cleanupExpiredEntries(address[] calldata _subjects) external {
        for (uint256 i = 0; i < _subjects.length; i++) {
            BlacklistEntry storage entry = blacklistEntries[_subjects[i]];
            if (entry.isBlacklisted && block.timestamp >= entry.expiryTime) {
                entry.isBlacklisted = false;
                entry.reason = "Expired";
                emit BlacklistUpdated(_subjects[i], false, SeverityLevel.LOW, 0, "Expired", false);
            }
        }
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
