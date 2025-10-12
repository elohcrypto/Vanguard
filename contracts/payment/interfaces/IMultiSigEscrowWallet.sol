// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

/**
 * @title IMultiSigEscrowWallet
 * @notice Interface for one-time-use multi-signature escrow wallet
 */
interface IMultiSigEscrowWallet {
    // ========================================
    // ENUMS
    // ========================================
    
    enum WalletState { Active, Released, Refunded, Disputed }
    
    // ========================================
    // EVENTS
    // ========================================
    
    event ShipmentProofSubmitted(
        string data,
        bytes32 dataHash,
        bytes signature,
        uint256 timestamp
    );

    event PayerSet(address indexed payer, uint256 timestamp);
    event PayerSigned(address indexed payer, uint256 timestamp);
    event PayeeSigned(address indexed payee, uint256 timestamp);
    event InvestorSigned(address indexed investor, uint256 timestamp);
    
    event FundsReleased(
        address indexed payee,
        uint256 amount,
        address indexed investor,
        uint256 investorFee,
        address indexed owner,
        uint256 ownerFee
    );
    
    event FundsRefunded(address indexed payer, uint256 totalAmount);
    event DisputeRaised(address indexed payer, uint256 timestamp);
    event DisputeResolved(address indexed investor, bool refunded);
    
    // ========================================
    // FUNCTIONS
    // ========================================
    
    function setPayer(address _payer) external;

    function submitShipmentProof(
        string calldata data,
        bytes32 dataHash,
        bytes calldata signature
    ) external;

    function raiseDispute() external;

    function resolveDispute(bool refundToPayer) external;

    function signAsPayer() external;

    function signAsPayee() external;

    function signAsInvestor() external;

    function manualRefund() external;
    
    // ========================================
    // VIEW FUNCTIONS
    // ========================================
    
    function paymentId() external view returns (uint256);
    
    function payer() external view returns (address);

    function payerSet() external view returns (bool);

    function payee() external view returns (address);

    function investor() external view returns (address);

    function factory() external view returns (address);

    function amount() external view returns (uint256);

    function investorFee() external view returns (uint256);

    function ownerFee() external view returns (uint256);

    function state() external view returns (WalletState);

    function payerSigned() external view returns (bool);

    function payeeSigned() external view returns (bool);

    function investorSigned() external view returns (bool);
    
    function isDisputeWindowOpen() external view returns (bool);
    
    function isReadyForSignatures() external view returns (bool);
    
    function getWalletStatus() external view returns (
        WalletState currentState,
        bool payerIsSet,
        bool proofSubmitted,
        bool disputeWindowOpen,
        bool readyForSignatures,
        bool payerHasSigned,
        bool payeeHasSigned,
        bool investorHasSigned,
        uint256 timeUntilSignatures
    );
    
    function getShipmentProof() external view returns (
        string memory data,
        bytes32 dataHash,
        bytes memory signature,
        uint256 submittedAt,
        bool exists
    );
}

