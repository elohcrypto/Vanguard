// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "./MultiSigEscrowWallet.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "../erc3643/interfaces/IIdentityRegistry.sol";
import "../compliance/interfaces/IComplianceRules.sol";

/**
 * @title EscrowWalletFactory
 * @notice Factory for creating one-time-use multi-signature escrow wallets
 * @dev Only registered investors can create escrow wallets
 * @dev Payer and Payee must have valid KYC/AML (OnchainID with verified identity)
 */
contract EscrowWalletFactory is AccessControl, ReentrancyGuard {
    // ========================================
    // ROLES
    // ========================================
    
    bytes32 public constant INVESTOR_ROLE = keccak256("INVESTOR_ROLE");
    bytes32 public constant ADMIN_ROLE = keccak256("ADMIN_ROLE");
    
    // ========================================
    // STATE VARIABLES
    // ========================================
    
    IERC20 public immutable vscToken;
    IIdentityRegistry public identityRegistry;  // KYC/AML verification
    IComplianceRules public complianceRules;    // Compliance rules (for trusted contracts)
    address public owner;
    address public ownerWallet;  // Where owner fees are sent

    // Fee rates (basis points: 10000 = 100%)
    uint256 public constant INVESTOR_FEE_RATE = 300;   // 3%
    uint256 public constant OWNER_FEE_RATE = 200;      // 2%
    uint256 public constant TOTAL_FEE_RATE = 500;      // 5%
    uint256 public constant FEE_DENOMINATOR = 10000;   // 100%

    uint256 private _nextPaymentId = 1;
    
    // ========================================
    // MAPPINGS
    // ========================================
    
    mapping(uint256 => address) public paymentToWallet;
    mapping(address => uint256[]) public payerPayments;
    mapping(address => uint256[]) public payeePayments;
    mapping(address => uint256[]) public investorPayments;
    
    // Investor profiles (from Option 23 - INVESTOR ONBOARDING SYSTEM)
    mapping(address => InvestorProfile) public investors;
    
    struct InvestorProfile {
        address investorAddress;
        address walletAddress;      // Investor's wallet for receiving fees
        bool isActive;
        uint256 totalEscrowsCreated;
        uint256 totalFeesEarned;
        uint256 registeredAt;
    }
    
    // ========================================
    // EVENTS
    // ========================================
    
    event EscrowWalletCreated(
        uint256 indexed paymentId,
        address indexed walletAddress,
        address indexed investor,
        address payer,
        address payee,
        uint256 amount,
        uint256 investorFee,
        uint256 ownerFee
    );
    
    event InvestorRegistered(
        address indexed investor,
        address indexed walletAddress
    );
    
    event InvestorDeactivated(address indexed investor);
    
    event FundsReceived(
        uint256 indexed paymentId,
        address indexed payer,
        uint256 totalAmount
    );
    
    // ========================================
    // CONSTRUCTOR
    // ========================================
    
    constructor(
        address _vscToken,
        address _ownerWallet,
        address _identityRegistry,
        address _complianceRules
    ) {
        require(_vscToken != address(0), "Invalid token");
        require(_ownerWallet != address(0), "Invalid owner wallet");
        require(_identityRegistry != address(0), "Invalid identity registry");
        require(_complianceRules != address(0), "Invalid compliance rules");

        vscToken = IERC20(_vscToken);
        owner = msg.sender;
        ownerWallet = _ownerWallet;
        identityRegistry = IIdentityRegistry(_identityRegistry);
        complianceRules = IComplianceRules(_complianceRules);

        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
        _grantRole(ADMIN_ROLE, msg.sender);
    }

    /**
     * @notice Set ComplianceRules contract (admin only)
     * @param _complianceRules Address of ComplianceRules contract
     */
    function setComplianceRules(address _complianceRules) external onlyRole(ADMIN_ROLE) {
        require(_complianceRules != address(0), "Invalid compliance rules");
        complianceRules = IComplianceRules(_complianceRules);
    }
    
    // ========================================
    // INVESTOR MANAGEMENT
    // ========================================
    
    /**
     * @notice Register investor from INVESTOR ONBOARDING SYSTEM (Option 23)
     * @param investor Investor's address
     * @param walletAddress Investor's wallet for receiving fees
     */
    function registerInvestor(
        address investor,
        address walletAddress
    ) external onlyRole(ADMIN_ROLE) {
        require(investor != address(0), "Invalid investor");
        require(walletAddress != address(0), "Invalid wallet");
        require(!investors[investor].isActive, "Already registered");
        
        investors[investor] = InvestorProfile({
            investorAddress: investor,
            walletAddress: walletAddress,
            isActive: true,
            totalEscrowsCreated: 0,
            totalFeesEarned: 0,
            registeredAt: block.timestamp
        });
        
        _grantRole(INVESTOR_ROLE, investor);
        
        emit InvestorRegistered(investor, walletAddress);
    }
    
    /**
     * @notice Deactivate investor
     */
    function deactivateInvestor(address investor) external onlyRole(ADMIN_ROLE) {
        require(investors[investor].isActive, "Not active");
        
        investors[investor].isActive = false;
        _revokeRole(INVESTOR_ROLE, investor);
        
        emit InvestorDeactivated(investor);
    }
    
    /**
     * @notice Check if address is active investor
     */
    function isInvestor(address account) public view returns (bool) {
        return hasRole(INVESTOR_ROLE, account) && investors[account].isActive;
    }
    
    // ========================================
    // ESCROW WALLET CREATION
    // ========================================
    
    /**
     * @notice Investor creates one-time-use escrow wallet for a payment
     * @dev Payer and Payee must have valid KYC/AML (OnchainID with verified identity)
     * @param payer Address of the payer (can be address(0) for marketplace scenarios)
     * @param payee Address of the payee
     * @param amount Payment amount (excluding fees)
     * @return paymentId Unique payment ID
     * @return walletAddress Address of the created escrow wallet
     */
    function createEscrowWallet(
        address payer,
        address payee,
        uint256 amount
    ) external onlyRole(INVESTOR_ROLE) nonReentrant returns (
        uint256 paymentId,
        address walletAddress
    ) {
        require(isInvestor(msg.sender), "Not active investor");
        // Note: payer can be address(0) for marketplace scenarios (unknown payer)
        require(payee != address(0), "Invalid payee");
        require(payer != payee, "Payer cannot be payee");
        require(amount > 0, "Invalid amount");

        // ✅ KYC/AML COMPLIANCE: Payee must be verified
        require(
            identityRegistry.isVerified(payee),
            "Payee must have valid KYC/AML (OnchainID)"
        );

        // ✅ KYC/AML COMPLIANCE: Payer must be verified (if known)
        if (payer != address(0)) {
            require(
                identityRegistry.isVerified(payer),
                "Payer must have valid KYC/AML (OnchainID)"
            );
        }
        
        // Calculate fees
        uint256 investorFee = (amount * INVESTOR_FEE_RATE) / FEE_DENOMINATOR;
        uint256 ownerFee = (amount * OWNER_FEE_RATE) / FEE_DENOMINATOR;
        
        // Create payment ID
        paymentId = _nextPaymentId++;
        
        // Get investor's wallet for fees
        address investorWallet = investors[msg.sender].walletAddress;
        
        // Deploy new MultiSigEscrowWallet
        MultiSigEscrowWallet wallet = new MultiSigEscrowWallet(
            paymentId,
            payer,
            payee,
            msg.sender,      // investor
            address(vscToken),
            amount,
            investorFee,
            ownerFee,
            owner,
            investorWallet,  // investor's wallet for fees
            ownerWallet      // owner's wallet for fees
        );

        walletAddress = address(wallet);

        // ✅ SECURITY MODEL: Trusted Contracts
        //
        // The escrow wallet needs to be added to ComplianceRules.trustedContracts
        // to allow ERC-3643 token transfers WITHOUT bypassing KYC/AML verification.
        //
        // Security Model:
        // 1. Escrow wallet is added to trusted contracts list (by owner)
        // 2. Transfers to/from escrow still require the OTHER party to be KYC/AML verified
        // 3. Escrow wallet enforces its own multi-sig rules (2-of-3)
        // 4. Only verified investors can create escrow wallets
        // 5. Only ComplianceRules owner can add/remove trusted contracts
        //
        // This is SECURE because:
        // - Escrow wallets are created by verified investors
        // - Payer and Payee must still be KYC/AML verified
        // - Escrow wallets enforce multi-sig release conditions
        // - No direct identity registration bypass
        //
        // ⚠️ IMPORTANT: The ComplianceRules owner must manually add the wallet
        // to trusted contracts after creation. This is done in the demo script
        // or by calling: complianceRules.addTrustedContract(walletAddress)

        // Store mappings
        paymentToWallet[paymentId] = walletAddress;
        payerPayments[payer].push(paymentId);
        payeePayments[payee].push(paymentId);
        investorPayments[msg.sender].push(paymentId);
        
        // Update investor stats
        investors[msg.sender].totalEscrowsCreated++;
        
        emit EscrowWalletCreated(
            paymentId,
            walletAddress,
            msg.sender,
            payer,
            payee,
            amount,
            investorFee,
            ownerFee
        );
    }
    
    /**
     * @notice Payer funds the escrow wallet
     * @dev If payer is unknown (address(0)), first funder becomes the payer
     * @dev Payer must have valid KYC/AML (OnchainID with verified identity)
     * @param paymentId Payment ID
     */
    function fundEscrowWallet(uint256 paymentId) external nonReentrant {
        address walletAddress = paymentToWallet[paymentId];
        require(walletAddress != address(0), "Wallet not found");

        MultiSigEscrowWallet wallet = MultiSigEscrowWallet(walletAddress);

        // ✅ KYC/AML COMPLIANCE: Payer must be verified
        require(
            identityRegistry.isVerified(msg.sender),
            "Payer must have valid KYC/AML (OnchainID)"
        );

        // Handle dynamic payer assignment for marketplace scenarios
        if (!wallet.payerSet()) {
            // Payer is unknown - set to msg.sender (already verified above)
            wallet.setPayer(msg.sender);
        } else {
            // Payer is known - verify it's them
            require(msg.sender == wallet.payer(), "Only payer can fund");
        }

        require(
            wallet.state() == MultiSigEscrowWallet.WalletState.Active,
            "Wallet not active"
        );

        // Calculate total amount
        uint256 amount = wallet.amount();
        uint256 investorFee = wallet.investorFee();
        uint256 ownerFee = wallet.ownerFee();
        uint256 totalAmount = amount + investorFee + ownerFee;

        // Transfer tokens from payer to wallet
        require(
            vscToken.transferFrom(msg.sender, walletAddress, totalAmount),
            "Transfer failed"
        );

        emit FundsReceived(paymentId, msg.sender, totalAmount);
    }

    // ========================================
    // ADMIN FUNCTIONS
    // ========================================

    /**
     * @notice Update identity registry address
     * @dev Only admin can update
     * @param _identityRegistry New identity registry address
     */
    function setIdentityRegistry(address _identityRegistry) external onlyRole(ADMIN_ROLE) {
        require(_identityRegistry != address(0), "Invalid identity registry");
        identityRegistry = IIdentityRegistry(_identityRegistry);
    }

    // ========================================
    // VIEW FUNCTIONS
    // ========================================
    
    /**
     * @notice Get wallet address for payment ID
     */
    function getWalletAddress(uint256 paymentId) external view returns (address) {
        return paymentToWallet[paymentId];
    }
    
    /**
     * @notice Get all payments for payer
     */
    function getPayerPayments(address payer) external view returns (uint256[] memory) {
        return payerPayments[payer];
    }
    
    /**
     * @notice Get all payments for payee
     */
    function getPayeePayments(address payee) external view returns (uint256[] memory) {
        return payeePayments[payee];
    }
    
    /**
     * @notice Get all payments created by investor
     */
    function getInvestorPayments(address investor) external view returns (uint256[] memory) {
        return investorPayments[investor];
    }
    
    /**
     * @notice Calculate fees for an amount
     */
    function calculateFees(uint256 amount) external pure returns (
        uint256 investorFee,
        uint256 ownerFee,
        uint256 totalFee,
        uint256 totalAmount
    ) {
        investorFee = (amount * INVESTOR_FEE_RATE) / FEE_DENOMINATOR;
        ownerFee = (amount * OWNER_FEE_RATE) / FEE_DENOMINATOR;
        totalFee = investorFee + ownerFee;
        totalAmount = amount + totalFee;
    }
    
    /**
     * @notice Get investor profile
     */
    function getInvestorProfile(address investor) external view returns (
        address investorAddress,
        address walletAddress,
        bool isActive,
        uint256 totalEscrowsCreated,
        uint256 totalFeesEarned,
        uint256 registeredAt
    ) {
        InvestorProfile memory profile = investors[investor];
        return (
            profile.investorAddress,
            profile.walletAddress,
            profile.isActive,
            profile.totalEscrowsCreated,
            profile.totalFeesEarned,
            profile.registeredAt
        );
    }
    
    /**
     * @notice Update investor's total fees earned (called when fees are distributed)
     */
    function updateInvestorFeesEarned(address investor, uint256 feeAmount) external {
        // Only the escrow wallet can call this
        require(paymentToWallet[MultiSigEscrowWallet(msg.sender).paymentId()] == msg.sender, "Only escrow wallet");
        investors[investor].totalFeesEarned += feeAmount;
    }
    
    /**
     * @notice Update owner wallet address
     */
    function setOwnerWallet(address _ownerWallet) external onlyRole(ADMIN_ROLE) {
        require(_ownerWallet != address(0), "Invalid wallet");
        ownerWallet = _ownerWallet;
    }
}

