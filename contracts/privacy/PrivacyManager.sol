// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable2Step.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "./interfaces/IZKVerifier.sol";

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
 * @title PrivacyManager
 * @dev Whitelist root registry and wallet binder for the PLONK whitelist
 *      proof, plus the attestation binder of the three attestation circuits.
 *
 *      Whitelist (plan Task 3.3, D29/D30, R-3R-7/R-3R-10): the list operator
 *      (or the owner) publishes ONE current Merkle root of commitments; a
 *      wallet submits a proof whose signals are [nullifier, root, binding];
 *      it counts only against the current root, only for the wallet named in
 *      the binding (msg.sender), and one nullifier binds one wallet. Status
 *      lapses when the root rotates or when the binding's frozen expiry
 *      passes. `hasValidWhitelistProof` is the view a compliance gate reads.
 *
 *      Attestations (plan Task 3.7b, D31 a): a trusted issuer signs the
 *      investor's attribute message off chain with an EdDSA Baby Jubjub key;
 *      this contract holds the trusted issuer keys per circuit and the policy
 *      (allowed-jurisdiction mask, minimum accreditation, compliance weights
 *      and minimum).
 *
 *      Jurisdictions (plan Task 3.8, one source): the allowed set is the one
 *      the policy token's ComplianceRules (`policyToken.compliance()`, read
 *      on every use, so a Token vote moving it is followed) enforces for the
 *      token (its validateJurisdiction verdict); this contract only keeps the
 *      append-only ISO-code-to-bit assignment issuers attest, because an
 *      attested bit must never move. An attestation is signed for one chain
 *      and one PrivacyManager (public chainId and verifierContext signals). A wallet submits a
 *      PLONK proof of the signature and the policy; it is recorded for the
 *      wallet named in the binding, one wallet per attestation per policy,
 *      and lapses on a policy change, an attestor revocation or expiry.
 */
