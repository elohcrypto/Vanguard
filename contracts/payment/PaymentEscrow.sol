// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "./interfaces/IPaymentEscrow.sol";

/**
 * @title PaymentEscrow
 * @dev Secure fund holding system for payment protocol
 * @author Vanguard StableCoin Team
 */
contract PaymentEscrow is IPaymentEscrow, Ownable, ReentrancyGuard, Pausable {
    // State variables
    IERC20 public immutable vscToken;
    address public paymentProtocol;

    // Storage
    mapping(uint256 => EscrowDetails) private _escrows;
    mapping(uint256 => uint256) private _paymentToEscrow; // paymentId => escrowId

    uint256 private _nextEscrowId = 1;
    uint256 public totalEscrows;
    uint256 public totalEscrowedAmount;

    // Fee settings
    uint256 public escrowFeeRate = 10; // 0.1% (10 basis points)
    uint256 public constant MAX_FEE_RATE = 1000; // 10% maximum
    uint256 public constant FEE_DENOMINATOR = 10000; // 100% = 10000 basis points

    // Emergency settings
    address public emergencyRefundAuthority;
    uint256 public defaultEscrowDuration = 31 days; // 24h confirmation + 7d dispute window

    // Modifiers
    modifier onlyPaymentProtocol() {
        require(msg.sender == paymentProtocol, "Only payment protocol");
        _;
    }

    modifier validEscrowId(uint256 escrowId) {
        require(escrowId > 0 && escrowId < _nextEscrowId, "Invalid escrow ID");
        _;
    }

    modifier onlyEmergencyAuthority() {
        require(
            msg.sender == emergencyRefundAuthority || msg.sender == owner() || msg.sender == paymentProtocol,
            "Only emergency authority"
        );
        _;
    }

    constructor(address _vscToken, address _paymentProtocol) Ownable(msg.sender) {
        require(_vscToken != address(0), "Invalid VSC token");
        require(_paymentProtocol != address(0), "Invalid payment protocol");

        vscToken = IERC20(_vscToken);
        paymentProtocol = _paymentProtocol;
        emergencyRefundAuthority = msg.sender;
    }

    /**
     * @dev Create escrow for payment
     */
    function createEscrow(
        uint256 paymentId,
        address payer,
        address payee,
        uint256 amount,
        uint256 duration
    ) external override onlyPaymentProtocol whenNotPaused returns (uint256 escrowId) {
        require(payer != address(0), "Invalid payer");
        require(payee != address(0), "Invalid payee");
        require(amount > 0, "Invalid amount");
        require(duration > 0, "Invalid duration");
        require(_paymentToEscrow[paymentId] == 0, "Escrow already exists for payment");

        // Calculate fee
        uint256 fee = calculateEscrowFee(amount);
        uint256 totalAmount = amount + fee;

        // Verify tokens are received
        require(vscToken.balanceOf(address(this)) >= totalAmount, "Insufficient escrow balance");

        // Create escrow record
        escrowId = _nextEscrowId++;
        EscrowDetails storage escrow = _escrows[escrowId];

        escrow.escrowId = escrowId;
        escrow.paymentId = paymentId;
        escrow.payer = payer;
        escrow.payee = payee;
        escrow.amount = amount;
        escrow.fee = fee;
        escrow.state = EscrowState.Active;
        escrow.createdAt = block.timestamp;
        escrow.expiryTime = block.timestamp + duration;
        escrow.emergencyRefundable = true;

        // Update mappings
        _paymentToEscrow[paymentId] = escrowId;
        totalEscrows++;
        totalEscrowedAmount += totalAmount;

        emit EscrowCreated(escrowId, paymentId, payer, payee, amount, fee);
    }

    /**
     * @dev Release escrow funds to payee
     */
    function releaseEscrow(
        uint256 escrowId
    ) external override validEscrowId(escrowId) onlyPaymentProtocol nonReentrant {
        EscrowDetails storage escrow = _escrows[escrowId];
        require(escrow.state == EscrowState.Active, "Escrow not active");
        require(!isEscrowExpired(escrowId), "Escrow expired");

        // Update state
        escrow.state = EscrowState.Released;
        totalEscrowedAmount -= (escrow.amount + escrow.fee);

        // Transfer amount to payee (fee stays in contract)
        require(vscToken.transfer(escrow.payee, escrow.amount), "Transfer to payee failed");

        emit EscrowReleased(escrowId, escrow.payee, escrow.amount);
    }

    /**
     * @dev Refund escrow funds to payer
     */
    function refundEscrow(uint256 escrowId) external override validEscrowId(escrowId) onlyPaymentProtocol nonReentrant {
        EscrowDetails storage escrow = _escrows[escrowId];
        require(escrow.state == EscrowState.Active, "Escrow not active");

        // Update state
        escrow.state = EscrowState.Refunded;
        totalEscrowedAmount -= (escrow.amount + escrow.fee);

        // Refund full amount including fee to payer
        uint256 refundAmount = escrow.amount + escrow.fee;
        require(vscToken.transfer(escrow.payer, refundAmount), "Refund transfer failed");

        emit EscrowRefunded(escrowId, escrow.payer, refundAmount);
    }

    /**
     * @dev Emergency refund (authority only)
     */
    function emergencyRefund(
        uint256 escrowId
    ) external override validEscrowId(escrowId) onlyEmergencyAuthority nonReentrant {
        EscrowDetails storage escrow = _escrows[escrowId];
        require(escrow.state == EscrowState.Active, "Escrow not active");
        require(escrow.emergencyRefundable, "Not emergency refundable");

        // Update state
        escrow.state = EscrowState.Refunded;
        totalEscrowedAmount -= (escrow.amount + escrow.fee);

        // Emergency refund to payer (including fee)
        uint256 refundAmount = escrow.amount + escrow.fee;
        require(vscToken.transfer(escrow.payer, refundAmount), "Emergency refund failed");

        emit EmergencyEscrowRefund(escrowId, msg.sender, refundAmount);
    }

    /**
     * @dev Extend escrow duration
     */
    function extendEscrow(
        uint256 escrowId,
        uint256 additionalTime
    ) external override validEscrowId(escrowId) onlyPaymentProtocol {
        EscrowDetails storage escrow = _escrows[escrowId];
        require(escrow.state == EscrowState.Active, "Escrow not active");
        require(additionalTime > 0, "Invalid additional time");

        escrow.expiryTime += additionalTime;
    }

    /**
     * @dev Process expired escrows (automatic refund)
     */
    function processExpiredEscrow(uint256 escrowId) external validEscrowId(escrowId) nonReentrant {
        EscrowDetails storage escrow = _escrows[escrowId];
        require(escrow.state == EscrowState.Active, "Escrow not active");
        require(isEscrowExpired(escrowId), "Escrow not expired");

        // Update state
        escrow.state = EscrowState.Expired;
        totalEscrowedAmount -= (escrow.amount + escrow.fee);

        // Auto-refund to payer (including fee)
        uint256 refundAmount = escrow.amount + escrow.fee;
        require(vscToken.transfer(escrow.payer, refundAmount), "Expired refund failed");

        emit EscrowExpired(escrowId, block.timestamp);
        emit EscrowRefunded(escrowId, escrow.payer, refundAmount);
    }

    /**
     * @dev Get escrow details
     */
    function getEscrowDetails(
        uint256 escrowId
    ) external view override validEscrowId(escrowId) returns (EscrowDetails memory) {
        return _escrows[escrowId];
    }

    /**
     * @dev Get escrow by payment ID
     */
    function getEscrowByPayment(uint256 paymentId) external view override returns (uint256 escrowId) {
        return _paymentToEscrow[paymentId];
    }

    /**
     * @dev Check if escrow is expired
     */
    function isEscrowExpired(uint256 escrowId) public view override validEscrowId(escrowId) returns (bool) {
        return block.timestamp > _escrows[escrowId].expiryTime;
    }

    /**
     * @dev Get escrow balance
     */
    function getEscrowBalance(uint256 escrowId) external view override validEscrowId(escrowId) returns (uint256) {
        EscrowDetails storage escrow = _escrows[escrowId];
        if (escrow.state == EscrowState.Active) {
            return escrow.amount + escrow.fee;
        }
        return 0;
    }

    /**
     * @dev Calculate escrow fee
     */
    function calculateEscrowFee(uint256 amount) public view override returns (uint256) {
        return (amount * escrowFeeRate) / FEE_DENOMINATOR;
    }

    /**
     * @dev Set payment protocol address (owner only)
     */
    function setPaymentProtocol(address _paymentProtocol) external onlyOwner {
        require(_paymentProtocol != address(0), "Invalid payment protocol");
        paymentProtocol = _paymentProtocol;
    }

    /**
     * @dev Set emergency refund authority (owner only)
     */
    function setEmergencyRefundAuthority(address _authority) external onlyOwner {
        require(_authority != address(0), "Invalid authority");
        emergencyRefundAuthority = _authority;
    }

    /**
     * @dev Update escrow fee rate (owner only)
     */
    function setEscrowFeeRate(uint256 _feeRate) external onlyOwner {
        require(_feeRate <= MAX_FEE_RATE, "Fee rate too high");
        escrowFeeRate = _feeRate;
    }

    /**
     * @dev Set default escrow duration (owner only)
     */
    function setDefaultEscrowDuration(uint256 _duration) external onlyOwner {
        require(_duration >= 1 days, "Duration too short");
        require(_duration <= 90 days, "Duration too long");
        defaultEscrowDuration = _duration;
    }

    /**
     * @dev Withdraw collected fees (owner only)
     */
    function withdrawFees(address recipient, uint256 amount) external onlyOwner nonReentrant {
        require(recipient != address(0), "Invalid recipient");
        require(amount > 0, "Invalid amount");

        uint256 availableFees = vscToken.balanceOf(address(this)) - totalEscrowedAmount;
        require(amount <= availableFees, "Insufficient fee balance");

        require(vscToken.transfer(recipient, amount), "Fee withdrawal failed");
    }

    /**
     * @dev Get available fee balance
     */
    function getAvailableFees() external view returns (uint256) {
        uint256 totalBalance = vscToken.balanceOf(address(this));
        return totalBalance > totalEscrowedAmount ? totalBalance - totalEscrowedAmount : 0;
    }

    /**
     * @dev Batch process expired escrows
     */
    function batchProcessExpiredEscrows(uint256[] calldata escrowIds) external {
        for (uint256 i = 0; i < escrowIds.length; i++) {
            if (isEscrowExpired(escrowIds[i]) && _escrows[escrowIds[i]].state == EscrowState.Active) {
                this.processExpiredEscrow(escrowIds[i]);
            }
        }
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
