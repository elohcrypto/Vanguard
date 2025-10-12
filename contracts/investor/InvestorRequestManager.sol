// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "../erc3643/interfaces/IInvestorTypeRegistry.sol";
import "../erc3643/interfaces/IIdentityRegistry.sol";
import "./MultiSigWallet.sol";

/**
 * @title InvestorRequestManager
 * @dev Manages investor status requests with multi-sig wallet token locking
 * @notice Handles complete investor onboarding workflow
 * @author Vanguard StableCoin Team
 */
contract InvestorRequestManager is Ownable, ReentrancyGuard {
    // Request status enumeration
    enum RequestStatus {
        None,               // 0 - No request exists
        Pending,            // 1 - Request created, awaiting wallet creation
        WalletCreated,      // 2 - Multi-sig wallet created
        TokensLocked,       // 3 - Required tokens locked
        Approved,           // 4 - Request approved, investor type assigned
        Rejected            // 5 - Request rejected
    }
    
    // Investor request structure
    struct InvestorRequest {
        address user;
        IInvestorTypeRegistry.InvestorType requestedType;
        uint256 requiredLockAmount;
        address multiSigWallet;
        RequestStatus status;
        uint256 createdAt;
        uint256 approvedAt;
        string rejectionReason;
    }
    
    // State variables
    mapping(address => InvestorRequest) public requests;
    mapping(IInvestorTypeRegistry.InvestorType => uint256) public lockRequirements;
    
    address public immutable bank;
    address public immutable token;
    IInvestorTypeRegistry public immutable investorRegistry;
    IIdentityRegistry public immutable identityRegistry;
    
    // Tracking
    address[] public allRequests;
    mapping(address => bool) public hasActiveRequest;
    
    // Events
    event InvestorRequestCreated(
        address indexed user,
        IInvestorTypeRegistry.InvestorType requestedType,
        uint256 requiredLockAmount,
        uint256 timestamp
    );
    event MultiSigWalletCreated(
        address indexed user,
        address indexed wallet,
        uint256 timestamp
    );
    event TokensLocked(
        address indexed user,
        address indexed wallet,
        uint256 amount,
        uint256 timestamp
    );
    event InvestorRequestApproved(
        address indexed user,
        IInvestorTypeRegistry.InvestorType investorType,
        uint256 timestamp
    );
    event InvestorRequestRejected(
        address indexed user,
        string reason,
        uint256 timestamp
    );
    event LockRequirementUpdated(
        IInvestorTypeRegistry.InvestorType investorType,
        uint256 oldAmount,
        uint256 newAmount
    );
    event InvestorDowngraded(
        address indexed user,
        IInvestorTypeRegistry.InvestorType oldType,
        IInvestorTypeRegistry.InvestorType newType,
        uint256 timestamp
    );
    
    /**
     * @dev Constructor
     * @param _bank Bank address (compliance officer)
     * @param _token Token contract address
     * @param _investorRegistry InvestorTypeRegistry address
     * @param _identityRegistry IdentityRegistry address
     */
    constructor(
        address _bank,
        address _token,
        address _investorRegistry,
        address _identityRegistry
    ) Ownable(msg.sender) {
        require(_bank != address(0), "Invalid bank address");
        require(_token != address(0), "Invalid token address");
        require(_investorRegistry != address(0), "Invalid investor registry");
        require(_identityRegistry != address(0), "Invalid identity registry");
        
        bank = _bank;
        token = _token;
        investorRegistry = IInvestorTypeRegistry(_investorRegistry);
        identityRegistry = IIdentityRegistry(_identityRegistry);
        
        // Initialize default lock requirements
        _initializeLockRequirements();
    }
    
    /**
     * @dev Initialize default lock requirements for each investor type
     */
    function _initializeLockRequirements() private {
        lockRequirements[IInvestorTypeRegistry.InvestorType.Retail] = 10_000 * 10**18;        // 10,000 tokens
        lockRequirements[IInvestorTypeRegistry.InvestorType.Accredited] = 100_000 * 10**18;   // 100,000 tokens
        lockRequirements[IInvestorTypeRegistry.InvestorType.Institutional] = 1_000_000 * 10**18; // 1,000,000 tokens
    }
    
    /**
     * @dev Request investor status
     * @param requestedType Desired investor type
     */
    function requestInvestorStatus(IInvestorTypeRegistry.InvestorType requestedType) external nonReentrant {
        require(requestedType != IInvestorTypeRegistry.InvestorType.Normal, "Cannot request Normal type");
        require(uint8(requestedType) <= uint8(IInvestorTypeRegistry.InvestorType.Institutional), "Invalid investor type");
        require(!hasActiveRequest[msg.sender], "Active request already exists");
        
        // Verify KYC/AML compliance
        require(identityRegistry.isVerified(msg.sender), "KYC/AML verification required");
        
        // Get current investor type
        IInvestorTypeRegistry.InvestorType currentType = investorRegistry.getInvestorType(msg.sender);
        require(currentType == IInvestorTypeRegistry.InvestorType.Normal, "Already an investor");
        
        // Get required lock amount
        uint256 requiredAmount = lockRequirements[requestedType];
        require(requiredAmount > 0, "Lock requirement not set");
        
        // Create request
        requests[msg.sender] = InvestorRequest({
            user: msg.sender,
            requestedType: requestedType,
            requiredLockAmount: requiredAmount,
            multiSigWallet: address(0),
            status: RequestStatus.Pending,
            createdAt: block.timestamp,
            approvedAt: 0,
            rejectionReason: ""
        });
        
        allRequests.push(msg.sender);
        hasActiveRequest[msg.sender] = true;
        
        emit InvestorRequestCreated(msg.sender, requestedType, requiredAmount, block.timestamp);
    }
    
    /**
     * @dev Create multi-sig wallet for user (bank only)
     * @param user User address
     */
    function createMultiSigWallet(address user) external nonReentrant {
        require(msg.sender == bank || msg.sender == owner(), "Only bank can create wallet");
        
        InvestorRequest storage request = requests[user];
        require(request.status == RequestStatus.Pending, "Invalid request status");
        require(request.multiSigWallet == address(0), "Wallet already created");
        
        // Deploy new MultiSigWallet
        MultiSigWallet wallet = new MultiSigWallet(bank, user, token);
        
        // Update request
        request.multiSigWallet = address(wallet);
        request.status = RequestStatus.WalletCreated;
        
        emit MultiSigWalletCreated(user, address(wallet), block.timestamp);
    }
    
    /**
     * @dev Confirm tokens locked (called after user locks tokens)
     * @notice User must approve tokens and call lockTokens on MultiSigWallet first
     */
    function confirmTokensLocked() external nonReentrant {
        InvestorRequest storage request = requests[msg.sender];
        require(request.status == RequestStatus.WalletCreated, "Wallet not created yet");
        require(request.multiSigWallet != address(0), "No wallet assigned");
        
        // Verify tokens are locked in multi-sig wallet
        MultiSigWallet wallet = MultiSigWallet(request.multiSigWallet);
        uint256 lockedAmount = wallet.getLockedBalance();
        
        require(lockedAmount >= request.requiredLockAmount, "Insufficient tokens locked");
        
        // Update status
        request.status = RequestStatus.TokensLocked;
        
        emit TokensLocked(msg.sender, request.multiSigWallet, lockedAmount, block.timestamp);
    }
    
    /**
     * @dev Approve investor request (bank only)
     * @param user User address
     */
    function approveRequest(address user) external nonReentrant {
        require(msg.sender == bank || msg.sender == owner(), "Only bank can approve");
        
        InvestorRequest storage request = requests[user];
        require(request.status == RequestStatus.TokensLocked, "Tokens not locked");
        
        // Verify tokens still locked
        MultiSigWallet wallet = MultiSigWallet(request.multiSigWallet);
        require(wallet.getLockedBalance() >= request.requiredLockAmount, "Tokens no longer locked");
        
        // Assign investor type
        investorRegistry.assignInvestorType(user, request.requestedType);
        
        // Update request
        request.status = RequestStatus.Approved;
        request.approvedAt = block.timestamp;
        hasActiveRequest[user] = false;
        
        emit InvestorRequestApproved(user, request.requestedType, block.timestamp);
    }
    
    /**
     * @dev Reject investor request (bank only)
     * @param user User address
     * @param reason Rejection reason
     */
    function rejectRequest(address user, string calldata reason) external {
        require(msg.sender == bank || msg.sender == owner(), "Only bank can reject");
        require(bytes(reason).length > 0, "Reason required");
        
        InvestorRequest storage request = requests[user];
        require(
            request.status == RequestStatus.Pending ||
            request.status == RequestStatus.WalletCreated ||
            request.status == RequestStatus.TokensLocked,
            "Cannot reject this request"
        );
        
        // Update request
        request.status = RequestStatus.Rejected;
        request.rejectionReason = reason;
        hasActiveRequest[user] = false;
        
        emit InvestorRequestRejected(user, reason, block.timestamp);
    }
    
    /**
     * @dev Update lock requirement for investor type (owner only)
     * @param investorType Investor type
     * @param newAmount New lock amount
     */
    function updateLockRequirement(
        IInvestorTypeRegistry.InvestorType investorType,
        uint256 newAmount
    ) external onlyOwner {
        require(investorType != IInvestorTypeRegistry.InvestorType.Normal, "Cannot set for Normal type");
        require(newAmount > 0, "Amount must be greater than 0");
        
        uint256 oldAmount = lockRequirements[investorType];
        lockRequirements[investorType] = newAmount;
        
        emit LockRequirementUpdated(investorType, oldAmount, newAmount);
    }
    
    /**
     * @dev Get request details
     * @param user User address
     * @return requestedType Requested investor type
     * @return requiredLockAmount Required lock amount
     * @return multiSigWallet Multi-sig wallet address
     * @return status Request status
     * @return createdAt Creation timestamp
     * @return approvedAt Approval timestamp
     * @return rejectionReason Rejection reason
     */
    function getRequest(address user) external view returns (
        IInvestorTypeRegistry.InvestorType requestedType,
        uint256 requiredLockAmount,
        address multiSigWallet,
        RequestStatus status,
        uint256 createdAt,
        uint256 approvedAt,
        string memory rejectionReason
    ) {
        InvestorRequest memory request = requests[user];
        return (
            request.requestedType,
            request.requiredLockAmount,
            request.multiSigWallet,
            request.status,
            request.createdAt,
            request.approvedAt,
            request.rejectionReason
        );
    }
    
    /**
     * @dev Get all requests count
     * @return Total number of requests
     */
    function getRequestCount() external view returns (uint256) {
        return allRequests.length;
    }
    
    /**
     * @dev Get request by index
     * @param index Request index
     * @return user User address
     */
    function getRequestByIndex(uint256 index) external view returns (address user) {
        require(index < allRequests.length, "Index out of bounds");
        return allRequests[index];
    }
}

