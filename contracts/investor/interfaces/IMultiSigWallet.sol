// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

/**
 * @title IMultiSigWallet
 * @dev Interface for MultiSigWallet contract
 */
interface IMultiSigWallet {
    // Events
    event TokensLocked(address indexed user, uint256 amount, uint256 timestamp);
    event UnlockProposalCreated(bytes32 indexed proposalId, address indexed proposer, uint256 amount, string reason);
    event ProposalSigned(bytes32 indexed proposalId, address indexed signer, bool isBankSignature);
    event TokensUnlocked(bytes32 indexed proposalId, address indexed recipient, uint256 amount);
    event ProposalCancelled(bytes32 indexed proposalId, address indexed canceller);
    
    // Core functions
    function lockTokens(uint256 amount) external;
    
    function proposeUnlock(
        uint256 amount,
        address recipient,
        string calldata reason
    ) external returns (bytes32 proposalId);
    
    function signUnlock(bytes32 proposalId) external;
    
    function cancelProposal(bytes32 proposalId) external;
    
    // View functions
    function getProposal(bytes32 proposalId) external view returns (
        uint256 proposalNumber,
        uint256 amount,
        address recipient,
        bool bankSigned,
        bool userSigned,
        bool executed,
        uint256 createdAt,
        string memory reason
    );
    
    function getWalletStatus() external view returns (
        address bankAddress,
        address userAddress,
        address tokenAddress,
        uint256 locked,
        uint256 balance
    );
    
    function isFullySigned(bytes32 proposalId) external view returns (bool);
    
    function getLockedBalance() external view returns (uint256);
    
    // Public variables
    function bank() external view returns (address);
    function user() external view returns (address);
    function token() external view returns (address);
    function lockedAmount() external view returns (uint256);
}

