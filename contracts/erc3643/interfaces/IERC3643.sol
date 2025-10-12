// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/**
 * @title IERC3643 Interface
 * @dev Interface for ERC-3643 T-REX (Token for Regulated eXchanges) standard
 * This interface defines the core functionality for compliant security tokens
 */
interface IERC3643 is IERC20 {
    // Events
    event IdentityRegistryAdded(address indexed _identityRegistry);
    event ComplianceAdded(address indexed _compliance);
    event RecoverySuccess(address indexed _lostWallet, address indexed _newWallet, address indexed _investorOnchainID);
    event AddressFrozen(address indexed _userAddress, bool indexed _isFrozen, address indexed _owner);
    event TokensFrozen(address indexed _userAddress, uint256 _amount);
    event TokensUnfrozen(address indexed _userAddress, uint256 _amount);

    // Note: Paused and Unpaused events are inherited from OpenZeppelin's Pausable

    // Core T-REX functions
    function identityRegistry() external view returns (address);

    function compliance() external view returns (address);

    // Token management
    function mint(address _to, uint256 _amount) external;

    function burn(address _from, uint256 _amount) external;

    function setAddressFrozen(address _userAddress, bool _freeze) external;

    function freezePartialTokens(address _userAddress, uint256 _amount) external;

    function unfreezePartialTokens(address _userAddress, uint256 _amount) external;

    // Compliance checks
    function canTransfer(address _from, address _to, uint256 _amount) external view returns (bool);

    // Recovery mechanism
    function recoveryAddress(
        address _lostWallet,
        address _newWallet,
        address _investorOnchainID
    ) external returns (bool);

    // Pause functionality
    function pause() external;

    function unpause() external;

    function paused() external view returns (bool);

    // Balance queries
    // Note: balanceOf is inherited from ERC20

    function frozenTokens(address _userAddress) external view returns (uint256);

    function getFreeBalance(address _userAddress) external view returns (uint256);

    // Address status
    function isFrozen(address _userAddress) external view returns (bool);

    // Registry management
    function setIdentityRegistry(address _identityRegistry) external;

    function setCompliance(address _compliance) external;
}
