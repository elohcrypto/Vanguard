// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable2Step.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "./interfaces/IZKVerifier.sol";
import "./verifiers/whitelist_membershipVerifier.sol";
import "./verifiers/blacklist_membershipVerifier.sol";
import "./verifiers/jurisdiction_proofVerifier.sol";
import "./verifiers/accreditation_proofVerifier.sol";
import "./verifiers/compliance_aggregationVerifier.sol";

/**
 * @title ZKVerifierIntegrated
 * @dev Wraps the snarkjs-generated verifiers. Two protocols:
 *      - whitelist: PLONK (24-word proof, signals [nullifier, merkleRoot,
 *        walletBinding]); sound; the typed entry PrivacyManager uses is
 *        verifyWhitelistMembership (see IZKVerifier).
 *      - blacklist: PLONK (24-word proof, signals [nullifier, whitelistRoot,
 *        blacklistRoot, walletBinding]); sound; typed entry
 *        verifyBlacklistNonMembership. A non-gating demonstration (D2):
 *        nothing on chain consumes its result.
 *      - jurisdiction, accreditation, compliance (Task 3.7b, D31 a): PLONK
 *        proofs over an issuer-signed EdDSA attestation; signals
 *        [nullifier, Ax, Ay, policy..., walletBinding]; typed entries
 *        verifyJurisdictionProof / verifyAccreditationProof /
 *        verifyComplianceAggregation, also routed by id through
 *        verifyCircuitProof. Trusting (Ax, Ay), comparing the policy signals
 *        and the wallet, and the nullifier map belong to PrivacyManager
 *        (submitAttestationProof).
 *      Every circuit is PLONK on the universal ptau (D28 c).
 */
/**
 * @dev Uses Ownable2Step so ownership can migrate as governance matures —
 * EOA today, multisig later, timelock after that — without redeploying.
 * The two-step handover matters: with one-step Ownable, transferring to a
 * wrong or non-responsive address permanently strands this contract, since
 * updateVerifier and setProofCacheExpiry would become uncallable forever.
 * Requiring acceptOwnership() proves the new owner exists and can act.
 */
