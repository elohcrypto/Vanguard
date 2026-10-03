// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable2Step.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "./interfaces/IZKVerifier.sol";

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
 *      (allowed-jurisdiction mask from the jurisdiction registry, minimum
 *      accreditation, compliance weights and minimum). A wallet submits a
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

    struct JurisdictionInfo {
        string name;
        string code;
        uint256 mask;
        bool isActive;
        uint256 addedTimestamp;
    }

    /// @dev A wallet's whitelist status: valid while version is the current
    ///      whitelistVersion and block.timestamp < expiresAt.
    struct WhitelistBinding {
        uint256 version;
        uint256 nullifier;
        uint256 expiresAt;
    }

    /// @dev A wallet's attestation status for one circuit: valid while
    ///      policyHash is the circuit's current policy hash, the attestor key
    ///      is still trusted for the circuit and block.timestamp < expiresAt.
    struct AttestationRecord {
        bytes32 policyHash;
        bytes32 attestor;
        uint256 nullifier;
        uint256 expiresAt;
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

    // Jurisdiction management
    mapping(uint256 => JurisdictionInfo) public jurisdictions;
    mapping(string => uint256) public jurisdictionCodeToMask;
    uint256[] public activeJurisdictionMasks;
    uint256 public nextJurisdictionMask = 1;

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
    /// @notice Wallet holding each attestation nullifier, per circuit and
    ///         policy hash: one attestation binds one wallet per policy.
    mapping(bytes32 circuitId => mapping(bytes32 policyHash => mapping(uint256 nullifier => address)))
        public attestationNullifierWallet;

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

    // Events
    event AttestationProofBound(
        address indexed user,
        bytes32 indexed circuitId,
        uint256 indexed nullifier,
        bytes32 policyHash,
        uint256 expiresAt
    );
    event TrustedAttestorSet(bytes32 indexed circuitId, bytes32 indexed attestor, uint256 ax, uint256 ay, bool trusted);
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

    event JurisdictionAdded(uint256 indexed mask, string name, string code, uint256 timestamp);
    event JurisdictionRemoved(uint256 indexed mask, string name, string code, uint256 timestamp);
    event JurisdictionUpdated(uint256 indexed mask, string name, string code, bool isActive);

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

        // Initialize default jurisdictions
        _initializeDefaultJurisdictions();
    }

    /**
     * @dev Initialize default jurisdictions
     */
    function _initializeDefaultJurisdictions() private {
        // United States
        uint256 usMask = nextJurisdictionMask;
        nextJurisdictionMask *= 2;
        jurisdictions[usMask] = JurisdictionInfo({
            name: "United States",
            code: "US",
            mask: usMask,
            isActive: true,
            addedTimestamp: block.timestamp
        });
        jurisdictionCodeToMask["US"] = usMask;
        activeJurisdictionMasks.push(usMask);

        // European Union
        uint256 euMask = nextJurisdictionMask;
        nextJurisdictionMask *= 2;
        jurisdictions[euMask] = JurisdictionInfo({
            name: "European Union",
            code: "EU",
            mask: euMask,
            isActive: true,
            addedTimestamp: block.timestamp
        });
        jurisdictionCodeToMask["EU"] = euMask;
        activeJurisdictionMasks.push(euMask);

        // United Kingdom
        uint256 ukMask = nextJurisdictionMask;
        nextJurisdictionMask *= 2;
        jurisdictions[ukMask] = JurisdictionInfo({
            name: "United Kingdom",
            code: "UK",
            mask: ukMask,
            isActive: true,
            addedTimestamp: block.timestamp
        });
        jurisdictionCodeToMask["UK"] = ukMask;
        activeJurisdictionMasks.push(ukMask);

        // Canada
        uint256 caMask = nextJurisdictionMask;
        nextJurisdictionMask *= 2;
        jurisdictions[caMask] = JurisdictionInfo({
            name: "Canada",
            code: "CA",
            mask: caMask,
            isActive: true,
            addedTimestamp: block.timestamp
        });
        jurisdictionCodeToMask["CA"] = caMask;
        activeJurisdictionMasks.push(caMask);
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
     * @param signals [nullifier, Ax, Ay, policy..., walletBinding]: policy is
     *        [allowedMask], [minimumAccreditation] or [minimum, wK, wA, wJ, wAcc]
     * @dev Reverts unless: the circuit is one of the three (the whitelist has
     *      submitWhitelistProof; the blacklist is refused, D2); the signal
     *      count is the circuit's; (Ax, Ay) is a trusted issuer key for the
     *      circuit; the policy signals equal the current policy (which is
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
        uint256 n = policy.length + 4;
        if (signals.length != n) revert InvalidSignalCount(n, signals.length);
        bytes32 attestor = keccak256(abi.encode(signals[1], signals[2]));
        if (!trustedAttestor[circuitId][attestor]) revert UntrustedAttestor(circuitId, attestor);
        if (!_policySet(circuitId, policy)) revert PolicyNotSet(circuitId);
        for (uint256 i = 0; i < policy.length; i++) {
            if (signals[3 + i] != policy[i]) revert StalePolicy(circuitId);
        }
        if (signals[n - 1] != uint256(uint160(msg.sender))) revert WalletBindingMismatch();

        bytes32 policyHash = keccak256(abi.encode(circuitId, policy));
        uint256 nullifier = signals[0];
        address bound = attestationNullifierWallet[circuitId][policyHash][nullifier];
        if (bound != address(0) && bound != msg.sender) revert AttestationNullifierBound(bound);
        if (!zkVerifier.verifyCircuitProof(circuitId, proof, signals)) revert InvalidAttestationProof();

        if (bound == address(0)) attestationNullifierWallet[circuitId][policyHash][nullifier] = msg.sender;
        uint256 expiresAt = block.timestamp + proofValidityPeriod;
        attestationRecords[msg.sender][circuitId] = AttestationRecord({
            policyHash: policyHash,
            attestor: attestor,
            nullifier: nullifier,
            expiresAt: expiresAt
        });
        emit AttestationProofBound(msg.sender, circuitId, nullifier, policyHash, expiresAt);
    }

    /**
     * @notice Trust or untrust an issuer key (Ax, Ay) for one attestation
     *         circuit (owner; a type 11 vote after the handover). Untrusting
     *         lapses every record made with that key.
     */
    function setTrustedAttestor(bytes32 circuitId, uint256 ax, uint256 ay, bool trusted) external onlyOwner {
        currentPolicy(circuitId); // reverts NotAttestationCircuit
        if (ax == 0 || ay == 0 || ax >= SNARK_SCALAR_FIELD || ay >= SNARK_SCALAR_FIELD) revert InvalidAttestorKey();
        bytes32 attestor = keccak256(abi.encode(ax, ay));
        if (trustedAttestor[circuitId][attestor] != trusted) {
            trustedAttestor[circuitId][attestor] = trusted;
            if (trusted) trustedAttestorCount[circuitId]++;
            else trustedAttestorCount[circuitId]--;
        }
        emit TrustedAttestorSet(circuitId, attestor, ax, ay, trusted);
    }

    /// @notice Accreditation policy: attested amount >= minimum, in (0, 2^64).
    function setMinimumAccreditation(uint256 minimum) external onlyOwner {
        if (minimum == 0 || minimum > MAX_MASK) revert InvalidPolicy();
        emit AccreditationPolicyUpdated(minimumAccreditation, minimum);
        minimumAccreditation = minimum;
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
    }

    /// @notice Jurisdiction policy: the OR of the active jurisdictions' masks.
    function allowedJurisdictionMask() public view returns (uint256 mask) {
        uint256 count = activeJurisdictionMasks.length;
        for (uint256 i = 0; i < count; i++) mask |= activeJurisdictionMasks[i];
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

    /// @notice keccak256(abi.encode(circuitId, currentPolicy(circuitId))): the
    ///         value a record must carry to be valid.
    function currentPolicyHash(bytes32 circuitId) public view returns (bytes32) {
        return keccak256(abi.encode(circuitId, currentPolicy(circuitId)));
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

    /// @dev The record counts while its policy is current, its attestor is
    ///      still trusted for the circuit and it has not expired.
    function _hasValidProof(address user, bytes32 circuitId) internal view returns (bool) {
        AttestationRecord storage r = attestationRecords[user][circuitId];
        return
            r.expiresAt != 0 &&
            block.timestamp < r.expiresAt &&
            trustedAttestor[circuitId][r.attestor] &&
            r.policyHash == currentPolicyHash(circuitId);
    }

    // ============ JURISDICTION MANAGEMENT ============

    /**
     * @dev Add a new jurisdiction to the whitelist
     * @param name Jurisdiction name (e.g., "United States")
     * @param code Jurisdiction code (e.g., "US")
     */
    function addJurisdiction(string memory name, string memory code) external onlyOwner {
        require(bytes(name).length > 0, "PrivacyManager: Name cannot be empty");
        require(bytes(code).length > 0, "PrivacyManager: Code cannot be empty");
        require(jurisdictionCodeToMask[code] == 0, "PrivacyManager: Jurisdiction already exists");

        uint256 mask = nextJurisdictionMask;
        // The jurisdiction circuit carries masks in 64 bits.
        if (mask > MAX_MASK) revert JurisdictionCapacity();
        nextJurisdictionMask = nextJurisdictionMask * 2; // Binary shift for unique masks

        jurisdictions[mask] = JurisdictionInfo({
            name: name,
            code: code,
            mask: mask,
            isActive: true,
            addedTimestamp: block.timestamp
        });

        jurisdictionCodeToMask[code] = mask;
        activeJurisdictionMasks.push(mask);

        emit JurisdictionAdded(mask, name, code, block.timestamp);
    }

    /**
     * @dev Remove a jurisdiction from the whitelist
     * @param code Jurisdiction code to remove
     */
    function removeJurisdiction(string memory code) external onlyOwner {
        uint256 mask = jurisdictionCodeToMask[code];
        require(mask != 0, "PrivacyManager: Jurisdiction not found");

        JurisdictionInfo storage jurisdiction = jurisdictions[mask];
        require(jurisdiction.isActive, "PrivacyManager: Jurisdiction already inactive");

        jurisdiction.isActive = false;

        // Remove from active list
        for (uint256 i = 0; i < activeJurisdictionMasks.length; i++) {
            if (activeJurisdictionMasks[i] == mask) {
                activeJurisdictionMasks[i] = activeJurisdictionMasks[activeJurisdictionMasks.length - 1];
                activeJurisdictionMasks.pop();
                break;
            }
        }

        emit JurisdictionRemoved(mask, jurisdiction.name, code, block.timestamp);
    }

    /**
     * @dev Update jurisdiction status
     * @param code Jurisdiction code
     * @param isActive New active status
     */
    function updateJurisdictionStatus(string memory code, bool isActive) external onlyOwner {
        uint256 mask = jurisdictionCodeToMask[code];
        require(mask != 0, "PrivacyManager: Jurisdiction not found");

        JurisdictionInfo storage jurisdiction = jurisdictions[mask];
        require(jurisdiction.isActive != isActive, "PrivacyManager: Status already set");

        jurisdiction.isActive = isActive;

        if (isActive) {
            // Add back to active list
            activeJurisdictionMasks.push(mask);
        } else {
            // Remove from active list
            for (uint256 i = 0; i < activeJurisdictionMasks.length; i++) {
                if (activeJurisdictionMasks[i] == mask) {
                    activeJurisdictionMasks[i] = activeJurisdictionMasks[activeJurisdictionMasks.length - 1];
                    activeJurisdictionMasks.pop();
                    break;
                }
            }
        }

        emit JurisdictionUpdated(mask, jurisdiction.name, code, isActive);
    }

    /**
     * @dev Get all active jurisdictions
     * @return masks Array of active jurisdiction masks
     * @return names Array of jurisdiction names
     * @return codes Array of jurisdiction codes
     */
    function getActiveJurisdictions() external view returns (
        uint256[] memory masks,
        string[] memory names,
        string[] memory codes
    ) {
        uint256 activeCount = activeJurisdictionMasks.length;
        masks = new uint256[](activeCount);
        names = new string[](activeCount);
        codes = new string[](activeCount);

        for (uint256 i = 0; i < activeCount; i++) {
            uint256 mask = activeJurisdictionMasks[i];
            JurisdictionInfo storage jurisdiction = jurisdictions[mask];
            masks[i] = mask;
            names[i] = jurisdiction.name;
            codes[i] = jurisdiction.code;
        }
    }

    /**
     * @dev Get jurisdiction info by code
     * @param code Jurisdiction code
     * @return info Jurisdiction information
     */
    function getJurisdictionByCode(string memory code) external view returns (JurisdictionInfo memory info) {
        uint256 mask = jurisdictionCodeToMask[code];
        require(mask != 0, "PrivacyManager: Jurisdiction not found");
        return jurisdictions[mask];
    }

    /**
     * @dev Check if jurisdiction is active
     * @param code Jurisdiction code
     * @return True if jurisdiction is active
     */
    function isJurisdictionActive(string memory code) external view returns (bool) {
        uint256 mask = jurisdictionCodeToMask[code];
        if (mask == 0) return false;
        return jurisdictions[mask].isActive;
    }

    /**
     * @dev Get all active jurisdictions (alias for getActiveJurisdictions)
     * @return masks Array of active jurisdiction masks
     * @return names Array of jurisdiction names
     * @return codes Array of jurisdiction codes
     */
    function getAllJurisdictions() external view returns (
        uint256[] memory masks,
        string[] memory names,
        string[] memory codes
    ) {
        return this.getActiveJurisdictions();
    }
}
