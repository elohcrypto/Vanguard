// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

/**
 * @title IPaymentProtocol
 * @dev Interface for the Vanguard StableCoin Payment Protocol with escrow and refund capabilities
 */
interface IPaymentProtocol {
    // Payment states
    enum PaymentState {
        Pending, // Payment initiated, funds in escrow
        Confirmed, // Payment confirmed, funds released to payee
        Disputed, // Payment disputed, awaiting resolution
        Refunded, // Payment refunded, funds returned to payer
        Expired, // Payment expired, automatic refund triggered
        Cancelled // Payment cancelled before confirmation
    }

    // Refund types
    enum RefundType {
        Automatic, // Timeout or compliance-triggered
        Manual, // Mutual agreement between parties
        Dispute, // Oracle-mediated dispute resolution
        Emergency // Token Issuer emergency authority
    }

    // Payment structure
    struct Payment {
        uint256 paymentId;
        address payer;
        address payee;
        uint256 amount;
        PaymentState state;
        uint256 createdAt;
        uint256 confirmationDeadline;
        uint256 disputeDeadline;
        bytes32 complianceHash;
        bool refundable;
        string paymentReason;
        uint256 escrowAmount;
    }

    // Events
    event PaymentInitiated(
        uint256 indexed paymentId,
        address indexed payer,
        address indexed payee,
        uint256 amount,
        string reason
    );

    event PaymentConfirmed(uint256 indexed paymentId, address indexed payee, uint256 timestamp);

    event PaymentDisputed(uint256 indexed paymentId, address indexed disputer, string reason);

    event PaymentRefunded(uint256 indexed paymentId, address indexed recipient, uint256 amount, RefundType refundType);

    event PaymentExpired(uint256 indexed paymentId, uint256 timestamp);

    event PaymentCancelled(uint256 indexed paymentId, address indexed canceller);

    // Core functions
    function initiatePayment(
        address payee,
        uint256 amount,
        string calldata reason
    ) external returns (uint256 paymentId);

    function confirmPayment(uint256 paymentId) external;

    function disputePayment(uint256 paymentId, string calldata reason) external;

    function cancelPayment(uint256 paymentId) external;

    function processRefund(uint256 paymentId, RefundType refundType) external;

    function emergencyRefund(uint256 paymentId) external;

    // View functions
    function getPayment(uint256 paymentId) external view returns (Payment memory);

    function getPaymentState(uint256 paymentId) external view returns (PaymentState);

    function isPaymentExpired(uint256 paymentId) external view returns (bool);

    function canDispute(uint256 paymentId) external view returns (bool);

    function getPaymentsByPayer(address payer) external view returns (uint256[] memory);

    function getPaymentsByPayee(address payee) external view returns (uint256[] memory);
}