contract PrivacyManager is Ownable2Step, ReentrancyGuard {
    IZKVerifier public zkVerifier;

    /// @dev User preference data. proofValidityPeriod here is kept for the
    ///      settings ABI only: validity is the owner's proofValidityPeriod.
    struct PrivacySettings {
        bool enablePrivateWhitelist;
        bool enablePrivateJurisdiction;
        bool enablePrivateAccreditation;
        bool enablePrivateCompliance;
        uint256 proofValidityPeriod;
    }

    /// @dev A wallet's whitelist status: valid while version is the current
    ///      whitelistVersion and block.timestamp < expiresAt.
    struct WhitelistBinding {
        uint256 version;
        uint256 nullifier;
        uint256 expiresAt;
    }

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

    // Storage
    mapping(address => PrivacySettings) public userPrivacySettings;

    PrivacySettings public defaultPrivacySettings;
    uint256 public constant DEFAULT_PROOF_VALIDITY = 24 hours;

    // Whitelist root registry and binder
    bytes32 private constant WHITELIST_ID = keccak256("WHITELIST_MEMBERSHIP");
    bytes32 private constant BLACKLIST_ID = keccak256("BLACKLIST_MEMBERSHIP");
    bytes32 private constant JURISDICTION_ID = keccak256("JURISDICTION_PROOF");
    bytes32 private constant ACCREDITATION_ID = keccak256("ACCREDITATION_PROOF");
    bytes32 private constant COMPLIANCE_ID = keccak256("COMPLIANCE_AGGREGATION");
    /// @dev The circuits range-check masks and the accreditation minimum to
    ///      64 bits, and compliance values to 7 bits.
    uint256 private constant MAX_MASK = type(uint64).max;
    uint256 public constant MIN_PROOF_VALIDITY = 1 days;
    uint256 public constant MAX_PROOF_VALIDITY = 365 days;
    uint256 internal constant SNARK_SCALAR_FIELD =
        21888242871839275222246405745257275088548364400416034343698204186575808495617;

    bytes32 public whitelistRoot;
    uint256 public whitelistVersion;
    address public listOperator;
    /// @notice Validity granted to a binding at submission (frozen per binding).
    uint256 public proofValidityPeriod = 30 days;
    mapping(address => WhitelistBinding) public whitelistBindings;
    /// @notice Wallet holding each nullifier, per root version: one commitment
    ///         holds at most one live wallet per version, and a new version
    ///         (rotation or a republish of the same root) frees it.
    mapping(uint256 version => mapping(uint256 nullifier => address)) public nullifierWallet;

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

    // Errors
    error NotListOperator();
    error InvalidWhitelistRoot();
    error RootNotCurrent();
    error WalletBindingMismatch();
    error NullifierBoundToOtherWallet(address wallet, uint256 version);
    error InvalidWhitelistProof();
    error InvalidValidityPeriod();
    error TestingModeVerifier();
    error RenounceDisabled();
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

    // Events
    event AttestationProofBound(
        address indexed user,
        bytes32 indexed circuitId,
        uint256 indexed nullifier,
        bytes32 policyHash,
        uint256 expiresAt
    );
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

    event PrivacySettingsUpdated(
        address indexed user,
        bool enablePrivateWhitelist,
        bool enablePrivateJurisdiction,
        bool enablePrivateAccreditation,
        bool enablePrivateCompliance
    );

    event PrivateComplianceValidated(address indexed user, bytes32 indexed proofType, bool result);

    event WhitelistRootPublished(bytes32 indexed root, uint256 indexed version, address indexed publisher);
    event WhitelistProofBound(address indexed wallet, uint256 indexed nullifier, uint256 version, uint256 expiresAt);
    event ListOperatorUpdated(address indexed previousOperator, address indexed newOperator);
    event ProofValidityPeriodUpdated(uint256 previousPeriod, uint256 newPeriod);
    event ZKVerifierUpdated(address indexed previousVerifier, address indexed newVerifier);

    event PolicyTokenSet(address indexed policyToken, address complianceRules);
    event JurisdictionCodeRegistered(uint256 indexed isoCode, uint256 bit);

    /// @param _zkVerifier ZKVerifierIntegrated; a testingMode instance is refused.
    constructor(address _zkVerifier) Ownable(msg.sender) {
        _setZKVerifier(_zkVerifier);

        // Set default privacy settings
        defaultPrivacySettings = PrivacySettings({
            enablePrivateWhitelist: true,
            enablePrivateJurisdiction: true,
            enablePrivateAccreditation: true,
            enablePrivateCompliance: true,
            proofValidityPeriod: DEFAULT_PROOF_VALIDITY
        });

    }

    // ============ WHITELIST ROOT REGISTRY AND BINDER ============

    /**
     * @notice Publish the single current whitelist root (a Merkle root of
     *         commitments). Bumps whitelistVersion, which lapses every
     *         existing binding: holders re-prove under the new root.
     * @dev listOperator or owner. A root >= the scalar field could never
     *      match a canonical signal, so it is refused, as is 0.
     */
    function publishWhitelistRoot(bytes32 root) external {
        if (msg.sender != listOperator && msg.sender != owner()) revert NotListOperator();
        if (root == bytes32(0) || uint256(root) >= SNARK_SCALAR_FIELD) revert InvalidWhitelistRoot();
        whitelistRoot = root;
        uint256 version = ++whitelistVersion;
        emit WhitelistRootPublished(root, version, msg.sender);
    }

    /**
     * @notice Bind the caller's wallet to a whitelist proof.
     * @param proof 24-word PLONK proof
     * @param signals [nullifier, merkleRoot, walletBinding]
     * @dev Reverts unless: merkleRoot is the current published root;
     *      walletBinding == uint160(msg.sender) (rejects 0 and any alias);
     *      the nullifier is unbound under the current root version or
     *      bound to the caller; the proof verifies through the wrapper, which
     *      refuses non-canonical signals (so the nullifier map is keyed on
     *      the canonical value). A failing proof records nothing.
     *      Resubmitting under the same version refreshes the caller's own
     *      binding and its expiry: expiry alone does not revoke, rotating
     *      the root does. The reservation is per version, so after any new
     *      version (A -> B -> A, or the same root republished) a holder who
     *      lost a wallet can bind another one.
     */
    function submitWhitelistProof(
        uint256[24] calldata proof,
        uint256[3] calldata signals
    ) external nonReentrant {
        bytes32 root = whitelistRoot;
        if (root == bytes32(0) || bytes32(signals[1]) != root) revert RootNotCurrent();
        if (signals[2] != uint256(uint160(msg.sender))) revert WalletBindingMismatch();
        uint256 nullifier = signals[0];
        uint256 version = whitelistVersion;
        address bound = nullifierWallet[version][nullifier];
        if (bound != address(0) && bound != msg.sender) revert NullifierBoundToOtherWallet(bound, version);
        if (!zkVerifier.verifyWhitelistMembership(proof, signals)) revert InvalidWhitelistProof();

        if (bound == address(0)) nullifierWallet[version][nullifier] = msg.sender;
        uint256 expiresAt = block.timestamp + proofValidityPeriod;
        whitelistBindings[msg.sender] = WhitelistBinding({
            version: version,
            nullifier: nullifier,
            expiresAt: expiresAt
        });
        emit WhitelistProofBound(msg.sender, nullifier, version, expiresAt);
    }

    /**
     * @notice True while `user` holds a binding made under the current root
     *         version that has not expired.
     */
    function hasValidWhitelistProof(address user) public view returns (bool) {
        WhitelistBinding storage b = whitelistBindings[user];
        return b.version != 0 && b.version == whitelistVersion && block.timestamp < b.expiresAt;
    }

    /// @notice Set the key that publishes roots (ops after the handover); 0 disables it.
    function setListOperator(address operator) external onlyOwner {
        emit ListOperatorUpdated(listOperator, operator);
        listOperator = operator;
    }

    /// @notice Validity given to bindings made from now on, in [1 day, 365 days].
    function setProofValidityPeriod(uint256 period) external onlyOwner {
        if (period < MIN_PROOF_VALIDITY || period > MAX_PROOF_VALIDITY) revert InvalidValidityPeriod();
        emit ProofValidityPeriodUpdated(proofValidityPeriod, period);
        proofValidityPeriod = period;
    }

    /// @notice Replace the verifier wrapper; a testingMode instance is refused.
    function setZKVerifier(address _zkVerifier) external onlyOwner {
        _setZKVerifier(_zkVerifier);
    }

    function _setZKVerifier(address _zkVerifier) private {
        require(_zkVerifier.code.length > 0, "PrivacyManager: ZK verifier is not a contract");
        // Fails closed: a verifier without testingMode() is refused too.
        bool testing = true;
        try IZKVerifier(_zkVerifier).testingMode() returns (bool t) {
            testing = t;
        } catch {}
        if (testing) revert TestingModeVerifier();
        emit ZKVerifierUpdated(address(zkVerifier), _zkVerifier);
        zkVerifier = IZKVerifier(_zkVerifier);
    }

    /// @notice Disabled: this contract is handed to governance, never orphaned.
    function renounceOwnership() public pure override {
        revert RenounceDisabled();
    }

    // ============ ATTESTATION PROOFS (Task 3.7b, D31 a) ============

    /**
     * @notice Record the caller's attestation proof for one circuit.
     * @param circuitId JURISDICTION_PROOF, ACCREDITATION_PROOF or
     *        COMPLIANCE_AGGREGATION (keccak256 of the name)
     * @param proof 24-word PLONK proof
     * @param signals [nullifier, Ax, Ay, chainId, verifierContext, policy...,
     *        walletBinding]: policy is [allowedMask], [minimumAccreditation]
     *        or [minimum, wK, wA, wJ, wAcc]
     * @dev Reverts unless: the circuit is one of the three (the whitelist has
     *      submitWhitelistProof; the blacklist is refused, D2); the signal
     *      count is the circuit's; (Ax, Ay) is a trusted issuer key for the
     *      circuit; chainId is block.chainid and verifierContext this
     *      contract (the issuer signed for this deployment, review 3.8 M1);
     *      the policy signals equal the current policy (which is
     *      set); walletBinding == uint160(msg.sender); the nullifier is
     *      unbound under this policy or bound to the caller; the proof
     *      verifies through the wrapper (which refuses non-canonical signals).
     *      A failing proof records nothing. Only the record is stored, not the
     *      proof. Resubmitting refreshes the caller's record and its expiry.
     */
    function submitAttestationProof(
        bytes32 circuitId,
        uint256[24] calldata proof,
        uint256[] calldata signals
    ) external nonReentrant {
        if (circuitId == BLACKLIST_ID) revert NonGatingBlacklistProof();
        uint256[] memory policy = currentPolicy(circuitId);
        uint256 n = policy.length + 6;
        if (signals.length != n) revert InvalidSignalCount(n, signals.length);
        bytes32 attestor = keccak256(abi.encode(signals[1], signals[2]));
        if (!trustedAttestor[circuitId][attestor]) revert UntrustedAttestor(circuitId, attestor);
        if (!_policySet(circuitId, policy)) revert PolicyNotSet(circuitId);
        if (signals[3] != block.chainid) revert WrongChainId(signals[3]);
        if (signals[4] != uint256(uint160(address(this)))) revert WrongVerifierContext(signals[4]);
        for (uint256 i = 0; i < policy.length; i++) {
            if (signals[5 + i] != policy[i]) revert StalePolicy(circuitId);
        }
        if (signals[n - 1] != uint256(uint160(msg.sender))) revert WalletBindingMismatch();

        bytes32 policyHash = _policyHash(circuitId, policy);
        uint256 epoch = policyEpoch[circuitId];
        uint256 nullifier = signals[0];
        address bound = attestationNullifierWallet[policyHash][nullifier];
        if (bound != address(0) && bound != msg.sender) revert AttestationNullifierBound(bound);
        if (!zkVerifier.verifyCircuitProof(circuitId, proof, signals)) revert InvalidAttestationProof();

        if (bound == address(0)) attestationNullifierWallet[policyHash][nullifier] = msg.sender;
        uint256 expiresAt = block.timestamp + proofValidityPeriod;
        attestationRecords[msg.sender][circuitId] = AttestationRecord({
            policyHash: policyHash,
            attestor: attestor,
            nullifier: nullifier,
            expiresAt: expiresAt,
            policyEpoch: epoch,
            attestorEpoch: attestorEpoch[circuitId][attestor]
        });
        emit AttestationProofBound(msg.sender, circuitId, nullifier, policyHash, expiresAt);
    }

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

    function _policyHash(bytes32 circuitId, uint256[] memory policy) private view returns (bytes32) {
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
    function _policySet(bytes32 circuitId, uint256[] memory policy) private pure returns (bool) {
        if (circuitId == COMPLIANCE_ID) return policy[1] + policy[2] + policy[3] + policy[4] != 0;
        return policy[0] != 0;
    }

    /// @notice Whether `user` holds a valid jurisdiction attestation and has
    ///         not opted out of private jurisdiction checks.
    function validatePrivateJurisdiction(address user) external returns (bool) {
        return _validate(user, JURISDICTION_ID, _getUserPrivacySettings(user).enablePrivateJurisdiction);
    }

    /// @notice Same for the accreditation attestation.
    function validatePrivateAccreditation(address user) external returns (bool) {
        return _validate(user, ACCREDITATION_ID, _getUserPrivacySettings(user).enablePrivateAccreditation);
    }

    /// @notice Same for the compliance-aggregation attestation.
    function validatePrivateCompliance(address user) external returns (bool) {
        return _validate(user, COMPLIANCE_ID, _getUserPrivacySettings(user).enablePrivateCompliance);
    }

    function _validate(address user, bytes32 circuitId, bool enabled) private returns (bool result) {
        result = enabled && _hasValidProof(user, circuitId);
        emit PrivateComplianceValidated(user, circuitId, result);
    }

    /**
     * @dev Comprehensive private compliance validation. The whitelist entry
     *      is hasValidWhitelistProof (not a user preference); the other three
     *      are the attestation records under the user's preference flags.
     * @param user User address
     * @return whitelistValid True if the user holds a valid whitelist binding
     * @return jurisdictionValid True if jurisdiction proof is valid
     * @return accreditationValid True if accreditation proof is valid
     * @return complianceValid True if compliance proof is valid
     */
    function validateAllPrivateCompliance(
        address user
    )
        external
        view
        returns (bool whitelistValid, bool jurisdictionValid, bool accreditationValid, bool complianceValid)
    {
        PrivacySettings memory settings = _getUserPrivacySettings(user);
        whitelistValid = hasValidWhitelistProof(user);
        jurisdictionValid = settings.enablePrivateJurisdiction && _hasValidProof(user, JURISDICTION_ID);
        accreditationValid = settings.enablePrivateAccreditation && _hasValidProof(user, ACCREDITATION_ID);
        complianceValid = settings.enablePrivateCompliance && _hasValidProof(user, COMPLIANCE_ID);
    }

    /**
     * @dev Set user privacy settings (preference data; never changes validity)
     * @param settings Privacy settings for the user
     */
    function setUserPrivacySettings(PrivacySettings memory settings) external {
        require(
            settings.proofValidityPeriod >= 1 hours && settings.proofValidityPeriod <= 30 days,
            "PrivacyManager: Invalid proof validity period"
        );

        userPrivacySettings[msg.sender] = settings;

        emit PrivacySettingsUpdated(
            msg.sender,
            settings.enablePrivateWhitelist,
            settings.enablePrivateJurisdiction,
            settings.enablePrivateAccreditation,
            settings.enablePrivateCompliance
        );
    }

    /**
     * @dev Get user's privacy settings
     * @param user User address
     * @return Privacy settings for the user
     */
    function getUserPrivacySettings(address user) external view returns (PrivacySettings memory) {
        return _getUserPrivacySettings(user);
    }

    /**
     * @notice A wallet's attestation status for one circuit.
     * @return expiresAt Expiry of the latest record (0 if none)
     * @return isValid True if the record counts now (current policy, trusted
     *         attestor, not expired); preference flags not applied
     * @return isExpired True if there is no record or it has expired
     */
    function getUserProofInfo(
        address user,
        bytes32 circuitId
    ) external view returns (uint256 expiresAt, bool isValid, bool isExpired) {
        expiresAt = attestationRecords[user][circuitId].expiresAt;
        isValid = _hasValidProof(user, circuitId);
        isExpired = expiresAt == 0 || block.timestamp >= expiresAt;
    }

    /**
     * @dev Get user privacy settings with fallback to default
     * @param user User address
     * @return Privacy settings
     */
    function _getUserPrivacySettings(address user) internal view returns (PrivacySettings memory) {
        PrivacySettings storage userSettings = userPrivacySettings[user];

        // If user hasn't set custom settings, use defaults
        if (userSettings.proofValidityPeriod == 0) {
            return defaultPrivacySettings;
        }

        return userSettings;
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
