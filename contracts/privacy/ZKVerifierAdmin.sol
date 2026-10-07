// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable2Step.sol";
import "./verifiers/whitelist_membershipVerifier.sol";
import "./verifiers/blacklist_membershipVerifier.sol";
import "./verifiers/jurisdiction_proofVerifier.sol";
import "./verifiers/accreditation_proofVerifier.sol";
import "./verifiers/compliance_aggregationVerifier.sol";

/**
 * @title ZKVerifierAdmin
 * @dev The administrative half of ZKVerifierIntegrated (split by
 *      inheritance, plan Task 4.8, D35 a): the five verifier instances and
 *      their replacement, the proof statistics, the proof cache with its
 *      keys and expiry, and the circuit ids. ZKVerifierIntegrated is the
 *      only contract deployed (one address, one bound type, one code-hash
 *      pin).
 */
abstract contract ZKVerifierAdmin is Ownable2Step {
    // Real verifier contracts
    WhitelistMembershipVerifier public whitelistVerifier;
    BlacklistMembershipVerifier public blacklistVerifier;
    JurisdictionProofVerifier public jurisdictionVerifier;
    AccreditationProofVerifier public accreditationVerifier;
    ComplianceAggregationVerifier public complianceVerifier;
    
    // Proof verification statistics
    mapping(string => uint256) public totalProofs;
    mapping(string => uint256) public validProofs;
    mapping(address => uint256) public userProofCount;

    // BN254 scalar field q. The PLONK verifier reduces signals mod q in the PI
    // term but hashes raw calldata in the transcript: n+q verifies as a new nullifier.
    uint256 internal constant SNARK_SCALAR_FIELD =
        21888242871839275222246405745257275088548364400416034343698204186575808495617;

    bytes32 internal constant WHITELIST_ID = keccak256("WHITELIST_MEMBERSHIP");
    bytes32 internal constant BLACKLIST_ID = keccak256("BLACKLIST_MEMBERSHIP");
    bytes32 internal constant JURISDICTION_ID = keccak256("JURISDICTION_PROOF");
    bytes32 internal constant ACCREDITATION_ID = keccak256("ACCREDITATION_PROOF");
    bytes32 internal constant COMPLIANCE_ID = keccak256("COMPLIANCE_AGGREGATION");

    // Testing mode for mock verification (IMMUTABLE - set at deployment)
    bool public immutable testingMode;

    // Gas Optimization: Proof caching
    // Maps proof hash => verification result (true if verified)
    mapping(bytes32 => bool) internal verifiedProofs;
    mapping(bytes32 => uint256) internal proofTimestamp;

    // Gas Optimization: Proof cache expiry (24 hours default)
    uint256 public proofCacheExpiry = 24 hours;

    // Events
    event ProofVerified(string indexed proofType, address indexed user, bool result);
    event ProofCached(bytes32 indexed proofHash, string indexed proofType);
    event ProofCacheHit(bytes32 indexed proofHash, string indexed proofType);
    event VerifierUpdated(string indexed proofType, address indexed newVerifier);
    event BatchProofsVerified(uint256 count, uint256 successCount);
    
    constructor(bool _testingMode) {
        testingMode = _testingMode;

        // Deploy real verifier contracts
        whitelistVerifier = new WhitelistMembershipVerifier();
        blacklistVerifier = new BlacklistMembershipVerifier();
        jurisdictionVerifier = new JurisdictionProofVerifier();
        accreditationVerifier = new AccreditationProofVerifier();
        complianceVerifier = new ComplianceAggregationVerifier();
    }

    /**
     * @dev Update verifier contract for a specific proof type
     * @param proofType "whitelist", "blacklist", "jurisdiction", "accreditation" or "compliance"
     * @param newVerifier Address of the new verifier contract
     *
     * @custom:security Owner can disable ZK verification with a single transaction.
     * `testingMode` is immutable, so a deployed instance cannot be flipped into mock
     * mode — but production verification delegates to the verifier addresses this
     * function replaces. An owner who installs a contract whose `verifyProof` always
     * returns true bypasses verification entirely, reaching the same outcome the
     * immutable flag was meant to prevent. Immutability of `testingMode` therefore
     * does NOT bound owner power.
     *
     * What is and is not guarded:
     *   - NO timelock or delay on the swap (documented trust assumption)
     *   - `newVerifier` must be a contract, but there is NO proof it implements
     *     the circuit's PLONK verifier — only code presence is checked
     *   - a `VerifierUpdated` event IS emitted, so swaps are observable on-chain
     *     and can be monitored
     *
     * Demonstrated by test/privacy/VerifierSwapRisk.test.ts. Before mainnet, consider
     * owning this contract with a TimelockController or multisig.
     */
    function updateVerifier(string memory proofType, address newVerifier) external onlyOwner {
        require(newVerifier != address(0), "ZKVerifierIntegrated: Invalid verifier address");
        // Reject addresses with no code. Without this, setting a verifier to an EOA
        // succeeds here and instead reverts later inside every verify* call, bricking
        // that proof type until someone traces the failure back to this setter.
        require(newVerifier.code.length > 0, "ZKVerifierIntegrated: Verifier is not a contract");

        bytes32 proofHash = keccak256(abi.encodePacked(proofType));

        if (proofHash == keccak256(abi.encodePacked("whitelist"))) {
            whitelistVerifier = WhitelistMembershipVerifier(newVerifier);
        } else if (proofHash == keccak256(abi.encodePacked("blacklist"))) {
            blacklistVerifier = BlacklistMembershipVerifier(newVerifier);
        } else if (proofHash == keccak256(abi.encodePacked("jurisdiction"))) {
            jurisdictionVerifier = JurisdictionProofVerifier(newVerifier);
        } else if (proofHash == keccak256(abi.encodePacked("accreditation"))) {
            accreditationVerifier = AccreditationProofVerifier(newVerifier);
        } else if (proofHash == keccak256(abi.encodePacked("compliance"))) {
            complianceVerifier = ComplianceAggregationVerifier(newVerifier);
        } else {
            revert("ZKVerifierIntegrated: Invalid proof type");
        }
        
        emit VerifierUpdated(proofType, newVerifier);
    }
    
    /**
     * @dev Get verification statistics
     * @param proofType The type of proof to get stats for
     * @return total Total number of proofs submitted
     * @return valid Number of valid proofs
     * @return successRate Success rate as percentage (scaled by 100)
     */
    function getVerificationStats(string memory proofType) 
        external 
        view 
        returns (uint256 total, uint256 valid, uint256 successRate) 
    {
        total = totalProofs[proofType];
        valid = validProofs[proofType];
        successRate = total > 0 ? (valid * 10000) / total : 0; // Scaled by 100 for 2 decimal places
    }
    
    /**
     * @dev Get verifier contract addresses
     * @return whitelist Address of whitelist verifier
     * @return jurisdiction Address of jurisdiction verifier
     * @return accreditation Address of accreditation verifier
     * @return compliance Address of compliance verifier
     */
    function getVerifierAddresses() 
        external 
        view 
        returns (
            address whitelist,
            address jurisdiction,
            address accreditation,
            address compliance
        ) 
    {
        return (
            address(whitelistVerifier),
            address(jurisdictionVerifier),
            address(accreditationVerifier),
            address(complianceVerifier)
        );
    }

    // Circuit constants
    function WHITELIST_MEMBERSHIP_CIRCUIT() external pure returns (bytes32) {
        return WHITELIST_ID;
    }

    function BLACKLIST_MEMBERSHIP_CIRCUIT() external pure returns (bytes32) {
        return BLACKLIST_ID;
    }

    function JURISDICTION_PROOF_CIRCUIT() external pure returns (bytes32) {
        return JURISDICTION_ID;
    }

    function ACCREDITATION_PROOF_CIRCUIT() external pure returns (bytes32) {
        return ACCREDITATION_ID;
    }

    function COMPLIANCE_AGGREGATION_CIRCUIT() external pure returns (bytes32) {
        return COMPLIANCE_ID;
    }

    /**
     * @dev Check if a circuit is registered
     * @param circuitId Circuit identifier
     * @return True if circuit is registered
     */
    function isCircuitRegistered(bytes32 circuitId) external pure returns (bool) {
        return circuitId == WHITELIST_ID || circuitId == BLACKLIST_ID || circuitId == JURISDICTION_ID ||
               circuitId == ACCREDITATION_ID || circuitId == COMPLIANCE_ID;
    }

    /**
     * @dev Get circuit statistics
     * @param circuitType Type of circuit ("whitelist", "blacklist", "jurisdiction", "accreditation", "compliance")
     * @return total Total number of proofs submitted
     * @return valid Number of valid proofs
     */
    function getCircuitStats(string memory circuitType) external view returns (uint256 total, uint256 valid) {
        total = totalProofs[circuitType];
        valid = validProofs[circuitType];
    }

    /**
     * @dev Cache key for a verified PLONK proof (24 words), BOUND TO THE
     *      CIRCUIT that verified it. The key used to carry no circuit id, and
     *      every verify* function checked that shared cache before calling its
     *      own verifier, so a proof verified once under one circuit satisfied
     *      another circuit of the same signal shape on the cache hit.
     *      The verifier INSTANCE is part of the key, not just the label: a
     *      proof accepted by the old verifier must not keep answering true from
     *      the cache after updateVerifier swaps in a new one. A rotation
     *      invalidates every cached proof for that circuit at once.
     */
    function _plonkCacheKey(
        string memory circuit,
        uint256[24] memory proof,
        bytes memory packedSignals
    ) internal view returns (bytes32) {
        return keccak256(abi.encodePacked(circuit, _verifierFor(circuit), proof, packedSignals));
    }

    /// @dev Verifier contract currently bound to a circuit tag. testingMode has
    ///      no verifier instance, so it keys on address(0).
    function _verifierFor(string memory circuit) internal view returns (address) {
        if (testingMode) return address(0);
        bytes32 h = keccak256(bytes(circuit));
        if (h == keccak256("whitelist")) return address(whitelistVerifier);
        if (h == keccak256("blacklist")) return address(blacklistVerifier);
        if (h == keccak256("jurisdiction")) return address(jurisdictionVerifier);
        if (h == keccak256("accreditation")) return address(accreditationVerifier);
        if (h == keccak256("compliance")) return address(complianceVerifier);
        return address(0);
    }

    /**
     * @notice Cache key of a PLONK whitelist proof (single and batch); see
     *         blacklistProofCacheKey, and proofCacheKey for the attestation
     *         circuits.
     */
    function whitelistProofCacheKey(
        uint256[24] calldata proof,
        uint256[3] calldata pubSignals
    ) external view returns (bytes32) {
        return _plonkCacheKey("whitelist", proof, abi.encodePacked(pubSignals));
    }

    /**
     * @notice Cache key of a PLONK blacklist non-membership proof.
     */
    function blacklistProofCacheKey(
        uint256[24] calldata proof,
        uint256[4] calldata pubSignals
    ) external view returns (bytes32) {
        return _plonkCacheKey("blacklist", proof, abi.encodePacked(pubSignals));
    }

    /**
     * @notice Cache key of an attestation proof under its circuit tag:
     *         "jurisdiction", "accreditation" or "compliance". The key also
     *         folds in the verifier instance bound to that tag, so it changes
     *         after updateVerifier. Callers of clearExpiredProofs compute keys
     *         with this.
     */
    function proofCacheKey(
        string calldata circuit,
        uint256[24] calldata proof,
        uint256[] calldata publicSignals
    ) external view returns (bytes32) {
        return _plonkCacheKey(circuit, proof, abi.encodePacked(publicSignals));
    }

    /**
     * @dev Set proof cache expiry time
     * @param _expiry New expiry time in seconds
     */
    function setProofCacheExpiry(uint256 _expiry) external onlyOwner {
        require(_expiry >= 1 hours && _expiry <= 7 days, "Invalid expiry time");
        proofCacheExpiry = _expiry;
    }

    /**
     * @dev Clear expired proofs from cache (gas optimization)
     * @param proofHashes Array of proof hashes to check and clear if expired
     */
    function clearExpiredProofs(bytes32[] calldata proofHashes) external {
        for (uint256 i = 0; i < proofHashes.length; i++) {
            if (block.timestamp > proofTimestamp[proofHashes[i]] + proofCacheExpiry) {
                delete verifiedProofs[proofHashes[i]];
                delete proofTimestamp[proofHashes[i]];
            }
        }
    }
}
