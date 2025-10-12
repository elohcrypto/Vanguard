// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "./InvestorLockWallet.sol";
import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * @title InvestorLockWalletFactory
 * @notice Factory for creating investor lock wallets
 * @dev Creates 2-of-2 multi-sig wallets for investor onboarding
 */
contract InvestorLockWalletFactory is AccessControl, ReentrancyGuard {
    // ========================================
    // ROLES
    // ========================================
    
    bytes32 public constant ADMIN_ROLE = keccak256("ADMIN_ROLE");
    bytes32 public constant BANK_ROLE = keccak256("BANK_ROLE");
    
    // ========================================
    // STATE VARIABLES
    // ========================================
    
    address public immutable vscToken;
    
    // Investor type requirements
    enum InvestorType { RETAIL, ACCREDITED, INSTITUTIONAL }
    
    struct LockRequirement {
        uint256 minLockAmount;
        uint256 lockDuration;  // Minimum lock duration in seconds
    }
    
    mapping(InvestorType => LockRequirement) public lockRequirements;
    
    // User => Lock Wallet
    mapping(address => address) public userLockWallet;
    
    // Lock Wallet => User
    mapping(address => address) public walletToUser;
    
    // User => Investor Type
    mapping(address => InvestorType) public userInvestorType;
    
    // User => Approved
    mapping(address => bool) public isApprovedInvestor;
    
    // ========================================
    // EVENTS
    // ========================================
    
    event LockWalletCreated(
        address indexed user,
        address indexed bank,
        address walletAddress,
        InvestorType investorType,
        uint256 lockAmount
    );
    
    event InvestorApproved(
        address indexed user,
        InvestorType investorType,
        uint256 timestamp
    );
    
    event LockRequirementUpdated(
        InvestorType investorType,
        uint256 minLockAmount,
        uint256 lockDuration
    );
    
    // ========================================
    // CONSTRUCTOR
    // ========================================
    
    constructor(address _vscToken) {
        require(_vscToken != address(0), "Invalid token");
        
        vscToken = _vscToken;
        
        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
        _grantRole(ADMIN_ROLE, msg.sender);
        
        // Set default lock requirements
        lockRequirements[InvestorType.RETAIL] = LockRequirement({
            minLockAmount: 10_000 ether,      // 10,000 VSC
            lockDuration: 30 days
        });
        
        lockRequirements[InvestorType.ACCREDITED] = LockRequirement({
            minLockAmount: 50_000 ether,      // 50,000 VSC
            lockDuration: 90 days
        });
        
        lockRequirements[InvestorType.INSTITUTIONAL] = LockRequirement({
            minLockAmount: 100_000 ether,     // 100,000 VSC
            lockDuration: 180 days
        });
    }
    
    // ========================================
    // WALLET CREATION
    // ========================================
    
    /**
     * @notice Bank creates lock wallet for investor candidate
     * @param user Investor candidate address
     * @param investorType Type of investor (RETAIL/ACCREDITED/INSTITUTIONAL)
     */
    function createLockWallet(
        address user,
        InvestorType investorType
    ) external onlyRole(BANK_ROLE) nonReentrant returns (address) {
        require(user != address(0), "Invalid user");
        require(userLockWallet[user] == address(0), "Wallet already exists");
        
        LockRequirement memory requirement = lockRequirements[investorType];
        
        // Deploy new lock wallet
        InvestorLockWallet wallet = new InvestorLockWallet(
            user,
            msg.sender,  // bank
            vscToken,
            requirement.minLockAmount
        );
        
        address walletAddress = address(wallet);
        
        // Store mappings
        userLockWallet[user] = walletAddress;
        walletToUser[walletAddress] = user;
        userInvestorType[user] = investorType;
        
        emit LockWalletCreated(
            user,
            msg.sender,
            walletAddress,
            investorType,
            requirement.minLockAmount
        );
        
        return walletAddress;
    }
    
    // ========================================
    // INVESTOR APPROVAL
    // ========================================
    
    /**
     * @notice Bank approves investor after tokens are locked
     * @param user Investor candidate address
     */
    function approveInvestor(address user) external onlyRole(BANK_ROLE) {
        require(user != address(0), "Invalid user");
        require(userLockWallet[user] != address(0), "No lock wallet");
        require(!isApprovedInvestor[user], "Already approved");
        
        InvestorLockWallet wallet = InvestorLockWallet(userLockWallet[user]);
        
        // Verify tokens are locked
        require(wallet.state() == InvestorLockWallet.WalletState.Locked, "Tokens not locked");
        require(wallet.areTokensFrozen(), "Tokens not frozen on-chain");
        
        // Approve investor
        isApprovedInvestor[user] = true;
        
        emit InvestorApproved(user, userInvestorType[user], block.timestamp);
    }
    
    // ========================================
    // ADMIN FUNCTIONS
    // ========================================
    
    /**
     * @notice Update lock requirements for investor type
     */
    function updateLockRequirement(
        InvestorType investorType,
        uint256 minLockAmount,
        uint256 lockDuration
    ) external onlyRole(ADMIN_ROLE) {
        require(minLockAmount > 0, "Invalid amount");
        
        lockRequirements[investorType] = LockRequirement({
            minLockAmount: minLockAmount,
            lockDuration: lockDuration
        });
        
        emit LockRequirementUpdated(investorType, minLockAmount, lockDuration);
    }
    
    /**
     * @notice Register bank
     */
    function registerBank(address bank) external onlyRole(ADMIN_ROLE) {
        require(bank != address(0), "Invalid bank");
        _grantRole(BANK_ROLE, bank);
    }
    
    /**
     * @notice Remove bank
     */
    function removeBank(address bank) external onlyRole(ADMIN_ROLE) {
        _revokeRole(BANK_ROLE, bank);
    }
    
    // ========================================
    // VIEW FUNCTIONS
    // ========================================
    
    /**
     * @notice Get lock requirement for investor type
     */
    function getLockRequirement(InvestorType investorType) 
        external 
        view 
        returns (uint256 minLockAmount, uint256 lockDuration) 
    {
        LockRequirement memory requirement = lockRequirements[investorType];
        return (requirement.minLockAmount, requirement.lockDuration);
    }
    
    /**
     * @notice Check if user is approved investor
     */
    function isInvestor(address user) external view returns (bool) {
        return isApprovedInvestor[user];
    }
    
    /**
     * @notice Get user's lock wallet address
     */
    function getLockWallet(address user) external view returns (address) {
        return userLockWallet[user];
    }
    
    /**
     * @notice Get user's investor type
     */
    function getInvestorType(address user) external view returns (InvestorType) {
        return userInvestorType[user];
    }
}

