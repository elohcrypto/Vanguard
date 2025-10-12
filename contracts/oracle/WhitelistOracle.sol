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
 * @title WhitelistOracle
 * @dev Oracle contract for managing whitelist consensus and attestations
 */
contract WhitelistOracle is IOracle, Ownable, ReentrancyGuard, Pausable {
    using ECDSA for bytes32;

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
    IOracleManager public oracleManager;
    mapping(address => WhitelistEntry) public whitelistEntries;
    mapping(bytes32 => Attestation) public attestations;
    mapping(address => uint256) public oracleReputation;

    string public oracleName;
    string public oracleDescription;
    bool public active;
    uint256 public totalAttestations;
    uint256 public correctAttestations;

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

    modifier onlyOracleManager() {
        require(msg.sender == address(oracleManager), "WhitelistOracle: Only oracle manager");
        _;
    }

    modifier onlyWhenActive() {
        require(active, "WhitelistOracle: Oracle not active");
        _;
    }

    constructor(address _oracleManager, string memory _name, string memory _description) Ownable(msg.sender) {
        require(_oracleManager != address(0), "WhitelistOracle: Invalid oracle manager");

        oracleManager = IOracleManager(_oracleManager);
        oracleName = _name;
        oracleDescription = _description;
        active = true;
        totalAttestations = 0;
        correctAttestations = 0;
    }

    /**
     * @dev Provide attestation for whitelist status
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
        attestations[_queryId] = Attestation({
            subject: _subject,
            result: _result,
            timestamp: block.timestamp,
            signature: _signature,
            isValid: true,
            metadata: string(_data)
        });

        totalAttestations++;

        // Update whitelist based on consensus
        _updateWhitelistConsensus(_subject, _queryId, _result);

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
        Attestation storage attestation = attestations[_queryId];
        return (
            attestation.result,
            attestation.timestamp,
            msg.sender, // This would be the oracle that provided the attestation
            attestation.signature,
            attestation.isValid
        );
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
     * @dev Add address to whitelist with tier
     */
    function addToWhitelist(
        address _subject,
        uint8 _tier,
        uint256 _duration,
        string calldata _reason
    ) external onlyOwner {
        require(_subject != address(0), "WhitelistOracle: Invalid subject");
        require(_tier >= MIN_TIER && _tier <= MAX_TIER, "WhitelistOracle: Invalid tier");

        uint256 expiryTime = block.timestamp + (_duration > 0 ? _duration : DEFAULT_WHITELIST_DURATION);

        whitelistEntries[_subject] = WhitelistEntry({
            isWhitelisted: true,
            timestamp: block.timestamp,
            expiryTime: expiryTime,
            tier: _tier,
            reason: _reason,
            attestingOracles: new address[](0)
        });

        emit WhitelistUpdated(_subject, true, _tier, expiryTime, _reason);
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
            entry.isWhitelisted && block.timestamp < entry.expiryTime,
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
    function removeFromWhitelist(address _subject, string calldata _reason) external onlyOwner {
        require(whitelistEntries[_subject].isWhitelisted, "WhitelistOracle: Not whitelisted");

        whitelistEntries[_subject].isWhitelisted = false;
        whitelistEntries[_subject].reason = _reason;
        whitelistEntries[_subject].timestamp = block.timestamp;

        emit WhitelistUpdated(_subject, false, 0, 0, _reason);
    }

    /**
     * @dev Update whitelist based on oracle consensus
     */
    function _updateWhitelistConsensus(address _subject, bytes32 _queryId, bool /* _result */) internal {
        // Get consensus from oracle manager
        (bool hasConsensus, bool consensusResult) = oracleManager.checkConsensus(_queryId);

        if (hasConsensus) {
            if (consensusResult && !whitelistEntries[_subject].isWhitelisted) {
                // Add to whitelist with default tier
                whitelistEntries[_subject] = WhitelistEntry({
                    isWhitelisted: true,
                    timestamp: block.timestamp,
                    expiryTime: block.timestamp + DEFAULT_WHITELIST_DURATION,
                    tier: 3, // Default tier
                    reason: "Oracle consensus approval",
                    attestingOracles: new address[](0)
                });

                emit WhitelistUpdated(
                    _subject,
                    true,
                    3,
                    block.timestamp + DEFAULT_WHITELIST_DURATION,
                    "Oracle consensus approval"
                );
                correctAttestations++;
            } else if (!consensusResult && whitelistEntries[_subject].isWhitelisted) {
                // Remove from whitelist
                whitelistEntries[_subject].isWhitelisted = false;
                whitelistEntries[_subject].reason = "Oracle consensus rejection";

                emit WhitelistUpdated(_subject, false, 0, 0, "Oracle consensus rejection");
                correctAttestations++;
            }
        }
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

            uint256 expiryTime = block.timestamp + (_duration > 0 ? _duration : DEFAULT_WHITELIST_DURATION);

            whitelistEntries[_subjects[i]] = WhitelistEntry({
                isWhitelisted: true,
                timestamp: block.timestamp,
                expiryTime: expiryTime,
                tier: _tiers[i],
                reason: _reason,
                attestingOracles: new address[](0)
            });

            emit WhitelistUpdated(_subjects[i], true, _tiers[i], expiryTime, _reason);
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
}
