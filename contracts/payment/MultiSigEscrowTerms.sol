// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @dev The factory's fee ledger (EscrowWalletFactory.updateInvestorFeesEarned).
interface IEscrowFeeLedger {
    function updateInvestorFeesEarned(address investor, uint256 feeAmount) external;
}

/**
 * @title MultiSigEscrowTerms
 * @dev The terms half of MultiSigEscrowWallet (split by inheritance, plan
 *      Task 4.8): the parties, amounts and fee wallets fixed at creation,
 *      the shipment proof record, the three signature flags, the funding
 *      flag and the deferred (marketplace) payer, with their errors and
 *      events. MultiSigEscrowWallet is the only contract deployed.
 */
abstract contract MultiSigEscrowTerms {
    // ========================================
    // WALLET DETAILS
    // ========================================

    // No immutables (plan v2 Task 4.3): an immutable is spliced into the
    // runtime code, so every escrow would have its own code hash, and the
    // factory may trust (as a ComplianceRules registrar) only accounts whose
    // code hash is the compiled MultiSigEscrowWallet's.
    uint256 public paymentId;
    address public payer;                      // Mutable: set on first funding if unknown
    bool public payerSet;                      // True after payer is locked
    address public payee;
    address public investor;
    address public factory;          // Factory that created this wallet
    IERC20 public vscToken;

    uint256 public amount;           // Payment amount to payee
    uint256 public investorFee;      // 3% fee to investor
    uint256 public ownerFee;         // 2% fee to owner

    address public owner;            // Platform owner
    address public investorWallet;   // Investor's wallet for fee
    address public ownerWallet;      // Owner's wallet for fee
    
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

    /**
     * @notice True once the factory has funded this escrow.
     * @dev Funding used to be gated only on `state == Active`, true both before
     *      and after funding, so fundEscrowWallet ran repeatedly and each extra
     *      funding was stranded (release and refund pay fixed sums). This flag
     *      stops the factory path; anything else that arrives is returned by
     *      sweepExcess once the escrow is settled.
     */
    bool public funded;

    error OnlyFactory();        // markFunded: caller is not the factory
    error AlreadyFunded();      // markFunded: already set
    error EscrowStillActive();  // sweepExcess: escrow not yet Released/Refunded
    error NothingToSweep();     // sweepExcess: balance is zero
    error SweepFailed();        // sweepExcess: token transfer returned false
    error NotEscrowParty();     // sweepExcess: caller is not an escrow party
    /// @notice Investor coincides with a counterparty (payee/payer). Blocks
    ///         self-dealing at construction as defence in depth behind the factory.
    /// @notice Investor tried to unilaterally refund after the payee shipped.
    ///         Once proof exists a refund needs the payer as well (a dispute,
    ///         or signAsPayer + signAsInvestor(false)); a 1-of-3 investor
    ///         cannot rug a performer.
    error RefundBlockedAfterShipment();
    error InvestorCannotBePayee();
    error InvestorCannotBePayer();
    /// @notice setPayer: the deferred (marketplace) payer is the payee.
    error PayerCannotBePayee();

    /// @notice Tokens beyond the escrow's own settlement were returned.
    event ExcessSwept(address indexed to, uint256 amount);

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
        if (_investor == _payee) revert InvestorCannotBePayee();
        if (_payer != address(0) && _investor == _payer) revert InvestorCannotBePayer();
        // Escrow review 2.3.1: the factory refuses payer == payee; so does
        // the wallet, for anyone who deploys it directly.
        if (_payer != address(0) && _payer == _payee) revert PayerCannotBePayee();
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
        // The constructor skips the investor/payer check for a marketplace
        // escrow (payer unknown). Close the same invariant here: the factory's
        // first-funder-becomes-payer path and a direct setPayer both land on
        // this line, so an investor cannot make itself the payer later.
        if (_payer == investor) revert InvestorCannotBePayer();
        // Mirror the factory's creation-time invariant: a marketplace payee
        // must not fund the escrow and become its own payer, or it holds both
        // shipment proof and the payer's signature/dispute.
        if (_payer == payee) revert PayerCannotBePayee();

        payer = _payer;
        payerSet = true;
        emit PayerSet(_payer, block.timestamp);
    }
}
