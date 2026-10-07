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
 * @title ListOracleBase
 * @dev What WhitelistOracle and BlacklistOracle had in duplicate (plan Task
 *      4.8, split by inheritance): the oracle identity and status, the
 *      reputation the OracleManager sets, signature checks, the list-manager
 *      writer role, the pause switch and the verdict rules of plan 2F.3.
 *      Each list oracle keeps its own entries, attestations, consensus
 *      application and reason strings; each is deployed on its own.
 */
abstract contract ListOracleBase is IOracle, Ownable, ReentrancyGuard, Pausable {
    /// @notice A resolved consensus was replayed against an address, or under a
    ///         policy, the query was not raised for. Binds queryId consensus to
    ///         its subject and query type.
    error QuerySubjectMismatch();
    /// @notice This resolved query's verdict was already applied here (plan 2F.3).
    error VerdictAlreadyApplied();
    /// @notice The verdict resolved more than `maxVerdictAge` ago.
    error VerdictExpired();
    /// @notice The subject was written at or after the verdict resolved.
    error VerdictSuperseded();
    /// @notice `maxVerdictAge` outside [MIN_VERDICT_AGE, MAX_VERDICT_AGE].
    error InvalidVerdictAge();
    using ECDSA for bytes32;

    // State variables
    IOracleManager public oracleManager;
    /// @notice Last oracle to attest each query; serves `getAttestation`.
    mapping(bytes32 => address) public lastAttester;

    /// @notice Verdict rules (plan 2F.3, review H3): a resolved OracleManager
    ///         query is applied at most once, only within `maxVerdictAge` of
    ///         resolving, and only if it resolved after the subject's last
    ///         write. Ordered by resolution time (review MEDIUM-1):
    ///         `lastWriteAt` is block.timestamp for an owner, list-manager,
    ///         emergency (BlacklistOracle) or batch write and the verdict's
    ///         resolvedAt for a consensus application (a no-op included), so
    ///         an older verdict applied late never beats a newer one.
    ///         `entry.timestamp` is the readers' write time and is not the
    ///         ordering clock.
    mapping(bytes32 => bool) public verdictApplied;
    mapping(address => uint256) public lastWriteAt;
    uint256 public maxVerdictAge = 1 days;
    uint256 public constant MIN_VERDICT_AGE = 1 hours;
    uint256 public constant MAX_VERDICT_AGE = 30 days;
    event MaxVerdictAgeUpdated(uint256 previous, uint256 current);
    mapping(address => uint256) public oracleReputation;

    string public oracleName;
    string public oracleDescription;
    bool public active;
    uint256 public totalAttestations;
    uint256 public correctAttestations;

    /// @notice Duration sentinel: store expiryTime 0, the entry never expires
    uint256 public constant NO_EXPIRY = type(uint256).max;

    /// @notice DynamicListManager allowed to write single list entries, so a
    ///         governance ListUpdate vote reaches this oracle (plan 2D.1).
    ///         Set by the oracle owner; zero means no writer besides the owner.
    address public listManager;

    event ListManagerUpdated(address indexed previous, address indexed current);

    /// @dev Only the OracleManager; each oracle names itself in the reason.
    ///      Declared without a body: every list oracle MUST override it with
    ///      a body that restricts the caller to its oracleManager, or
    ///      updateReputation is open to anyone. The two overrides
    ///      (WhitelistOracle, BlacklistOracle) are not virtual.
    modifier onlyOracleManager() virtual;

    /// @notice Grant (or clear, with address(0)) the list-manager writer role.
    function setListManager(address _listManager) external onlyOwner {
        emit ListManagerUpdated(listManager, _listManager);
        listManager = _listManager;
    }

    /// @notice Owner sets how long a resolved verdict stays usable.
    function setMaxVerdictAge(uint256 _maxAge) external onlyOwner {
        if (_maxAge < MIN_VERDICT_AGE || _maxAge > MAX_VERDICT_AGE) revert InvalidVerdictAge();
        emit MaxVerdictAgeUpdated(maxVerdictAge, _maxAge);
        maxVerdictAge = _maxAge;
    }

    /**
     * @dev Consume a resolved verdict for `_subject`: refused if already
     *      applied, if the subject was written at or after it resolved, or
     *      if it resolved more than maxVerdictAge ago; otherwise marked
     *      applied (even when it changes nothing) and lastWriteAt moves to
     *      its resolvedAt.
     */
    function _consumeVerdict(bytes32 _queryId, address _subject, uint256 _resolvedAt) internal {
        if (verdictApplied[_queryId]) revert VerdictAlreadyApplied();
        if (_resolvedAt <= lastWriteAt[_subject]) revert VerdictSuperseded();
        if (block.timestamp > _resolvedAt + maxVerdictAge) revert VerdictExpired();
        verdictApplied[_queryId] = true;
        lastWriteAt[_subject] = _resolvedAt;
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

        // The attestation is the sender's (review N-7, as ConsensusOracle):
        // the signer must be msg.sender, not any active oracle.
        address signer = ECDSA.recover(ethSignedMessageHash, _signature);
        return signer == msg.sender && oracleManager.isActiveOracle(signer);
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
