// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * @title MultiSigWallet
 * @dev 2-of-2 multi-signature wallet for investor token locking
 * @notice Requires both bank and user signatures to unlock tokens
 * @author Vanguard StableCoin Team
 */
contract MultiSigWallet is Ownable, ReentrancyGuard {
    // Wallet participants
    address public immutable bank;
    address public immutable user;
    address public immutable token;
    
    // Locked token amount
    uint256 public lockedAmount;
    
    // Unlock proposal structure
    struct UnlockProposal {
        uint256 proposalId;
        uint256 amount;
        address recipient;
        bool bankSigned;
        bool userSigned;
        bool executed;
        uint256 createdAt;
        string reason;
    }
    
    // Proposals mapping
    mapping(bytes32 => UnlockProposal) public proposals;
    
    // Proposal counter
    uint256 private _proposalCounter;
    
    // Events
    event TokensLocked(address indexed user, uint256 amount, uint256 timestamp);
    event UnlockProposalCreated(bytes32 indexed proposalId, address indexed proposer, uint256 amount, string reason);
    event ProposalSigned(bytes32 indexed proposalId, address indexed signer, bool isBankSignature);
    event TokensUnlocked(bytes32 indexed proposalId, address indexed recipient, uint256 amount);
    event ProposalCancelled(bytes32 indexed proposalId, address indexed canceller);
    
    /**
     * @dev Constructor
     * @param _bank Bank address (first signer)
     * @param _user User address (second signer)
     * @param _token Token contract address
     */
    constructor(address _bank, address _user, address _token) Ownable(msg.sender) {
        require(_bank != address(0), "Invalid bank address");
        require(_user != address(0), "Invalid user address");
        require(_token != address(0), "Invalid token address");
        require(_bank != _user, "Bank and user must be different");
        
        bank = _bank;
        user = _user;
        token = _token;
    }
    
    /**
     * @dev Lock tokens in the wallet
     * @param amount Amount of tokens to lock
     * @notice Only user can lock tokens
     */
    function lockTokens(uint256 amount) external nonReentrant {
        require(msg.sender == user, "Only user can lock tokens");
        require(amount > 0, "Amount must be greater than 0");
        require(lockedAmount == 0, "Tokens already locked");
        
        // Transfer tokens from user to this contract
        require(
            IERC20(token).transferFrom(msg.sender, address(this), amount),
            "Token transfer failed"
        );
        
        lockedAmount = amount;
        
        emit TokensLocked(msg.sender, amount, block.timestamp);
    }
    
    /**
     * @dev Create unlock proposal
     * @param amount Amount to unlock
     * @param recipient Recipient address (usually user)
     * @param reason Reason for unlocking
     * @return proposalId The created proposal ID
     */
    function proposeUnlock(
        uint256 amount,
        address recipient,
        string calldata reason
    ) external returns (bytes32 proposalId) {
        require(msg.sender == user || msg.sender == bank, "Not authorized");
        require(amount > 0 && amount <= lockedAmount, "Invalid amount");
        require(recipient != address(0), "Invalid recipient");
        require(bytes(reason).length > 0, "Reason required");
        
        // Generate unique proposal ID
        _proposalCounter++;
        proposalId = keccak256(
            abi.encodePacked(
                address(this),
                _proposalCounter,
                block.timestamp,
                amount,
                recipient
            )
        );
        
        // Create proposal
        proposals[proposalId] = UnlockProposal({
            proposalId: _proposalCounter,
            amount: amount,
            recipient: recipient,
            bankSigned: false,
            userSigned: false,
            executed: false,
            createdAt: block.timestamp,
            reason: reason
        });
        
        emit UnlockProposalCreated(proposalId, msg.sender, amount, reason);
        
        return proposalId;
    }
    
    /**
     * @dev Sign unlock proposal
     * @param proposalId Proposal ID to sign
     */
    function signUnlock(bytes32 proposalId) external {
        require(msg.sender == user || msg.sender == bank, "Not authorized");
        
        UnlockProposal storage proposal = proposals[proposalId];
        require(proposal.createdAt > 0, "Proposal does not exist");
        require(!proposal.executed, "Proposal already executed");
        
        // Record signature
        if (msg.sender == bank) {
            require(!proposal.bankSigned, "Bank already signed");
            proposal.bankSigned = true;
            emit ProposalSigned(proposalId, msg.sender, true);
        } else {
            require(!proposal.userSigned, "User already signed");
            proposal.userSigned = true;
            emit ProposalSigned(proposalId, msg.sender, false);
        }
        
        // Auto-execute if both signatures collected
        if (proposal.bankSigned && proposal.userSigned) {
            _executeUnlock(proposalId);
        }
    }
    
    /**
     * @dev Execute unlock proposal (internal)
     * @param proposalId Proposal ID to execute
     */
    function _executeUnlock(bytes32 proposalId) private nonReentrant {
        UnlockProposal storage proposal = proposals[proposalId];
        
        require(proposal.bankSigned, "Bank signature missing");
        require(proposal.userSigned, "User signature missing");
        require(!proposal.executed, "Already executed");
        require(proposal.amount <= lockedAmount, "Insufficient locked balance");
        
        // Mark as executed
        proposal.executed = true;
        
        // Update locked amount
        lockedAmount -= proposal.amount;
        
        // Transfer tokens to recipient
        require(
            IERC20(token).transfer(proposal.recipient, proposal.amount),
            "Token transfer failed"
        );
        
        emit TokensUnlocked(proposalId, proposal.recipient, proposal.amount);
    }
    
    /**
     * @dev Cancel unlock proposal
     * @param proposalId Proposal ID to cancel
     * @notice Only the proposer or owner can cancel
     */
    function cancelProposal(bytes32 proposalId) external {
        require(msg.sender == user || msg.sender == bank || msg.sender == owner(), "Not authorized");
        
        UnlockProposal storage proposal = proposals[proposalId];
        require(proposal.createdAt > 0, "Proposal does not exist");
        require(!proposal.executed, "Proposal already executed");
        
        // Delete proposal
        delete proposals[proposalId];
        
        emit ProposalCancelled(proposalId, msg.sender);
    }
    
    /**
     * @dev Get proposal details
     * @param proposalId Proposal ID
     * @return proposalNumber Proposal number
     * @return amount Amount to unlock
     * @return recipient Recipient address
     * @return bankSigned Bank signature status
     * @return userSigned User signature status
     * @return executed Execution status
     * @return createdAt Creation timestamp
     * @return reason Unlock reason
     */
    function getProposal(bytes32 proposalId) external view returns (
        uint256 proposalNumber,
        uint256 amount,
        address recipient,
        bool bankSigned,
        bool userSigned,
        bool executed,
        uint256 createdAt,
        string memory reason
    ) {
        UnlockProposal memory proposal = proposals[proposalId];
        return (
            proposal.proposalId,
            proposal.amount,
            proposal.recipient,
            proposal.bankSigned,
            proposal.userSigned,
            proposal.executed,
            proposal.createdAt,
            proposal.reason
        );
    }
    
    /**
     * @dev Get wallet status
     * @return bankAddress Bank address
     * @return userAddress User address
     * @return tokenAddress Token address
     * @return locked Locked amount
     * @return balance Wallet balance
     */
    function getWalletStatus() external view returns (
        address bankAddress,
        address userAddress,
        address tokenAddress,
        uint256 locked,
        uint256 balance
    ) {
        return (
            bank,
            user,
            token,
            lockedAmount,
            IERC20(token).balanceOf(address(this))
        );
    }
    
    /**
     * @dev Check if proposal has both signatures
     * @param proposalId Proposal ID
     * @return True if both signatures present
     */
    function isFullySigned(bytes32 proposalId) external view returns (bool) {
        UnlockProposal memory proposal = proposals[proposalId];
        return proposal.bankSigned && proposal.userSigned && !proposal.executed;
    }
    
    /**
     * @dev Get current locked balance
     * @return Locked token amount
     */
    function getLockedBalance() external view returns (uint256) {
        return lockedAmount;
    }
}

