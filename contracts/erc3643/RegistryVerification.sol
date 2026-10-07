// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "@openzeppelin/contracts/access/Ownable2Step.sol";
import "./interfaces/IIdentityRegistry.sol";
import "../onchain_id/interfaces/IClaimIssuer.sol";

/**
 * @title RegistryVerification
 * @dev The verification half of IdentityRegistry: required claim topics,
 *      trusted issuers, the claim walk and its cache. IdentityRegistry adds
 *      wallets, identities, countries, agents and the investor-type and
 *      compliance links; one contract is deployed (plan v2 Task 4.9, split
 *      by inheritance as OnchainID was in 4.5).
 *
 *      Verification cache (D17 = a). The walk asks every trusted issuer of
 *      every required topic, one external call each; a transfer pays it for
 *      both parties. `refreshVerified` / `refreshIdentity` run the full walk
 *      and store its result per IDENTITY (the walk depends only on the
 *      identity; one entry serves the wallet bound to it). While the entry
 *      is fresh `isVerified` returns true at the cost of two reads.
 *
 *      - Only positives are cached; a missing or stale entry falls back to
 *        the full walk, so an unrefreshed identity behaves as before.
 *      - An entry lives until the earlier of refresh time + VERIFIED_TTL
 *        and the validTo of every claim the walk accepted, so claim expiry
 *        is exact. An issuer that does not expose validTo is never cached.
 *      - Refresh is permissionless and truth-only: on a passing walk it
 *        writes, on a failing walk it clears. After an issuer revokes or
 *        supersedes a claim, anyone's refresh makes the change immediate;
 *        without one the entry may verify until it lapses (at most
 *        VERIFIED_TTL). There is no privileged invalidate (R-49-2).
 *      - Registry changes that can unverify bump `verificationGeneration`,
 *        which voids every entry in the same transaction:
 *
 *        | path                              | effect on the cache          |
 *        |-----------------------------------|------------------------------|
 *        | addClaimTopic                     | bumps (a new requirement)    |
 *        | removeTrustedIssuer               | bumps (an issuer stops counting) |
 *        | removeClaimTopic                  | cannot unverify (fewer reqs) |
 *        | addTrustedIssuer                  | cannot unverify (more issuers) |
 *        | registerIdentity / batch          | covered by the key (identity) |
 *        | deleteIdentity                    | covered by the key: wallet reads zero |
 *        | updateIdentity                    | covered by the key: wallet reads the new identity's own entry |
 *        | moveIdentity                      | covered by the key: old wallet reads zero |
 *        | updateCountry, agents, setters    | not part of the walk         |
 *
 *      Blacklist (the oracle path in ComplianceRules) and token freezes do
 *      not go through this cache; they stay immediate.
 */