contract ZKVerifierIntegrated is Ownable2Step, ReentrancyGuard {
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

    bytes32 private constant WHITELIST_ID = keccak256("WHITELIST_MEMBERSHIP");
    bytes32 private constant BLACKLIST_ID = keccak256("BLACKLIST_MEMBERSHIP");
    bytes32 private constant JURISDICTION_ID = keccak256("JURISDICTION_PROOF");
    bytes32 private constant ACCREDITATION_ID = keccak256("ACCREDITATION_PROOF");
    bytes32 private constant COMPLIANCE_ID = keccak256("COMPLIANCE_AGGREGATION");

    // Testing mode for mock verification (IMMUTABLE - set at deployment)
    bool public immutable testingMode;

    // Gas Optimization: Proof caching
    // Maps proof hash => verification result (true if verified)
    mapping(bytes32 => bool) private verifiedProofs;
    mapping(bytes32 => uint256) private proofTimestamp;

    // Gas Optimization: Proof cache expiry (24 hours default)
    uint256 public proofCacheExpiry = 24 hours;

    // Events
    event ProofVerified(string indexed proofType, address indexed user, bool result);
    event ProofCached(bytes32 indexed proofHash, string indexed proofType);
    event ProofCacheHit(bytes32 indexed proofHash, string indexed proofType);
    event VerifierUpdated(string indexed proofType, address indexed newVerifier);
    event BatchProofsVerified(uint256 count, uint256 successCount);
    
    /**
     * @param _testingMode True for mock verification (testnet), false for real ZK verification (mainnet)
     * @notice testingMode is IMMUTABLE and cannot be changed after deployment
     * @notice Deploy with testingMode=true for testing, testingMode=false for production
     */
    constructor(bool _testingMode) Ownable(msg.sender) {
        testingMode = _testingMode;

        // Deploy real verifier contracts
        whitelistVerifier = new WhitelistMembershipVerifier();
        blacklistVerifier = new BlacklistMembershipVerifier();
        jurisdictionVerifier = new JurisdictionProofVerifier();
        accreditationVerifier = new AccreditationProofVerifier();
        complianceVerifier = new ComplianceAggregationVerifier();
    }
    
    /**
     * @dev Verify a PLONK whitelist membership proof.
     * @param proof 24-word PLONK proof (snarkjs `plonk exportSolidityCallData`)
     * @param pubSignals [nullifier, merkleRoot, walletBinding]
     * @return True if the proof verifies against these public signals
     *
     * This checks the proof only. Comparing merkleRoot with the published
     * root, walletBinding with the submitting wallet and recording the
     * nullifier (one wallet per commitment per root) belong to the consumer,
     * PrivacyManager.submitWhitelistProof; msg.sender here is whoever called this
     * contract, so the binding cannot be checked here.
     *
     * testingMode (demo only): the proof words are not checked and no
     * verifier is called; a proof is accepted when all three signals are
     * non-zero (and below the field order).
     */
    function verifyWhitelistMembership(
        uint256[24] calldata proof,
        uint256[3] calldata pubSignals
    ) external nonReentrant returns (bool) {
        return _verifyWhitelist(proof, pubSignals);
    }

    /**
     * @dev Verify multiple PLONK whitelist proofs; same rules as
     *      verifyWhitelistMembership for each entry.
     * @return results Array of verification results
     * @return successCount Number of successful verifications
     */
    function verifyBatchWhitelistMembership(
        uint256[24][] calldata proofs,
        uint256[3][] calldata pubSignalsArray
    ) external nonReentrant returns (bool[] memory results, uint256 successCount) {
        require(proofs.length == pubSignalsArray.length, "Array length mismatch");
        require(proofs.length > 0 && proofs.length <= 50, "Invalid batch size");

        results = new bool[](proofs.length);
        for (uint256 i = 0; i < proofs.length; i++) {
            results[i] = _verifyWhitelist(proofs[i], pubSignalsArray[i]);
            if (results[i]) successCount++;
        }
        return (results, successCount);
    }

    function _verifyWhitelist(
        uint256[24] memory proof,
        uint256[3] memory pubSignals
    ) internal returns (bool) {
        if (pubSignals[0] >= SNARK_SCALAR_FIELD || pubSignals[1] >= SNARK_SCALAR_FIELD ||
            pubSignals[2] >= SNARK_SCALAR_FIELD) return false;
        bytes32 proofHash = _plonkCacheKey("whitelist", proof, abi.encodePacked(pubSignals));
        if (verifiedProofs[proofHash] && block.timestamp <= proofTimestamp[proofHash] + proofCacheExpiry) {
            emit ProofCacheHit(proofHash, "whitelist");
            return true;
        }

        totalProofs["whitelist"]++;
        userProofCount[msg.sender]++;

        bool result;
        if (testingMode) {
            result = pubSignals[0] != 0 && pubSignals[1] != 0 && pubSignals[2] != 0;
        } else {
            result = whitelistVerifier.verifyProof(proof, pubSignals);
        }

        if (result) {
            validProofs["whitelist"]++;
            verifiedProofs[proofHash] = true;
            proofTimestamp[proofHash] = block.timestamp;
            emit ProofCached(proofHash, "whitelist");
        }

        emit ProofVerified("whitelist", msg.sender, result);
        return result;
    }

    /**
     * @dev Verify a PLONK blacklist non-membership proof: the wallet's holder
     *      owns a commitment in the whitelist root whose identity is not in
     *      the sanctions tree.
     * @param proof 24-word PLONK proof (snarkjs `plonk exportSolidityCallData`)
     * @param pubSignals [nullifier, whitelistRoot, blacklistRoot, walletBinding]
     * @return True if the proof verifies against these public signals
     *
     * Checks the proof only; comparing the roots with the published ones and
     * walletBinding with a wallet is the caller's job. Nothing on chain gates
     * on this result (D2): the sanctions list stays explicit and immediate,
     * and PrivacyManager refuses this circuit.
     *
     * testingMode (demo only): the proof words are not checked and no
     * verifier is called; a proof is accepted when the nullifier,
     * whitelistRoot and walletBinding are non-zero (and every signal is below
     * the field order). blacklistRoot may be 0: an empty sanctions list has
     * root 0 and the real verifier accepts it.
     */
    function verifyBlacklistNonMembership(
        uint256[24] calldata proof,
        uint256[4] calldata pubSignals
    ) external nonReentrant returns (bool) {
        return _verifyBlacklist(proof, pubSignals);
    }

    function _verifyBlacklist(
        uint256[24] memory proof,
        uint256[4] memory pubSignals
    ) internal returns (bool) {
        if (pubSignals[0] >= SNARK_SCALAR_FIELD || pubSignals[1] >= SNARK_SCALAR_FIELD ||
            pubSignals[2] >= SNARK_SCALAR_FIELD || pubSignals[3] >= SNARK_SCALAR_FIELD) return false;
        bytes32 proofHash = _plonkCacheKey("blacklist", proof, abi.encodePacked(pubSignals));
        if (verifiedProofs[proofHash] && block.timestamp <= proofTimestamp[proofHash] + proofCacheExpiry) {
            emit ProofCacheHit(proofHash, "blacklist");
            return true;
        }

        totalProofs["blacklist"]++;
        userProofCount[msg.sender]++;

        bool result;
        if (testingMode) {
            // pubSignals[2] (blacklistRoot) is 0 for an empty sanctions list.
            result = pubSignals[0] != 0 && pubSignals[1] != 0 && pubSignals[3] != 0;
        } else {
            result = blacklistVerifier.verifyProof(proof, pubSignals);
        }

        if (result) {
            validProofs["blacklist"]++;
            verifiedProofs[proofHash] = true;
            proofTimestamp[proofHash] = block.timestamp;
            emit ProofCached(proofHash, "blacklist");
        }

        emit ProofVerified("blacklist", msg.sender, result);
        return result;
    }

    /**
     * @dev Verify a PLONK jurisdiction attestation proof.
     * @param proof 24-word PLONK proof (snarkjs `plonk exportSolidityCallData`)
     * @param pubSignals [nullifier, Ax, Ay, chainId, verifierContext,
     *        validUntil, allowedMask, walletBinding]
     * @return True if the proof verifies against these public signals
     *
     * Checks the proof only: whether (Ax, Ay) is a trusted issuer key,
     * chainId and verifierContext this chain and PrivacyManager, validUntil
     * still ahead (Task 3.10), the mask the current policy, walletBinding
     * the submitter and the nullifier free is
     * PrivacyManager.submitAttestationProof's job.
     *
     * testingMode (demo only): the proof words are not checked and no
     * verifier is called; a proof is accepted when the nullifier, Ax, Ay and
     * walletBinding are non-zero (every signal below the field order). The
     * policy signals may be 0 (a weight of 0 is a legitimate policy).
     */
    function verifyJurisdictionProof(
        uint256[24] calldata proof,
        uint256[8] calldata pubSignals
    ) external nonReentrant returns (bool) {
        uint256[] memory s = new uint256[](8);
        for (uint256 i = 0; i < 8; i++) s[i] = pubSignals[i];
        return _verifyAttestation("jurisdiction", proof, s);
    }

    /**
     * @dev Verify a PLONK accreditation attestation proof; same rules as
     *      verifyJurisdictionProof.
     * @param pubSignals [nullifier, Ax, Ay, chainId, verifierContext,
     *        validUntil, minimumAccreditation, walletBinding]
     */
    function verifyAccreditationProof(
        uint256[24] calldata proof,
        uint256[8] calldata pubSignals
    ) external nonReentrant returns (bool) {
        uint256[] memory s = new uint256[](8);
        for (uint256 i = 0; i < 8; i++) s[i] = pubSignals[i];
        return _verifyAttestation("accreditation", proof, s);
    }

    /**
     * @dev Verify a PLONK compliance-aggregation attestation proof; same rules
     *      as verifyJurisdictionProof.
     * @param pubSignals [nullifier, Ax, Ay, chainId, verifierContext,
     *        validUntil, minimum, wK, wA, wJ, wAcc, walletBinding]
     */
    function verifyComplianceAggregation(
        uint256[24] calldata proof,
        uint256[12] calldata pubSignals
    ) external nonReentrant returns (bool) {
        uint256[] memory s = new uint256[](12);
        for (uint256 i = 0; i < 12; i++) s[i] = pubSignals[i];
        return _verifyAttestation("compliance", proof, s);
    }

    /// @dev Shared body of the three attestation routes; mirrors
    ///      _verifyWhitelist: range check before any bookkeeping, cache key
    ///      bound to the circuit tag and verifier instance, stats and events.
    ///      The caller guarantees the circuit's signal count.
    function _verifyAttestation(
        string memory circuit,
        uint256[24] memory proof,
        uint256[] memory s
    ) internal returns (bool) {
        uint256 n = s.length;
        for (uint256 i = 0; i < n; i++) {
            if (s[i] >= SNARK_SCALAR_FIELD) return false;
        }
        bytes32 proofHash = _plonkCacheKey(circuit, proof, abi.encodePacked(s));
        if (verifiedProofs[proofHash] && block.timestamp <= proofTimestamp[proofHash] + proofCacheExpiry) {
            emit ProofCacheHit(proofHash, circuit);
            return true;
        }

        totalProofs[circuit]++;
        userProofCount[msg.sender]++;

        bool result;
        if (testingMode) {
            // nullifier, Ax, Ay and walletBinding; policy signals may be 0.
            result = s[0] != 0 && s[1] != 0 && s[2] != 0 && s[n - 1] != 0;
        } else {
            result = _callAttestationVerifier(circuit, proof, s);
        }

        if (result) {
            validProofs[circuit]++;
            verifiedProofs[proofHash] = true;
            proofTimestamp[proofHash] = block.timestamp;
            emit ProofCached(proofHash, circuit);
        }

        emit ProofVerified(circuit, msg.sender, result);
        return result;
    }

    function _callAttestationVerifier(
        string memory circuit,
        uint256[24] memory proof,
        uint256[] memory s
    ) private view returns (bool) {
        bytes32 h = keccak256(bytes(circuit));
        if (h == keccak256("jurisdiction")) {
            return jurisdictionVerifier.verifyProof(proof, [s[0], s[1], s[2], s[3], s[4], s[5], s[6], s[7]]);
        }
        if (h == keccak256("accreditation")) {
            return accreditationVerifier.verifyProof(proof, [s[0], s[1], s[2], s[3], s[4], s[5], s[6], s[7]]);
        }
        return complianceVerifier.verifyProof(
            proof,
            [s[0], s[1], s[2], s[3], s[4], s[5], s[6], s[7], s[8], s[9], s[10], s[11]]
        );
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
     * @dev Verify an attestation proof routed by circuit id: jurisdiction
     *      (8 signals), accreditation (8) or compliance aggregation (12).
     * @param circuitId JURISDICTION_PROOF_CIRCUIT, ACCREDITATION_PROOF_CIRCUIT
     *        or COMPLIANCE_AGGREGATION_CIRCUIT
     * @param proof 24-word PLONK proof
     * @param signals The circuit's public signals, in snarkjs order
     * @return True if the proof verifies; false on a bad proof or a signal
     *         >= the field order. Reverts on a wrong signal count, an unknown
     *         id, or the whitelist/blacklist ids (they have typed entries:
     *         verifyWhitelistMembership / verifyBlacklistNonMembership).
     */
    function verifyCircuitProof(
        bytes32 circuitId,
        uint256[24] calldata proof,
        uint256[] calldata signals
    ) external nonReentrant returns (bool) {
        return _verifyCircuit(circuitId, proof, signals, true);
    }

    /// @dev Shared router of verifyCircuitProof (strict: a malformed entry
    ///      reverts) and verifyBatchProofs (non-strict: it returns false).
    function _verifyCircuit(
        bytes32 circuitId,
        uint256[24] memory proof,
        uint256[] memory s,
        bool strict
    ) internal returns (bool) {
        uint256 n = s.length;
        if (circuitId == WHITELIST_ID) {
            return _malformed(strict, "use verifyWhitelistMembership");
        } else if (circuitId == BLACKLIST_ID) {
            return _malformed(strict, "use verifyBlacklistNonMembership");
        } else if (circuitId == JURISDICTION_ID) {
            if (n != 8) return _malformed(strict, "Invalid public inputs for jurisdiction circuit");
            return _verifyAttestation("jurisdiction", proof, s);
        } else if (circuitId == ACCREDITATION_ID) {
            if (n != 8) return _malformed(strict, "Invalid public inputs for accreditation circuit");
            return _verifyAttestation("accreditation", proof, s);
        } else if (circuitId == COMPLIANCE_ID) {
            if (n != 12) return _malformed(strict, "Invalid public inputs for compliance circuit");
            return _verifyAttestation("compliance", proof, s);
        }
        return _malformed(strict, "ZKVerifierIntegrated: Unknown circuit ID");
    }

    function _malformed(bool strict, string memory reason) private pure returns (bool) {
        require(!strict, reason);
        return false;
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
     * @dev Verify a batch of proofs that may mix circuits; same rules as
     *      verifyCircuitProof per entry, except that a malformed entry
     *      (wrong input count, unknown circuit) yields false instead of
     *      reverting the batch.
     * @return results Array of verification results
     * @return successCount Number of successful verifications
     */
    function verifyBatchProofs(
        bytes32[] calldata circuitIds,
        uint256[24][] calldata proofs,
        uint256[][] calldata publicInputsArray
    ) external nonReentrant returns (bool[] memory results, uint256 successCount) {
        require(
            circuitIds.length == proofs.length && proofs.length == publicInputsArray.length,
            "Array length mismatch"
        );
        require(circuitIds.length > 0 && circuitIds.length <= 50, "Invalid batch size");

        results = new bool[](circuitIds.length);
        for (uint256 i = 0; i < circuitIds.length; i++) {
            // Internal calls: the old `try this.verifyCircuitProof` re-entered
            // the nonReentrant verify* externals and always returned false.
            results[i] = _verifyCircuit(circuitIds[i], proofs[i], publicInputsArray[i], false);
            if (results[i]) successCount++;
        }

        emit BatchProofsVerified(circuitIds.length, successCount);
        return (results, successCount);
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
