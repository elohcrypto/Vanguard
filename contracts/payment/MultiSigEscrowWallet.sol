// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import "./MultiSigEscrowTerms.sol";

/**
 * @title MultiSigEscrowWallet
 * @notice One-time-use multi-signature escrow wallet for a single payment
 * @dev 2-of-3 multisig: Investor MUST sign + (Payer OR Payee)
 *      - Investor + Payee = Release to Payee
 *      - Investor + Payer = Refund to Payer
 */
contract MultiSigEscrowWallet is MultiSigEscrowTerms, ReentrancyGuard {
    // ========================================
    // WALLET STATE
    // ========================================
    
    enum WalletState { Active, Released, Refunded, Disputed }
    WalletState public state;

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
    ) MultiSigEscrowTerms(
        _paymentId,
        _payer,
        _payee,
        _investor,
        _vscToken,
        _amount,
        _investorFee,
        _ownerFee,
        _owner,
        _investorWallet,
        _ownerWallet
    ) {
        state = WalletState.Active;
    }
    
    // ========================================
    // SHIPMENT PROOF FUNCTIONS
    // ========================================

    /// @dev Domain tag binding a shipment proof to this protocol.
    string private constant PROOF_DOMAIN = "VanguardShipmentProof";

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
        // Escrow review 2.5.1: the factory's per-investor fee total
        // (getInvestorProfile; option 69 prints it) records each release.
        IEscrowFeeLedger(factory).updateInvestorFeesEarned(investor, investorFee);

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
        // Block a unilateral refund once the payee has shipped: that path let a
        // 1-of-3 investor rug a payee who performed. A funded-but-not-shipped
        // escrow may still be refunded here. A shipped one needs a second
        // party: either the payer disputes (raiseDispute, then resolveDispute
        // or this function), or the payer counter-signs (signAsPayer, then
        // signAsInvestor(false)).
        if (state == WalletState.Active && shipmentProof.exists) revert RefundBlockedAfterShipment();
        
        _refundToPayer();
    }

    /**
     * @notice Return tokens that reached this escrow outside the factory's single
     *         funding. `funded` only stops a second FACTORY funding; any verified
     *         holder can transfer here directly, and release/refund pay fixed
     *         sums, so the rest sat here forever. An escrow party (payer,
     *         payee, investor, platform owner) may call it once settled; a
     *         public sweep let any holder relay VSC through a settled escrow
     *         (H4). Goes to the payer, the party that funds escrows. If none
     *         ever identified themselves (marketplace escrow settled from
     *         direct transfers) it goes to the platform fee wallet, which
     *         release already pays, rather than to address(0) where it would
     *         strand. The token's investor caps apply to the recipient.
     */
    function sweepExcess() external nonReentrant {
        if (
            msg.sender != payer && msg.sender != payee &&
            msg.sender != investor && msg.sender != owner
        ) revert NotEscrowParty();
        if (state != WalletState.Released && state != WalletState.Refunded) revert EscrowStillActive();
        uint256 excess = vscToken.balanceOf(address(this));
        if (excess == 0) revert NothingToSweep();
        address to = payerSet ? payer : ownerWallet;
        if (!vscToken.transfer(to, excess)) revert SweepFailed();
        emit ExcessSwept(to, excess);
    }

    // ========================================
    // VIEW FUNCTIONS
    // ========================================
    
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
}
