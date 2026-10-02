// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable2Step.sol";

/// @dev The WhitelistOracle surface the manager writes and reads.
interface IWhitelistOracleWriter {
    function addToWhitelist(address subject, uint8 tier, uint256 duration, string calldata reason) external;
    function removeFromWhitelist(address subject, string calldata reason) external;
    function isWhitelisted(address subject) external view returns (bool);
    /// @dev Public getter of WhitelistOracle.whitelistEntries (the array
    ///      member attestingOracles is omitted by Solidity).
    function whitelistEntries(address subject)
        external
        view
        returns (bool isWhitelisted, uint256 timestamp, uint256 expiryTime, uint8 tier, string memory reason);
}

/// @dev The BlacklistOracle surface the manager writes and reads. `severity` is
///      BlacklistOracle.SeverityLevel, which the ABI encodes as uint8.
interface IBlacklistOracleWriter {
    function addToBlacklist(address subject, uint8 severity, uint256 duration, string calldata reason) external;
    function removeFromBlacklist(address subject, string calldata reason) external;
    function isBlacklisted(address subject) external view returns (bool);
    /// @dev Public getter of BlacklistOracle.blacklistEntries (the array
    ///      member attestingOracles is omitted; emergencyListing follows it).
    function blacklistEntries(address subject)
        external
        view
        returns (
            bool isBlacklisted,
            uint256 timestamp,
            uint256 expiryTime,
            uint8 severity,
            string memory reason,
            bool emergencyListing
        );
}

/**
 * @title DynamicListManager
 * @notice Single entry for moving a member between whitelist and blacklist. The
 *         owner or governance (a ListUpdate proposal, plan 2D.1) calls one of the
 *         four add/remove functions; each records status history here and
 *         writes the WhitelistOracle/BlacklistOracle that ComplianceRules
 *         reads. Membership lives only in the oracles (D6'); getUserStatus
 *         and isProofValid derive from them. The whitelist Merkle root lives
 *         in PrivacyManager (D14, plan 3.3), not here. The oracle owner must
 *         grant this contract the writer role (oracle.setListManager).
 */
