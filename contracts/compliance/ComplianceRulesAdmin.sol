// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./ComplianceRulesTrust.sol";
import "./interfaces/IComplianceRules.sol";

/// @dev Read-only slice of BlacklistOracle. Declared here rather than imported
///      so ComplianceRules cannot reach any state-changing oracle function.
interface IBlacklistOracleView {
    function isBlacklisted(address subject) external view returns (bool);
}

/// @dev Read-only slice of WhitelistOracle. Same rationale as above.
interface IWhitelistOracleView {
    function isWhitelisted(address subject) external view returns (bool);

    /// @dev The entry's tier is the fourth field (Task 4.10 tier rule).
    function getWhitelistInfo(
        address subject
    ) external view returns (bool, uint256, uint256, uint8 tier, string memory, address[] memory);
}

/// @dev Read-only slice of Token: the investor-type registry it applies.
interface ITokenInvestorTypesView {
    function investorTypeRegistry() external view returns (address);
}

/// @dev Read-only slice of PrivacyManager (the ZK whitelist binder). Same rationale.
interface IPrivacyManagerView {
    function hasValidWhitelistProof(address user) external view returns (bool);
}

/**
 * @title ComplianceRulesAdmin
 * @dev Configuration half of ComplianceRules (plan v2 Task 4.1, split by
 *      inheritance: one deployed contract, one address, one governance
 *      type). Holds every setting canTransfer reads and the functions that
 *      write them: trusted contracts and their registrars (inherited from
 *      ComplianceRulesTrust, Task 4.3), rule administrators, the per-token
 *      oracles, identity registry, whitelist mode and PrivacyManager, and
 *      the jurisdiction rules with their version counter. The evaluation
 *      half is ComplianceRules.
 */
