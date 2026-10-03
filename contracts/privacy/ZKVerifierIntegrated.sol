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
 *      - jurisdiction, accreditation, compliance: Groth16 with no phase-2
 *        contribution, so forgeable until Task 3.7 moves each to PLONK with
 *        the same signal range check the PLONK paths have.
 *      Not `is IZKVerifier`: that interface also carries the legacy
 *      verifyProof/setVerifyingKey/getVerifyingKey ABI this contract never had.
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
     * verifier is called; a proof is accepted when all four signals are
     * non-zero (and below the field order).
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
            result = pubSignals[0] != 0 && pubSignals[1] != 0 && pubSignals[2] != 0 && pubSignals[3] != 0;
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
     * @dev Verify jurisdiction proof
     * @param a Proof point A
     * @param b Proof point B
     * @param c Proof point C
     * @param publicSignals Public inputs for the proof (1 element)
     * @return True if the proof is valid
     */
    function verifyJurisdictionProof(
        uint256[2] memory a,
        uint256[2][2] memory b,
        uint256[2] memory c,
        uint256[1] memory publicSignals
    ) external nonReentrant returns (bool) {
        return _verifyJurisdiction(a, b, c, publicSignals);
    }

    function _verifyJurisdiction(
        uint256[2] memory a, uint256[2][2] memory b, uint256[2] memory c, uint256[1] memory publicSignals
    ) internal returns (bool) {
        bytes32 proofHash = _proofCacheKey("jurisdiction", a, b, c, abi.encodePacked(publicSignals));
        if (verifiedProofs[proofHash] && block.timestamp <= proofTimestamp[proofHash] + proofCacheExpiry) {
            emit ProofCacheHit(proofHash, "jurisdiction");
            return true; // Cached proof, ~5k gas instead of ~300k
        }

        totalProofs["jurisdiction"]++;
        userProofCount[msg.sender]++;

        bool result;
        if (testingMode) {
            // Mock verification for testing - always return true for valid inputs
            result = (publicSignals.length == 1 && publicSignals[0] > 0);
        } else {
            result = jurisdictionVerifier.verifyProof(a, b, c, publicSignals);
        }

        if (result) {
            validProofs["jurisdiction"]++;
            verifiedProofs[proofHash] = true;
            proofTimestamp[proofHash] = block.timestamp;
            emit ProofCached(proofHash, "jurisdiction");
        }

        emit ProofVerified("jurisdiction", msg.sender, result);
        return result;
    }
    
    /**
     * @dev Verify accreditation proof
     * @param a Proof point A
     * @param b Proof point B
     * @param c Proof point C
     * @param publicSignals Public inputs for the proof (1 element)
     * @return True if the proof is valid
     */
    function verifyAccreditationProof(
        uint256[2] memory a,
        uint256[2][2] memory b,
        uint256[2] memory c,
        uint256[1] memory publicSignals
    ) external nonReentrant returns (bool) {
        return _verifyAccreditation(a, b, c, publicSignals);
    }

    function _verifyAccreditation(
        uint256[2] memory a, uint256[2][2] memory b, uint256[2] memory c, uint256[1] memory publicSignals
    ) internal returns (bool) {
        bytes32 proofHash = _proofCacheKey("accreditation", a, b, c, abi.encodePacked(publicSignals));
        if (verifiedProofs[proofHash] && block.timestamp <= proofTimestamp[proofHash] + proofCacheExpiry) {
            emit ProofCacheHit(proofHash, "accreditation");
            return true; // Cached proof, ~5k gas instead of ~300k
        }

        totalProofs["accreditation"]++;
        userProofCount[msg.sender]++;

        bool result;
        if (testingMode) {
            // Mock verification for testing - always return true for valid inputs
            result = (publicSignals.length == 1 && publicSignals[0] > 0);
        } else {
            result = accreditationVerifier.verifyProof(a, b, c, publicSignals);
        }

        if (result) {
            validProofs["accreditation"]++;
            verifiedProofs[proofHash] = true;
            proofTimestamp[proofHash] = block.timestamp;
            emit ProofCached(proofHash, "accreditation");
        }

        emit ProofVerified("accreditation", msg.sender, result);
        return result;
    }

    /**
     * @dev Verify compliance aggregation proof
     * @param a Proof point A
     * @param b Proof point B
     * @param c Proof point C
     * @param publicSignals Public inputs for the proof (6 elements: minimumComplianceLevel, commitmentHash, weightKyc, weightAml, weightJurisdiction, weightAccreditation)
     * @return True if the proof is valid
     */
    function verifyComplianceAggregation(
        uint256[2] memory a,
        uint256[2][2] memory b,
        uint256[2] memory c,
        uint256[6] memory publicSignals
    ) external nonReentrant returns (bool) {
        return _verifyComplianceAggregation(a, b, c, publicSignals);
    }

    function _verifyComplianceAggregation(
        uint256[2] memory a, uint256[2][2] memory b, uint256[2] memory c, uint256[6] memory publicSignals
    ) internal returns (bool) {
        bytes32 proofHash = _proofCacheKey("compliance", a, b, c, abi.encodePacked(publicSignals));
        if (verifiedProofs[proofHash] && block.timestamp <= proofTimestamp[proofHash] + proofCacheExpiry) {
            emit ProofCacheHit(proofHash, "compliance");
            return true; // Cached proof, ~5k gas instead of ~300k
        }

        totalProofs["compliance"]++;
        userProofCount[msg.sender]++;

        bool result;
        if (testingMode) {
            // Mock verification for testing - always return true for valid inputs
            result = (publicSignals.length == 6 && publicSignals[0] > 0);
        } else {
            // The actual circuit only has 2 public inputs, extract them from the 6-element array
            uint256[2] memory actualPublicSignals = [publicSignals[0], publicSignals[1]];
            result = complianceVerifier.verifyProof(a, b, c, actualPublicSignals);
        }

        if (result) {
            validProofs["compliance"]++;
            verifiedProofs[proofHash] = true;
            proofTimestamp[proofHash] = block.timestamp;
            emit ProofCached(proofHash, "compliance");
        }

        emit ProofVerified("compliance", msg.sender, result);
        return result;
    }

    /**
     * @dev Alias for verifyComplianceAggregation for compatibility
     * @param a Proof point A
     * @param b Proof point B
     * @param c Proof point C
     * @param publicSignals Public inputs for the proof (6 elements: minimumComplianceLevel, commitmentHash, weightKyc, weightAml, weightJurisdiction, weightAccreditation)
     * @return True if the proof is valid
     */
    function verifyComplianceProof(
        uint256[2] memory a,
        uint256[2][2] memory b,
        uint256[2] memory c,
        uint256[2] memory publicSignals // compliance_aggregation_fixed outputs 2 signals
    ) external nonReentrant returns (bool) {
        // Gas Optimization: Check proof cache first
        bytes32 proofHash = _proofCacheKey("compliance-proof", a, b, c, abi.encodePacked(publicSignals));
        if (verifiedProofs[proofHash] && block.timestamp <= proofTimestamp[proofHash] + proofCacheExpiry) {
            emit ProofCacheHit(proofHash, "compliance");
            return true; // Cached proof, ~5k gas instead of ~300k
        }

        totalProofs["compliance"]++;
        userProofCount[msg.sender]++;

        bool result;
        if (testingMode) {
            // Mock verification for testing - always return true for valid inputs
            result = (publicSignals.length == 2 && publicSignals[0] > 0);
        } else {
            // The circuit has exactly 2 public inputs, pass them directly
            result = complianceVerifier.verifyProof(a, b, c, publicSignals);
        }

        if (result) {
            validProofs["compliance"]++;
            // Cache successful proof for gas optimization
            verifiedProofs[proofHash] = true;
            proofTimestamp[proofHash] = block.timestamp;
            emit ProofCached(proofHash, "compliance");
        }

        emit ProofVerified("compliance", msg.sender, result);
        return result;
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
     *     the circuit's PLONK (whitelist) or Groth16 (others) verifier — only
     *     code presence is checked
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
     * @dev Verify a proof for a specific circuit, routed by circuit id.
     * @param circuitId Identifier for the circuit
     * @param proof Groth16 proof
     * @param publicInputs Public inputs for the proof
     * @return True if the proof is valid
     *
     * Groth16 circuits only. The PLONK circuits (24-word proof) are refused
     * here: use verifyWhitelistMembership / verifyBlacklistNonMembership.
     */
    function verifyCircuitProof(
        bytes32 circuitId,
        IZKVerifier.Proof memory proof,
        uint256[] memory publicInputs
    ) external nonReentrant returns (bool) {
        return _verifyCircuit(circuitId, proof, publicInputs, true);
    }

    /// @dev Shared router of verifyCircuitProof (strict: a malformed entry
    ///      reverts) and verifyBatchProofs (non-strict: it returns false).
    function _verifyCircuit(
        bytes32 circuitId,
        IZKVerifier.Proof memory proof,
        uint256[] memory pi,
        bool strict
    ) internal returns (bool) {
        uint256 n = pi.length;
        if (circuitId == WHITELIST_ID) {
            return _malformed(strict, "use verifyWhitelistMembership");
        } else if (circuitId == BLACKLIST_ID) {
            return _malformed(strict, "use verifyBlacklistNonMembership");
        } else if (circuitId == JURISDICTION_ID) {
            if (n != 1) return _malformed(strict, "Invalid public inputs for jurisdiction circuit");
            return _verifyJurisdiction(proof.a, proof.b, proof.c, [pi[0]]);
        } else if (circuitId == ACCREDITATION_ID) {
            if (n != 1) return _malformed(strict, "Invalid public inputs for accreditation circuit");
            return _verifyAccreditation(proof.a, proof.b, proof.c, [pi[0]]);
        } else if (circuitId == COMPLIANCE_ID) {
            if (n != 6) return _malformed(strict, "Invalid public inputs for compliance circuit");
            return _verifyComplianceAggregation(
                proof.a, proof.b, proof.c, [pi[0], pi[1], pi[2], pi[3], pi[4], pi[5]]
            );
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
        IZKVerifier.Proof[] calldata proofs,
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
     * @dev Cache key for a verified proof, BOUND TO THE CIRCUIT that verified it.
     *      The key used to be keccak256(a, b, c, publicSignals) with no circuit id,
     *      and every verify* function checked that shared cache before calling its
     *      own verifier. Four circuits share the uint256[1] signal shape, so a proof
     *      verified once under whitelist satisfied verifyBlacklistNonMembership on
     *      the cache hit; the blacklist verifier was never called.
     */
    function _proofCacheKey(
        string memory circuit,
        uint256[2] memory a,
        uint256[2][2] memory b,
        uint256[2] memory c,
        bytes memory packedSignals
    ) internal view returns (bytes32) {
        // The verifier INSTANCE is part of the key, not just the label: a
        // proof accepted by the old verifier must not keep answering true from
        // the cache after updateVerifier swaps in a new one. A rotation now
        // invalidates every cached proof for that circuit at once.
        return keccak256(abi.encodePacked(circuit, _verifierFor(circuit), a, b, c, packedSignals));
    }

    /// @dev Cache key for a PLONK proof (24 words); same binding to circuit
    ///      tag and verifier instance as _proofCacheKey.
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
        if (h == keccak256("compliance") || h == keccak256("compliance-proof")) return address(complianceVerifier);
        return address(0);
    }

    /**
     * @notice Cache key of a PLONK whitelist proof (single and batch); see
     *         blacklistProofCacheKey, and proofCacheKey for the Groth16 circuits.
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
     * @notice Cache key for a Groth16 proof under a given circuit tag:
     *         "jurisdiction", "accreditation",
     *         "compliance" (6-signal aggregation) or "compliance-proof"
     *         (2-signal verifyComplianceProof). The key also folds in the
     *         verifier instance bound to that tag, so it changes after
     *         updateVerifier. Callers of clearExpiredProofs compute keys with this.
     */
    function proofCacheKey(
        string calldata circuit,
        uint256[2] calldata a,
        uint256[2][2] calldata b,
        uint256[2] calldata c,
        uint256[] calldata publicSignals
    ) external view returns (bytes32) {
        return _proofCacheKey(circuit, a, b, c, abi.encodePacked(publicSignals));
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
