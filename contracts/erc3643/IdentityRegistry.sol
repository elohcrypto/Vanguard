// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "@openzeppelin/contracts/access/Ownable.sol";
import "./interfaces/IIdentityRegistry.sol";
import "./interfaces/IInvestorTypeRegistry.sol";
import "../compliance/interfaces/IComplianceRules.sol";

/**
 * @title IdentityRegistry
 * @dev Implementation of identity registry for ERC-3643 ecosystem
 */
contract IdentityRegistry is IIdentityRegistry, Ownable {
    // Mapping from wallet address to OnchainID identity
    mapping(address => address) private _identities;

    // Mapping from wallet address to country code
    mapping(address => uint16) private _countries;

    // Mapping of authorized agents
    mapping(address => bool) private _agents;

    // Array of bound tokens
    address[] private _tokensBound;

    // Mapping to check if token is bound
    mapping(address => bool) private _isTokenBound;

    // Investor Type Registry integration
    IInvestorTypeRegistry private _investorTypeRegistry;

    // Compliance Rules integration
    IComplianceRules private _complianceRules;

    // Token address for jurisdiction validation
    address private _tokenForJurisdiction;

    // Events
    event IdentityUnstored(address indexed userAddress, address indexed identity);
    event IdentityModified(address indexed oldIdentity, address indexed newIdentity);
    event IdentityRegistryBound(address indexed token);
    event IdentityRegistryUnbound(address indexed token);
    event InvestorTypeRegistryUpdated(address indexed oldRegistry, address indexed newRegistry);
    event ComplianceRulesUpdated(address indexed oldRules, address indexed newRules);
    event IdentityRegistrationRejected(address indexed userAddress, uint16 country, string reason);

    modifier onlyAgent() {
        require(_agents[msg.sender] || msg.sender == owner(), "Not authorized agent");
        _;
    }

    constructor() Ownable(msg.sender) {
        _agents[msg.sender] = true;
    }

    function registerIdentity(address _userAddress, address _identity, uint16 _country) external override onlyAgent {
        require(_userAddress != address(0), "Invalid user address");
        require(_identity != address(0), "Invalid identity address");
        require(_identities[_userAddress] == address(0), "Identity already registered");

        // ✅ ENFORCE: Jurisdiction rules at identity registration
        if (address(_complianceRules) != address(0) && _tokenForJurisdiction != address(0)) {
            (bool isValid, string memory reason) = _complianceRules.validateJurisdiction(
                _tokenForJurisdiction,
                _country
            );

            if (!isValid) {
                emit IdentityRegistrationRejected(_userAddress, _country, reason);
                revert(string(abi.encodePacked("Country not allowed: ", reason)));
            }
        }

        _identities[_userAddress] = _identity;
        _countries[_userAddress] = _country;

        emit IdentityStored(_userAddress, _identity);
        emit CountryUpdated(_identity, _country);
    }

    function deleteIdentity(address _userAddress) external override onlyAgent {
        require(_identities[_userAddress] != address(0), "Identity not found");

        address identityAddr = _identities[_userAddress];
        delete _identities[_userAddress];
        delete _countries[_userAddress];

        emit IdentityUnstored(_userAddress, identityAddr);
    }

    function updateIdentity(address _userAddress, address _identity) external onlyAgent {
        require(_userAddress != address(0), "Invalid user address");
        require(_identity != address(0), "Invalid identity address");
        require(_identities[_userAddress] != address(0), "Identity not registered");

        address oldIdentity = _identities[_userAddress];
        _identities[_userAddress] = _identity;

        emit IdentityModified(oldIdentity, _identity);
    }

    function updateCountry(address _userAddress, uint16 _country) external override onlyAgent {
        require(_identities[_userAddress] != address(0), "Identity not registered");

        _countries[_userAddress] = _country;
        emit CountryUpdated(_identities[_userAddress], _country);
    }

    function identity(address _userAddress) external view override returns (address) {
        return _identities[_userAddress];
    }

    function investorCountry(address _userAddress) external view override returns (uint16) {
        return _countries[_userAddress];
    }

    function isVerified(address _userAddress) external view override returns (bool) {
        return _identities[_userAddress] != address(0);
    }

    function bindIdentityRegistry(address _token) external onlyAgent {
        require(_token != address(0), "Invalid token address");
        require(!_isTokenBound[_token], "Token already bound");

        _tokensBound.push(_token);
        _isTokenBound[_token] = true;

        emit IdentityRegistryBound(_token);
    }

    function unbindIdentityRegistry(address _token) external onlyAgent {
        require(_isTokenBound[_token], "Token not bound");

        // Remove from array
        for (uint i = 0; i < _tokensBound.length; i++) {
            if (_tokensBound[i] == _token) {
                _tokensBound[i] = _tokensBound[_tokensBound.length - 1];
                _tokensBound.pop();
                break;
            }
        }

        _isTokenBound[_token] = false;
        emit IdentityRegistryUnbound(_token);
    }

    function batchRegisterIdentity(
        address[] calldata _userAddresses,
        address[] calldata _identityAddresses,
        uint16[] calldata _countryCodes
    ) external override onlyAgent {
        require(
            _userAddresses.length == _identityAddresses.length && _identityAddresses.length == _countryCodes.length,
            "Array length mismatch"
        );

        for (uint i = 0; i < _userAddresses.length; i++) {
            require(_userAddresses[i] != address(0), "Invalid user address");
            require(_identityAddresses[i] != address(0), "Invalid identity address");
            require(_identities[_userAddresses[i]] == address(0), "Identity already registered");

            _identities[_userAddresses[i]] = _identityAddresses[i];
            _countries[_userAddresses[i]] = _countryCodes[i];

            emit IdentityStored(_userAddresses[i], _identityAddresses[i]);
            emit CountryUpdated(_identityAddresses[i], _countryCodes[i]);
        }
    }

    function isAgent(address _agent) external view returns (bool) {
        return _agents[_agent];
    }

    function addAgent(address _agent) external onlyOwner {
        require(_agent != address(0), "Invalid agent address");
        _agents[_agent] = true;
    }

    function removeAgent(address _agent) external onlyOwner {
        _agents[_agent] = false;
    }

    // Additional utility functions
    function getTokensBound() external view returns (address[] memory) {
        return _tokensBound;
    }

    function isTokenBound(address _token) external view returns (bool) {
        return _isTokenBound[_token];
    }

    /**
     * @dev Set investor type registry
     */
    function setInvestorTypeRegistry(address _investorTypeRegistryAddress) external onlyOwner {
        require(_investorTypeRegistryAddress != address(0), "Invalid registry address");

        address oldRegistry = address(_investorTypeRegistry);
        _investorTypeRegistry = IInvestorTypeRegistry(_investorTypeRegistryAddress);

        emit InvestorTypeRegistryUpdated(oldRegistry, _investorTypeRegistryAddress);
    }

    /**
     * @dev Get investor type registry address
     */
    function getInvestorTypeRegistry() external view returns (address) {
        return address(_investorTypeRegistry);
    }

    /**
     * @dev Set compliance rules for jurisdiction validation
     */
    function setComplianceRules(address _complianceRulesAddress, address _token) external onlyOwner {
        require(_complianceRulesAddress != address(0), "Invalid compliance rules address");
        require(_token != address(0), "Invalid token address");

        address oldRules = address(_complianceRules);
        _complianceRules = IComplianceRules(_complianceRulesAddress);
        _tokenForJurisdiction = _token;

        emit ComplianceRulesUpdated(oldRules, _complianceRulesAddress);
    }

    /**
     * @dev Get compliance rules address
     */
    function getComplianceRules() external view returns (address) {
        return address(_complianceRules);
    }

    /**
     * @dev Get investor type for a user (integrated with InvestorTypeRegistry)
     */
    function getInvestorType(address _userAddress) external view returns (IInvestorTypeRegistry.InvestorType) {
        require(address(_investorTypeRegistry) != address(0), "InvestorTypeRegistry not set");
        return _investorTypeRegistry.getInvestorType(_userAddress);
    }

    /**
     * @dev Check if user can transfer specified amount based on investor type
     */
    function canTransferAmount(address _userAddress, uint256 _amount) external view returns (bool) {
        require(address(_investorTypeRegistry) != address(0), "InvestorTypeRegistry not set");
        return _investorTypeRegistry.canTransferAmount(_userAddress, _amount);
    }

    /**
     * @dev Check if user can hold specified amount based on investor type
     */
    function canHoldAmount(address _userAddress, uint256 _amount) external view returns (bool) {
        require(address(_investorTypeRegistry) != address(0), "InvestorTypeRegistry not set");
        return _investorTypeRegistry.canHoldAmount(_userAddress, _amount);
    }

    /**
     * @dev Get required whitelist tier for user based on investor type
     */
    function getRequiredWhitelistTier(address _userAddress) external view returns (uint8) {
        require(address(_investorTypeRegistry) != address(0), "InvestorTypeRegistry not set");
        return _investorTypeRegistry.getRequiredWhitelistTier(_userAddress);
    }
}
