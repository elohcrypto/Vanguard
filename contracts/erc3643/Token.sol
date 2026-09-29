// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/access/Ownable2Step.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "./interfaces/IERC3643.sol";
import "./interfaces/IIdentityRegistry.sol";
import "./interfaces/ICompliance.sol";
import "./interfaces/IInvestorTypeRegistry.sol";

/**
 * @title ERC3643 Token
 * @dev Implementation of ERC-3643 T-REX standard for compliant security tokens
 */
contract Token is IERC3643, ERC20, Ownable2Step, Pausable {
    // State variables
    IIdentityRegistry private _identityRegistry;
    IComplianceHooks internal _compliance;
    IInvestorTypeRegistry private _investorTypeRegistry;

    // Frozen addresses
    mapping(address => bool) private _frozen;

    // Frozen tokens per address
    mapping(address => uint256) private _frozenTokens;

    // Agent addresses
    mapping(address => bool) private _agents;

    // ponytail: single guardian address; point it at a multisig, not an EOA
    address public guardian;

    event GuardianUpdated(address indexed previous, address indexed current);

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
        (bool ok, string memory why) = _checkTransfer(_from, _to, _amount);
        require(ok, why);
        _;
    }

    constructor(
        string memory _name,
        string memory _symbol,
        address _identityRegistryAddress,
        address _complianceAddress
    ) ERC20(_name, _symbol) Ownable(msg.sender) {
        // Same validation as the setters below. A constructor mistake is worse:
        // the setters can be called again, but a token deployed with a bad
        // dependency is permanently broken and must be redeployed.
        require(_identityRegistryAddress != address(0), "Token: Identity registry is zero address");
        require(
            _identityRegistryAddress.code.length > 0,
            "Token: Identity registry is not a contract"
        );
        require(_complianceAddress != address(0), "Token: Compliance is zero address");
        require(_complianceAddress.code.length > 0, "Token: Compliance is not a contract");

        _identityRegistry = IIdentityRegistry(_identityRegistryAddress);
        _compliance = IComplianceHooks(_complianceAddress);
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
        // One path with canTransfer(0, to, amount): identity, compliance, holding cap.
        (bool ok, string memory reason) = _checkTransfer(address(0), _to, _amount);
        require(ok, reason);

        _mint(_to, _amount);
        _compliance.created(_to, _amount);
    }

    function burn(address _from, uint256 _amount) external override onlyAgent whenNotPaused {
        _checkAgentTarget(_from);
        require(balanceOf(_from) >= _amount, "Insufficient balance");
        require(getFreeBalance(_from) >= _amount, "Insufficient free balance");

        _burn(_from, _amount);
        _compliance.destroyed(_from, _amount);
    }

    function setAddressFrozen(address _userAddress, bool _freeze) external override onlyAgent {
        // Unfreezing is always allowed, so a target frozen by any route can
        // be released.
        if (_freeze) _checkAgentTarget(_userAddress);
        _frozen[_userAddress] = _freeze;
        emit AddressFrozen(_userAddress, _freeze, msg.sender);
    }

    function freezePartialTokens(address _userAddress, uint256 _amount) external override onlyAgent {
        _checkAgentTarget(_userAddress);
        require(balanceOf(_userAddress) >= _frozenTokens[_userAddress] + _amount, "Insufficient balance to freeze");
        _frozenTokens[_userAddress] += _amount;
        emit TokensFrozen(_userAddress, _amount);
    }

    /**
     * @dev Hook for agent levers that act ON a holder (burn, freeze, partial
     *      freeze, recovery), so a subclass can refuse some targets. Empty
     *      here: on the base token an agent may act on any holder.
     */
    function _checkAgentTarget(address target) internal view virtual {}

    function unfreezePartialTokens(address _userAddress, uint256 _amount) external override onlyAgent {
        require(_frozenTokens[_userAddress] >= _amount, "Insufficient frozen tokens");
        _frozenTokens[_userAddress] -= _amount;
        emit TokensUnfrozen(_userAddress, _amount);
    }

    // ERC-3643 canTransfer is a predicate: callers (dApps, demo pre-checks,
    // compliance tooling) ask "would this succeed?" and expect false, not a
    // revert. The reasons live in _checkTransfer so transfer() still reverts
    // with the exact string that explains the refusal.
    function canTransfer(address _from, address _to, uint256 _amount) public view override returns (bool) {
        (bool ok, ) = _checkTransfer(_from, _to, _amount);
        return ok;
    }

    function _checkTransfer(
        address _from,
        address _to,
        uint256 _amount
    ) internal view returns (bool ok, string memory reason) {
        if (_from == address(0)) {
            // Minting case: freeze, identity, compliance, recipient holding cap
            if (_frozen[_to]) return (false, "Recipient frozen");
            if (!_identityRegistry.isVerified(_to)) return (false, "Identity not verified");
            if (!_compliance.canTransfer(_from, _to, _amount)) return (false, "Compliance check failed");
            if (
                address(_investorTypeRegistry) != address(0) &&
                !_investorTypeRegistry.canHoldAmount(_to, balanceOf(_to) + _amount)
            ) return (false, "Holding limit exceeded");
            return (true, "");
        }

        if (_to == address(0)) {
            // Burning case
            if (getFreeBalance(_from) >= _amount) return (true, "");
            return (false, "Transfer not allowed");
        }

        // Regular transfer - check transfer limits and holding limits
        // ✅ ENFORCE: ALL transfers require KYC/AML verification (NO BYPASS)
        // ✅ EXCEPT: Trusted contracts (escrow wallets) bypass identity verification
        //            because they are verified through ComplianceRules instead

        // Check if either party is a trusted contract
        bool isTrustedTransfer = _compliance.isTrustedContract(_from) ||
                                 _compliance.isTrustedContract(_to);

        // Same checks in the same order for both branches; trusted contracts
        // skip only the identity pair (ComplianceRules verifies them instead).
        if (_frozen[_from]) return (false, "Sender frozen");
        if (_frozen[_to]) return (false, "Recipient frozen");
        if (!isTrustedTransfer) {
            if (!_identityRegistry.isVerified(_from)) return (false, "Sender not verified");
            if (!_identityRegistry.isVerified(_to)) return (false, "Recipient not verified");
        }
        if (getFreeBalance(_from) < _amount) return (false, "Insufficient balance");
        if (!_compliance.canTransfer(_from, _to, _amount)) return (false, "Compliance check failed");

        // Check investor type limits if registry is set
        // ✅ SKIP for trusted contracts (escrow wallets don't have investor types)
        if (address(_investorTypeRegistry) != address(0) && !isTrustedTransfer) {
            // Check transfer amount limit for sender
            if (!_investorTypeRegistry.canTransferAmount(_from, _amount)) {
                return (false, "Transfer amount limit exceeded");
            }

            // Check holding limit for recipient
            uint256 newBalance = balanceOf(_to) + _amount;
            if (!_investorTypeRegistry.canHoldAmount(_to, newBalance)) {
                return (false, "Holding limit exceeded");
            }
        }

        return (true, "");
    }

    function recoveryAddress(
        address _lostWallet,
        address _newWallet,
        address _investorOnchainID
    ) external override onlyAgent whenNotPaused returns (bool) {
        _checkAgentTarget(_lostWallet);
        _checkAgentTarget(_newWallet);
        // A recovery relocates an identity. A never-registered wallet has
        // none, and the all-zero case below would take the "already moved"
        // branch and move its whole balance to any unregistered wallet.
        require(_investorOnchainID != address(0), "Invalid identity");
        // The registry is shared by every token, so a sibling token's recovery
        // may already have moved this person's identity to the new wallet.
        // Requiring identity(lost) == onchainID here made every token after the
        // first revert "Invalid identity", stranding its balance on a wallet
        // that could no longer transfer. Accept either "not moved yet" or
        // "already moved from THIS wallet to exactly this identity". The
        // formerIdentity check is what keeps the second case a recovery: without
        // it any deregistered wallet holding tokens could be routed into the
        // recovered wallet under a RecoverySuccess event.
        address lostIdentity = _identityRegistry.identity(_lostWallet);
        address newIdentity = _identityRegistry.identity(_newWallet);
        bool identityAlreadyMoved = lostIdentity == address(0)
            && newIdentity == _investorOnchainID
            && _identityRegistry.formerIdentity(_lostWallet) == _investorOnchainID;
        require(lostIdentity == _investorOnchainID || identityAlreadyMoved, "Invalid identity");
        require(newIdentity == address(0) || identityAlreadyMoved, "New wallet already has identity");

        uint256 balance = balanceOf(_lostWallet);
        uint256 frozenBalance = _frozenTokens[_lostWallet];
        bool wasFrozen = _frozen[_lostWallet];

        // Transfer balance
        _transfer(_lostWallet, _newWallet, balance);

        // Add, never assign: the new wallet may already hold frozen tokens
        // (freezePartialTokens needs no identity, and a second-token recovery
        // lands on a wallet already in use). An assignment zeroed them.
        _frozenTokens[_newWallet] += frozenBalance;
        _frozenTokens[_lostWallet] = 0;

        // Carry the address-level freeze. Recovering a sanctioned wallet must
        // not launder it into an unfrozen one.
        //
        // OR, not assignment: the destination may carry its own administrative
        // freeze. A plain assignment let an unfrozen source CLEAR a frozen
        // destination, so recovering into a sanctioned address unfroze it and
        // handed it the balance. A freeze on either wallet survives.
        _frozen[_newWallet] = wasFrozen || _frozen[_newWallet];
        _frozen[_lostWallet] = false;

        // Move the identity atomically. This used to delete the old entry and
        // never create the new one, leaving the recovered balance unspendable
        // because every transfer requires isVerified(from).
        //
        // moveIdentity, not registerIdentity + deleteIdentity: recovery
        // relocates an already-admitted user, so it must not re-run the
        // jurisdiction check. A user sanctioned after joining is precisely who
        // needs a recovery, and re-validating would strand their funds.
        // It also leaves registeredIdentityCount untouched.
        if (!identityAlreadyMoved) {
            _identityRegistry.moveIdentity(_lostWallet, _newWallet);
        }

        // Recovery moves the SAME holder's balance, so it re-checks only the
        // sanction and allow lists on _newWallet, not identity or jurisdiction:
        // a holder whose country was blocked after onboarding must still recover.
        require(_compliance.canReceive(_newWallet), "Recovery blocked by compliance");

        emit RecoverySuccess(_lostWallet, _newWallet, _investorOnchainID);
        return true;
    }

    /// @notice Set the address allowed to pause (not unpause). Zero clears it.
    function setGuardian(address _guardian) external onlyOwner {
        emit GuardianUpdated(guardian, _guardian);
        guardian = _guardian;
    }

    function pause() external override {
        require(msg.sender == owner() || msg.sender == guardian, "Token: caller is not owner or guardian");
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

    // These three setters replace contracts the transfer path calls on every
    // transfer. Pointing one at an address with no code does not fail here: it
    // reverts later inside transfer(), with no reason string, far from the cause.
    // Validate at the setter so a bad address is rejected where it is supplied.

    function setIdentityRegistry(address _identityRegistryAddress) external override onlyOwner {
        require(_identityRegistryAddress != address(0), "Token: Identity registry is zero address");
        require(_identityRegistryAddress.code.length > 0, "Token: Identity registry is not a contract");
        _identityRegistry = IIdentityRegistry(_identityRegistryAddress);
        emit IdentityRegistryAdded(_identityRegistryAddress);
    }

    function setCompliance(address _complianceAddress) external override onlyOwner {
        require(_complianceAddress != address(0), "Token: Compliance is zero address");
        require(_complianceAddress.code.length > 0, "Token: Compliance is not a contract");
        _compliance = IComplianceHooks(_complianceAddress);
        emit ComplianceAdded(_complianceAddress);
    }

    function setInvestorTypeRegistry(address _investorTypeRegistryAddress) external onlyOwner {
        require(_investorTypeRegistryAddress != address(0), "Token: Investor type registry is zero address");
        require(
            _investorTypeRegistryAddress.code.length > 0,
            "Token: Investor type registry is not a contract"
        );
        _investorTypeRegistry = IInvestorTypeRegistry(_investorTypeRegistryAddress);
    }

    function investorTypeRegistry() external view returns (address) {
        return address(_investorTypeRegistry);
    }

    // Agent management. Agents mint, burn, freeze and pause, so every change
    // is on the log; a monitor that cannot see agent changes cannot audit
    // supply. Not part of IERC3643, so the events are declared here.
    event AgentAdded(address indexed agent);
    event AgentRemoved(address indexed agent);
    error ZeroAgent();

    function addAgent(address _agent) external onlyOwner {
        if (_agent == address(0)) revert ZeroAgent();
        _agents[_agent] = true;
        emit AgentAdded(_agent);
    }

    function removeAgent(address _agent) external onlyOwner {
        _agents[_agent] = false;
        emit AgentRemoved(_agent);
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
