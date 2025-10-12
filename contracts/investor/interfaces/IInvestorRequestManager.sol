// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "../../erc3643/interfaces/IInvestorTypeRegistry.sol";

/**
 * @title IInvestorRequestManager
 * @dev Interface for InvestorRequestManager contract
 */
interface IInvestorRequestManager {
    // Request status enumeration
    enum RequestStatus {
        None,
        Pending,
        WalletCreated,
        TokensLocked,
        Approved,
        Rejected
    }
    
    // Events
    event InvestorRequestCreated(
        address indexed user,
        IInvestorTypeRegistry.InvestorType requestedType,
        uint256 requiredLockAmount,
        uint256 timestamp
    );
    event MultiSigWalletCreated(
        address indexed user,
        address indexed wallet,
        uint256 timestamp
    );
    event TokensLocked(
        address indexed user,
        address indexed wallet,
        uint256 amount,
        uint256 timestamp
    );
    event InvestorRequestApproved(
        address indexed user,
        IInvestorTypeRegistry.InvestorType investorType,
        uint256 timestamp
    );
    event InvestorRequestRejected(
        address indexed user,
        string reason,
        uint256 timestamp
    );
    event LockRequirementUpdated(
        IInvestorTypeRegistry.InvestorType investorType,
        uint256 oldAmount,
        uint256 newAmount
    );
    event InvestorDowngraded(
        address indexed user,
        IInvestorTypeRegistry.InvestorType oldType,
        IInvestorTypeRegistry.InvestorType newType,
        uint256 timestamp
    );
    
    // Core functions
    function requestInvestorStatus(IInvestorTypeRegistry.InvestorType requestedType) external;
    
    function createMultiSigWallet(address user) external;
    
    function confirmTokensLocked() external;
    
    function approveRequest(address user) external;
    
    function rejectRequest(address user, string calldata reason) external;
    
    function updateLockRequirement(
        IInvestorTypeRegistry.InvestorType investorType,
        uint256 newAmount
    ) external;
    
    // View functions
    function getRequest(address user) external view returns (
        IInvestorTypeRegistry.InvestorType requestedType,
        uint256 requiredLockAmount,
        address multiSigWallet,
        RequestStatus status,
        uint256 createdAt,
        uint256 approvedAt,
        string memory rejectionReason
    );
    
    function getRequestCount() external view returns (uint256);
    
    function getRequestByIndex(uint256 index) external view returns (address user);
    
    // Public variables
    function bank() external view returns (address);
    function token() external view returns (address);
    function investorRegistry() external view returns (IInvestorTypeRegistry);
    function lockRequirements(IInvestorTypeRegistry.InvestorType) external view returns (uint256);
    function hasActiveRequest(address) external view returns (bool);
}

