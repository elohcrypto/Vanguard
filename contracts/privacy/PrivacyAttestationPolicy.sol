// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable2Step.sol";

/// @dev The slice of ComplianceRules the jurisdiction policy reads (Task 3.8).
interface IJurisdictionRuleSource {
    function validateJurisdiction(address token, uint256 countryCode)
        external
        view
        returns (bool isValid, string memory reason);

    function jurisdictionRuleVersion(address token) external view returns (uint256);
}

/// @dev The ERC-3643 getter the policy token answers (Token.compliance()).
interface IPolicyToken {
    function compliance() external view returns (address);
}

/**
 * @title PrivacyAttestationPolicy
 * @dev The attestation policy half of PrivacyManager (split by inheritance,
 *      plan Task 4.8, D35 a): the trusted issuer keys per circuit, the
 *      jurisdiction source and its ISO-code bits, the accreditation and
 *      compliance policies, their epochs and the attestation records'
 *      validity. PrivacyManager is the only contract deployed (one address,
 *      one bound type, one code-hash pin).
 */
abstract contract PrivacyAttestationPolicy is Ownable2Step {
    /// @dev A wallet's attestation status for one circuit: valid while
    ///      policyEpoch is the circuit's current epoch (and policyHash its
    ///      current policy hash), the attestor key is still trusted for the
    ///      circuit under the same attestorEpoch, and block.timestamp <
    ///      expiresAt. Like whitelistVersion (R-3R-10), an epoch only grows:
    ///      restoring a policy or re-trusting a key never revives a record.
    struct AttestationRecord {
        bytes32 policyHash;
        bytes32 attestor;
        uint256 nullifier;
        uint256 expiresAt;
        uint256 policyEpoch;
        uint256 attestorEpoch;
    }

    /// @dev Compliance-aggregation policy: weighted sum of the four attested
    ///      scores (each 0..100) >= minimum * 100; weights sum to 100.
    struct CompliancePolicy {
        uint256 minimum;
        uint256 wK;
        uint256 wA;
        uint256 wJ;
        uint256 wAcc;
    }

    bytes32 internal constant WHITELIST_ID = keccak256("WHITELIST_MEMBERSHIP");
    bytes32 internal constant BLACKLIST_ID = keccak256("BLACKLIST_MEMBERSHIP");
    bytes32 internal constant JURISDICTION_ID = keccak256("JURISDICTION_PROOF");
    bytes32 internal constant ACCREDITATION_ID = keccak256("ACCREDITATION_PROOF");
    bytes32 internal constant COMPLIANCE_ID = keccak256("COMPLIANCE_AGGREGATION");
    /// @dev The circuits range-check masks and the accreditation minimum to
    ///      64 bits, and compliance values to 7 bits.
    uint256 private constant MAX_MASK = type(uint64).max;
    uint256 internal constant SNARK_SCALAR_FIELD =
        21888242871839275222246405745257275088548364400416034343698204186575808495617;

    // Jurisdiction source (Task 3.8)
    /// @notice The token whose ComplianceRules rule defines the set (VSC);
    ///         unset = policy not set. Its compliance() is read on every use.
    address public policyToken;
    /// @notice Attested bit of a registered ISO 3166-1 numeric code (0 =
    ///         unassigned). Append-only: the n-th registered code gets 1 << n.
    mapping(uint256 isoCode => uint256) public jurisdictionBit;
    /// @dev Registered codes in bit order: jurisdictionCodes[i] has bit 1 << i.
    uint256[] private jurisdictionCodes;

    // Attestations (Task 3.7b)
    /// @notice Trusted issuer keys per circuit, keyed by keccak256(abi.encode(Ax, Ay)).
    mapping(bytes32 circuitId => mapping(bytes32 attestor => bool)) public trustedAttestor;
    /// @notice Number of trusted issuer keys per circuit (the ceremony reports it).
    mapping(bytes32 circuitId => uint256) public trustedAttestorCount;
    /// @notice Accreditation policy: attested amount >= this; 0 = not set.
    uint256 public minimumAccreditation;
    /// @notice Compliance-aggregation policy; all zero = not set.
    CompliancePolicy public compliancePolicy;
    /// @notice Latest attestation record per wallet per circuit.
    mapping(address user => mapping(bytes32 circuitId => AttestationRecord)) public attestationRecords;
    /// @notice Bumped on every policy change of a circuit (a policy
    ///         token or code registration, setMinimumAccreditation,
    ///         setCompliancePolicy). ComplianceRules' own rule changes reach
    ///         the jurisdiction records through jurisdictionRuleVersion.
    mapping(bytes32 circuitId => uint256) public policyEpoch;
    /// @notice Bumped on every trust change of an issuer key for a circuit.
    mapping(bytes32 circuitId => mapping(bytes32 attestor => uint256)) public attestorEpoch;
    /// @notice Wallet holding each attestation nullifier, per policy hash
    ///         (currentPolicyHash: circuit, epoch, policy and, for the
    ///         jurisdiction circuit, ComplianceRules and its rule version):
    ///         one attestation binds one wallet per policy, and any policy
    ///         change, a ComplianceRules rule change included, frees it.
    mapping(bytes32 policyHash => mapping(uint256 nullifier => address)) public attestationNullifierWallet;

    /// @dev The blacklist proof is a non-gating demonstration (D2): verify it
    ///      through ZKVerifierIntegrated.verifyBlacklistNonMembership.
    error NonGatingBlacklistProof();
    error NotAttestationCircuit(bytes32 circuitId);
    error InvalidSignalCount(uint256 expected, uint256 got);
    error UntrustedAttestor(bytes32 circuitId, bytes32 attestor);
    error PolicyNotSet(bytes32 circuitId);
    error StalePolicy(bytes32 circuitId);
    error AttestationNullifierBound(address wallet);
    error InvalidAttestationProof();
    error InvalidAttestorKey();
    error InvalidPolicy();
    error JurisdictionCapacity();
    error InvalidJurisdictionCode(uint256 isoCode);
    error InvalidPolicyToken();
    error WrongChainId(uint256 signal);
    error WrongVerifierContext(uint256 signal);
    error AttestationExpired(uint256 validUntil);

    event TrustedAttestorSet(
        bytes32 indexed circuitId,
        bytes32 indexed attestor,
        address indexed by,
        uint256 ax,
        uint256 ay,
        bool trusted
    );
    event PolicyEpochBumped(bytes32 indexed circuitId, uint256 epoch);
    event AccreditationPolicyUpdated(uint256 previousMinimum, uint256 newMinimum);
    event CompliancePolicyUpdated(uint256 minimum, uint256 wK, uint256 wA, uint256 wJ, uint256 wAcc);
    event PolicyTokenSet(address indexed policyToken, address complianceRules);
    event JurisdictionCodeRegistered(uint256 indexed isoCode, uint256 bit);

    /**
     * @notice Trust or untrust an issuer key (Ax, Ay) for one attestation
     *         circuit (owner; a type 11 vote after the handover). Any
     *         change bumps the key's epoch: untrusting lapses every record
     *         made with the key, and trusting it again does not revive them.
     * @dev The key must be a Baby Jubjub point other than the identity
     *      (canonical, non-zero coordinates): an off-curve "key" could never
     *      sign, and its forgery resistance is unproven.
     */
    function setTrustedAttestor(bytes32 circuitId, uint256 ax, uint256 ay, bool trusted) external onlyOwner {
        currentPolicy(circuitId); // reverts NotAttestationCircuit
        if (ax == 0 || ay == 0 || ax >= SNARK_SCALAR_FIELD || ay >= SNARK_SCALAR_FIELD || !_onBabyJubjub(ax, ay)) {
            revert InvalidAttestorKey();
        }
        bytes32 attestor = keccak256(abi.encode(ax, ay));
        if (trustedAttestor[circuitId][attestor] != trusted) {
            trustedAttestor[circuitId][attestor] = trusted;
            attestorEpoch[circuitId][attestor]++;
            if (trusted) trustedAttestorCount[circuitId]++;
            else trustedAttestorCount[circuitId]--;
        }
        emit TrustedAttestorSet(circuitId, attestor, msg.sender, ax, ay, trusted);
    }

    /// @dev a*x^2 + y^2 == 1 + d*x^2*y^2 over the BN254 scalar field, with
    ///      circomlib's Baby Jubjub constants a = 168700, d = 168696.
    function _onBabyJubjub(uint256 x, uint256 y) private pure returns (bool) {
        uint256 p = SNARK_SCALAR_FIELD;
        uint256 x2 = mulmod(x, x, p);
        uint256 y2 = mulmod(y, y, p);
        return addmod(mulmod(168700, x2, p), y2, p) == addmod(1, mulmod(168696, mulmod(x2, y2, p), p), p);
    }

    /// @dev Every policy change starts a new epoch (records lapse, the
    ///      nullifier reservations reset), even one that restores an earlier
    ///      policy.
    function _bumpPolicy(bytes32 circuitId) private {
        emit PolicyEpochBumped(circuitId, ++policyEpoch[circuitId]);
    }

    /// @notice Accreditation policy: attested amount >= minimum, in (0, 2^64).
    function setMinimumAccreditation(uint256 minimum) external onlyOwner {
        if (minimum == 0 || minimum > MAX_MASK) revert InvalidPolicy();
        emit AccreditationPolicyUpdated(minimumAccreditation, minimum);
        minimumAccreditation = minimum;
        _bumpPolicy(ACCREDITATION_ID);
    }

    /// @notice Compliance policy: minimum <= 100, weights sum to 100.
    function setCompliancePolicy(uint256 minimum, uint256 wK, uint256 wA, uint256 wJ, uint256 wAcc)
        external
        onlyOwner
    {
        if (minimum > 100 || wK > 100 || wA > 100 || wJ > 100 || wAcc > 100 || wK + wA + wJ + wAcc != 100) {
            revert InvalidPolicy();
        }
        compliancePolicy = CompliancePolicy({minimum: minimum, wK: wK, wA: wA, wJ: wJ, wAcc: wAcc});
        emit CompliancePolicyUpdated(minimum, wK, wA, wJ, wAcc);
        _bumpPolicy(COMPLIANCE_ID);
    }

    /**
     * @notice Take the jurisdiction policy from `token`'s ComplianceRules rule
     *         for it (owner; a type 11 vote after the handover). Starts a new
     *         jurisdiction epoch.
     * @dev The token must be a contract answering compliance(), and that
     *      ComplianceRules must answer jurisdictionRuleVersion (a pre-3.8 one
     *      is refused here, not at the first proof).
     */
    function setPolicyToken(address token) external onlyOwner {
        if (token.code.length == 0) revert InvalidPolicyToken();
        address rules = IPolicyToken(token).compliance();
        if (rules.code.length == 0) revert InvalidPolicyToken();
        IJurisdictionRuleSource(rules).jurisdictionRuleVersion(token);
        policyToken = token;
        emit PolicyTokenSet(token, rules);
        _bumpPolicy(JURISDICTION_ID);
    }

    /// @notice The ComplianceRules whose rule is the jurisdiction policy:
    ///         policyToken.compliance() now (0 while no policy token is set).
    function complianceRules() public view returns (address) {
        return policyToken == address(0) ? address(0) : IPolicyToken(policyToken).compliance();
    }

    /**
     * @notice Assign the next bit to an ISO 3166-1 numeric code so issuers
     *         can attest it (owner; a type 11 vote after the handover).
     *         Bits never move; at most 64 codes (the circuit's mask width).
     */
    function registerJurisdictionCode(uint256 isoCode) external onlyOwner {
        if (isoCode == 0 || isoCode > 999 || jurisdictionBit[isoCode] != 0) revert InvalidJurisdictionCode(isoCode);
        uint256 n = jurisdictionCodes.length;
        if (n == 64) revert JurisdictionCapacity();
        jurisdictionBit[isoCode] = 1 << n;
        jurisdictionCodes.push(isoCode);
        emit JurisdictionCodeRegistered(isoCode, 1 << n);
        _bumpPolicy(JURISDICTION_ID);
    }

    /// @dev The verdict `rules` applies to a holder of `isoCode` on
    ///      policyToken (default blocked list, then the token's rule).
    function _countryAllowed(IJurisdictionRuleSource rules, uint256 isoCode) private view returns (bool allowed) {
        (allowed, ) = rules.validateJurisdiction(policyToken, isoCode);
    }

    /// @dev complianceRules() as the view slice (zero while no token is set).
    function _source() private view returns (IJurisdictionRuleSource) {
        return IJurisdictionRuleSource(complianceRules());
    }

    /// @notice Jurisdiction policy: the OR of the bits of the registered codes
    ///         ComplianceRules allows on policyToken; 0 while no token is set.
    function allowedJurisdictionMask() public view returns (uint256 mask) {
        IJurisdictionRuleSource rules = _source();
        if (address(rules) == address(0)) return 0;
        uint256 n = jurisdictionCodes.length;
        for (uint256 i = 0; i < n; i++) {
            if (_countryAllowed(rules, jurisdictionCodes[i])) mask |= 1 << i;
        }
    }

    /**
     * @notice The policy signals a proof for `circuitId` must carry now, in
     *         signal order: [allowedMask], [minimumAccreditation] or
     *         [minimum, wK, wA, wJ, wAcc]. Reverts for any other circuit.
     */
    function currentPolicy(bytes32 circuitId) public view returns (uint256[] memory policy) {
        if (circuitId == JURISDICTION_ID) {
            policy = new uint256[](1);
            policy[0] = allowedJurisdictionMask();
        } else if (circuitId == ACCREDITATION_ID) {
            policy = new uint256[](1);
            policy[0] = minimumAccreditation;
        } else if (circuitId == COMPLIANCE_ID) {
            CompliancePolicy memory c = compliancePolicy;
            policy = new uint256[](5);
            (policy[0], policy[1], policy[2], policy[3], policy[4]) = (c.minimum, c.wK, c.wA, c.wJ, c.wAcc);
        } else {
            revert NotAttestationCircuit(circuitId);
        }
    }

    /// @notice The value a record must carry to be valid, and the key of
    ///         the nullifier reservation: keccak256(abi.encode(circuitId,
    ///         policyEpoch, currentPolicy(circuitId), rules, v)), with rules =
    ///         complianceRules() and v its jurisdictionRuleVersion(policyToken)
    ///         for the jurisdiction circuit (so a restored rule revives
    ///         nothing and a rule change frees the nullifier), else 0 and 0.
    function currentPolicyHash(bytes32 circuitId) public view returns (bytes32) {
        return _policyHash(circuitId, currentPolicy(circuitId));
    }

    function _policyHash(bytes32 circuitId, uint256[] memory policy) internal view returns (bytes32) {
        IJurisdictionRuleSource rules;
        uint256 version;
        if (circuitId == JURISDICTION_ID) {
            rules = _source();
            if (address(rules) != address(0)) version = rules.jurisdictionRuleVersion(policyToken);
        }
        return keccak256(abi.encode(circuitId, policyEpoch[circuitId], policy, rules, version));
    }

    /// @dev Jurisdiction and accreditation are set when non-zero; compliance
    ///      when its weights are (the setter makes them sum to 100).
    function _policySet(bytes32 circuitId, uint256[] memory policy) internal pure returns (bool) {
        if (circuitId == COMPLIANCE_ID) return policy[1] + policy[2] + policy[3] + policy[4] != 0;
        return policy[0] != 0;
    }

    /// @dev The record counts while its policy epoch and policy are
    ///      current, its attestor is still trusted for the circuit under the
    ///      same attestor epoch, and it has not expired.
    function _hasValidProof(address user, bytes32 circuitId) internal view returns (bool) {
        AttestationRecord storage r = attestationRecords[user][circuitId];
        return
            r.expiresAt != 0 &&
            block.timestamp < r.expiresAt &&
            r.policyEpoch == policyEpoch[circuitId] &&
            trustedAttestor[circuitId][r.attestor] &&
            r.attestorEpoch == attestorEpoch[circuitId][r.attestor] &&
            r.policyHash == currentPolicyHash(circuitId);
    }

    // ============ JURISDICTION VIEWS (over ComplianceRules) ============

    /// @notice Registered codes ComplianceRules allows on policyToken now,
    ///         with their bits.
    function getActiveJurisdictions() external view returns (uint256[] memory codes, uint256[] memory bits) {
        uint256 mask = allowedJurisdictionMask();
        uint256 n = jurisdictionCodes.length;
        uint256 count;
        for (uint256 i = 0; i < n; i++) {
            if (mask & (1 << i) != 0) count++;
        }
        codes = new uint256[](count);
        bits = new uint256[](count);
        uint256 j;
        for (uint256 i = 0; i < n; i++) {
            if (mask & (1 << i) != 0) {
                codes[j] = jurisdictionCodes[i];
                bits[j++] = 1 << i;
            }
        }
    }

    /// @notice Whether `isoCode` has a bit and ComplianceRules allows it now.
    function isJurisdictionActive(uint256 isoCode) external view returns (bool) {
        IJurisdictionRuleSource rules = _source();
        return jurisdictionBit[isoCode] != 0 && address(rules) != address(0) && _countryAllowed(rules, isoCode);
    }

    /// @notice Every registered code in bit order (codes[i] has bit 1 << i)
    ///         and whether ComplianceRules allows it now.
    function getAllJurisdictions() external view returns (uint256[] memory codes, bool[] memory allowed) {
        codes = jurisdictionCodes;
        allowed = new bool[](codes.length);
        IJurisdictionRuleSource rules = _source();
        if (address(rules) == address(0)) return (codes, allowed);
        for (uint256 i = 0; i < codes.length; i++) allowed[i] = _countryAllowed(rules, codes[i]);
    }
}
