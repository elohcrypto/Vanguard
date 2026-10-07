// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./ComplianceRulesAdmin.sol";
import "../erc3643/interfaces/ICompliance.sol";
import "../erc3643/interfaces/IIdentityRegistry.sol";
import {IInvestorTypeRegistry} from "../erc3643/interfaces/IInvestorTypeRegistry.sol";

/**
 * @title ComplianceRules
 * @dev Compliance rule engine bound to Token via IComplianceHooks: the
 *      evaluation half (canTransfer, canReceive, the oracle and whitelist
 *      helpers, the hooks, the production marker). Every setting it reads,
 *      and every function that writes one, lives in ComplianceRulesAdmin.
 *      One deployed contract (plan v2 Task 4.1, split by inheritance).
 */
contract ComplianceRules is ComplianceRulesAdmin, IComplianceHooks {
    // Implements IComplianceHooks, the slice Token actually calls, so the
    // compiler enforces it. Not a full ICompliance: the module functions
    // that interface declares were empty stubs here and are gone.

    constructor(
        address _owner,
        uint256[] memory initialAllowedCountries,
        uint256[] memory initialBlockedCountries
    ) ComplianceRulesAdmin(_owner) {
        // Initialize default rules with user-provided countries
        _initializeDefaultRules(initialAllowedCountries, initialBlockedCountries);
        // No rule administrator yet: the owner grants one per token (G5).
    }

    /**
     * @dev Whether `contractAddress` is trusted on the calling token
     *      (msg.sender is the token, as in canTransfer). Off-chain readers
     *      use isTrustedContract(token, account).
     * @param contractAddress Address to check
     */
    function isTrustedContract(address contractAddress) external view override returns (bool) {
        return trustedContracts[msg.sender][contractAddress];
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
     *      Tier (D37 = a, Task 4.10): wherever a party passes by its oracle
     *      entry (OracleOnly, or Either with a live entry), the entry's tier
     *      must reach its investor type's requiredWhitelistTier, so every
     *      caller above applies it to the same parties. Not applicable in
     *      ZkOnly, nor to a party that passes Either by a proof binding with
     *      no live entry: a proof binding carries no tier.
     */
    function _whitelistAllows(address token, address from, address to) internal view returns (bool) {
        return _whitelisted(token, from) && _whitelisted(token, to);
    }

    /// @dev One party of _whitelistAllows; address(0) (mint/burn side) passes.
    ///      Each source is called at most once. A party that passes by its
    ///      oracle entry must also meet its investor type's required tier
    ///      (_tierMet, Task 4.10); a tier-short entry refuses even in Either.
    function _whitelisted(address token, address party) private view returns (bool) {
        if (party == address(0)) return true;
        WhitelistMode mode = whitelistMode[token];
        if (mode != WhitelistMode.ZkOnly) {
            address wlOracle = whitelistOracle[token];
            if (wlOracle != address(0)) {
                IWhitelistOracleView wl = IWhitelistOracleView(wlOracle);
                if (wl.isWhitelisted(party)) return _tierMet(token, wl, party);
                if (mode == WhitelistMode.OracleOnly) return false;
            } else if (mode == WhitelistMode.OracleOnly) {
                return true;
            }
        }
        return IPrivacyManagerView(privacyManager[token]).hasValidWhitelistProof(party);
    }

    /**
     * @notice The whitelist tier rule (D37 = a, Task 4.10) for `party` on
     *         `token`: false only when the token's mode is OracleOnly or
     *         Either, its whitelist oracle holds a live entry for the party,
     *         and that entry's tier is below the tier the party's investor
     *         type requires in the token's investor-type registry. True
     *         (not applicable) in ZkOnly and for a party with no live entry,
     *         such as one that passes Either by its proof binding: a proof
     *         binding carries no tier. Lets a reader name the cause of a
     *         "Compliance check failed" refusal.
     */
    function whitelistTierAllows(address token, address party) external view returns (bool) {
        address wlOracle = whitelistOracle[token];
        if (whitelistMode[token] == WhitelistMode.ZkOnly || wlOracle == address(0)) return true;
        IWhitelistOracleView wl = IWhitelistOracleView(wlOracle);
        if (!wl.isWhitelisted(party)) return true;
        return _tierMet(token, wl, party);
    }

    /// @dev The party's oracle entry tier meets its investor type's required
    ///      tier. No rule when the token applies no investor-type registry
    ///      (Token.investorTypeRegistry() is zero, or the token is not a
    ///      Token) or the party is investorLimitExempt (D22, as for the caps).
    function _tierMet(address token, IWhitelistOracleView wlOracle, address party) private view returns (bool) {
        IInvestorTypeRegistry types = _typesOf(token);
        if (address(types) == address(0) || types.investorLimitExempt(party)) return true;
        (, , , uint8 tier, , ) = wlOracle.getWhitelistInfo(party);
        return tier >= types.getRequiredWhitelistTier(party);
    }

    /// @dev The token's own investor-type registry (R-410-2), or zero.
    function _typesOf(address token) private view returns (IInvestorTypeRegistry) {
        if (token.code.length == 0) return IInvestorTypeRegistry(address(0));
        try ITokenInvestorTypesView(token).investorTypeRegistry() returns (address r) {
            return IInvestorTypeRegistry(r);
        } catch {
            return IInvestorTypeRegistry(address(0));
        }
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
        mapping(address => bool) storage trusted = trustedContracts[token];
        if (trusted[from] || trusted[to]) {
            address partyToCheck = trusted[from] ? to : from;

            // Both parties trusted: contract-to-contract move, nothing to check.
            if (trusted[partyToCheck]) {
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
     *         A contract trusted on ANY token is refused: trust is per token
     *         (G5), so VSC's own trusted check no longer sees governance, and
     *         a VSC recovery must still not move a voter's shared identity
     *         onto it (review M1, 2E).
     */
    function canReceive(address to) external view returns (bool) {
        if (trustedTokenCount[to] != 0) return false;
        return _oraclesAllow(msg.sender, address(0), to);
    }

    /**
     * @dev Country rule for one party, as recorded in the token's registry.
     */
    function _countryAllowed(address token, IIdentityRegistry registry, address party) private view returns (bool) {
        return _countryVerdict(token, registry.investorCountry(party)) == 0;
    }

    // Token calls these three after every mint, burn and transfer through its
    // ICompliance reference. They are intentionally empty: this contract keeps
    // no per-transfer state, and all enforcement happens in canTransfer above.
    // They carry no access control because there is nothing to protect. If a
    // body is ever added, gate it (the Token is the only legitimate caller).
    function transferred(address /* from */, address /* to */, uint256 /* amount */) external {}

    function created(address /* to */, uint256 /* amount */) external {}

    function destroyed(address /* from */, uint256 /* amount */) external {}

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
}
