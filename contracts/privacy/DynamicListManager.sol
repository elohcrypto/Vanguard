// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable.sol";

/**
 * @title DynamicListManager
 * @notice Manages dynamic whitelist and blacklist with governance integration
 * @dev Tracks user status changes and invalidates old proofs when status changes
 */
contract DynamicListManager is Ownable {
    // User status enum
    enum UserStatus { 
        NONE,        // Not in any list
        WHITELISTED, // Approved user
        BLACKLISTED  // Banned user
    }

    // List version tracking (increments on each update)
    uint256 public whitelistVersion;
    uint256 public blacklistVersion;

    // Current Merkle roots
    bytes32 public currentWhitelistRoot;
    bytes32 public currentBlacklistRoot;

    // Historical roots (for audit trail)
    mapping(uint256 => bytes32) public whitelistRootHistory;
    mapping(uint256 => bytes32) public blacklistRootHistory;
    mapping(uint256 => uint256) public whitelistRootTimestamp;
    mapping(uint256 => uint256) public blacklistRootTimestamp;

    // User status tracking
    mapping(address => UserStatus) public userStatus;
    mapping(uint256 => UserStatus) public identityStatus; // By identity ID

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

    // Events
    event WhitelistUpdated(uint256 indexed version, bytes32 newRoot, uint256 timestamp);
    event BlacklistUpdated(uint256 indexed version, bytes32 newRoot, uint256 timestamp);
    event UserStatusChanged(
        address indexed user, 
        uint256 indexed identity, 
        UserStatus oldStatus,
        UserStatus newStatus,
        string reason
    );
    event ProofExpiryDurationUpdated(uint256 oldDuration, uint256 newDuration);
    event GovernanceContractUpdated(address indexed oldGovernance, address indexed newGovernance);

    /**
     * @notice Constructor
     * @param initialOwner Initial owner address
     */
    constructor(address initialOwner) Ownable(initialOwner) {
        whitelistVersion = 1;
        blacklistVersion = 1;
    }

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
     * @notice Update whitelist Merkle root
     * @param newRoot New Merkle root
     */
    function updateWhitelist(bytes32 newRoot) external onlyOwnerOrGovernance {
        whitelistVersion++;
        currentWhitelistRoot = newRoot;
        whitelistRootHistory[whitelistVersion] = newRoot;
        whitelistRootTimestamp[whitelistVersion] = block.timestamp;

        emit WhitelistUpdated(whitelistVersion, newRoot, block.timestamp);
    }

    /**
     * @notice Update blacklist Merkle root
     * @param newRoot New Merkle root
     */
    function updateBlacklist(bytes32 newRoot) external onlyOwnerOrGovernance {
        blacklistVersion++;
        currentBlacklistRoot = newRoot;
        blacklistRootHistory[blacklistVersion] = newRoot;
        blacklistRootTimestamp[blacklistVersion] = block.timestamp;

        emit BlacklistUpdated(blacklistVersion, newRoot, block.timestamp);
    }

    /**
     * @notice Add user to whitelist
     * @param user User address
     * @param identity User identity ID
     * @param reason Reason for adding to whitelist
     */
    function addToWhitelist(
        address user, 
        uint256 identity,
        string memory reason
    ) external onlyOwnerOrGovernance {
        require(user != address(0), "Invalid user address");
        require(userStatus[user] != UserStatus.BLACKLISTED, "User is blacklisted");

        UserStatus oldStatus = userStatus[user];
        userStatus[user] = UserStatus.WHITELISTED;
        identityStatus[identity] = UserStatus.WHITELISTED;

        // Record status change
        _recordStatusChange(user, identity, oldStatus, UserStatus.WHITELISTED, reason);

        emit UserStatusChanged(user, identity, oldStatus, UserStatus.WHITELISTED, reason);
    }

    /**
     * @notice Add user to blacklist (removes from whitelist)
     * @param user User address
     * @param identity User identity ID
     * @param reason Reason for blacklisting
     */
    function addToBlacklist(
        address user, 
        uint256 identity,
        string memory reason
    ) external onlyOwnerOrGovernance {
        require(user != address(0), "Invalid user address");

        UserStatus oldStatus = userStatus[user];
        userStatus[user] = UserStatus.BLACKLISTED;
        identityStatus[identity] = UserStatus.BLACKLISTED;

        // Record status change
        _recordStatusChange(user, identity, oldStatus, UserStatus.BLACKLISTED, reason);

        emit UserStatusChanged(user, identity, oldStatus, UserStatus.BLACKLISTED, reason);
    }

    /**
     * @notice Remove user from blacklist (back to whitelist)
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
        require(userStatus[user] == UserStatus.BLACKLISTED, "User not blacklisted");

        UserStatus oldStatus = userStatus[user];
        userStatus[user] = UserStatus.WHITELISTED;
        identityStatus[identity] = UserStatus.WHITELISTED;

        // Record status change
        _recordStatusChange(user, identity, oldStatus, UserStatus.WHITELISTED, reason);

        emit UserStatusChanged(user, identity, oldStatus, UserStatus.WHITELISTED, reason);
    }

    /**
     * @notice Remove user from whitelist (back to NONE)
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
        require(userStatus[user] == UserStatus.WHITELISTED, "User not whitelisted");

        UserStatus oldStatus = userStatus[user];
        userStatus[user] = UserStatus.NONE;
        identityStatus[identity] = UserStatus.NONE;

        // Record status change
        _recordStatusChange(user, identity, oldStatus, UserStatus.NONE, reason);

        emit UserStatusChanged(user, identity, oldStatus, UserStatus.NONE, reason);
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
     * @notice Check if proof is still valid
     * @param identity User identity ID
     * @param proofTimestamp Timestamp when proof was generated
     * @param isWhitelistProof True if whitelist proof, false if blacklist proof
     * @return bool True if proof is still valid
     */
    function isProofValid(
        uint256 identity,
        uint256 proofTimestamp,
        bool isWhitelistProof
    ) external view returns (bool) {
        // Check expiry
        if (block.timestamp > proofTimestamp + proofExpiryDuration) {
            return false; // Proof expired
        }

        // Check current status
        UserStatus currentStatus = identityStatus[identity];

        if (isWhitelistProof) {
            // Whitelist proof only valid if user still whitelisted
            return currentStatus == UserStatus.WHITELISTED;
        } else {
            // Blacklist non-membership proof only valid if user NOT blacklisted
            return currentStatus != UserStatus.BLACKLISTED;
        }
    }

    /**
     * @notice Get user status by address
     * @param user User address
     * @return UserStatus Current status
     */
    function getUserStatus(address user) external view returns (UserStatus) {
        return userStatus[user];
    }

    /**
     * @notice Get user status by identity ID
     * @param identity User identity ID
     * @return UserStatus Current status
     */
    function getIdentityStatus(uint256 identity) external view returns (UserStatus) {
        return identityStatus[identity];
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

