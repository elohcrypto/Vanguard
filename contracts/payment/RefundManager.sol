// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "./interfaces/IRefundManager.sol";
import "./interfaces/IPaymentProtocol.sol";
import "./interfaces/IPaymentEscrow.sol";

/**
 * @title RefundManager
 * @dev Manages different types of refunds in the payment system
 * @author Vanguard StableCoin Team
 */
contract RefundManager is IRefundManager, Ownable, ReentrancyGuard, Pausable {
    // State variables
    IPaymentProtocol public paymentProtocol;
    IPaymentEscrow public paymentEscrow;

    // Storage
    mapping(uint256 => RefundRequest) private _refundRequests;
    mapping(uint256 => uint256[]) private _paymentRefunds; // paymentId => refundIds[]
    mapping(address => uint256[]) private _requesterRefunds; // requester => refundIds[]

    uint256 private _nextRefundId = 1;
    uint256 public totalRefunds;
    uint256 public totalRefundAmount;

    // Authorized addresses
    mapping(address => bool) public authorizedProcessors;
    address public emergencyRefundAuthority;

    // Refund settings
    uint256 public refundProcessingDelay = 1 hours; // Delay before processing manual refunds
    uint256 public maxRefundWindow = 30 days; // Maximum time to request refund

    // Modifiers
    modifier onlyPaymentProtocol() {
        require(msg.sender == address(paymentProtocol), "Only payment protocol");
        _;
    }

    modifier onlyAuthorizedProcessor() {
        require(authorizedProcessors[msg.sender] || msg.sender == owner(), "Not authorized processor");
        _;
    }

    modifier onlyEmergencyAuthority() {
        require(msg.sender == emergencyRefundAuthority || msg.sender == owner(), "Only emergency authority");
        _;
    }

    modifier validRefundId(uint256 refundId) {
        require(refundId > 0 && refundId < _nextRefundId, "Invalid refund ID");
        _;
    }

    constructor(address _paymentProtocol, address _paymentEscrow) Ownable(msg.sender) {
        require(_paymentProtocol != address(0), "Invalid payment protocol");
        require(_paymentEscrow != address(0), "Invalid payment escrow");

        paymentProtocol = IPaymentProtocol(_paymentProtocol);
        paymentEscrow = IPaymentEscrow(_paymentEscrow);
        emergencyRefundAuthority = msg.sender;
        authorizedProcessors[msg.sender] = true;
    }

    /**
     * @dev Request a refund
     */
    function requestRefund(
        uint256 paymentId,
        RefundType refundType,
        RefundReason reason,
        string calldata description,
        bytes32 evidenceHash
    ) external override whenNotPaused returns (uint256 refundId) {
        require(canRequestRefund(paymentId, msg.sender), "Cannot request refund");
        require(bytes(description).length > 0, "Description required");

        // Get payment details
        IPaymentProtocol.Payment memory payment = paymentProtocol.getPayment(paymentId);
        require(payment.paymentId != 0, "Payment not found");

        // Validate refund eligibility
        require(isRefundEligible(paymentId, refundType), "Refund not eligible");

        // Create refund request
        refundId = _nextRefundId++;
        RefundRequest storage refund = _refundRequests[refundId];

        refund.refundId = refundId;
        refund.paymentId = paymentId;
        refund.requester = msg.sender;
        refund.recipient = payment.payer; // Refunds always go to payer
        refund.amount = payment.amount;
        refund.refundType = refundType;
        refund.reason = reason;
        refund.description = description;
        refund.requestedAt = block.timestamp;
        refund.processedAt = 0;
        refund.approved = false;
        refund.processed = false;
        refund.evidenceHash = evidenceHash;

        // Update tracking
        _paymentRefunds[paymentId].push(refundId);
        _requesterRefunds[msg.sender].push(refundId);
        totalRefunds++;

        // Auto-approve certain refund types
        if (refundType == RefundType.Automatic) {
            refund.approved = true;
        }

        emit RefundRequested(refundId, paymentId, msg.sender, refundType, reason, payment.amount);

        // Process immediately if automatic
        if (refundType == RefundType.Automatic) {
            _processRefund(refundId);
        }
    }

    /**
     * @dev Approve a refund request
     */
    function approveRefund(uint256 refundId) external override validRefundId(refundId) onlyAuthorizedProcessor {
        RefundRequest storage refund = _refundRequests[refundId];
        require(!refund.approved, "Already approved");
        require(!refund.processed, "Already processed");

        refund.approved = true;

        emit RefundApproved(refundId, msg.sender, block.timestamp);

        // Process if ready
        if (_canProcessRefund(refundId)) {
            _processRefund(refundId);
        }
    }

    /**
     * @dev Reject a refund request
     */
    function rejectRefund(
        uint256 refundId,
        string calldata reason
    ) external override validRefundId(refundId) onlyAuthorizedProcessor {
        RefundRequest storage refund = _refundRequests[refundId];
        require(!refund.approved, "Already approved");
        require(!refund.processed, "Already processed");
        require(bytes(reason).length > 0, "Rejection reason required");

        // Mark as processed (rejected)
        refund.processed = true;
        refund.processedAt = block.timestamp;

        emit RefundRejected(refundId, msg.sender, reason);
    }

    /**
     * @dev Process an approved refund
     */
    function processRefund(uint256 refundId) external override validRefundId(refundId) nonReentrant {
        require(_canProcessRefund(refundId), "Cannot process refund");
        _processRefund(refundId);
    }

    /**
     * @dev Emergency refund (authority only)
     */
    function emergencyRefund(
        uint256 paymentId,
        address recipient,
        RefundReason reason,
        string calldata description
    ) external override onlyEmergencyAuthority returns (uint256 refundId) {
        require(recipient != address(0), "Invalid recipient");
        require(bytes(description).length > 0, "Description required");

        // Get payment details
        IPaymentProtocol.Payment memory payment = paymentProtocol.getPayment(paymentId);
        require(payment.paymentId != 0, "Payment not found");

        // Create emergency refund request
        refundId = _nextRefundId++;
        RefundRequest storage refund = _refundRequests[refundId];

        refund.refundId = refundId;
        refund.paymentId = paymentId;
        refund.requester = msg.sender;
        refund.recipient = recipient;
        refund.amount = payment.amount;
        refund.refundType = RefundType.Emergency;
        refund.reason = reason;
        refund.description = description;
        refund.requestedAt = block.timestamp;
        refund.approved = true; // Auto-approved
        refund.processed = false;
        refund.evidenceHash = keccak256(abi.encodePacked(description));

        // Update tracking
        _paymentRefunds[paymentId].push(refundId);
        _requesterRefunds[msg.sender].push(refundId);
        totalRefunds++;

        emit RefundRequested(refundId, paymentId, msg.sender, RefundType.Emergency, reason, payment.amount);

        // Process immediately
        _processRefund(refundId);

        emit EmergencyRefundExecuted(refundId, msg.sender, payment.amount);
    }

    /**
     * @dev Process automatic refund (called by payment protocol)
     */
    function processAutomaticRefund(
        uint256 paymentId,
        RefundReason reason
    ) external override onlyPaymentProtocol returns (uint256 refundId) {
        // Get payment details
        IPaymentProtocol.Payment memory payment = paymentProtocol.getPayment(paymentId);
        require(payment.paymentId != 0, "Payment not found");

        // Create automatic refund request
        refundId = _nextRefundId++;
        RefundRequest storage refund = _refundRequests[refundId];

        refund.refundId = refundId;
        refund.paymentId = paymentId;
        refund.requester = address(paymentProtocol);
        refund.recipient = payment.payer;
        refund.amount = payment.amount;
        refund.refundType = RefundType.Automatic;
        refund.reason = reason;
        refund.description = "Automatic refund";
        refund.requestedAt = block.timestamp;
        refund.approved = true; // Auto-approved
        refund.processed = false;
        refund.evidenceHash = bytes32(0);

        // Update tracking
        _paymentRefunds[paymentId].push(refundId);
        _requesterRefunds[address(paymentProtocol)].push(refundId);
        totalRefunds++;

        emit RefundRequested(
            refundId,
            paymentId,
            address(paymentProtocol),
            RefundType.Automatic,
            reason,
            payment.amount
        );

        // Process immediately
        _processRefund(refundId);
    }

    /**
     * @dev Internal function to process refund
     */
    function _processRefund(uint256 refundId) internal {
        RefundRequest storage refund = _refundRequests[refundId];
        require(refund.approved, "Not approved");
        require(!refund.processed, "Already processed");

        // Mark as processed
        refund.processed = true;
        refund.processedAt = block.timestamp;
        totalRefundAmount += refund.amount;

        // Execute refund through payment protocol
        IPaymentProtocol.RefundType protocolRefundType;
        if (refund.refundType == RefundType.Automatic) {
            protocolRefundType = IPaymentProtocol.RefundType.Automatic;
        } else if (refund.refundType == RefundType.Manual) {
            protocolRefundType = IPaymentProtocol.RefundType.Manual;
        } else if (refund.refundType == RefundType.Dispute) {
            protocolRefundType = IPaymentProtocol.RefundType.Dispute;
        } else {
            protocolRefundType = IPaymentProtocol.RefundType.Emergency;
        }

        paymentProtocol.processRefund(refund.paymentId, protocolRefundType);

        emit RefundProcessed(refundId, refund.recipient, refund.amount, block.timestamp);
    }

    /**
     * @dev Check if refund can be processed
     */
    function _canProcessRefund(uint256 refundId) internal view returns (bool) {
        RefundRequest storage refund = _refundRequests[refundId];

        if (!refund.approved || refund.processed) {
            return false;
        }

        // Check processing delay for manual refunds
        if (refund.refundType == RefundType.Manual) {
            return block.timestamp >= refund.requestedAt + refundProcessingDelay;
        }

        return true;
    }

    /**
     * @dev Get refund request details
     */
    function getRefundRequest(
        uint256 refundId
    ) external view override validRefundId(refundId) returns (RefundRequest memory) {
        return _refundRequests[refundId];
    }

    /**
     * @dev Get refunds by payment
     */
    function getRefundsByPayment(uint256 paymentId) external view override returns (uint256[] memory) {
        return _paymentRefunds[paymentId];
    }

    /**
     * @dev Get refunds by requester
     */
    function getRefundsByRequester(address requester) external view override returns (uint256[] memory) {
        return _requesterRefunds[requester];
    }

    /**
     * @dev Check if can request refund
     */
    function canRequestRefund(uint256 paymentId, address requester) public view override returns (bool) {
        IPaymentProtocol.Payment memory payment = paymentProtocol.getPayment(paymentId);

        if (payment.paymentId == 0) return false;

        // Only payer or payee can request refunds
        if (requester != payment.payer && requester != payment.payee) return false;

        // Check if within refund window
        if (block.timestamp > payment.createdAt + maxRefundWindow) return false;

        // Check payment state
        IPaymentProtocol.PaymentState state = paymentProtocol.getPaymentState(paymentId);
        return state != IPaymentProtocol.PaymentState.Refunded;
    }

    /**
     * @dev Check if refund is eligible
     */
    function isRefundEligible(uint256 paymentId, RefundType refundType) public view override returns (bool) {
        IPaymentProtocol.PaymentState state = paymentProtocol.getPaymentState(paymentId);

        if (refundType == RefundType.Automatic) {
            return state == IPaymentProtocol.PaymentState.Pending || state == IPaymentProtocol.PaymentState.Expired;
        }

        if (refundType == RefundType.Manual) {
            return state == IPaymentProtocol.PaymentState.Confirmed;
        }

        if (refundType == RefundType.Dispute) {
            return state == IPaymentProtocol.PaymentState.Disputed;
        }

        if (refundType == RefundType.Emergency) {
            return state != IPaymentProtocol.PaymentState.Refunded;
        }

        return false;
    }

    /**
     * @dev Get refund amount for payment
     */
    function getRefundAmount(uint256 paymentId) external view override returns (uint256) {
        IPaymentProtocol.Payment memory payment = paymentProtocol.getPayment(paymentId);
        return payment.amount;
    }

    /**
     * @dev Set authorized processor
     */
    function setAuthorizedProcessor(address processor, bool authorized) external onlyOwner {
        require(processor != address(0), "Invalid processor");
        authorizedProcessors[processor] = authorized;
    }

    /**
     * @dev Set emergency refund authority
     */
    function setEmergencyRefundAuthority(address authority) external onlyOwner {
        require(authority != address(0), "Invalid authority");
        emergencyRefundAuthority = authority;
    }

    /**
     * @dev Set refund processing delay
     */
    function setRefundProcessingDelay(uint256 delay) external onlyOwner {
        require(delay <= 7 days, "Delay too long");
        refundProcessingDelay = delay;
    }

    /**
     * @dev Set max refund window
     */
    function setMaxRefundWindow(uint256 window) external onlyOwner {
        require(window >= 7 days, "Window too short");
        require(window <= 90 days, "Window too long");
        maxRefundWindow = window;
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