contract DynamicListManager is Ownable2Step {
    // User status enum
    enum UserStatus { 
        NONE,        // Not in any list
        WHITELISTED, // Approved user
        BLACKLISTED  // Banned user
    }

    // Status change history
    struct StatusChange {
        uint256 timestamp;
        UserStatus oldStatus;
        UserStatus newStatus;
        string reason;
    }
    
    mapping(address => StatusChange[]) public userStatusHistory;
    mapping(uint256 => StatusChange[]) public identityStatusHistory;

    // Proof expiry duration (default: 30 days)
    uint256 public proofExpiryDuration = 30 days;

    // Governance contract address
    address public governanceContract;

    /// @notice Oracles this manager writes. Unset = every list write reverts.
    IWhitelistOracleWriter public whitelistOracle;
    IBlacklistOracleWriter public blacklistOracle;

    /// @dev Highest BlacklistOracle.SeverityLevel (CRITICAL).
    uint8 private constant MAX_SEVERITY = 3;

    // Events
    event UserStatusChanged(
        address indexed user, 
        uint256 indexed identity, 
        UserStatus oldStatus,
        UserStatus newStatus,
        string reason
    );
    event ProofExpiryDurationUpdated(uint256 oldDuration, uint256 newDuration);
    event GovernanceContractUpdated(address indexed oldGovernance, address indexed newGovernance);
    event OraclesUpdated(address indexed whitelistOracle, address indexed blacklistOracle);

    /**
     * @notice Constructor
     * @param initialOwner Initial owner address
     */
    constructor(address initialOwner) Ownable(initialOwner) {}

    /**
     * @notice Set governance contract address
     * @param _governanceContract Governance contract address
     */
    function setGovernanceContract(address _governanceContract) external onlyOwner {
        require(_governanceContract != address(0), "Invalid governance address");
        address oldGovernance = governanceContract;
        governanceContract = _governanceContract;
        emit GovernanceContractUpdated(oldGovernance, _governanceContract);
    }

    /**
     * @notice Set the oracles the list functions write
     * @param whitelist WhitelistOracle address
     * @param blacklist BlacklistOracle address
     */
    function setOracles(address whitelist, address blacklist) external onlyOwner {
        require(whitelist.code.length > 0, "DynamicListManager: whitelist oracle not a contract");
        require(blacklist.code.length > 0, "DynamicListManager: blacklist oracle not a contract");
        whitelistOracle = IWhitelistOracleWriter(whitelist);
        blacklistOracle = IBlacklistOracleWriter(blacklist);
        emit OraclesUpdated(whitelist, blacklist);
    }

    /// @dev Fail closed: a list write with no oracle to reach gates nothing.
    function _requireOracles() internal view {
        require(
            address(whitelistOracle) != address(0) && address(blacklistOracle) != address(0),
            "DynamicListManager: oracles not set"
        );
    }

    /**
     * @notice Modifier to restrict access to owner or governance
     */
    modifier onlyOwnerOrGovernance() {
        require(
            msg.sender == owner() || msg.sender == governanceContract,
            "Only owner or governance"
        );
        _;
    }

    /**
     * @notice Add user to whitelist (writes WhitelistOracle)
     * @param user User address
     * @param identity User identity ID
     * @param tier Whitelist tier 1..5, passed to the oracle
     * @param duration Seconds until expiry, or type(uint256).max for no
     *        expiry. 0 is rejected: the oracle default is not reachable
     *        through the manager, every write states its duration (D20).
     * @param reason Reason for adding to whitelist
     */
    function addToWhitelist(
        address user,
        uint256 identity,
        uint8 tier,
        uint256 duration,
        string memory reason
    ) external onlyOwnerOrGovernance {
        require(user != address(0), "Invalid user address");
        require(duration != 0, "DynamicListManager: duration required");
        require(
            duration == type(uint256).max || duration <= type(uint256).max - block.timestamp,
            "DynamicListManager: duration too large"
        );
        _requireOracles();
        require(!blacklistOracle.isBlacklisted(user), "User is blacklisted");

        _setStatus(user, identity, getUserStatus(user), UserStatus.WHITELISTED, reason);
        whitelistOracle.addToWhitelist(user, tier, duration, reason);
    }

    /**
     * @notice Add user to blacklist (writes BlacklistOracle). A whitelist entry
     *         is left in place; the blacklist takes precedence while it lasts.
     * @param user User address
     * @param identity User identity ID
     * @param severity BlacklistOracle.SeverityLevel (0 LOW .. 3 CRITICAL)
     * @param duration Seconds until expiry, or type(uint256).max for no
     *        expiry. 0 is rejected: the oracle default is not reachable
     *        through the manager, every write states its duration (D20).
     * @param reason Reason for blacklisting
     */
    function addToBlacklist(
        address user,
        uint256 identity,
        uint8 severity,
        uint256 duration,
        string memory reason
    ) external onlyOwnerOrGovernance {
        require(user != address(0), "Invalid user address");
        require(duration != 0, "DynamicListManager: duration required");
        require(
            duration == type(uint256).max || duration <= type(uint256).max - block.timestamp,
            "DynamicListManager: duration too large"
        );
        require(severity <= MAX_SEVERITY, "Invalid severity");
        _requireOracles();

        _setStatus(user, identity, getUserStatus(user), UserStatus.BLACKLISTED, reason);
        blacklistOracle.addToBlacklist(user, severity, duration, reason);
    }

    /**
     * @notice Remove user from blacklist (writes BlacklistOracle). The user is
     *         WHITELISTED afterwards only if the whitelist oracle still lists them.
     * @param user User address
     * @param identity User identity ID
     * @param reason Reason for removing from blacklist
     */
    function removeFromBlacklist(
        address user,
        uint256 identity,
        string memory reason
    ) external onlyOwnerOrGovernance {
        require(user != address(0), "Invalid user address");
        _requireOracles();
        // A lapsed entry is no longer listed by the oracle but still STORES
        // its flag, which gates the consensus add paths: accept it and clear
        // the flag. Nothing listed and nothing stored: nothing to remove.
        bool listed = blacklistOracle.isBlacklisted(user);
        (bool stored, , , , , ) = blacklistOracle.blacklistEntries(user);
        require(listed || stored, "User not blacklisted");

        UserStatus newStatus = whitelistOracle.isWhitelisted(user) ? UserStatus.WHITELISTED : UserStatus.NONE;
        _setStatus(user, identity, UserStatus.BLACKLISTED, newStatus, reason);
        // No try/catch: a lost writer role or out-of-gas must revert.
        blacklistOracle.removeFromBlacklist(user, reason);
    }

    /**
     * @notice Remove user from whitelist (writes WhitelistOracle)
     * @param user User address
     * @param identity User identity ID
     * @param reason Reason for removing from whitelist
     */
    function removeFromWhitelist(
        address user,
        uint256 identity,
        string memory reason
    ) external onlyOwnerOrGovernance {
        require(user != address(0), "Invalid user address");
        _requireOracles();
        // Same shape as removeFromBlacklist: a lapsed stored entry is clearable.
        bool listed = whitelistOracle.isWhitelisted(user);
        (bool stored, , , , ) = whitelistOracle.whitelistEntries(user);
        require(listed || stored, "User not whitelisted");

        UserStatus oldStatus = getUserStatus(user);
        UserStatus newStatus = oldStatus == UserStatus.BLACKLISTED ? UserStatus.BLACKLISTED : UserStatus.NONE;
        _setStatus(user, identity, oldStatus, newStatus, reason);
        whitelistOracle.removeFromWhitelist(user, reason);
    }

    /// @dev History and event for one change (status itself is the oracles').
    function _setStatus(
        address user,
        uint256 identity,
        UserStatus oldStatus,
        UserStatus newStatus,
        string memory reason
    ) internal {
        _recordStatusChange(user, identity, oldStatus, newStatus, reason);
        emit UserStatusChanged(user, identity, oldStatus, newStatus, reason);
    }

    /**
     * @notice Record status change in history
     * @param user User address
     * @param identity User identity ID
     * @param oldStatus Old status
     * @param newStatus New status
     * @param reason Reason for change
     */
    function _recordStatusChange(
        address user,
        uint256 identity,
        UserStatus oldStatus,
        UserStatus newStatus,
        string memory reason
    ) internal {
        StatusChange memory change = StatusChange({
            timestamp: block.timestamp,
            oldStatus: oldStatus,
            newStatus: newStatus,
            reason: reason
        });

        userStatusHistory[user].push(change);
        identityStatusHistory[identity].push(change);
    }

    /**
     * @notice Check if a proof is still valid against the current oracle status
     * @param user Wallet the proof is about
     * @param proofTimestamp Timestamp when proof was generated
     * @param isWhitelistProof True if whitelist proof, false if blacklist proof
     * @return bool True if proof is still valid: not expired, and for a
     *         whitelist proof the wallet is whitelisted and not blacklisted;
     *         for a blacklist non-membership proof it is not blacklisted
     */
    function isProofValid(
        address user,
        uint256 proofTimestamp,
        bool isWhitelistProof
    ) external view returns (bool) {
        // Check expiry
        if (block.timestamp > proofTimestamp + proofExpiryDuration) {
            return false; // Proof expired
        }

        // Check current status (blacklist wins, see getUserStatus)
        UserStatus currentStatus = getUserStatus(user);

        if (isWhitelistProof) {
            // Whitelist proof only valid if user still whitelisted
            return currentStatus == UserStatus.WHITELISTED;
        } else {
            // Blacklist non-membership proof only valid if user NOT blacklisted
            return currentStatus != UserStatus.BLACKLISTED;
        }
    }

    /**
     * @notice Get user status by address, derived from the oracles (D6'):
     *         blacklisted wins, then whitelisted, else NONE (also when unset).
     * @param user User address
     * @return UserStatus Current status
     */
    function getUserStatus(address user) public view returns (UserStatus) {
        if (address(whitelistOracle) == address(0) || address(blacklistOracle) == address(0)) {
            return UserStatus.NONE;
        }
        if (blacklistOracle.isBlacklisted(user)) return UserStatus.BLACKLISTED;
        if (whitelistOracle.isWhitelisted(user)) return UserStatus.WHITELISTED;
        return UserStatus.NONE;
    }

    /**
     * @notice Get user status history count
     * @param user User address
     * @return uint256 Number of status changes
     */
    function getUserStatusHistoryCount(address user) external view returns (uint256) {
        return userStatusHistory[user].length;
    }

    /**
     * @notice Get identity status history count
     * @param identity User identity ID
     * @return uint256 Number of status changes
     */
    function getIdentityStatusHistoryCount(uint256 identity) external view returns (uint256) {
        return identityStatusHistory[identity].length;
    }

    /**
     * @notice Update proof expiry duration
     * @param newDuration New expiry duration in seconds
     */
    function setProofExpiryDuration(uint256 newDuration) external onlyOwner {
        require(newDuration > 0, "Invalid duration");
        uint256 oldDuration = proofExpiryDuration;
        proofExpiryDuration = newDuration;
        emit ProofExpiryDurationUpdated(oldDuration, newDuration);
    }
}

