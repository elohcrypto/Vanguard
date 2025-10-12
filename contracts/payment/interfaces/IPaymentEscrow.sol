// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

/**
 * @title IPaymentEscrow
 * @dev Interface for secure fund holding during payment process
 */
interface IPaymentEscrow {
    // Escrow states
    enum EscrowState {
        Active, // Funds locked in escrow
        Released, // Funds released to payee
        Refunded, // Funds refunded to payer
        Expired // Escrow expired
    }

    // Escrow structure
    struct EscrowDetails {
        uint256 escrowId;
        uint256 paymentId;
        address payer;
        address payee;
        uint256 amount;
        uint256 fee;
        EscrowState state;
        uint256 createdAt;
        uint256 expiryTime;
        bool emergencyRefundable;
    }

    // Events
    event EscrowCreated(
        uint256 indexed escrowId,
        uint256 indexed paymentId,
        address indexed payer,
        address payee,
        uint256 amount,
        uint256 fee
    );

    event EscrowReleased(uint256 indexed escrowId, address indexed payee, uint256 amount);

    event EscrowRefunded(uint256 indexed escrowId, address indexed payer, uint256 amount);

    event EscrowExpired(uint256 indexed escrowId, uint256 timestamp);

    event EmergencyEscrowRefund(uint256 indexed escrowId, address indexed authority, uint256 amount);

    // Core functions
    function createEscrow(
        uint256 paymentId,
        address payer,
        address payee,
        uint256 amount,
        uint256 duration
    ) external returns (uint256 escrowId);

    function releaseEscrow(uint256 escrowId) external;

    function refundEscrow(uint256 escrowId) external;

    function emergencyRefund(uint256 escrowId) external;

    function extendEscrow(uint256 escrowId, uint256 additionalTime) external;

    // View functions
    function getEscrowDetails(uint256 escrowId) external view returns (EscrowDetails memory);

    function getEscrowByPayment(uint256 paymentId) external view returns (uint256 escrowId);

    function isEscrowExpired(uint256 escrowId) external view returns (bool);

    function getEscrowBalance(uint256 escrowId) external view returns (uint256);

    function calculateEscrowFee(uint256 amount) external view returns (uint256);
}
