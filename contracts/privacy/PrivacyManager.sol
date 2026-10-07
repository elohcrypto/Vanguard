// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "./interfaces/IZKVerifier.sol";
import "./PrivacyAttestationPolicy.sol";

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
 *      attested bit must never move. An attestation is signed for one chain,
 *      one PrivacyManager and an expiry (public chainId, verifierContext and
 *      validUntil signals, Task 3.10). A wallet submits a PLONK proof of the
 *      signature and the policy; it is recorded for the wallet named in the
 *      binding, one wallet per attestation per policy, and lapses on a policy
 *      change, an attestor revocation or expiry (never after validUntil).
 */
contract PrivacyManager is PrivacyAttestationPolicy, ReentrancyGuard {
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


    // Storage
    mapping(address => PrivacySettings) public userPrivacySettings;

    PrivacySettings public defaultPrivacySettings;
    uint256 public constant DEFAULT_PROOF_VALIDITY = 24 hours;

    // Whitelist root registry and binder
    uint256 public constant MIN_PROOF_VALIDITY = 1 days;
    uint256 public constant MAX_PROOF_VALIDITY = 365 days;

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

    // Events
    event AttestationProofBound(
        address indexed user,
        bytes32 indexed circuitId,
        uint256 indexed nullifier,
        bytes32 policyHash,
        uint256 expiresAt
    );

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
     * @param signals [nullifier, Ax, Ay, chainId, verifierContext,
     *        validUntil, policy..., walletBinding]: policy is [allowedMask],
     *        [minimumAccreditation] or [minimum, wK, wA, wJ, wAcc]
     * @dev Reverts unless: the circuit is one of the three (the whitelist has
     *      submitWhitelistProof; the blacklist is refused, D2); the signal
     *      count is the circuit's; (Ax, Ay) is a trusted issuer key for it;
     *      chainId is block.chainid and verifierContext this contract (review
     *      3.8 M1); now < validUntil, the expiry the issuer signed (3.10); the
     *      policy signals equal the current, set policy; walletBinding ==
     *      uint160(msg.sender); the nullifier is unbound under this policy or
     *      bound to the caller; the proof verifies through the wrapper (which
     *      refuses non-canonical signals). Only the record is stored; it
     *      expires at min(now + proofValidityPeriod, validUntil), never after
     *      the attestation. Resubmitting refreshes it within that cap.
     */
    function submitAttestationProof(
        bytes32 circuitId,
        uint256[24] calldata proof,
        uint256[] calldata signals
    ) external nonReentrant {
        if (circuitId == BLACKLIST_ID) revert NonGatingBlacklistProof();
        uint256[] memory policy = currentPolicy(circuitId);
        uint256 n = policy.length + 7;
        if (signals.length != n) revert InvalidSignalCount(n, signals.length);
        bytes32 attestor = keccak256(abi.encode(signals[1], signals[2]));
        if (!trustedAttestor[circuitId][attestor]) revert UntrustedAttestor(circuitId, attestor);
        if (!_policySet(circuitId, policy)) revert PolicyNotSet(circuitId);
        if (signals[3] != block.chainid) revert WrongChainId(signals[3]);
        if (signals[4] != uint256(uint160(address(this)))) revert WrongVerifierContext(signals[4]);
        // >= 2^64 is never a signed expiry (a +q alias if the wrapper changes).
        if (signals[5] >= 1 << 64 || block.timestamp >= signals[5]) revert AttestationExpired(signals[5]);
        for (uint256 i = 0; i < policy.length; i++) {
            if (signals[6 + i] != policy[i]) revert StalePolicy(circuitId);
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
        if (signals[5] < expiresAt) expiresAt = signals[5];
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
}
