// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "../erc3643/interfaces/IInvestorTypeRegistry.sol";
import "../erc3643/interfaces/IIdentityRegistry.sol";
import "../erc3643/interfaces/IERC3643.sol";
import "../compliance/interfaces/ITrustedContracts.sol";
import "./MultiSigWallet.sol";

/// @dev Read-only slice of Token: the investor-type registry it applies.
interface ITokenTypesView {
    function investorTypeRegistry() external view returns (address);
}

/// @dev Read-only slice of ComplianceRules: the token's whitelist source.
interface IRulesWhitelistView {
    function whitelistOracle(address token) external view returns (address);

    function whitelistMode(address token) external view returns (uint8);
}

/// @dev Read-only slice of WhitelistOracle (the 6-tuple, Task 4.10).
interface IWhitelistEntryView {
    function isWhitelisted(address subject) external view returns (bool);

    function getWhitelistInfo(
        address subject
    ) external view returns (bool, uint256, uint256, uint8 tier, string memory, address[] memory);
}

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
    
    /// @dev D45: a lock no Normal holder could transfer or hold is unusable.
    error LockAboveNormalCap(uint256 amount, uint256 cap);
    /// @dev Q7 c: the user's live whitelist entry is below the new type's tier.
    error TierBelowNewType(uint8 tier, uint8 required);
    /// @dev R-416-15: the token applies a registry other than this manager's.
    error RegistryDiverged(address live, address bound);

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
        require(_investorRegistry.code.length > 0, "InvestorRequestManager: Investor registry is not a contract");
        require(_identityRegistry != address(0), "Invalid identity registry");
        require(_identityRegistry.code.length > 0, "InvestorRequestManager: Identity registry is not a contract");
        
        bank = _bank;
        token = _token;
        investorRegistry = IInvestorTypeRegistry(_investorRegistry);
        identityRegistry = IIdentityRegistry(_identityRegistry);
        
        // Initialize default lock requirements
        _initializeLockRequirements();
    }
    
    /**
     * @dev Default lock requirements (Task 4.16, D45): a quarter, a half
     *      and the whole of the Normal cap, so a Normal holder can lock
     *      any of them in one transfer and hold it. The business amounts
     *      are set later with updateLockRequirement, under the same cap.
     */
    function _initializeLockRequirements() private {
        uint256 cap = _lockCap();
        lockRequirements[IInvestorTypeRegistry.InvestorType.Retail] = cap / 4;
        lockRequirements[IInvestorTypeRegistry.InvestorType.Accredited] = cap / 2;
        lockRequirements[IInvestorTypeRegistry.InvestorType.Institutional] = cap;
    }

    /**
     * @dev The investor-type registry the token applies now (R-410-2), or
     *      this manager's when the token names none, has no such getter or
     *      is not a contract (as ComplianceRules._typesOf falls back). Read
     *      at call time: a lock is checked against the caps that gate the
     *      lock transfer. A registry refuses zero caps, so the cap read
     *      here is never zero.
     */
    function _liveTypes() private view returns (IInvestorTypeRegistry) {
        if (token.code.length == 0) return investorRegistry;
        try ITokenTypesView(token).investorTypeRegistry() returns (address live) {
            return live == address(0) ? investorRegistry : IInvestorTypeRegistry(live);
        } catch {
            return investorRegistry;
        }
    }

    /**
     * @dev R-416-15 (fail closed): the type this manager assigns lives in
     *      its immutable registry; once the token applies another one the
     *      manager would approve into a registry the token never reads, or
     *      set a lock by that registry's caps. Requests, approvals and lock
     *      updates refuse instead.
     */
    function _requireSameRegistry() private view {
        IInvestorTypeRegistry live = _liveTypes();
        if (live != investorRegistry) revert RegistryDiverged(address(live), address(investorRegistry));
    }

    /**
     * @dev The largest lock a Normal holder can make on the token: the
     *      smaller of the Normal type's per-transfer and holding caps
     *      (review A1 L2: 10k/100k/1M defaults above the 8k/50k caps made
     *      every request unlockable with the registry wired).
     */
    function _lockCap() private view returns (uint256) {
        IInvestorTypeRegistry.InvestorTypeConfig memory normal = _liveTypes().getInvestorTypeConfig(
            IInvestorTypeRegistry.InvestorType.Normal
        );
        return
            normal.maxTransferAmount < normal.maxHoldingAmount
                ? normal.maxTransferAmount
                : normal.maxHoldingAmount;
    }

    /**
     * @dev Q7 c (Task 4.16): the requested type's required whitelist tier
     *      must not refuse the user on the token's current whitelist
     *      oracle, or approval would strand the user (R-410-6, refused
     *      everywhere including the unlock). Active only once an oracle
     *      is bound and read (not ZkOnly) and the user has a live entry;
     *      with no entry the whitelist, not the tier, decides.
     */
    function _requireTierReachable(address user, IInvestorTypeRegistry.InvestorType requestedType) private view {
        IRulesWhitelistView rules = IRulesWhitelistView(IERC3643(token).compliance());
        address wl = rules.whitelistOracle(token);
        if (wl == address(0) || rules.whitelistMode(token) == 1) return; // none, or ZkOnly
        if (!IWhitelistEntryView(wl).isWhitelisted(user)) return;
        (, , , uint8 tier, , ) = IWhitelistEntryView(wl).getWhitelistInfo(user);
        uint8 required = _liveTypes().getInvestorTypeConfig(requestedType).requiredWhitelistTier;
        if (tier < required) revert TierBelowNewType(tier, required);
    }
    
    /**
     * @dev Request investor status
     * @param requestedType Desired investor type
     */
    function requestInvestorStatus(IInvestorTypeRegistry.InvestorType requestedType) external nonReentrant {
        require(requestedType != IInvestorTypeRegistry.InvestorType.Normal, "Cannot request Normal type");
        require(uint8(requestedType) <= uint8(IInvestorTypeRegistry.InvestorType.Institutional), "Invalid investor type");
        require(!hasActiveRequest[msg.sender], "Active request already exists");
        _requireSameRegistry();
        
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

        // The wallet has no identity: tokens move in and out of it only as a
        // trusted contract on the token (the human counterparty is still
        // checked). This manager is a registrar of the token's ComplianceRules
        // for the MultiSigWallet code hash (plan v2 Task 4.3), so it trusts
        // exactly the wallet it just deployed; a manager that is not a
        // registrar cannot create wallets.
        ITrustedContracts(IERC3643(token).compliance()).addTrustedContract(token, address(wallet));
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
        _requireSameRegistry();
        _requireTierReachable(user, request.requestedType);
        
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
        // R-416-15 extended: a lock set against another registry's cap would
        // outlive the divergence; the manager is inert for setters too.
        _requireSameRegistry();
        uint256 cap = _lockCap();
        if (newAmount > cap) revert LockAboveNormalCap(newAmount, cap);
        
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

