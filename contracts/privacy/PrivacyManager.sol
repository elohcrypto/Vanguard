// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable2Step.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "./interfaces/IZKVerifier.sol";

/**
 * @title PrivacyManager
 * @dev Whitelist root registry and wallet binder for the PLONK whitelist
 *      proof, plus the private-proof store of the four Groth16 circuits.
 *
 *      Whitelist (plan Task 3.3, D29/D30, R-3R-7/R-3R-10): the list operator
 *      (or the owner) publishes ONE current Merkle root of commitments; a
 *      wallet submits a proof whose signals are [nullifier, root, binding];
 *      it counts only against the current root, only for the wallet named in
 *      the binding (msg.sender), and one nullifier binds one wallet. Status
 *      lapses when the root rotates or when the binding's frozen expiry
 *      passes. `hasValidWhitelistProof` is the view a compliance gate reads.
 */
contract PrivacyManager is Ownable2Step, ReentrancyGuard {
    IZKVerifier public zkVerifier;

    struct PrivateComplianceProof {
        IZKVerifier.Proof zkProof;
        bytes32 circuitId;
        uint256[] publicInputs;
        uint256 timestamp;
        bool isValid;
    }

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

    // Storage
    mapping(address => mapping(bytes32 => PrivateComplianceProof)) private userProofs;
    mapping(address => PrivacySettings) public userPrivacySettings;
    mapping(bytes32 => uint256) public circuitMinimumInputs;

    PrivacySettings public defaultPrivacySettings;
    uint256 public constant DEFAULT_PROOF_VALIDITY = 24 hours;

    // Whitelist root registry and binder
    bytes32 private constant WHITELIST_ID = keccak256("WHITELIST_MEMBERSHIP");
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
    mapping(uint256 => address) public nullifierWallet;

    // Jurisdiction management
    mapping(uint256 => JurisdictionInfo) public jurisdictions;
    mapping(string => uint256) public jurisdictionCodeToMask;
    uint256[] public activeJurisdictionMasks;
    uint256 public nextJurisdictionMask = 1;

    // Errors
    error NotListOperator();
    error InvalidWhitelistRoot();
    error RootNotCurrent();
    error WalletBindingMismatch();
    error NullifierBoundToOtherWallet(address wallet);
    error InvalidWhitelistProof();
    error InvalidValidityPeriod();
    error TestingModeVerifier();
    error RenounceDisabled();

    // Events
    event PrivateProofSubmitted(address indexed user, bytes32 indexed circuitId, uint256 timestamp, bool isValid);

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

    modifier validCircuit(bytes32 circuitId) {
        require(zkVerifier.isCircuitRegistered(circuitId), "PrivacyManager: Invalid circuit");
        _;
    }

    modifier validProof(address user, bytes32 circuitId) {
        PrivateComplianceProof storage proof = userProofs[user][circuitId];
        require(proof.timestamp > 0, "PrivacyManager: No proof found");
        require(block.timestamp <= proof.timestamp + proofValidityPeriod, "PrivacyManager: Proof expired");
        require(proof.isValid, "PrivacyManager: Invalid proof");
        _;
    }

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

        // Minimum inputs of the Groth16 circuits submitPrivateProof serves
        circuitMinimumInputs[keccak256("JURISDICTION_PROOF")] = 1;
        circuitMinimumInputs[keccak256("ACCREDITATION_PROOF")] = 1;
        circuitMinimumInputs[keccak256("COMPLIANCE_AGGREGATION")] = 1;

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
     *      the nullifier is unbound or bound to the caller; the proof
     *      verifies through the wrapper, which refuses non-canonical signals
     *      (so the nullifier map is keyed on the canonical value). A failing
     *      proof records nothing. Resubmitting under the same root refreshes
     *      the caller's own binding.
     */
    function submitWhitelistProof(
        uint256[24] calldata proof,
        uint256[3] calldata signals
    ) external nonReentrant {
        bytes32 root = whitelistRoot;
        if (root == bytes32(0) || bytes32(signals[1]) != root) revert RootNotCurrent();
        if (signals[2] != uint256(uint160(msg.sender))) revert WalletBindingMismatch();
        uint256 nullifier = signals[0];
        address bound = nullifierWallet[nullifier];
        if (bound != address(0) && bound != msg.sender) revert NullifierBoundToOtherWallet(bound);
        if (!zkVerifier.verifyWhitelistMembership(proof, signals)) revert InvalidWhitelistProof();

        if (bound == address(0)) nullifierWallet[nullifier] = msg.sender;
        uint256 version = whitelistVersion;
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

    // ============ GROTH16 PRIVATE PROOFS ============

    /**
     * @dev Submit a private compliance proof for one of the four Groth16
     *      circuits (blacklist, jurisdiction, accreditation, compliance). The
     *      whitelist circuit goes through submitWhitelistProof.
     * @param circuitId Circuit identifier for the proof type
     * @param proof Zero-knowledge proof
     * @param publicInputs Public inputs for the proof
     * @return True if proof is valid and stored
     */
    function submitPrivateProof(
        bytes32 circuitId,
        IZKVerifier.Proof memory proof,
        uint256[] memory publicInputs
    ) external validCircuit(circuitId) nonReentrant returns (bool) {
        require(circuitId != WHITELIST_ID, "PrivacyManager: use submitWhitelistProof");
        require(publicInputs.length >= circuitMinimumInputs[circuitId], "PrivacyManager: Insufficient public inputs");

        // Verify the proof
        bool isValid = zkVerifier.verifyCircuitProof(circuitId, proof, publicInputs);

        // Store the proof
        userProofs[msg.sender][circuitId] = PrivateComplianceProof({
            zkProof: proof,
            circuitId: circuitId,
            publicInputs: publicInputs,
            timestamp: block.timestamp,
            isValid: isValid
        });

        emit PrivateProofSubmitted(msg.sender, circuitId, block.timestamp, isValid);
        return isValid;
    }

    /**
     * @dev Validate private jurisdiction eligibility
     * @param user User address
     * @return True if user has valid private jurisdiction proof
     */
    function validatePrivateJurisdiction(
        address user
    ) external validProof(user, keccak256("JURISDICTION_PROOF")) returns (bool) {
        PrivacySettings memory settings = _getUserPrivacySettings(user);
        if (!settings.enablePrivateJurisdiction) {
            return false;
        }

        emit PrivateComplianceValidated(user, keccak256("JURISDICTION_PROOF"), true);
        return true;
    }

    /**
     * @dev Validate private accreditation status
     * @param user User address
     * @return True if user has valid private accreditation proof
     */
    function validatePrivateAccreditation(
        address user
    ) external validProof(user, keccak256("ACCREDITATION_PROOF")) returns (bool) {
        PrivacySettings memory settings = _getUserPrivacySettings(user);
        if (!settings.enablePrivateAccreditation) {
            return false;
        }

        emit PrivateComplianceValidated(user, keccak256("ACCREDITATION_PROOF"), true);
        return true;
    }

    /**
     * @dev Validate private compliance aggregation
     * @param user User address
     * @return True if user has valid private compliance proof
     */
    function validatePrivateCompliance(
        address user
    ) external validProof(user, keccak256("COMPLIANCE_AGGREGATION")) returns (bool) {
        PrivacySettings memory settings = _getUserPrivacySettings(user);
        if (!settings.enablePrivateCompliance) {
            return false;
        }

        emit PrivateComplianceValidated(user, keccak256("COMPLIANCE_AGGREGATION"), true);
        return true;
    }

    /**
     * @dev Comprehensive private compliance validation. The whitelist entry
     *      is hasValidWhitelistProof (not a user preference).
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

        // Check jurisdiction eligibility
        if (settings.enablePrivateJurisdiction && _hasValidProof(user, keccak256("JURISDICTION_PROOF"))) {
            jurisdictionValid = true;
        }

        // Check accreditation status
        if (settings.enablePrivateAccreditation && _hasValidProof(user, keccak256("ACCREDITATION_PROOF"))) {
            accreditationValid = true;
        }

        // Check compliance aggregation
        if (settings.enablePrivateCompliance && _hasValidProof(user, keccak256("COMPLIANCE_AGGREGATION"))) {
            complianceValid = true;
        }
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
     * @dev Get user's Groth16 proof information
     * @param user User address
     * @param circuitId Circuit identifier
     * @return timestamp Proof submission timestamp
     * @return isValid True if proof is valid
     * @return isExpired True if proof is expired
     */
    function getUserProofInfo(
        address user,
        bytes32 circuitId
    ) external view returns (uint256 timestamp, bool isValid, bool isExpired) {
        PrivateComplianceProof storage proof = userProofs[user][circuitId];
        timestamp = proof.timestamp;
        isValid = proof.isValid;
        isExpired = timestamp == 0 || block.timestamp > timestamp + proofValidityPeriod;
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

    /**
     * @dev Check if user has valid proof for circuit
     * @param user User address
     * @param circuitId Circuit identifier
     * @return True if proof exists and is valid
     */
    function _hasValidProof(address user, bytes32 circuitId) internal view returns (bool) {
        PrivateComplianceProof storage proof = userProofs[user][circuitId];

        if (proof.timestamp == 0 || !proof.isValid) {
            return false;
        }

        return block.timestamp <= proof.timestamp + proofValidityPeriod;
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
