// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "./interfaces/IZKVerifier.sol";
import "../compliance/interfaces/IComplianceRules.sol";
import "../oracle/interfaces/IOracleManager.sol";

/**
 * @title PrivacyManager
 * @dev Privacy-preserving compliance validation using zero-knowledge proofs
 */
contract PrivacyManager is Ownable, ReentrancyGuard {
    IZKVerifier public zkVerifier;
    IComplianceRules public complianceRules;
    IOracleManager public oracleManager;

    struct PrivateComplianceProof {
        IZKVerifier.Proof zkProof;
        bytes32 circuitId;
        uint256[] publicInputs;
        uint256 timestamp;
        bool isValid;
    }

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

    // Storage
    mapping(address => mapping(bytes32 => PrivateComplianceProof)) private userProofs;
    mapping(address => PrivacySettings) public userPrivacySettings;
    mapping(bytes32 => uint256) public circuitMinimumInputs;

    PrivacySettings public defaultPrivacySettings;
    uint256 public constant DEFAULT_PROOF_VALIDITY = 24 hours;

    // Jurisdiction management
    mapping(uint256 => JurisdictionInfo) public jurisdictions;
    mapping(string => uint256) public jurisdictionCodeToMask;
    uint256[] public activeJurisdictionMasks;
    uint256 public nextJurisdictionMask = 1;

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
        require(block.timestamp <= proof.timestamp + _getProofValidityPeriod(user), "PrivacyManager: Proof expired");
        require(proof.isValid, "PrivacyManager: Invalid proof");
        _;
    }

    constructor(address _zkVerifier, address _complianceRules, address _oracleManager) Ownable(msg.sender) {
        require(_zkVerifier != address(0), "PrivacyManager: Invalid ZK verifier");
        require(_complianceRules != address(0), "PrivacyManager: Invalid compliance rules");
        require(_oracleManager != address(0), "PrivacyManager: Invalid oracle manager");

        zkVerifier = IZKVerifier(_zkVerifier);
        complianceRules = IComplianceRules(_complianceRules);
        oracleManager = IOracleManager(_oracleManager);

        // Set default privacy settings
        defaultPrivacySettings = PrivacySettings({
            enablePrivateWhitelist: true,
            enablePrivateJurisdiction: true,
            enablePrivateAccreditation: true,
            enablePrivateCompliance: true,
            proofValidityPeriod: DEFAULT_PROOF_VALIDITY
        });

        // Set minimum inputs for circuits using hardcoded circuit IDs
        circuitMinimumInputs[keccak256("WHITELIST_MEMBERSHIP")] = 1;
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

    /**
     * @dev Submit a private compliance proof
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
     * @dev Validate private whitelist membership
     * @param user User address
     * @return True if user has valid private whitelist proof
     */
    function validatePrivateWhitelistMembership(
        address user
    ) external validProof(user, keccak256("WHITELIST_MEMBERSHIP")) returns (bool) {
        PrivacySettings memory settings = _getUserPrivacySettings(user);
        if (!settings.enablePrivateWhitelist) {
            return false;
        }

        emit PrivateComplianceValidated(user, keccak256("WHITELIST_MEMBERSHIP"), true);
        return true;
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
     * @dev Comprehensive private compliance validation
     * @param user User address
     * @return whitelistValid True if whitelist proof is valid
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

        // Check whitelist membership
        if (settings.enablePrivateWhitelist && _hasValidProof(user, keccak256("WHITELIST_MEMBERSHIP"))) {
            whitelistValid = true;
        }

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
     * @dev Set user privacy settings
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
     * @dev Get user's proof information
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

        if (timestamp > 0) {
            uint256 validityPeriod = _getProofValidityPeriod(user);
            isExpired = block.timestamp > timestamp + validityPeriod;
        } else {
            isExpired = true;
        }
    }

    /**
     * @dev Update ZK verifier contract
     * @param _zkVerifier New ZK verifier address
     */
    function updateZKVerifier(address _zkVerifier) external onlyOwner {
        require(_zkVerifier != address(0), "PrivacyManager: Invalid ZK verifier");
        zkVerifier = IZKVerifier(_zkVerifier);
    }

    /**
     * @dev Update compliance rules contract
     * @param _complianceRules New compliance rules address
     */
    function updateComplianceRules(address _complianceRules) external onlyOwner {
        require(_complianceRules != address(0), "PrivacyManager: Invalid compliance rules");
        complianceRules = IComplianceRules(_complianceRules);
    }

    /**
     * @dev Update oracle manager contract
     * @param _oracleManager New oracle manager address
     */
    function updateOracleManager(address _oracleManager) external onlyOwner {
        require(_oracleManager != address(0), "PrivacyManager: Invalid oracle manager");
        oracleManager = IOracleManager(_oracleManager);
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
     * @dev Get proof validity period for user
     * @param user User address
     * @return Validity period in seconds
     */
    function _getProofValidityPeriod(address user) internal view returns (uint256) {
        PrivacySettings memory settings = _getUserPrivacySettings(user);
        return settings.proofValidityPeriod;
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

        uint256 validityPeriod = _getProofValidityPeriod(user);
        return block.timestamp <= proof.timestamp + validityPeriod;
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
