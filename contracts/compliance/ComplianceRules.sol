// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable2Step.sol";
import "./interfaces/IComplianceRules.sol";
import "../erc3643/interfaces/ICompliance.sol";
import "../erc3643/interfaces/IIdentityRegistry.sol";

/// @dev Read-only slice of BlacklistOracle. Declared here rather than imported
///      so ComplianceRules cannot reach any state-changing oracle function.
interface IBlacklistOracleView {
    function isBlacklisted(address subject) external view returns (bool);
}

/// @dev Read-only slice of WhitelistOracle. Same rationale as above.
interface IWhitelistOracleView {
    function isWhitelisted(address subject) external view returns (bool);
}

/// @dev Read-only slice of PrivacyManager (the ZK whitelist binder). Same rationale.
interface IPrivacyManagerView {
    function hasValidWhitelistProof(address user) external view returns (bool);
}

/**
 * @title ComplianceRules
 * @dev Configurable compliance rule engine bound to Token via IComplianceHooks
 */
contract ComplianceRules is IComplianceRules, IComplianceHooks, Ownable2Step {
    // Implements IComplianceHooks, the slice Token actually calls, so the
    // compiler enforces it. Not a full ICompliance: the module functions
    // that interface declares were empty stubs here and are gone.
    /**
     * @dev Check if a transfer is allowed based on all compliance rules
     * This is the main function called by Token contract
     * Enforces KYC/AML verification + business rules
     */
    // ========================================
    // TRUSTED CONTRACTS (Escrow Wallets, etc.)
    // ========================================

    mapping(address => bool) private trustedContracts;

    event TrustedContractAdded(address indexed contractAddress);
    event TrustedContractRemoved(address indexed contractAddress);

    /**
     * @dev Add a trusted contract (e.g., escrow wallet) that can bypass KYC/AML
     * @param contractAddress Address of the trusted contract
     */
    function addTrustedContract(address contractAddress) external onlyOwner {
        require(contractAddress != address(0), "Invalid address");
        require(contractAddress.code.length > 0, "ComplianceRules: not a contract");
        // EIP-7702 delegation indicator (0xef0100 || address, 23 bytes): a
        // delegated EOA is still a wallet, so it must never be trusted.
        if (contractAddress.code.length == 23) {
            bytes memory code = contractAddress.code;
            require(
                !(code[0] == 0xef && code[1] == 0x01 && code[2] == 0x00),
                "ComplianceRules: delegated wallet"
            );
        }
        require(!trustedContracts[contractAddress], "Already trusted");
        trustedContracts[contractAddress] = true;
        emit TrustedContractAdded(contractAddress);
    }

    /**
     * @dev Remove a trusted contract
     * @param contractAddress Address of the contract to remove
     */
    function removeTrustedContract(address contractAddress) external onlyOwner {
        require(trustedContracts[contractAddress], "Not trusted");
        // After the handover the owner is governance, which holds VGT fees as
        // a trusted contract with no identity (D21). Untrusting it would make
        // every later fee pull revert, so no proposal could ever undo it.
        require(contractAddress != owner(), "ComplianceRules: owner stays trusted");
        trustedContracts[contractAddress] = false;
        emit TrustedContractRemoved(contractAddress);
    }

    /**
     * @dev Check if an address is a trusted contract
     * @param contractAddress Address to check
     */
    function isTrustedContract(address contractAddress)
        external
        view
        override(IComplianceRules, IComplianceHooks)
        returns (bool)
    {
        return trustedContracts[contractAddress];
    }

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

    /**
     * @dev Apply whichever oracle gates are configured for `token` to one pair.
     *      Returns false to block. A gate with no oracle set is skipped.
     */
    function _oraclesAllow(address token, address from, address to) internal view returns (bool) {
        if (!_blacklistAllows(token, from, to)) {
            return false;
        }
        return _whitelistAllows(token, from, to);
    }

    /**
     * @dev Blacklist (deny list) only. Split out because it is enforced on
     *      every party of every path, while the whitelist exempts the escrow
     *      wallet on the trusted path. Keeping it separate means the oracle
     *      is queried exactly once per transfer rather than twice.
     */
    function _blacklistAllows(address token, address from, address to) internal view returns (bool) {
        // address(0) is the mint/burn counterparty, not a real party. Asking an
        // oracle about it would block every mint, so each side is checked only
        // when it is a real address.
        address blOracle = blacklistOracle[token];
        if (blOracle != address(0)) {
            IBlacklistOracleView bl = IBlacklistOracleView(blOracle);
            if (from != address(0) && bl.isBlacklisted(from)) {
                return false;
            }
            if (to != address(0) && bl.isBlacklisted(to)) {
                return false;
            }
        }
        return true;
    }

    /**
     * @dev Whitelist (allow list) only, per non-zero party, by whitelistMode:
     *      OracleOnly: no oracle set, or the oracle lists the party.
     *      ZkOnly: the PrivacyManager holds a live binding for the party (the
     *        whitelist oracle is not consulted).
     *      Either: the oracle is set and lists the party, or a live binding;
     *        with no oracle set this is ZkOnly (no oracle vouches for nobody).
     *      Every caller obeys the mode (R-3R-5): mint checks the recipient (in
     *      ZkOnly a mint recipient needs a live binding), the trusted path
     *      checks the non-escrow counterparty (the escrow wallet itself is
     *      exempt: a contract will never be on an investor allow list),
     *      canReceive (wallet recovery) checks the new wallet. Burn is never
     *      gated.
     */
    function _whitelistAllows(address token, address from, address to) internal view returns (bool) {
        return _whitelisted(token, from) && _whitelisted(token, to);
    }

    /// @dev One party of _whitelistAllows; address(0) (mint/burn side) passes.
    ///      Each source is called at most once.
    function _whitelisted(address token, address party) private view returns (bool) {
        if (party == address(0)) return true;
        WhitelistMode mode = whitelistMode[token];
        if (mode != WhitelistMode.ZkOnly) {
            address wlOracle = whitelistOracle[token];
            if (wlOracle != address(0)) {
                if (IWhitelistOracleView(wlOracle).isWhitelisted(party)) return true;
                if (mode == WhitelistMode.OracleOnly) return false;
            } else if (mode == WhitelistMode.OracleOnly) {
                return true;
            }
        }
        return IPrivacyManagerView(privacyManager[token]).hasValidWhitelistProof(party);
    }

    /**
     * @notice Deployment marker read by scripts/deploy-helpers.ts before a Token
     *         is bound to this contract. True: canTransfer enforces KYC and
     *         jurisdiction rules. The permissive test double ComplianceRegistry
     *         returns false, and a contract without this function is refused.
     */
    function isProductionCompliance() external pure returns (bool) {
        return true;
    }

    /**
     * @notice Token-aware marker: true only once an IdentityRegistry is bound
     *         for `token`. Without one, canTransfer refuses every non-mint,
     *         non-burn transfer for that token (fail closed).
     */
    function isProductionCompliance(address token) external view returns (bool) {
        return tokenIdentityRegistry[token] != address(0);
    }

    function canTransfer(
        address from,
        address to,
        uint256 /* amount */
    ) external view returns (bool) {
        // Rule: identity is Token's gate (ERC-3643); compliance checks lists,
        // jurisdiction, and the non-escrow counterparty on the trusted path.
        // Token verifies both parties itself, so they are not re-verified here.
        //
        // Minting (from == address(0)): the recipient still faces the list
        // gates (the blacklist, and the whitelist by mode), so tokens cannot
        // be issued to a blacklisted or unlisted address. When a
        // registry is bound, the recipient must also pass the country rule.
        // Identity is Token's gate (mint() verifies the recipient).
        if (from == address(0)) {
            if (!_oraclesAllow(msg.sender, address(0), to)) {
                return false;
            }
            address mintRegistryAddr = tokenIdentityRegistry[msg.sender];
            if (mintRegistryAddr == address(0)) {
                return true;
            }
            IIdentityRegistry mintRegistry = IIdentityRegistry(mintRegistryAddr);
            return _countryAllowed(msg.sender, mintRegistry, to);
        }

        // Burning (to == address(0)): never gated. Burning is how an operator
        // claws tokens back from a bad actor; gating it would strand them.
        if (to == address(0)) {
            return true;
        }

        // Get the token that's calling us (msg.sender is the token contract)
        address token = msg.sender;

        // Check if we have an IdentityRegistry configured for this token
        address identityRegistryAddr = tokenIdentityRegistry[token];

        // ✅ ENFORCE FIRST, UNCONDITIONALLY: the blacklist applies to everyone,
        // on every path, whether or not an identity registry is wired for this
        // token. It used to sit inside the registry block below, so an operator
        // who set a blacklist oracle before setTokenIdentityRegistry got a
        // silent no-op. It also sits ABOVE the trusted-contract bypass: a
        // sanctioned address must not launder a transfer through an escrow.
        if (!_blacklistAllows(token, from, to)) {
            return false; // ❌ BLOCK: blacklisted party, no bypass
        }

        // ✅ FAIL CLOSED: without a bound IdentityRegistry nobody can be
        // verified, so no transfer passes. Mint (oracle gating) and burn are
        // handled above.
        if (identityRegistryAddr == address(0)) {
            return false; // ❌ BLOCK: no identity registry bound for this token
        }
        IIdentityRegistry identityRegistry = IIdentityRegistry(identityRegistryAddr);

        // Trusted contracts (escrow wallets) skip the KYC and whitelist checks
        // for THEMSELVES only. Token skips identity on trusted transfers, so
        // this is the one path where compliance verifies identity: the
        // non-escrow counterparty must be verified, pass the whitelist, and
        // pass the country rule (no funds to or from a blocked jurisdiction).
        if (trustedContracts[from] || trustedContracts[to]) {
            address partyToCheck = trustedContracts[from] ? to : from;

            // Both parties trusted: contract-to-contract move, nothing to check.
            if (trustedContracts[partyToCheck]) {
                return true;
            }

            if (!identityRegistry.isVerified(partyToCheck)) {
                return false; // ❌ BLOCK: counterparty not verified
            }

            // The escrow wallet itself is exempt from the whitelist (a contract
            // will never be on an investor allow list), but an UNLISTED investor
            // must not route around the allow list by going through escrow.
            if (!_whitelistAllows(token, partyToCheck, address(0))) {
                return false;
            }

            return _countryAllowed(token, identityRegistry, partyToCheck);
        }

        // ✅ ENFORCE: whitelist (allow list). The blacklist was already
        // applied above, on every path including trusted contracts, so only
        // the whitelist remains here. Off in OracleOnly with no oracle set.
        if (!_whitelistAllows(token, from, to)) {
            return false; // ❌ BLOCK: whitelist gate
        }

        // Identity is Token's gate (ERC-3643): Token._checkTransfer verifies
        // both parties before calling here, so compliance checks lists and
        // jurisdiction only on the normal path.

        // ✅ ENFORCE: Jurisdiction rules for both parties
        return _countryAllowed(token, identityRegistry, from) && _countryAllowed(token, identityRegistry, to);
    }

    /**
     * @notice List gate only (blacklist, then whitelist by mode) for the calling
     *         token on `to`. No identity or jurisdiction: wallet recovery moves
     *         the same holder's balance, so it re-checks the lists alone.
     */
    function canReceive(address to) external view returns (bool) {
        return _oraclesAllow(msg.sender, address(0), to);
    }

    /**
     * @dev Country rule for one party, as recorded in the token's registry.
     */
    function _countryAllowed(address token, IIdentityRegistry registry, address party) private view returns (bool) {
        return _countryVerdict(token, registry.investorCountry(party)) == 0;
    }

    /**
     * @dev 0 = allowed, 1 = blocked, 2 = not in allowed list. The default
     *      blocked list (sanctions) always applies; a per-token rule, when
     *      active, is checked on top of it and cannot remove it. With no
     *      per-token rule the full default rule (blocked, then allowed) applies.
     */
    function _countryVerdict(address token, uint256 country) private view returns (uint8) {
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

    // Token calls these three after every mint, burn and transfer through its
    // ICompliance reference. They are intentionally empty: this contract keeps
    // no per-transfer state, and all enforcement happens in canTransfer above.
    // They carry no access control because there is nothing to protect. If a
    // body is ever added, gate it (the Token is the only legitimate caller).
    function transferred(address /* from */, address /* to */, uint256 /* amount */) external {}

    function created(address /* to */, uint256 /* amount */) external {}

    function destroyed(address /* from */, uint256 /* amount */) external {}
    // Compliance rule structures
    struct JurisdictionRule {
        bool isActive;
        uint256[] allowedCountries;
        uint256[] blockedCountries;
        mapping(uint256 => bool) allowedCountryMap;
        mapping(uint256 => bool) blockedCountryMap;
        uint256 lastUpdated;
    }

    // State variables
    mapping(address => JurisdictionRule) private jurisdictionRules;

    // Global rule configurations
    mapping(address => bool) public ruleAdministrators;
    mapping(address => address) public tokenIdentityRegistry; // Maps token address to its IdentityRegistry
    /// @notice Bumped by every setJurisdictionRule/clearJurisdictionRule for
    ///         the token (never decreases): PrivacyManager folds it into the
    ///         jurisdiction attestation policy so a restored rule (A -> B -> A)
    ///         does not revive an attestation made under the first A.
    mapping(address => uint256) public jurisdictionRuleVersion;

    // Default rules
    JurisdictionRule private defaultJurisdictionRule;

    // Constants
    uint256 public constant MAX_COUNTRIES = 300;

    // Events
    event JurisdictionRuleUpdated(address indexed token, uint256[] allowedCountries, uint256[] blockedCountries);
    event JurisdictionRuleCleared(address indexed token);
    event RuleAdministratorUpdated(address indexed administrator, bool authorized);
    event TokenIdentityRegistrySet(address indexed token, address indexed identityRegistry);

    modifier onlyGovernance() {
        require(
            ruleAdministrators[msg.sender],
            "ComplianceRules: Only governance can update rules"
        );
        _;
    }

    constructor(
        address _owner,
        uint256[] memory initialAllowedCountries,
        uint256[] memory initialBlockedCountries
    ) Ownable(_owner) {
        // Initialize default rules with user-provided countries
        _initializeDefaultRules(initialAllowedCountries, initialBlockedCountries);

        // Set deployer as rule administrator
        ruleAdministrators[_owner] = true;
    }

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
     * @dev Set jurisdiction-based validation rules
     * @notice Can only be called by governance contract after voting
     */
    function setJurisdictionRule(
        address token,
        uint256[] calldata allowedCountries,
        uint256[] calldata blockedCountries
    ) external override onlyGovernance {
        require(token != address(0), "ComplianceRules: Invalid token address");
        require(allowedCountries.length <= MAX_COUNTRIES, "ComplianceRules: Too many allowed countries");
        require(blockedCountries.length <= MAX_COUNTRIES, "ComplianceRules: Too many blocked countries");

        JurisdictionRule storage rule = jurisdictionRules[token];

        // Clear the mappings for the rule that is being REPLACED. These loops
        // must read the STORED arrays: iterating the incoming calldata deleted
        // only the keys about to be re-set, so removals never took effect and
        // an un-blocked country stayed blocked forever.
        uint256[] storage previousAllowed = rule.allowedCountries;
        for (uint256 i = 0; i < previousAllowed.length; i++) {
            delete rule.allowedCountryMap[previousAllowed[i]];
        }
        uint256[] storage previousBlocked = rule.blockedCountries;
        for (uint256 i = 0; i < previousBlocked.length; i++) {
            delete rule.blockedCountryMap[previousBlocked[i]];
        }

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
    function clearJurisdictionRule(address token) external onlyGovernance {
        require(token != address(0), "ComplianceRules: Invalid token address");
        JurisdictionRule storage rule = jurisdictionRules[token];
        for (uint256 i = 0; i < rule.allowedCountries.length; i++) {
            delete rule.allowedCountryMap[rule.allowedCountries[i]];
        }
        for (uint256 i = 0; i < rule.blockedCountries.length; i++) {
            delete rule.blockedCountryMap[rule.blockedCountries[i]];
        }
        delete rule.allowedCountries;
        delete rule.blockedCountries;
        rule.isActive = false;
        rule.lastUpdated = block.timestamp;
        jurisdictionRuleVersion[token]++;
        emit JurisdictionRuleCleared(token);
    }

    /**
     * @dev Validate jurisdiction compliance
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
     * @dev Set rule administrator
     */
    function setRuleAdministrator(address administrator, bool authorized) external onlyOwner {
        require(administrator != address(0), "ComplianceRules: Invalid administrator address");
        ruleAdministrators[administrator] = authorized;
        emit RuleAdministratorUpdated(administrator, authorized);
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

    /**
     * @dev Initialize default compliance rules
     * @param initialAllowedCountries Array of country codes to allow (whitelist)
     * @param initialBlockedCountries Array of country codes to block (blacklist)
     */
    function _initializeDefaultRules(
        uint256[] memory initialAllowedCountries,
        uint256[] memory initialBlockedCountries
    ) private {
        // Default jurisdiction rule - use user-specified countries
        defaultJurisdictionRule.isActive = true;
        defaultJurisdictionRule.lastUpdated = block.timestamp;

        // Set allowed countries (whitelist)
        // If empty array provided, no whitelist is active (all countries allowed except blocked)
        for (uint256 i = 0; i < initialAllowedCountries.length; i++) {
            defaultJurisdictionRule.allowedCountries.push(initialAllowedCountries[i]);
            defaultJurisdictionRule.allowedCountryMap[initialAllowedCountries[i]] = true;
        }

        // Set blocked countries (blacklist)
        // If empty array provided, no countries are blocked by default
        for (uint256 i = 0; i < initialBlockedCountries.length; i++) {
            defaultJurisdictionRule.blockedCountries.push(initialBlockedCountries[i]);
            defaultJurisdictionRule.blockedCountryMap[initialBlockedCountries[i]] = true;
        }
    }

    /**
     * @dev Get jurisdiction rule details
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
}
