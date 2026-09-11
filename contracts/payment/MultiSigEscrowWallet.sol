// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";

/**
 * @title MultiSigEscrowWallet
 * @notice One-time-use multi-signature escrow wallet for a single payment
 * @dev 2-of-3 multisig: Investor MUST sign + (Payer OR Payee)
 *      - Investor + Payee = Release to Payee
 *      - Investor + Payer = Refund to Payer
 */
contract MultiSigEscrowWallet is ReentrancyGuard {
    // ========================================
    // WALLET DETAILS
    // ========================================

    uint256 public immutable paymentId;
    address public payer;                      // Mutable: set on first funding if unknown
    bool public payerSet;                      // True after payer is locked
    address public immutable payee;
    address public immutable investor;
    address public immutable factory;          // Factory that created this wallet
    IERC20 public immutable vscToken;

    uint256 public immutable amount;           // Payment amount to payee
    uint256 public immutable investorFee;      // 3% fee to investor
    uint256 public immutable ownerFee;         // 2% fee to owner

    address public immutable owner;            // Platform owner
    address public immutable investorWallet;   // Investor's wallet for fee
    address public immutable ownerWallet;      // Owner's wallet for fee
    
    // ========================================
    // SHIPMENT PROOF
    // ========================================
    
    struct ShipmentProof {
        string data;              // JSON structured data
        bytes32 dataHash;         // Hash of the data
        bytes signature;          // Signature from payee
        uint256 submittedAt;      // Timestamp
        bool exists;              // Flag
    }
    
    ShipmentProof public shipmentProof;
    uint256 public constant DISPUTE_WINDOW = 14 days;

    /// @dev Domain tag binding a shipment proof to this protocol.
    string private constant PROOF_DOMAIN = "VanguardShipmentProof";

    /// @dev The shipment proof was not signed by the payee for this escrow.
    error ProofNotSignedByPayee();
    /// @dev Investor asked to release, but the payee has not signed.
    error PayeeHasNotSigned();
    /// @dev Investor asked to refund, but the payer has not signed.
    error PayerHasNotSigned();
    
    // ========================================
    // MULTI-SIGNATURE STATE (2-of-3)
    // ========================================
    // Investor MUST sign + (Payer OR Payee)
    // - Investor + Payee = Release to Payee
    // - Investor + Payer = Refund to Payer

    bool public payerSigned;
    bool public payeeSigned;
    bool public investorSigned;
    
    // ========================================
    // WALLET STATE
    // ========================================
    
    enum WalletState { Active, Released, Refunded, Disputed }
    WalletState public state;

    /**
     * @notice True once the factory has funded this escrow.
     * @dev Funding was previously gated only on `state == Active` — the state
     *      BOTH before and after funding — so fundEscrowWallet could run
     *      repeatedly. Release and refund pay fixed sums (amount and the fees
     *      are immutable), so each extra funding was stranded in the wallet
     *      with no sweep function and no way out. This flag makes funding
     *      idempotent: it removes the money-losing path rather than guarding it.
     */
    bool public funded;

    /// @dev Only the factory may mark this escrow funded.
    error OnlyFactory();
    /// @dev This escrow has already been funded.
    error AlreadyFunded();

    /**
     * @notice Record that the factory has funded this escrow.
     * @dev Factory-only and callable once. The factory calls this AFTER the
     *      transfer succeeds, so the flag can never be set for a transfer that
     *      did not land.
     */
    function markFunded() external {
        if (msg.sender != factory) revert OnlyFactory();
        if (funded) revert AlreadyFunded();
        funded = true;
    }
    
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
    // CONSTRUCTOR
    // ========================================
    
    constructor(
        uint256 _paymentId,
        address _payer,
        address _payee,
        address _investor,
        address _vscToken,
        uint256 _amount,
        uint256 _investorFee,
        uint256 _ownerFee,
        address _owner,
        address _investorWallet,
        address _ownerWallet
    ) {
        // Note: _payer can be address(0) for marketplace scenarios (unknown payer)
        require(_payee != address(0), "Invalid payee");
        require(_investor != address(0), "Invalid investor");
        require(_vscToken != address(0), "Invalid token");
        require(_vscToken.code.length > 0, "MultiSigEscrowWallet: VSC token is not a contract");
        require(_amount > 0, "Invalid amount");
        require(_owner != address(0), "Invalid owner");
        require(_investorWallet != address(0), "Invalid investor wallet");
        require(_ownerWallet != address(0), "Invalid owner wallet");

        paymentId = _paymentId;
        payer = _payer;
        payerSet = (_payer != address(0));  // True if known, false if unknown
        payee = _payee;
        investor = _investor;
        factory = msg.sender;                // Factory that created this wallet
        vscToken = IERC20(_vscToken);
        amount = _amount;
        investorFee = _investorFee;
        ownerFee = _ownerFee;
        owner = _owner;
        investorWallet = _investorWallet;
        ownerWallet = _ownerWallet;
        state = WalletState.Active;
    }
    
    // ========================================
    // PAYER MANAGEMENT
    // ========================================

    /**
     * @notice Set payer address (for marketplace scenarios where payer is unknown initially)
     * @param _payer Address of the payer
     * @dev Can only be called once, typically by factory during funding
     */
    function setPayer(address _payer) external {
        require(!payerSet, "Payer already set");
        require(_payer != address(0), "Invalid payer");
        require(
            msg.sender == investor || msg.sender == owner || msg.sender == factory,
            "Only investor, owner, or factory"
        );

        payer = _payer;
        payerSet = true;
        emit PayerSet(_payer, block.timestamp);
    }

    // ========================================
    // SHIPMENT PROOF FUNCTIONS
    // ========================================

    /**
     * @notice Payee submits shipment proof (JSON + hash + signature)
     * @param data JSON structured data (tracking, photos, etc.)
     * @param dataHash Hash of the structured data
     * @param signature Signature from payee
     */
    function submitShipmentProof(
        string calldata data,
        bytes32 dataHash,
        bytes calldata signature
    ) external {
        require(msg.sender == payee, "Only payee can submit proof");
        require(state == WalletState.Active, "Wallet not active");
        require(!shipmentProof.exists, "Proof already submitted");
        require(bytes(data).length > 0, "Empty data");
        require(dataHash != bytes32(0), "Invalid hash");
        require(signature.length > 0, "Invalid signature");

        // Verify the hash matches the data
        bytes32 computedHash = keccak256(bytes(data));
        require(computedHash == dataHash, "Hash mismatch");

        // Verify the payee actually signed THIS proof for THIS escrow on THIS
        // chain. Previously only `signature.length > 0` was checked, so any
        // bytes passed, and a genuine signature was replayable across escrows
        // and chains because nothing scoped it. ECDSA.recover also rejects the
        // malleable high-s form that raw ecrecover accepts.
        bytes32 digest = MessageHashUtils.toEthSignedMessageHash(
            keccak256(abi.encode(PROOF_DOMAIN, address(this), block.chainid, dataHash))
        );
        if (ECDSA.recover(digest, signature) != payee) revert ProofNotSignedByPayee();
        
        shipmentProof = ShipmentProof({
            data: data,
            dataHash: dataHash,
            signature: signature,
            submittedAt: block.timestamp,
            exists: true
        });
        
        emit ShipmentProofSubmitted(data, dataHash, signature, block.timestamp);
    }
    
    // ========================================
    // DISPUTE FUNCTIONS
    // ========================================
    
    /**
     * @notice Payer raises dispute within 14 days of proof submission
     */
    function raiseDispute() external {
        require(msg.sender == payer, "Only payer can dispute");
        require(state == WalletState.Active, "Wallet not active");
        require(shipmentProof.exists, "No proof submitted yet");
        require(
            block.timestamp <= shipmentProof.submittedAt + DISPUTE_WINDOW,
            "Dispute window closed"
        );
        
        state = WalletState.Disputed;
        emit DisputeRaised(payer, block.timestamp);
    }
    
    /**
     * @notice Investor resolves dispute (manual review)
     * @param refundToPayer True to refund payer, false to release to payee
     */
    function resolveDispute(bool refundToPayer) external nonReentrant {
        require(msg.sender == investor, "Only investor can resolve");
        require(state == WalletState.Disputed, "No active dispute");
        
        if (refundToPayer) {
            _refundToPayer();
        } else {
            // Investor decides payee deserves payment despite dispute
            state = WalletState.Active;
            // Reset ALL signatures. Leaving payerSigned set would re-arm the
            // refund branch on a dispute resolved in the payee's favour.
            payerSigned = false;
            payeeSigned = false;
            investorSigned = false;
        }
        
        emit DisputeResolved(investor, refundToPayer);
    }
    
    // ========================================
    // MULTI-SIGNATURE RELEASE FUNCTIONS
    // ========================================
    
    /**
     * @notice Payer signs to approve refund (2-of-3 multi-sig)
     * @dev Investor + Payer signature = Refund to Payer
     */
    function signAsPayer() external nonReentrant {
        require(payerSet, "Payer not set yet");
        require(msg.sender == payer, "Only payer can sign");
        require(state == WalletState.Active, "Wallet not active");
        require(!payerSigned, "Already signed");

        payerSigned = true;
        emit PayerSigned(payer, block.timestamp);

        // No auto-refund, mirroring signAsPayee. The investor states the
        // direction in signAsInvestor; a signature here is a precondition.
        // (This branch was already unreachable — investorSigned implies a
        // terminal state — but a dead path is a trap for the next edit.)
    }

    /**
     * @notice Payee signs to approve release (2-of-3 multi-sig)
     * @dev Investor + Payee signature = Release to Payee
     */
    function signAsPayee() external nonReentrant {
        require(msg.sender == payee, "Only payee can sign");
        require(state == WalletState.Active, "Wallet not active");
        require(shipmentProof.exists, "No proof submitted");
        require(
            block.timestamp > shipmentProof.submittedAt + DISPUTE_WINDOW,
            "Dispute window still open"
        );
        require(!payeeSigned, "Already signed");

        payeeSigned = true;
        emit PayeeSigned(payee, block.timestamp);

        // No auto-release. The investor states the direction explicitly in
        // signAsInvestor; a signature here is a precondition, not a trigger.
    }

    /**
     * @notice Investor signs to approve transaction (2-of-3 multi-sig)
     * @dev Investor + Payer = Refund, Investor + Payee = Release
     */
    function signAsInvestor(bool releaseToPayee) external nonReentrant {
        require(msg.sender == investor, "Only investor can sign");
        require(state == WalletState.Active, "Wallet not active");
        require(!investorSigned, "Already signed");

        // The direction is an explicit argument, never inferred from who
        // signed first. Inferring it let a payer pre-sign silently and divert
        // an investor's intended release into a refund to themselves; the
        // payee shipped and received nothing.
        if (releaseToPayee) {
            if (!payeeSigned) revert PayeeHasNotSigned();
        } else {
            if (!payerSigned) revert PayerHasNotSigned();
        }

        investorSigned = true;
        emit InvestorSigned(investor, block.timestamp);

        if (releaseToPayee) {
            _releaseToPayee();
        } else {
            _refundToPayer();
        }
    }
    
    // ========================================
    // INTERNAL FUNCTIONS
    // ========================================
    
    /**
     * @dev Release funds to payee with auto-distribution of fees
     * Requires investor + payee signatures (2-of-3)
     */
    // Internal helpers carry no guard: every external entry that reaches
    // them (signAsPayee, signAsInvestor, resolveDispute, manualRefund) is
    // nonReentrant, and OpenZeppelin's guard reverts when a guarded
    // function calls another guarded function.
    function _releaseToPayee() internal {
        require(payeeSigned && investorSigned, "Need payee and investor signatures");
        require(state == WalletState.Active, "Wallet not active");

        state = WalletState.Released;

        // Auto-distribute funds
        require(vscToken.transfer(payee, amount), "Transfer to payee failed");
        require(vscToken.transfer(investorWallet, investorFee), "Investor fee transfer failed");
        require(vscToken.transfer(ownerWallet, ownerFee), "Owner fee transfer failed");

        emit FundsReleased(payee, amount, investor, investorFee, owner, ownerFee);
    }
    
    /**
     * @dev Refund full amount to payer (including fees)
     */
    function _refundToPayer() internal {
        state = WalletState.Refunded;
        
        uint256 totalRefund = amount + investorFee + ownerFee;
        require(vscToken.transfer(payer, totalRefund), "Refund failed");
        
        emit FundsRefunded(payer, totalRefund);
    }
    
    /**
     * @notice Investor can manually refund (for disputes or issues)
     */
    function manualRefund() external nonReentrant {
        require(msg.sender == investor, "Only investor can refund");
        require(
            state == WalletState.Active || state == WalletState.Disputed,
            "Cannot refund in current state"
        );
        
        _refundToPayer();
    }
    
    // ========================================
    // VIEW FUNCTIONS
    // ========================================
    
    /**
     * @notice Check if dispute window is currently open
     */
    function isDisputeWindowOpen() external view returns (bool) {
        if (!shipmentProof.exists) return false;
        return block.timestamp <= shipmentProof.submittedAt + DISPUTE_WINDOW;
    }
    
    /**
     * @notice Check if ready for signatures (dispute window closed)
     */
    function isReadyForSignatures() external view returns (bool) {
        if (!shipmentProof.exists) return false;
        return block.timestamp > shipmentProof.submittedAt + DISPUTE_WINDOW;
    }
    
    /**
     * @notice Get complete wallet status
     */
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
    ) {
        currentState = state;
        payerIsSet = payerSet;
        proofSubmitted = shipmentProof.exists;

        if (shipmentProof.exists) {
            uint256 windowEnd = shipmentProof.submittedAt + DISPUTE_WINDOW;
            disputeWindowOpen = block.timestamp <= windowEnd;
            readyForSignatures = block.timestamp > windowEnd;
            timeUntilSignatures = block.timestamp < windowEnd ? windowEnd - block.timestamp : 0;
        }

        payerHasSigned = payerSigned;
        payeeHasSigned = payeeSigned;
        investorHasSigned = investorSigned;
    }
    
    /**
     * @notice Get shipment proof details
     */
    function getShipmentProof() external view returns (
        string memory data,
        bytes32 dataHash,
        bytes memory signature,
        uint256 submittedAt,
        bool exists
    ) {
        return (
            shipmentProof.data,
            shipmentProof.dataHash,
            shipmentProof.signature,
            shipmentProof.submittedAt,
            shipmentProof.exists
        );
    }
}