abstract contract RegistryVerification is IIdentityRegistry, Ownable2Step {
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

    /// @notice Longest a cached verification lives without a refresh.
    uint256 public constant VERIFIED_TTL = 24 hours;

    /// @notice Bumped by every registry change that can unverify; an entry
    ///         written under an older generation is stale.
    uint64 public verificationGeneration;

    struct VerifiedEntry {
        uint64 generation;
        uint64 until;
    }

    // identity => cached positive walk (one slot)
    mapping(address => VerifiedEntry) private _verified;

    error TooManyTrustedIssuers(uint256 topic);
    error IssuerNotAContract(address issuer);

    event ClaimTopicAdded(uint256 indexed topic);
    event ClaimTopicRemoved(uint256 indexed topic);
    event TrustedIssuerAdded(address indexed issuer, uint256[] topics);
    event TrustedIssuerRemoved(address indexed issuer);
    event VerificationRefreshed(address indexed identity, uint64 generation, uint64 until);
    event VerificationCleared(address indexed identity);
    event VerificationCacheVoided(uint64 generation);

    /// @dev The identity registered to `wallet`, or address(0).
    function _identityOf(address wallet) internal view virtual returns (address);

    /**
     * @dev Verified = registered by an agent AND holding a live claim from a
     *      trusted issuer on every required topic. A registry with no required
     *      topics verifies nobody (fail closed; T-REX would verify everyone).
     *      The deploy guard in scripts/deploy-helpers.ts is the second line.
     *      A fresh cache entry for the identity answers without the walk.
     */
    function isVerified(address _userAddress) external view override returns (bool) {
        address id = _identityOf(_userAddress);
        if (id == address(0)) return false;
        VerifiedEntry memory e = _verified[id];
        if (e.until > block.timestamp && e.generation == verificationGeneration) return true;
        (bool ok, ) = _walk(id, false);
        return ok;
    }

    /// @notice Run the full walk for the identity registered to `wallet` and
    ///         cache the result (pass) or clear it (fail). Anyone may call.
    /// @return The walk's result; false for an unregistered wallet.
    function refreshVerified(address wallet) external returns (bool) {
        address id = _identityOf(wallet);
        if (id == address(0)) return false;
        return _refresh(id);
    }

    /// @notice refreshVerified keyed by identity. Anyone may call.
    function refreshIdentity(address identityAddr) external returns (bool) {
        if (identityAddr == address(0)) return false;
        return _refresh(identityAddr);
    }

    /// @notice The identity's fresh cache entry, or (0, 0) if none is fresh.
    function verifiedUntil(address identityAddr) external view returns (uint64 generation, uint64 until) {
        VerifiedEntry memory e = _verified[identityAddr];
        if (e.until > block.timestamp && e.generation == verificationGeneration) return (e.generation, e.until);
        return (0, 0);
    }

    function _refresh(address id) private returns (bool ok) {
        uint64 until;
        (ok, until) = _walk(id, true);
        if (ok && until > block.timestamp) {
            uint64 gen = verificationGeneration;
            _verified[id] = VerifiedEntry(gen, until);
            emit VerificationRefreshed(id, gen, until);
        } else if (_verified[id].until != 0) {
            delete _verified[id];
            emit VerificationCleared(id);
        }
    }

    function _voidCache() private {
        uint64 gen = verificationGeneration + 1;
        verificationGeneration = gen;
        emit VerificationCacheVoided(gen);
    }

    // ---- Required-claim configuration (owner = governance after handover) ----

    /// @dev Never a topic no trusted issuer covers (2F.5 review L-1): it
    ///      would verify nobody, so no vote could ever pass again. Trust the
    ///      issuer first (addTrustedIssuer accepts a non-required topic).
    function addClaimTopic(uint256 _topic) external onlyOwner {
        require(!_isRequiredTopic[_topic], "Topic already required");
        require(_trustedIssuersForTopic[_topic].length > 0, "No trusted issuer for topic");
        _isRequiredTopic[_topic] = true;
        _claimTopics.push(_topic);
        _voidCache();
        emit ClaimTopicAdded(_topic);
    }

    /// @dev Never the last topic (2F.5, L3): zero topics verifies nobody, so
    ///      no vote could ever pass again. Zero is only a fail-closed initial state.
    function removeClaimTopic(uint256 _topic) external onlyOwner {
        require(_isRequiredTopic[_topic], "Topic not required");
        require(_claimTopics.length > 1, "Last claim topic");
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

    /// @dev Voids every cache entry: a removed (e.g. compromised) issuer
    ///      stops counting in the same block.
    function removeTrustedIssuer(address _issuer) external onlyOwner {
        uint256[] storage topics = _issuerTopics[_issuer];
        require(topics.length > 0, "Issuer not trusted");
        for (uint256 i = 0; i < topics.length; i++) {
            // A required topic with no trusted issuer verifies nobody (2F.5, L3).
            require(
                !_isRequiredTopic[topics[i]] || _trustedIssuersForTopic[topics[i]].length > 1,
                "Last issuer for required topic"
            );
            _issuerHasTopic[_issuer][topics[i]] = false;
            _removeAddressFromList(_trustedIssuersForTopic[topics[i]], _issuer);
        }
        delete _issuerTopics[_issuer];
        _voidCache();
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
     * @dev The full walk. With `withUntil`, also the cache expiry: the
     *      earlier of now + VERIFIED_TTL and the validTo of each accepted
     *      claim (past, so never cached, if an issuer hides validTo).
     */
    function _walk(address id, bool withUntil) private view returns (bool, uint64 until) {
        uint256 n = _claimTopics.length;
        if (n == 0) return (false, 0);
        // Wallets registered with a non-identity address are unverified.
        if (id.code.length == 0) return (false, 0);
        if (withUntil) until = uint64(block.timestamp + VERIFIED_TTL);
        for (uint256 t = 0; t < n; t++) {
            uint256 topic = _claimTopics[t];
            address issuer = _acceptingIssuer(id, topic);
            if (issuer == address(0)) return (false, 0);
            if (withUntil) {
                uint256 validTo = _claimValidTo(issuer, id, topic);
                if (validTo != 0 && validTo < until) until = uint64(validTo);
            }
        }
        return (true, until);
    }

    /**
     * @dev The first issuer trusted for `topic` that reports a live claim on
     *      it for `id`, or address(0). Asks the issuers, never the identity's
     *      claim list: anyone may add claims naming themselves to an identity
     *      (OnchainID.addClaim), so that list cannot decide verification
     *      (2F.2, H2). A low-level staticcall: an issuer that reverts or
     *      returns short data counts as "no claim", never reverts here.
     */
    function _acceptingIssuer(address id, uint256 topic) private view returns (address) {
        address[] storage issuers = _trustedIssuersForTopic[topic];
        for (uint256 i = 0; i < issuers.length; i++) {
            (bool ok, bytes memory ret) = issuers[i].staticcall(
                abi.encodeCall(IClaimIssuer.hasValidClaim, (id, topic))
            );
            if (ok && ret.length >= 32 && abi.decode(ret, (bool))) return issuers[i];
        }
        return address(0);
    }

    /**
     * @dev validTo of the issuer's latest claim on (id, topic), read through
     *      ClaimIssuer's public getters latestClaimId and issuedClaims (word 7
     *      of the flattened IssuedClaim: identity, topic, scheme, signature,
     *      data, uri, issuedAt, validTo, revoked, revokedAt). An issuer
     *      without these getters, or a record for another identity or
     *      topic, returns 1: a past expiry, so the walk is never cached.
     */
    function _claimValidTo(address issuer, address id, uint256 topic) private view returns (uint256 validTo) {
        (bool ok, bytes memory ret) = issuer.staticcall(abi.encodeWithSignature("latestClaimId(address,uint256)", id, topic));
        if (!ok || ret.length < 32) return 1;
        bytes32 claimId = abi.decode(ret, (bytes32));
        (ok, ret) = issuer.staticcall(abi.encodeWithSignature("issuedClaims(bytes32)", claimId));
        if (!ok || ret.length < 320) return 1;
        uint256 claimIdentity;
        uint256 claimTopic;
        // solhint-disable-next-line no-inline-assembly
        assembly {
            claimIdentity := mload(add(ret, 32))
            claimTopic := mload(add(ret, 64))
            validTo := mload(add(ret, 256))
        }
        if (claimIdentity != uint256(uint160(id)) || claimTopic != topic) return 1;
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
}
