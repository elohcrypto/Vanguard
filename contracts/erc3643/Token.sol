// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "./interfaces/IERC3643.sol";
import "./interfaces/IIdentityRegistry.sol";
import "./interfaces/ICompliance.sol";
import "./interfaces/IInvestorTypeRegistry.sol";

/**
 * @title ERC3643 Token
 * @dev Implementation of ERC-3643 T-REX standard for compliant security tokens
 */
contract Token is IERC3643, ERC20, Ownable, Pausable {
    // State variables
    IIdentityRegistry private _identityRegistry;
    ICompliance private _compliance;
    IInvestorTypeRegistry private _investorTypeRegistry;

    // Frozen addresses
    mapping(address => bool) private _frozen;

    // Frozen tokens per address
    mapping(address => uint256) private _frozenTokens;

    // Agent addresses
    mapping(address => bool) private _agents;

    modifier onlyAgent() {
        require(_agents[msg.sender] || msg.sender == owner(), "Not authorized agent");
        _;
    }

    modifier whenNotFrozen(address _userAddress) {
        require(!_frozen[_userAddress], "Address is frozen");
        _;
    }

    modifier whenTransferAllowed(
        address _from,
        address _to,
        uint256 _amount
    ) {
        require(canTransfer(_from, _to, _amount), "Transfer not allowed");
        _;
    }

    constructor(
        string memory _name,
        string memory _symbol,
        address _identityRegistryAddress,
        address _complianceAddress
    ) ERC20(_name, _symbol) Ownable(msg.sender) {
        _identityRegistry = IIdentityRegistry(_identityRegistryAddress);
        _compliance = ICompliance(_complianceAddress);
        _agents[msg.sender] = true;

        emit IdentityRegistryAdded(_identityRegistryAddress);
        emit ComplianceAdded(_complianceAddress);
    }

    // ERC-3643 Implementation

    function identityRegistry() external view override returns (address) {
        return address(_identityRegistry);
    }

    function compliance() external view override returns (address) {
        return address(_compliance);
    }

    function mint(address _to, uint256 _amount) external override onlyAgent whenNotPaused {
        require(_identityRegistry.isVerified(_to), "Identity not verified");
        require(_compliance.canTransfer(address(0), _to, _amount), "Compliance check failed");

        _mint(_to, _amount);
        _compliance.created(_to, _amount);
    }

    function burn(address _from, uint256 _amount) external override onlyAgent whenNotPaused {
        require(balanceOf(_from) >= _amount, "Insufficient balance");
        require(getFreeBalance(_from) >= _amount, "Insufficient free balance");

        _burn(_from, _amount);
        _compliance.destroyed(_from, _amount);
    }

    function setAddressFrozen(address _userAddress, bool _freeze) external override onlyAgent {
        _frozen[_userAddress] = _freeze;
        emit AddressFrozen(_userAddress, _freeze, msg.sender);
    }

    function freezePartialTokens(address _userAddress, uint256 _amount) external override onlyAgent {
        require(balanceOf(_userAddress) >= _frozenTokens[_userAddress] + _amount, "Insufficient balance to freeze");
        _frozenTokens[_userAddress] += _amount;
        emit TokensFrozen(_userAddress, _amount);
    }

    function unfreezePartialTokens(address _userAddress, uint256 _amount) external override onlyAgent {
        require(_frozenTokens[_userAddress] >= _amount, "Insufficient frozen tokens");
        _frozenTokens[_userAddress] -= _amount;
        emit TokensUnfrozen(_userAddress, _amount);
    }

    function canTransfer(address _from, address _to, uint256 _amount) public view override returns (bool) {
        if (_from == address(0)) {
            // Minting case - check holding limits for recipient
            bool identityValid = _identityRegistry.isVerified(_to);
            bool complianceValid = _compliance.canTransfer(_from, _to, _amount);
            bool holdingLimitValid = true;

            if (address(_investorTypeRegistry) != address(0)) {
                uint256 newBalance = balanceOf(_to) + _amount;
                holdingLimitValid = _investorTypeRegistry.canHoldAmount(_to, newBalance);
            }

            return identityValid && complianceValid && holdingLimitValid;
        }

        if (_to == address(0)) {
            // Burning case
            return getFreeBalance(_from) >= _amount;
        }

        // Regular transfer - check transfer limits and holding limits
        // ✅ ENFORCE: ALL transfers require KYC/AML verification (NO BYPASS)
        // ✅ EXCEPT: Trusted contracts (escrow wallets) bypass identity verification
        //            because they are verified through ComplianceRules instead

        // Check if either party is a trusted contract
        bool isTrustedTransfer = _compliance.isTrustedContract(_from) ||
                                 _compliance.isTrustedContract(_to);

        bool basicChecks;
        if (isTrustedTransfer) {
            // For trusted contracts: only check non-frozen and compliance
            // Identity verification is handled by ComplianceRules
            require(!_frozen[_from], "Sender frozen");
            require(!_frozen[_to], "Recipient frozen");
            require(getFreeBalance(_from) >= _amount, "Insufficient balance");
            require(_compliance.canTransfer(_from, _to, _amount), "Compliance check failed");
            basicChecks = true;
        } else {
            // For regular transfers: check everything including identity
            require(!_frozen[_from], "Sender frozen");
            require(!_frozen[_to], "Recipient frozen");
            require(_identityRegistry.isVerified(_from), "Sender not verified");
            require(_identityRegistry.isVerified(_to), "Recipient not verified");
            require(getFreeBalance(_from) >= _amount, "Insufficient balance");
            require(_compliance.canTransfer(_from, _to, _amount), "Compliance check failed");
            basicChecks = true;
        }

        if (!basicChecks) {
            return false;
        }

        // Check investor type limits if registry is set
        // ✅ SKIP for trusted contracts (escrow wallets don't have investor types)
        if (address(_investorTypeRegistry) != address(0) && !isTrustedTransfer) {
            // Check transfer amount limit for sender
            require(_investorTypeRegistry.canTransferAmount(_from, _amount), "Transfer amount limit exceeded");

            // Check holding limit for recipient
            uint256 newBalance = balanceOf(_to) + _amount;
            require(_investorTypeRegistry.canHoldAmount(_to, newBalance), "Holding limit exceeded");
        }

        return true;
    }

    function recoveryAddress(
        address _lostWallet,
        address _newWallet,
        address _investorOnchainID
    ) external override onlyAgent returns (bool) {
        require(_identityRegistry.identity(_lostWallet) == _investorOnchainID, "Invalid identity");
        require(_identityRegistry.identity(_newWallet) == address(0), "New wallet already has identity");

        uint256 balance = balanceOf(_lostWallet);
        uint256 frozenBalance = _frozenTokens[_lostWallet];

        // Transfer balance
        _transfer(_lostWallet, _newWallet, balance);

        // Transfer frozen tokens
        _frozenTokens[_newWallet] = frozenBalance;
        _frozenTokens[_lostWallet] = 0;

        // Update identity registry
        // Update identity - simplified for demo
        // _identityRegistry.updateIdentity(_newWallet, _investorOnchainID);
        _identityRegistry.deleteIdentity(_lostWallet);

        emit RecoverySuccess(_lostWallet, _newWallet, _investorOnchainID);
        return true;
    }

    function pause() external override onlyOwner {
        _pause();
        emit Paused(msg.sender);
    }

    function unpause() external override onlyOwner {
        _unpause();
        emit Unpaused(msg.sender);
    }

    function paused() public view override(IERC3643, Pausable) returns (bool) {
        return super.paused();
    }

    function frozenTokens(address _userAddress) external view override returns (uint256) {
        return _frozenTokens[_userAddress];
    }

    function getFreeBalance(address _userAddress) public view override returns (uint256) {
        return balanceOf(_userAddress) - _frozenTokens[_userAddress];
    }

    function isFrozen(address _userAddress) external view override returns (bool) {
        return _frozen[_userAddress];
    }

    function setIdentityRegistry(address _identityRegistryAddress) external override onlyOwner {
        _identityRegistry = IIdentityRegistry(_identityRegistryAddress);
        emit IdentityRegistryAdded(_identityRegistryAddress);
    }

    function setCompliance(address _complianceAddress) external override onlyOwner {
        _compliance = ICompliance(_complianceAddress);
        emit ComplianceAdded(_complianceAddress);
    }

    function setInvestorTypeRegistry(address _investorTypeRegistryAddress) external onlyOwner {
        _investorTypeRegistry = IInvestorTypeRegistry(_investorTypeRegistryAddress);
    }

    function investorTypeRegistry() external view returns (address) {
        return address(_investorTypeRegistry);
    }

    // Agent management
    function addAgent(address _agent) external onlyOwner {
        _agents[_agent] = true;
    }

    function removeAgent(address _agent) external onlyOwner {
        _agents[_agent] = false;
    }

    function isAgent(address _agent) external view returns (bool) {
        return _agents[_agent];
    }

    // Override ERC20 transfer functions to include compliance checks
    function transfer(
        address _to,
        uint256 _amount
    )
        public
        override(ERC20, IERC20)
        whenNotPaused
        whenNotFrozen(msg.sender)
        whenTransferAllowed(msg.sender, _to, _amount)
        returns (bool)
    {
        bool success = super.transfer(_to, _amount);
        if (success) {
            _compliance.transferred(msg.sender, _to, _amount);
        }
        return success;
    }

    function transferFrom(
        address _from,
        address _to,
        uint256 _amount
    )
        public
        override(ERC20, IERC20)
        whenNotPaused
        whenNotFrozen(_from)
        whenTransferAllowed(_from, _to, _amount)
        returns (bool)
    {
        bool success = super.transferFrom(_from, _to, _amount);
        if (success) {
            _compliance.transferred(_from, _to, _amount);
        }
        return success;
    }
}
