// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "@openzeppelin/contracts/access/Ownable2Step.sol";
import "@openzeppelin/contracts/utils/structs/Checkpoints.sol";
import "./interfaces/IIdentityRegistry.sol";
import "./interfaces/IInvestorTypeRegistry.sol";
import "../compliance/interfaces/IComplianceRules.sol";
import "../onchain_id/interfaces/IClaimIssuer.sol";

/**
 * @title IdentityRegistry
 * @dev Implementation of identity registry for ERC-3643 ecosystem
 */
contract IdentityRegistry is IIdentityRegistry, Ownable2Step {
    using Checkpoints for Checkpoints.Trace208;

    // Mapping from wallet address to OnchainID identity
    mapping(address => address) private _identities;

    /**
     * @dev Number of currently registered identities.
     *
     * Governance needs a denominator to express quorum as a percentage of
     * eligible voters. VanguardGovernance counts one vote per verified person
     * (1p1v), so token supply is the wrong basis — the eligible population is
     * the set of registered identities. Maintained in registerIdentity and
     * deleteIdentity; never derived by iteration.
     */
    uint256 public registeredIdentityCount;

    // One identity, one wallet (plan 2F.1, H1). Governance counts one vote per
    // identity; a second wallet on the same OnchainID would let whoever holds
    // the agent key vote twice with one person's identity.
    mapping(address => address) private _walletOf;

    /// @notice Start of the identity's current continuous binding. Every
    ///         bind of an unbound identity (register, batch, updateIdentity to
    ///         a different identity) restarts it; moveIdentity (recovery, same
    ///         person) keeps it. Governance only lets identities older than
    ///         its minimum voter age vote, and counts identities bound at its
    ///         cutoff, so a restart keeps "eligible" inside "counted": a
    ///         re-bound identity can neither vote twice nor vote uncounted.
    mapping(address => uint64) public identityRegisteredAt;

    // registeredIdentityCount over time, keyed by block.timestamp, so a
    // proposal's quorum denominator can be read at its voter-age cutoff.
    Checkpoints.Trace208 private _countHistory;

    /// @dev moveIdentity: the destination wallet is the zero address.
    error InvalidNewWallet();
    /// @dev moveIdentity: the source wallet has no registration to move.
    error IdentityNotRegistered(address wallet);
    /// @dev moveIdentity: the destination wallet is already registered.
    error WalletAlreadyHasIdentity(address wallet);

    // Mapping from wallet address to country code
    mapping(address => uint16) private _countries;

    // Identity a wallet held before moveIdentity relocated it. Lets sibling
    // tokens on this registry verify a recovery source after the first token
    // has already moved the identity. Cleared when the wallet is re-registered.
    mapping(address => address) private _formerIdentity;

    // Mapping of authorized agents
    mapping(address => bool) private _agents;

    // Investor Type Registry integration
    IInvestorTypeRegistry private _investorTypeRegistry;

    // Compliance Rules integration
    IComplianceRules private _complianceRules;

    // Token address for jurisdiction validation
    address private _tokenForJurisdiction;

    // ---- Required claims (folds ClaimTopicsRegistry + TrustedIssuersRegistry) ----
    // A wallet is verified only if, for EVERY required topic, an issuer
    // trusted for that topic reports a live claim (issued to the identity,
    // not revoked, not expired).
    uint256[] private _claimTopics;
    mapping(uint256 => bool) private _isRequiredTopic;
    mapping(uint256 => address[]) private _trustedIssuersForTopic;
    mapping(address => mapping(uint256 => bool)) private _issuerHasTopic;
    mapping(address => uint256[]) private _issuerTopics;

    // ponytail: bounded loop in isVerified. Raise if a topic needs more issuers.
    uint256 public constant MAX_TRUSTED_ISSUERS_PER_TOPIC = 8;

    error TooManyTrustedIssuers(uint256 topic);
    error IssuerNotAContract(address issuer);

    event ClaimTopicAdded(uint256 indexed topic);
    event ClaimTopicRemoved(uint256 indexed topic);
    event TrustedIssuerAdded(address indexed issuer, uint256[] topics);
    event TrustedIssuerRemoved(address indexed issuer);

    // Events
    event IdentityUnstored(address indexed userAddress, address indexed identity);
    event IdentityModified(address indexed oldIdentity, address indexed newIdentity);
    event InvestorTypeRegistryUpdated(address indexed oldRegistry, address indexed newRegistry);
    event ComplianceRulesUpdated(address indexed oldRules, address indexed newRules);
    event IdentityRegistrationRejected(address indexed userAddress, uint16 country, string reason);
    event AgentAdded(address indexed agent);
    event AgentRemoved(address indexed agent);

    modifier onlyAgent() {
        require(_agents[msg.sender] || msg.sender == owner(), "Not authorized agent");
        _;
    }

    constructor() Ownable(msg.sender) {
        _agents[msg.sender] = true;
    }

    function registerIdentity(address _userAddress, address _identity, uint16 _country) external override onlyAgent {
        _validateNewIdentity(_userAddress, _identity, _country);
        _storeIdentity(_userAddress, _identity, _country);
    }

    /**
     * @dev The single place an identity is created. Both registerIdentity and
     *      batchRegisterIdentity route through here: the batch path used to
     *      write the mappings directly, skipping the counter increment and the
     *      jurisdiction check, which let the governance quorum denominator
     *      drift below the real electorate and reach zero.
     */
    function _storeIdentity(address _userAddress, address _identity, uint16 _country) private {
        _identities[_userAddress] = _identity;
        _countries[_userAddress] = _country;
        _bindIdentity(_userAddress, _identity);
        // A recycled wallet must not keep a stale "formerly belonged to" claim.
        delete _formerIdentity[_userAddress];
        // New registration only. updateIdentity replaces an existing entry and
        // must not change the count.
        registeredIdentityCount += 1;
        _countHistory.push(uint48(block.timestamp), uint208(registeredIdentityCount));

        emit IdentityStored(_userAddress, _identity);
        emit CountryUpdated(_identity, _country);
    }

    /**
     * @dev Shared validation for a new identity, including the jurisdiction
     *      rule. Called by both registration paths.
     */
    function _validateNewIdentity(address _userAddress, address _identity, uint16 _country) private {
        require(_userAddress != address(0), "Invalid user address");
        require(_identity != address(0), "Invalid identity address");
        require(_identities[_userAddress] == address(0), "Identity already registered");
        require(_walletOf[_identity] == address(0), "Identity already bound");

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
    }

    function deleteIdentity(address _userAddress) external override onlyAgent {
        require(_identities[_userAddress] != address(0), "Identity not found");

        address identityAddr = _identities[_userAddress];
        delete _identities[_userAddress];
        delete _countries[_userAddress];
        delete _walletOf[identityAddr];
        // Guarded by the "Identity not found" require above, so this cannot
        // underflow, but the check makes that independent of call ordering.
        if (registeredIdentityCount > 0) {
            registeredIdentityCount -= 1;
        }
        _countHistory.push(uint48(block.timestamp), uint208(registeredIdentityCount));

        emit IdentityUnstored(_userAddress, identityAddr);
    }

    /**
     * @notice Move an existing registration from one wallet to another.
     * @dev For wallet RECOVERY, not for admitting a new investor. The user was
     *      already admitted, so this deliberately does NOT re-run the
     *      jurisdiction check: a user whose country is sanctioned after they
     *      joined is exactly the person who most needs to recover a lost
     *      wallet, and re-validating would strand their funds permanently.
     *      The country travels with the user rather than being reset.
     *
     *      registeredIdentityCount is unchanged: one registration moves, none
     *      is created or destroyed, so the governance quorum denominator is
     *      unaffected.
     */
    function moveIdentity(address _fromWallet, address _toWallet) external override onlyAgent {
        if (_toWallet == address(0)) revert InvalidNewWallet();
        if (_identities[_fromWallet] == address(0)) revert IdentityNotRegistered(_fromWallet);
        if (_identities[_toWallet] != address(0)) revert WalletAlreadyHasIdentity(_toWallet);

        address identityAddr = _identities[_fromWallet];
        uint16 country = _countries[_fromWallet];

        _identities[_toWallet] = identityAddr;
        _countries[_toWallet] = country;
        delete _identities[_fromWallet];
        delete _countries[_fromWallet];
        _walletOf[identityAddr] = _toWallet;
        // Remember whose wallet this was. Sibling tokens on the same registry
        // recover AFTER the identity has moved, and need to prove the lost
        // wallet really belonged to this identity rather than being any
        // unregistered address that happens to hold tokens.
        _formerIdentity[_fromWallet] = identityAddr;

        emit IdentityStored(_toWallet, identityAddr);
        emit CountryUpdated(identityAddr, country);
        emit IdentityUnstored(_fromWallet, identityAddr);
    }

    /// @dev Reverse entry plus bind timestamp. Callers check the identity is
    ///      not bound elsewhere first, so this always starts a new binding.
    function _bindIdentity(address _wallet, address _identity) private {
        _walletOf[_identity] = _wallet;
        identityRegisteredAt[_identity] = uint64(block.timestamp);
    }

    /// @inheritdoc IIdentityRegistry
    function walletOf(address _identity) external view override returns (address) {
        return _walletOf[_identity];
    }

    /// @inheritdoc IIdentityRegistry
    function registeredIdentityCountAt(uint48 _timestamp) external view override returns (uint256) {
        return _countHistory.upperLookup(_timestamp);
    }

    /// @inheritdoc IIdentityRegistry
    function formerIdentity(address _wallet) external view override returns (address) {
        return _formerIdentity[_wallet];
    }

    function updateIdentity(address _userAddress, address _identity) external onlyAgent {
        require(_userAddress != address(0), "Invalid user address");
        require(_identity != address(0), "Invalid identity address");
        require(_identities[_userAddress] != address(0), "Identity not registered");

        address oldIdentity = _identities[_userAddress];
        if (_identity != oldIdentity) {
            require(_walletOf[_identity] == address(0), "Identity already bound");
            delete _walletOf[oldIdentity];
            _bindIdentity(_userAddress, _identity);
        }
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

    /**
     * @dev Verified = registered by an agent AND holding a live claim from a
     *      trusted issuer on every required topic. A registry with no required
     *      topics verifies nobody (fail closed; T-REX would verify everyone).
     *      The deploy guard in scripts/deploy-helpers.ts is the second line.
     */
    function isVerified(address _userAddress) external view override returns (bool) {
        address id = _identities[_userAddress];
        if (id == address(0)) return false;
        uint256 n = _claimTopics.length;
        if (n == 0) return false;
        for (uint256 t = 0; t < n; t++) {
            if (!_hasValidClaim(id, _claimTopics[t])) return false;
        }
        return true;
    }

    // ---- Required-claim configuration (owner = governance after handover) ----

    function addClaimTopic(uint256 _topic) external onlyOwner {
        require(!_isRequiredTopic[_topic], "Topic already required");
        _isRequiredTopic[_topic] = true;
        _claimTopics.push(_topic);
        emit ClaimTopicAdded(_topic);
    }

    function removeClaimTopic(uint256 _topic) external onlyOwner {
        require(_isRequiredTopic[_topic], "Topic not required");
        _isRequiredTopic[_topic] = false;
        _removeFromList(_claimTopics, _topic);
        emit ClaimTopicRemoved(_topic);
    }

    function addTrustedIssuer(address _issuer, uint256[] calldata _topics) external onlyOwner {
        if (_issuer.code.length == 0) revert IssuerNotAContract(_issuer);
        require(_topics.length > 0, "No topics");
        for (uint256 i = 0; i < _topics.length; i++) {
            uint256 topic = _topics[i];
            if (_issuerHasTopic[_issuer][topic]) continue;
            if (_trustedIssuersForTopic[topic].length >= MAX_TRUSTED_ISSUERS_PER_TOPIC) {
                revert TooManyTrustedIssuers(topic);
            }
            _issuerHasTopic[_issuer][topic] = true;
            _trustedIssuersForTopic[topic].push(_issuer);
            _issuerTopics[_issuer].push(topic);
        }
        emit TrustedIssuerAdded(_issuer, _topics);
    }

    function removeTrustedIssuer(address _issuer) external onlyOwner {
        uint256[] storage topics = _issuerTopics[_issuer];
        require(topics.length > 0, "Issuer not trusted");
        for (uint256 i = 0; i < topics.length; i++) {
            _issuerHasTopic[_issuer][topics[i]] = false;
            _removeAddressFromList(_trustedIssuersForTopic[topics[i]], _issuer);
        }
        delete _issuerTopics[_issuer];
        emit TrustedIssuerRemoved(_issuer);
    }

    function getClaimTopics() external view returns (uint256[] memory) {
        return _claimTopics;
    }

    function getTrustedIssuersForClaimTopic(uint256 _topic) external view returns (address[] memory) {
        return _trustedIssuersForTopic[_topic];
    }

    function isTrustedIssuer(address _issuer, uint256 _topic) external view returns (bool) {
        return _issuerHasTopic[_issuer][_topic];
    }

    /**
     * @dev True if some issuer trusted for `topic` reports a live claim on it
     *      for `id`. Asks the issuers, never the identity's claim list: anyone
     *      may add claims naming themselves to an identity (OnchainID.addClaim),
     *      so that list cannot decide verification (2F.2, H2). A self-added
     *      claim naming a trusted issuer fails because the issuer has no
     *      record of it. A low-level staticcall: an issuer that reverts
     *      or returns short data counts as "no claim", never reverts here.
     */
    function _hasValidClaim(address id, uint256 topic) private view returns (bool) {
        // Wallets registered with a non-identity address are unverified.
        if (id.code.length == 0) return false;
        address[] storage issuers = _trustedIssuersForTopic[topic];
        for (uint256 i = 0; i < issuers.length; i++) {
            (bool ok, bytes memory ret) = issuers[i].staticcall(
                abi.encodeCall(IClaimIssuer.hasValidClaim, (id, topic))
            );
            if (ok && ret.length >= 32 && abi.decode(ret, (bool))) return true;
        }
        return false;
    }

    function _removeFromList(uint256[] storage list, uint256 value) private {
        uint256 len = list.length;
        for (uint256 i = 0; i < len; i++) {
            if (list[i] == value) {
                list[i] = list[len - 1];
                list.pop();
                return;
            }
        }
    }

    function _removeAddressFromList(address[] storage list, address value) private {
        uint256 len = list.length;
        for (uint256 i = 0; i < len; i++) {
            if (list[i] == value) {
                list[i] = list[len - 1];
                list.pop();
                return;
            }
        }
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
            _validateNewIdentity(_userAddresses[i], _identityAddresses[i], _countryCodes[i]);
            _storeIdentity(_userAddresses[i], _identityAddresses[i], _countryCodes[i]);
        }
    }

    function isAgent(address _agent) external view returns (bool) {
        return _agents[_agent];
    }

    function addAgent(address _agent) external onlyOwner {
        require(_agent != address(0), "Invalid agent address");
        _agents[_agent] = true;
        emit AgentAdded(_agent);
    }

    function removeAgent(address _agent) external onlyOwner {
        _agents[_agent] = false;
        emit AgentRemoved(_agent);
    }

    // Additional utility functions

    /**
     * @dev Set investor type registry
     */
    function setInvestorTypeRegistry(address _investorTypeRegistryAddress) external onlyOwner {
        require(_investorTypeRegistryAddress != address(0), "Invalid registry address");
        require(
            _investorTypeRegistryAddress.code.length > 0,
            "IdentityRegistry: Investor type registry address is not a contract"
        );

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
        require(
            _complianceRulesAddress.code.length > 0,
            "IdentityRegistry: Compliance rules address is not a contract"
        );
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
