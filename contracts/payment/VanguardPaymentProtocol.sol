// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "./interfaces/IPaymentProtocol.sol";
import "./interfaces/IPaymentEscrow.sol";
import "./interfaces/IRefundManager.sol";
import "./interfaces/IDisputeResolver.sol";
import "../compliance/interfaces/IComplianceRules.sol";
import "../oracle/interfaces/IOracleManager.sol";
import "../erc3643/interfaces/IIdentityRegistry.sol";

/**
 * @title VanguardPaymentProtocol
 * @dev Main payment protocol contract with escrow, refund, and dispute resolution capabilities
 * @author Vanguard StableCoin Team
 */
contract VanguardPaymentProtocol is IPaymentProtocol, Ownable, ReentrancyGuard, Pausable {
    // State variables
    IERC20 public immutable vscToken;
    IPaymentEscrow public paymentEscrow;
    IRefundManager public refundManager;
    IDisputeResolver public disputeResolver;
    IComplianceRules public complianceRules;
    IOracleManager public oracleManager;
    IIdentityRegistry public identityRegistry;

    // Payment settings
    struct PaymentSettings {
        uint256 confirmationPeriod; // 24 hours default
        uint256 disputeWindow; // 7 days default
        uint256 refundWindow; // 30 days default
        uint256 maxPaymentAmount; // 50,000 VSC
        uint256 minPaymentAmount; // 1 VSC
        uint256 escrowFeeRate; // 0.1% (10 basis points)
    }

    PaymentSettings public paymentSettings;

    // Storage
    mapping(uint256 => Payment) private _payments;
    mapping(address => uint256[]) private _payerPayments;
    mapping(address => uint256[]) private _payeePayments;

    uint256 private _nextPaymentId = 1;
    uint256 public totalPayments;
    uint256 public totalVolume;

    // Constants
    uint256 public constant MAX_FEE_RATE = 1000; // 10% maximum fee
    uint256 public constant FEE_DENOMINATOR = 10000; // 100% = 10000 basis points

    // Modifiers
    modifier validPaymentId(uint256 paymentId) {
        require(paymentId > 0 && paymentId < _nextPaymentId, "Invalid payment ID");
        _;
    }

    modifier onlyPaymentParty(uint256 paymentId) {
        Payment storage payment = _payments[paymentId];
        require(msg.sender == payment.payer || msg.sender == payment.payee, "Not payment party");
        _;
    }

    modifier onlyTokenIssuer() {
        require(msg.sender == owner(), "Only token issuer");
        _;
    }

    constructor(
        address _vscToken,
        address _complianceRules,
        address _oracleManager,
        address _identityRegistry
    ) Ownable(msg.sender) {
        require(_vscToken != address(0), "Invalid VSC token");
        require(_complianceRules != address(0), "Invalid compliance rules");
        require(_oracleManager != address(0), "Invalid oracle manager");
        require(_identityRegistry != address(0), "Invalid identity registry");

        vscToken = IERC20(_vscToken);
        complianceRules = IComplianceRules(_complianceRules);
        oracleManager = IOracleManager(_oracleManager);
        identityRegistry = IIdentityRegistry(_identityRegistry);

        // Initialize default settings
        paymentSettings = PaymentSettings({
            confirmationPeriod: 24 hours,
            disputeWindow: 7 days,
            refundWindow: 30 days,
            maxPaymentAmount: 50000 * 10 ** 18, // 50,000 VSC
            minPaymentAmount: 1 * 10 ** 18, // 1 VSC
            escrowFeeRate: 10 // 0.1% (10 basis points)
        });
    }

    /**
     * @dev Set payment escrow contract
     */
    function setPaymentEscrow(address _paymentEscrow) external onlyOwner {
        require(_paymentEscrow != address(0), "Invalid escrow address");
        paymentEscrow = IPaymentEscrow(_paymentEscrow);
    }

    /**
     * @dev Set refund manager contract
     */
    function setRefundManager(address _refundManager) external onlyOwner {
        require(_refundManager != address(0), "Invalid refund manager");
        refundManager = IRefundManager(_refundManager);
    }

    /**
     * @dev Set dispute resolver contract
     */
    function setDisputeResolver(address _disputeResolver) external onlyOwner {
        require(_disputeResolver != address(0), "Invalid dispute resolver");
        disputeResolver = IDisputeResolver(_disputeResolver);
    }

    /**
     * @dev Initiate a payment with escrow
     */
    function initiatePayment(
        address payee,
        uint256 amount,
        string calldata reason
    ) external override nonReentrant whenNotPaused returns (uint256 paymentId) {
        require(payee != address(0), "Invalid payee");
        require(payee != msg.sender, "Cannot pay yourself");
        require(amount >= paymentSettings.minPaymentAmount, "Amount too small");
        require(amount <= paymentSettings.maxPaymentAmount, "Amount too large");
        require(bytes(reason).length > 0, "Payment reason required");

        // Validate compliance for both parties
        _validatePaymentCompliance(msg.sender, payee, amount);

        // Check oracle whitelist/blacklist status
        _validateOracleAccess(msg.sender, payee);

        // Calculate escrow fee
        uint256 escrowFee = (amount * paymentSettings.escrowFeeRate) / FEE_DENOMINATOR;
        uint256 totalAmount = amount + escrowFee;

        // Check payer balance
        require(vscToken.balanceOf(msg.sender) >= totalAmount, "Insufficient balance");
        require(vscToken.allowance(msg.sender, address(this)) >= totalAmount, "Insufficient allowance");

        // Create payment record
        paymentId = _nextPaymentId++;
        Payment storage payment = _payments[paymentId];

        payment.paymentId = paymentId;
        payment.payer = msg.sender;
        payment.payee = payee;
        payment.amount = amount;
        payment.state = PaymentState.Pending;
        payment.createdAt = block.timestamp;
        payment.confirmationDeadline = block.timestamp + paymentSettings.confirmationPeriod;
        payment.disputeDeadline = 0; // Set when confirmed
        payment.complianceHash = _generateComplianceHash(msg.sender, payee, amount);
        payment.refundable = true;
        payment.paymentReason = reason;
        payment.escrowAmount = totalAmount;

        // Transfer tokens to this contract first, then to escrow
        require(vscToken.transferFrom(msg.sender, address(this), totalAmount), "Transfer failed");
        require(vscToken.transfer(address(paymentEscrow), totalAmount), "Escrow transfer failed");

        // Create escrow
        paymentEscrow.createEscrow(
            paymentId,
            msg.sender,
            payee,
            amount,
            paymentSettings.confirmationPeriod + paymentSettings.disputeWindow
        );

        // Update tracking
        _payerPayments[msg.sender].push(paymentId);
        _payeePayments[payee].push(paymentId);
        totalPayments++;
        totalVolume += amount;

        emit PaymentInitiated(paymentId, msg.sender, payee, amount, reason);
    }

    /**
     * @dev Confirm payment receipt (payee only)
     */
    function confirmPayment(uint256 paymentId) external override validPaymentId(paymentId) nonReentrant {
        Payment storage payment = _payments[paymentId];
        require(msg.sender == payment.payee, "Only payee can confirm");
        require(payment.state == PaymentState.Pending, "Payment not pending");
        require(block.timestamp <= payment.confirmationDeadline, "Confirmation period expired");

        // Update payment state
        payment.state = PaymentState.Confirmed;
        payment.disputeDeadline = block.timestamp + paymentSettings.disputeWindow;

        // Release funds from escrow to payee
        paymentEscrow.releaseEscrow(paymentId);

        emit PaymentConfirmed(paymentId, msg.sender, block.timestamp);
    }

    /**
     * @dev Dispute a payment (payer only, within dispute window)
     */
    function disputePayment(uint256 paymentId, string calldata reason) external override validPaymentId(paymentId) {
        Payment storage payment = _payments[paymentId];
        require(msg.sender == payment.payer, "Only payer can dispute");
        require(payment.state == PaymentState.Confirmed, "Payment not confirmed");
        require(block.timestamp <= payment.disputeDeadline, "Dispute window expired");
        require(bytes(reason).length > 0, "Dispute reason required");

        // Update payment state
        payment.state = PaymentState.Disputed;

        // File dispute with resolver (if available)
        if (address(disputeResolver) != address(0)) {
            disputeResolver.fileDispute(paymentId, reason, keccak256(abi.encodePacked(reason)));
        }

        emit PaymentDisputed(paymentId, msg.sender, reason);
    }

    /**
     * @dev Cancel payment before confirmation (payer only)
     */
    function cancelPayment(uint256 paymentId) external override validPaymentId(paymentId) nonReentrant {
        Payment storage payment = _payments[paymentId];
        require(msg.sender == payment.payer, "Only payer can cancel");
        require(payment.state == PaymentState.Pending, "Payment not pending");

        // Update payment state
        payment.state = PaymentState.Cancelled;

        // Process automatic refund
        refundManager.processAutomaticRefund(paymentId, IRefundManager.RefundReason.PaymentCancellation);

        emit PaymentCancelled(paymentId, msg.sender);
    }

    /**
     * @dev Process refund (called by refund manager)
     */
    function processRefund(uint256 paymentId, RefundType refundType) external override validPaymentId(paymentId) {
        require(msg.sender == address(refundManager), "Only refund manager");

        Payment storage payment = _payments[paymentId];
        require(payment.refundable, "Payment not refundable");
        require(payment.state != PaymentState.Refunded, "Already refunded");

        // Update payment state
        payment.state = PaymentState.Refunded;

        // Refund from escrow
        paymentEscrow.refundEscrow(paymentId);

        emit PaymentRefunded(paymentId, payment.payer, payment.amount, refundType);
    }

    /**
     * @dev Emergency refund (token issuer only)
     */
    function emergencyRefund(uint256 paymentId) external override validPaymentId(paymentId) onlyTokenIssuer {
        Payment storage payment = _payments[paymentId];
        require(payment.state != PaymentState.Refunded, "Already refunded");

        // Update payment state
        payment.state = PaymentState.Refunded;

        // Emergency refund from escrow
        paymentEscrow.emergencyRefund(paymentId);

        emit PaymentRefunded(paymentId, payment.payer, payment.amount, RefundType.Emergency);
    }

    /**
     * @dev Get payment details
     */
    function getPayment(uint256 paymentId) external view override validPaymentId(paymentId) returns (Payment memory) {
        return _payments[paymentId];
    }

    /**
     * @dev Get payment state
     */
    function getPaymentState(
        uint256 paymentId
    ) external view override validPaymentId(paymentId) returns (PaymentState) {
        return _payments[paymentId].state;
    }

    /**
     * @dev Check if payment is expired
     */
    function isPaymentExpired(uint256 paymentId) external view override validPaymentId(paymentId) returns (bool) {
        Payment storage payment = _payments[paymentId];
        if (payment.state == PaymentState.Pending) {
            return block.timestamp > payment.confirmationDeadline;
        }
        return false;
    }

    /**
     * @dev Check if payment can be disputed
     */
    function canDispute(uint256 paymentId) external view override validPaymentId(paymentId) returns (bool) {
        Payment storage payment = _payments[paymentId];
        return payment.state == PaymentState.Confirmed && block.timestamp <= payment.disputeDeadline;
    }

    /**
     * @dev Get payments by payer
     */
    function getPaymentsByPayer(address payer) external view override returns (uint256[] memory) {
        return _payerPayments[payer];
    }

    /**
     * @dev Get payments by payee
     */
    function getPaymentsByPayee(address payee) external view override returns (uint256[] memory) {
        return _payeePayments[payee];
    }

    /**
     * @dev Update payment settings (owner only)
     */
    function updatePaymentSettings(PaymentSettings calldata newSettings) external onlyOwner {
        require(newSettings.confirmationPeriod >= 1 hours, "Confirmation period too short");
        require(newSettings.confirmationPeriod <= 7 days, "Confirmation period too long");
        require(newSettings.disputeWindow >= 1 days, "Dispute window too short");
        require(newSettings.disputeWindow <= 30 days, "Dispute window too long");
        require(newSettings.maxPaymentAmount > newSettings.minPaymentAmount, "Invalid amount limits");
        require(newSettings.escrowFeeRate <= MAX_FEE_RATE, "Fee rate too high");

        paymentSettings = newSettings;
    }

    /**
     * @dev Validate payment compliance
     */
    function _validatePaymentCompliance(address payer, address payee, uint256 /* amount */) internal view {
        // Check if both parties have valid identities
        require(identityRegistry.isVerified(payer), "Payer not verified");
        require(identityRegistry.isVerified(payee), "Payee not verified");

        // Validate compliance rules using available interface methods
        // For now, we'll do basic validation - full integration would use specific validation methods
        require(payer != payee, "Compliance validation failed");
    }

    /**
     * @dev Validate oracle access control
     */
    function _validateOracleAccess(address payer, address payee) internal pure {
        // This would integrate with oracle whitelist/blacklist checking
        // For now, we'll implement basic validation
        require(payer != address(0) && payee != address(0), "Invalid addresses");
    }

    /**
     * @dev Generate compliance hash for payment
     */
    function _generateComplianceHash(address payer, address payee, uint256 amount) internal view returns (bytes32) {
        return keccak256(abi.encodePacked(payer, payee, amount, block.timestamp));
    }

    /**
     * @dev Pause contract (emergency)
     */
    function pause() external onlyOwner {
        _pause();
    }

    /**
     * @dev Unpause contract
     */
    function unpause() external onlyOwner {
        _unpause();
    }
}
