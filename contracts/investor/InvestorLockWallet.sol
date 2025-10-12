// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "../erc3643/interfaces/IERC3643.sol";

/**
 * @title InvestorLockWallet
 * @notice 2-of-2 multi-signature wallet for investor token locking
 * @dev Requires both bank and user signatures to unlock tokens
 * @dev Uses ERC-3643 freezePartialTokens/unfreezePartialTokens for on-chain locking
 */
contract InvestorLockWallet is ReentrancyGuard {
    // ========================================
    // IMMUTABLE STATE
    // ========================================
    
    address public immutable user;           // Investor candidate
    address public immutable bank;           // Banking institution
    address public immutable factory;        // Factory that created this wallet
    IERC3643 public immutable vscToken;      // ERC-3643 token
    uint256 public immutable lockAmount;     // Amount to lock
    uint256 public immutable createdAt;      // Creation timestamp
    
    // ========================================
    // MUTABLE STATE
    // ========================================
    
    enum WalletState { Created, Locked, Unlocked }
    WalletState public state;
    
    bool public userSigned;
    bool public bankSigned;
    
    // ========================================
    // EVENTS
    // ========================================
    
    event TokensLocked(address indexed user, uint256 amount, uint256 timestamp);
    event UserSigned(address indexed user, uint256 timestamp);
    event BankSigned(address indexed bank, uint256 timestamp);
    event TokensUnlocked(address indexed user, uint256 amount, uint256 timestamp);
    
    // ========================================
    // MODIFIERS
    // ========================================
    
    modifier onlyUser() {
        require(msg.sender == user, "Only user can call");
        _;
    }
    
    modifier onlyBank() {
        require(msg.sender == bank, "Only bank can call");
        _;
    }
    
    modifier inState(WalletState _state) {
        require(state == _state, "Invalid state");
        _;
    }
    
    // ========================================
    // CONSTRUCTOR
    // ========================================
    
    constructor(
        address _user,
        address _bank,
        address _vscToken,
        uint256 _lockAmount
    ) {
        require(_user != address(0), "Invalid user");
        require(_bank != address(0), "Invalid bank");
        require(_vscToken != address(0), "Invalid token");
        require(_lockAmount > 0, "Invalid amount");
        
        user = _user;
        bank = _bank;
        factory = msg.sender;
        vscToken = IERC3643(_vscToken);
        lockAmount = _lockAmount;
        createdAt = block.timestamp;
        state = WalletState.Created;
    }
    
    // ========================================
    // LOCK TOKENS (USER ACTION)
    // ========================================
    
    /**
     * @notice User locks tokens by freezing them on-chain
     * @dev Uses ERC-3643 freezePartialTokens to freeze tokens
     */
    function lockTokens() external onlyUser inState(WalletState.Created) nonReentrant {
        // Freeze tokens on-chain using ERC-3643
        vscToken.freezePartialTokens(user, lockAmount);
        
        state = WalletState.Locked;
        
        emit TokensLocked(user, lockAmount, block.timestamp);
    }
    
    // ========================================
    // UNLOCK TOKENS (2-OF-2 MULTI-SIG)
    // ========================================
    
    /**
     * @notice User signs to approve unlock
     */
    function userSignUnlock() external onlyUser inState(WalletState.Locked) {
        require(!userSigned, "Already signed");
        userSigned = true;
        
        emit UserSigned(user, block.timestamp);
        
        // If both signed, unlock
        if (bankSigned) {
            _unlockTokens();
        }
    }
    
    /**
     * @notice Bank signs to approve unlock
     */
    function bankSignUnlock() external onlyBank inState(WalletState.Locked) {
        require(!bankSigned, "Already signed");
        bankSigned = true;
        
        emit BankSigned(bank, block.timestamp);
        
        // If both signed, unlock
        if (userSigned) {
            _unlockTokens();
        }
    }
    
    /**
     * @notice Internal function to unlock tokens
     * @dev Requires both signatures
     */
    function _unlockTokens() private {
        require(userSigned && bankSigned, "Need both signatures");
        
        // Unfreeze tokens on-chain using ERC-3643
        vscToken.unfreezePartialTokens(user, lockAmount);
        
        state = WalletState.Unlocked;
        
        emit TokensUnlocked(user, lockAmount, block.timestamp);
    }
    
    // ========================================
    // VIEW FUNCTIONS
    // ========================================
    
    /**
     * @notice Get wallet status
     */
    function getStatus() external view returns (
        WalletState currentState,
        bool userHasSigned,
        bool bankHasSigned,
        uint256 lockedAmount,
        uint256 creationTime
    ) {
        return (
            state,
            userSigned,
            bankSigned,
            lockAmount,
            createdAt
        );
    }
    
    /**
     * @notice Check if tokens are currently frozen
     */
    function areTokensFrozen() external view returns (bool) {
        uint256 frozenTokens = vscToken.frozenTokens(user);
        return frozenTokens >= lockAmount;
    }
    
    /**
     * @notice Get user's free balance
     */
    function getUserFreeBalance() external view returns (uint256) {
        return vscToken.getFreeBalance(user);
    }
}