abstract contract ComplianceRulesAdmin is IComplianceRules, ComplianceRulesTrust {
    // ========================================
    // ORACLE GATING (per token, opt-in)
    // ========================================
    //
    // The blacklist and whitelist oracles are consulted on every transfer of a
    // token that has one set. Both default to address(0) = OFF, because most
    // deployments never stand up an oracle and must keep transferring; turning
    // them on by default would brick every existing system on upgrade.
    //
    // Semantics, chosen deliberately:
    //   blacklist -> DENY LIST. Set, and either party listed: block.
    //   whitelist -> ALLOW LIST. Set, and either party NOT listed: block.
    // The whitelist is therefore default-deny: switching it on blocks everyone
    // until they are listed. That is the point of an allow list, but it means
    // an operator must populate the oracle BEFORE pointing a live token at it.
    // Blacklist wins over whitelist: a listed address is blocked even if it is
    // also whitelisted.
    //
    // The whitelist source is chosen per token by whitelistMode (plan v2 Task
    // 3.4): OracleOnly (the default, the behaviour above), ZkOnly (a live
    // PrivacyManager binding, hasValidWhitelistProof) or Either. The
    // blacklist never depends on the mode.

    enum WhitelistMode {
        OracleOnly,
        ZkOnly,
        Either
    }

    mapping(address => address) public blacklistOracle;
    mapping(address => address) public whitelistOracle;
    mapping(address => WhitelistMode) public whitelistMode;
    mapping(address => address) public privacyManager;

    /// @dev Oracle gates are per token; the zero address is not a token.
    error InvalidTokenAddress();
    /// @dev An oracle must be a contract. address(0) is allowed: it disables the gate.
    error OracleNotAContract(address oracle);
    /// @dev The oracle does not answer the selector this gate calls.
    error OracleIncompatible(address oracle);
    /// @dev A PrivacyManager must be a contract; address(0) clears it.
    error PrivacyManagerNotAContract(address pm);
    /// @dev The PrivacyManager does not answer hasValidWhitelistProof.
    error PrivacyManagerIncompatible(address pm);
    /// @dev ZkOnly and Either need a PrivacyManager for the token.
    error PrivacyManagerNotSet(address token);
    /// @dev The token's mode reads the PrivacyManager: set OracleOnly first.
    error PrivacyManagerInUse(address token);

    event BlacklistOracleSet(address indexed token, address indexed oracle);
    event WhitelistOracleSet(address indexed token, address indexed oracle);
    event PrivacyManagerSet(address indexed token, address indexed privacyManager);
    event WhitelistModeSet(address indexed token, WhitelistMode mode);

    /**
     * @dev Point a token at a blacklist oracle, or pass address(0) to disable.
     * @param token The token whose transfers this oracle should gate.
     * @param oracle BlacklistOracle address, or address(0) to turn the gate off.
     */
    function setBlacklistOracle(address token, address oracle) external onlyOwner {
        if (token == address(0)) revert InvalidTokenAddress();
        if (oracle != address(0) && oracle.code.length == 0) revert OracleNotAContract(oracle);
        // Bytecode is not enough: the gate calls isBlacklisted on EVERY
        // transfer, so an incompatible contract here bricks the token until an
        // owner notices and unsets it. Probe the selector now and fail at
        // configuration time, where the mistake is made.
        if (oracle != address(0)) {
            (bool ok, bytes memory ret) = oracle.staticcall(
                abi.encodeWithSelector(IBlacklistOracleView.isBlacklisted.selector, address(this))
            );
            if (!ok || ret.length != 32) revert OracleIncompatible(oracle);
        }
        blacklistOracle[token] = oracle;
        emit BlacklistOracleSet(token, oracle);
    }

    /**
     * @dev Point a token at a whitelist oracle, or pass address(0) to disable.
     *      Switching this on is default-deny: populate the oracle first.
     * @param token The token whose transfers this oracle should gate.
     * @param oracle WhitelistOracle address, or address(0) to turn the gate off.
     */
    function setWhitelistOracle(address token, address oracle) external onlyOwner {
        if (token == address(0)) revert InvalidTokenAddress();
        if (oracle != address(0) && oracle.code.length == 0) revert OracleNotAContract(oracle);
        // Same rationale as setBlacklistOracle: fail here, not on every transfer.
        if (oracle != address(0)) {
            (bool ok, bytes memory ret) = oracle.staticcall(
                abi.encodeWithSelector(IWhitelistOracleView.isWhitelisted.selector, address(this))
            );
            if (!ok || ret.length != 32) revert OracleIncompatible(oracle);
        }
        whitelistOracle[token] = oracle;
        emit WhitelistOracleSet(token, oracle);
    }

    /**
     * @dev Point a token at the PrivacyManager whose whitelist bindings
     *      ZkOnly/Either read, or pass address(0) to clear it (OracleOnly only).
     *      Re-pointing an in-use mode to another PrivacyManager drops every
     *      holder's binding until they re-bind on the new one.
     * @param token The token whose whitelist this PrivacyManager may decide.
     * @param pm PrivacyManager address, or address(0).
     */
    function setPrivacyManager(address token, address pm) external onlyOwner {
        if (token == address(0)) revert InvalidTokenAddress();
        if (pm == address(0)) {
            // Clearing it under ZkOnly/Either would make every check call 0.
            if (whitelistMode[token] != WhitelistMode.OracleOnly) revert PrivacyManagerInUse(token);
        } else {
            if (pm.code.length == 0) revert PrivacyManagerNotAContract(pm);
            // Same rationale as setBlacklistOracle: fail here, not on every transfer.
            (bool ok, bytes memory ret) = pm.staticcall(
                abi.encodeWithSelector(IPrivacyManagerView.hasValidWhitelistProof.selector, address(this))
            );
            if (!ok || ret.length != 32) revert PrivacyManagerIncompatible(pm);
        }
        privacyManager[token] = pm;
        emit PrivacyManagerSet(token, pm);
    }

    /**
     * @dev Choose the whitelist source for a token. ZkOnly and Either need a
     *      PrivacyManager; switching to them is default-deny for every holder
     *      without a live binding (and, for Either, not on the oracle).
     */
    function setWhitelistMode(address token, WhitelistMode mode) external onlyOwner {
        if (token == address(0)) revert InvalidTokenAddress();
        if (mode != WhitelistMode.OracleOnly && privacyManager[token] == address(0)) {
            revert PrivacyManagerNotSet(token);
        }
        whitelistMode[token] = mode;
        emit WhitelistModeSet(token, mode);
    }

    // ========================================
    // JURISDICTION RULES, ADMINISTRATORS, REGISTRY
    // ========================================

    struct JurisdictionRule {
        bool isActive;
        uint256[] allowedCountries;
        uint256[] blockedCountries;
        mapping(uint256 => bool) allowedCountryMap;
        mapping(uint256 => bool) blockedCountryMap;
        uint256 lastUpdated;
    }

    mapping(address => JurisdictionRule) private jurisdictionRules;

    /// @notice token => account => may set and clear that token's jurisdiction
    ///         rule (G5). Granted per token by the owner; nobody holds it at
    ///         construction.
    mapping(address => mapping(address => bool)) public ruleAdministrators;
    mapping(address => address) public tokenIdentityRegistry; // Maps token address to its IdentityRegistry
    /// @notice Bumped by every setJurisdictionRule/clearJurisdictionRule for
    ///         the token (never decreases): PrivacyManager folds it into the
    ///         jurisdiction attestation policy so a restored rule (A -> B -> A)
    ///         does not revive an attestation made under the first A.
    mapping(address => uint256) public override jurisdictionRuleVersion;

    /// @dev The default rule: its blocked list applies to every token; the
    ///      whole rule applies to a token with no rule of its own.
    JurisdictionRule internal defaultJurisdictionRule;

    uint256 public constant MAX_COUNTRIES = 300;

    event JurisdictionRuleUpdated(address indexed token, uint256[] allowedCountries, uint256[] blockedCountries);
    event JurisdictionRuleCleared(address indexed token);
    event RuleAdministratorUpdated(address indexed token, address indexed administrator, bool authorized);
    event TokenIdentityRegistrySet(address indexed token, address indexed identityRegistry);

    modifier onlyGovernance(address token) {
        require(
            ruleAdministrators[token][msg.sender],
            "ComplianceRules: Only governance can update rules"
        );
        _;
    }

    constructor(address _owner) Ownable(_owner) {}

    /**
     * @dev Set the IdentityRegistry for a token
     * This allows ComplianceRules to verify KYC/AML status
     */
    function setTokenIdentityRegistry(
        address token,
        address identityRegistry
    ) external onlyOwner {
        require(token != address(0), "ComplianceRules: Invalid token address");
        require(identityRegistry != address(0), "ComplianceRules: Invalid identity registry address");
        require(identityRegistry.code.length > 0, "ComplianceRules: registry is not a contract");

        tokenIdentityRegistry[token] = identityRegistry;
        emit TokenIdentityRegistrySet(token, identityRegistry);
    }

    /**
     * @dev Grant or revoke the right to set `token`'s jurisdiction rule
     */
    function setRuleAdministrator(address token, address administrator, bool authorized) external onlyOwner {
        require(token != address(0), "ComplianceRules: Invalid token address");
        require(administrator != address(0), "ComplianceRules: Invalid administrator address");
        ruleAdministrators[token][administrator] = authorized;
        emit RuleAdministratorUpdated(token, administrator, authorized);
    }

    /**
     * @dev Set jurisdiction-based validation rules
     * @notice Can only be called by governance contract after voting
     */
    function setJurisdictionRule(
        address token,
        uint256[] calldata allowedCountries,
        uint256[] calldata blockedCountries
    ) external onlyGovernance(token) {
        // address(0) cannot hold an administrator: setRuleAdministrator refuses it.
        require(allowedCountries.length <= MAX_COUNTRIES, "ComplianceRules: Too many allowed countries");
        require(blockedCountries.length <= MAX_COUNTRIES, "ComplianceRules: Too many blocked countries");

        JurisdictionRule storage rule = jurisdictionRules[token];

        // Clear the mappings for the rule that is being REPLACED. These loops
        // must read the STORED arrays: iterating the incoming calldata deleted
        // only the keys about to be re-set, so removals never took effect and
        // an un-blocked country stayed blocked forever.
        _clearMaps(rule);

        // Set new rules
        rule.isActive = true;
        rule.allowedCountries = allowedCountries;
        rule.blockedCountries = blockedCountries;
        rule.lastUpdated = block.timestamp;

        // Update mappings for efficient lookup
        for (uint256 i = 0; i < allowedCountries.length; i++) {
            rule.allowedCountryMap[allowedCountries[i]] = true;
        }
        for (uint256 i = 0; i < blockedCountries.length; i++) {
            rule.blockedCountryMap[blockedCountries[i]] = true;
        }

        jurisdictionRuleVersion[token]++;
        emit JurisdictionRuleUpdated(token, allowedCountries, blockedCountries);
    }

    /**
     * @dev Remove a token's own jurisdiction rule so the default rule applies
     *      again. Clears the stored arrays and lookup maps.
     */
    function clearJurisdictionRule(address token) external onlyGovernance(token) {
        JurisdictionRule storage rule = jurisdictionRules[token];
        _clearMaps(rule);
        delete rule.allowedCountries;
        delete rule.blockedCountries;
        rule.isActive = false;
        rule.lastUpdated = block.timestamp;
        jurisdictionRuleVersion[token]++;
        emit JurisdictionRuleCleared(token);
    }

    /// @dev Delete the lookup entries of the rule's STORED arrays.
    function _clearMaps(JurisdictionRule storage rule) private {
        uint256[] storage allowed = rule.allowedCountries;
        for (uint256 i = 0; i < allowed.length; i++) {
            delete rule.allowedCountryMap[allowed[i]];
        }
        uint256[] storage blocked = rule.blockedCountries;
        for (uint256 i = 0; i < blocked.length; i++) {
            delete rule.blockedCountryMap[blocked[i]];
        }
    }

    /**
     * @dev Validate jurisdiction compliance. PrivacyManager reads this exact
     *      selector and return shape (its IJurisdictionRuleSource).
     */
    function validateJurisdiction(
        address token,
        uint256 countryCode
    ) external view override returns (bool isValid, string memory reason) {
        // Same rule canTransfer applies: default blocked list always, then the
        // per-token rule when active.
        uint8 verdict = _countryVerdict(token, countryCode);
        if (verdict == 1) {
            return (false, "Country is blocked");
        }
        if (verdict == 2) {
            return (false, "Country not in allowed list");
        }
        return (true, "Jurisdiction validation passed");
    }

    /**
     * @dev Get jurisdiction rule details (the default rule when the token has none)
     */
    function getJurisdictionRule(
        address token
    )
        external
        view
        returns (
            bool isActive,
            uint256[] memory allowedCountries,
            uint256[] memory blockedCountries,
            uint256 lastUpdated
        )
    {
        JurisdictionRule storage rule = _getJurisdictionRule(token);
        return (rule.isActive, rule.allowedCountries, rule.blockedCountries, rule.lastUpdated);
    }

    /**
     * @dev 0 = allowed, 1 = blocked, 2 = not in allowed list. The default
     *      blocked list (sanctions) always applies; a per-token rule, when
     *      active, is checked on top of it and cannot remove it. With no
     *      per-token rule the full default rule (blocked, then allowed) applies.
     */
    function _countryVerdict(address token, uint256 country) internal view returns (uint8) {
        if (defaultJurisdictionRule.blockedCountryMap[country]) {
            return 1;
        }
        JurisdictionRule storage rule = _getJurisdictionRule(token);
        if (!rule.isActive) {
            return 0;
        }
        if (rule.blockedCountryMap[country]) {
            return 1;
        }
        if (rule.allowedCountries.length > 0 && !rule.allowedCountryMap[country]) {
            return 2;
        }
        return 0;
    }

    /**
     * @dev Get jurisdiction rule for token (with fallback to default)
     */
    function _getJurisdictionRule(address token) private view returns (JurisdictionRule storage) {
        if (jurisdictionRules[token].isActive) {
            return jurisdictionRules[token];
        }
        return defaultJurisdictionRule;
    }
}
