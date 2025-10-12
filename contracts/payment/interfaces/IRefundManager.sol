// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

/**
 * @title IRefundManager
 * @dev Interface for managing different types of refunds in the payment system
 */
interface IRefundManager {
    // Refund types
    enum RefundType {
        Automatic, // Timeout or compliance-triggered
        Manual, // Mutual agreement between parties
        Dispute, // Oracle-mediated dispute resolution
        Emergency // Token Issuer emergency authority
    }

    // Refund reasons
    enum RefundReason {
        Timeout,
        ComplianceViolation,
        MutualAgreement,
        DisputeResolution,
        EmergencyAction,
        PaymentCancellation,
        SystemError
    }

    // Refund structure
    struct RefundRequest {
        uint256 refundId;
        uint256 paymentId;
        address requester;
        address recipient;
        uint256 amount;
        RefundType refundType;
        RefundReason reason;
        string description;
        uint256 requestedAt;
        uint256 processedAt;
        bool approved;
        bool processed;
        bytes32 evidenceHash;
    }

    // Events
    event RefundRequested(
        uint256 indexed refundId,
        uint256 indexed paymentId,
        address indexed requester,
        RefundType refundType,
        RefundReason reason,
        uint256 amount
    );

    event RefundApproved(uint256 indexed refundId, address indexed approver, uint256 timestamp);

    event RefundProcessed(uint256 indexed refundId, address indexed recipient, uint256 amount, uint256 timestamp);

    event RefundRejected(uint256 indexed refundId, address indexed rejector, string reason);

    event EmergencyRefundExecuted(uint256 indexed refundId, address indexed authority, uint256 amount);

    // Core functions
    function requestRefund(
        uint256 paymentId,
        RefundType refundType,
        RefundReason reason,
        string calldata description,
        bytes32 evidenceHash
    ) external returns (uint256 refundId);

    function approveRefund(uint256 refundId) external;

    function rejectRefund(uint256 refundId, string calldata reason) external;

    function processRefund(uint256 refundId) external;

    function emergencyRefund(
        uint256 paymentId,
        address recipient,
        RefundReason reason,
        string calldata description
    ) external returns (uint256 refundId);

    function processAutomaticRefund(uint256 paymentId, RefundReason reason) external returns (uint256 refundId);

    // View functions
    function getRefundRequest(uint256 refundId) external view returns (RefundRequest memory);

    function getRefundsByPayment(uint256 paymentId) external view returns (uint256[] memory);

    function getRefundsByRequester(address requester) external view returns (uint256[] memory);

    function canRequestRefund(uint256 paymentId, address requester) external view returns (bool);

    function isRefundEligible(uint256 paymentId, RefundType refundType) external view returns (bool);

    function getRefundAmount(uint256 paymentId) external view returns (uint256);
}
