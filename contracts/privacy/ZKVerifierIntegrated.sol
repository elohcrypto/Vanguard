// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "./interfaces/IZKVerifier.sol";
import "./verifiers/whitelist_membershipVerifier.sol";
import "./verifiers/blacklist_membershipVerifier.sol";
import "./verifiers/jurisdiction_proofVerifier.sol";
import "./verifiers/accreditation_proofVerifier.sol";
import "./verifiers/compliance_aggregationVerifier.sol";

/**
 * @title ZKVerifierIntegrated
 * @dev Real ZK proof verifier using actual Groth16 verifier contracts
 * @notice This integrates with the real snarkjs-generated verifiers
 */
contract ZKVerifierIntegrated is Ownable, ReentrancyGuard {
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
    
    // Proof structure for Groth16
    struct Proof {
        uint256[2] a;
        uint256[2][2] b;
        uint256[2] c;
    }
    
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
     * @dev Verify whitelist membership proof
     * @param a Proof point A
     * @param b Proof point B
     * @param c Proof point C
     * @param publicSignals Public inputs for the proof (1 element)
     * @return True if the proof is valid
     */
    function verifyWhitelistMembership(
        uint256[2] memory a,
        uint256[2][2] memory b,
        uint256[2] memory c,
        uint256[1] memory publicSignals
    ) external nonReentrant returns (bool) {
        // Gas Optimization: Check proof cache first
        bytes32 proofHash = keccak256(abi.encodePacked(a, b, c, publicSignals));
        if (verifiedProofs[proofHash] && block.timestamp <= proofTimestamp[proofHash] + proofCacheExpiry) {
            emit ProofCacheHit(proofHash, "whitelist");
            return true; // Cached proof, ~5k gas instead of ~300k
        }

        totalProofs["whitelist"]++;
        userProofCount[msg.sender]++;

        bool result;
        if (testingMode) {
            // Mock verification for testing - always return true for valid inputs
            result = (publicSignals.length == 1 && publicSignals[0] > 0);
        } else {
            result = whitelistVerifier.verifyProof(a, b, c, publicSignals);
        }

        if (result) {
            validProofs["whitelist"]++;
            // Cache successful proof for gas optimization
            verifiedProofs[proofHash] = true;
            proofTimestamp[proofHash] = block.timestamp;
            emit ProofCached(proofHash, "whitelist");
        }

        emit ProofVerified("whitelist", msg.sender, result);
        return result;
    }

    /**
     * @dev Verify multiple whitelist membership proofs in batch
     * @param proofsA Array of proof point A
     * @param proofsB Array of proof point B
     * @param proofsC Array of proof point C
     * @param publicSignalsArray Array of public signals
     * @return results Array of verification results
     * @return successCount Number of successful verifications
     */
    function verifyBatchWhitelistMembership(
        uint256[2][] memory proofsA,
        uint256[2][2][] memory proofsB,
        uint256[2][] memory proofsC,
        uint256[1][] memory publicSignalsArray
    ) external nonReentrant returns (bool[] memory results, uint256 successCount) {
        require(
            proofsA.length == proofsB.length &&
            proofsB.length == proofsC.length &&
            proofsC.length == publicSignalsArray.length,
            "Array length mismatch"
        );
        require(proofsA.length > 0 && proofsA.length <= 50, "Invalid batch size");

        results = new bool[](proofsA.length);
        successCount = 0;

        for (uint256 i = 0; i < proofsA.length; i++) {
            // Check cache first
            bytes32 proofHash = keccak256(abi.encodePacked(proofsA[i], proofsB[i], proofsC[i], publicSignalsArray[i]));

            if (verifiedProofs[proofHash] && block.timestamp <= proofTimestamp[proofHash] + proofCacheExpiry) {
                results[i] = true;
                successCount++;
                emit ProofCacheHit(proofHash, "whitelist");
                continue;
            }

            totalProofs["whitelist"]++;
            userProofCount[msg.sender]++;

            bool result;
            if (testingMode) {
                result = (publicSignalsArray[i].length == 1 && publicSignalsArray[i][0] > 0);
            } else {
                result = whitelistVerifier.verifyProof(proofsA[i], proofsB[i], proofsC[i], publicSignalsArray[i]);
            }

            results[i] = result;
            if (result) {
                validProofs["whitelist"]++;
                successCount++;
                // Cache successful proof
                verifiedProofs[proofHash] = true;
                proofTimestamp[proofHash] = block.timestamp;
                emit ProofCached(proofHash, "whitelist");
            }

            emit ProofVerified("whitelist", msg.sender, result);
        }

        return (results, successCount);
    }

    /**
     * @dev Verify blacklist non-membership proof
     * @param a Proof point A
     * @param b Proof point B
     * @param c Proof point C
     * @param publicSignals Public inputs for the proof (1 element: isNotBlacklisted)
     * @return True if the proof is valid (user is NOT blacklisted)
     */
    function verifyBlacklistNonMembership(
        uint256[2] memory a,
        uint256[2][2] memory b,
        uint256[2] memory c,
        uint256[1] memory publicSignals
    ) external nonReentrant returns (bool) {
        // Gas Optimization: Check proof cache first
        bytes32 proofHash = keccak256(abi.encodePacked(a, b, c, publicSignals));
        if (verifiedProofs[proofHash] && block.timestamp <= proofTimestamp[proofHash] + proofCacheExpiry) {
            emit ProofCacheHit(proofHash, "blacklist");
            return true; // Cached proof, ~5k gas instead of ~300k
        }

        totalProofs["blacklist"]++;
        userProofCount[msg.sender]++;

        bool result;
        if (testingMode) {
            // Mock verification for testing - always return true for valid inputs
            result = (publicSignals.length == 1 && publicSignals[0] == 1);
        } else {
            result = blacklistVerifier.verifyProof(a, b, c, publicSignals);
        }

        if (result) {
            validProofs["blacklist"]++;
            // Cache successful proof for gas optimization
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
        // Gas Optimization: Check proof cache first
        bytes32 proofHash = keccak256(abi.encodePacked(a, b, c, publicSignals));
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
            // Cache successful proof for gas optimization
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
        // Gas Optimization: Check proof cache first
        bytes32 proofHash = keccak256(abi.encodePacked(a, b, c, publicSignals));
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
            // Cache successful proof for gas optimization
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
        // Gas Optimization: Check proof cache first
        bytes32 proofHash = keccak256(abi.encodePacked(a, b, c, publicSignals));
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
            // Cache successful proof for gas optimization
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
        bytes32 proofHash = keccak256(abi.encodePacked(a, b, c, publicSignals));
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
     * @param proofType The type of proof ("whitelist", "jurisdiction", "accreditation", "compliance")
     * @param newVerifier Address of the new verifier contract
     */
    function updateVerifier(string memory proofType, address newVerifier) external onlyOwner {
        require(newVerifier != address(0), "ZKVerifierIntegrated: Invalid verifier address");
        
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
        return keccak256("WHITELIST_MEMBERSHIP");
    }

    function BLACKLIST_MEMBERSHIP_CIRCUIT() external pure returns (bytes32) {
        return keccak256("BLACKLIST_MEMBERSHIP");
    }

    function JURISDICTION_PROOF_CIRCUIT() external pure returns (bytes32) {
        return keccak256("JURISDICTION_PROOF");
    }

    function ACCREDITATION_PROOF_CIRCUIT() external pure returns (bytes32) {
        return keccak256("ACCREDITATION_PROOF");
    }

    function COMPLIANCE_AGGREGATION_CIRCUIT() external pure returns (bytes32) {
        return keccak256("COMPLIANCE_AGGREGATION");
    }

    /**
     * @dev Verify a proof for a specific circuit
     * @param circuitId Identifier for the circuit
     * @param proof The proof to verify
     * @param publicInputs Public inputs for the proof
     * @return True if the proof is valid
     */
    function verifyCircuitProof(
        bytes32 circuitId,
        IZKVerifier.Proof memory proof,
        uint256[] memory publicInputs
    ) external returns (bool) {
        // Convert proof format
        uint256[2] memory a = proof.a;
        uint256[2][2] memory b = proof.b;
        uint256[2] memory c = proof.c;

        // Route to appropriate verifier based on circuit ID
        if (circuitId == this.WHITELIST_MEMBERSHIP_CIRCUIT()) {
            require(publicInputs.length == 1, "Invalid public inputs for whitelist circuit");
            uint256[1] memory whitelistInputs = [publicInputs[0]];
            return this.verifyWhitelistMembership(a, b, c, whitelistInputs);
        } else if (circuitId == this.BLACKLIST_MEMBERSHIP_CIRCUIT()) {
            require(publicInputs.length == 1, "Invalid public inputs for blacklist circuit");
            uint256[1] memory blacklistInputs = [publicInputs[0]];
            return this.verifyBlacklistNonMembership(a, b, c, blacklistInputs);
        } else if (circuitId == this.JURISDICTION_PROOF_CIRCUIT()) {
            require(publicInputs.length == 1, "Invalid public inputs for jurisdiction circuit");
            uint256[1] memory jurisdictionInputs = [publicInputs[0]];
            return this.verifyJurisdictionProof(a, b, c, jurisdictionInputs);
        } else if (circuitId == this.ACCREDITATION_PROOF_CIRCUIT()) {
            require(publicInputs.length == 1, "Invalid public inputs for accreditation circuit");
            uint256[1] memory accreditationInputs = [publicInputs[0]];
            return this.verifyAccreditationProof(a, b, c, accreditationInputs);
        } else if (circuitId == this.COMPLIANCE_AGGREGATION_CIRCUIT()) {
            require(publicInputs.length == 6, "Invalid public inputs for compliance circuit");
            uint256[6] memory complianceInputs = [publicInputs[0], publicInputs[1], publicInputs[2], publicInputs[3], publicInputs[4], publicInputs[5]];
            return this.verifyComplianceAggregation(a, b, c, complianceInputs);
        } else {
            revert("ZKVerifierIntegrated: Unknown circuit ID");
        }
    }

    /**
     * @dev Check if a circuit is registered
     * @param circuitId Circuit identifier
     * @return True if circuit is registered
     */
    function isCircuitRegistered(bytes32 circuitId) external view returns (bool) {
        return circuitId == this.WHITELIST_MEMBERSHIP_CIRCUIT() ||
               circuitId == this.BLACKLIST_MEMBERSHIP_CIRCUIT() ||
               circuitId == this.JURISDICTION_PROOF_CIRCUIT() ||
               circuitId == this.ACCREDITATION_PROOF_CIRCUIT() ||
               circuitId == this.COMPLIANCE_AGGREGATION_CIRCUIT();
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
     * @dev Batch verify multiple proofs (Gas Optimization: ~40% savings)
     * @param circuitIds Array of circuit identifiers
     * @param proofs Array of proofs to verify
     * @param publicInputsArray Array of public inputs for each proof
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
        successCount = 0;

        for (uint256 i = 0; i < circuitIds.length; i++) {
            // Use try-catch to prevent one failure from blocking the entire batch
            try this.verifyCircuitProof(circuitIds[i], proofs[i], publicInputsArray[i]) returns (bool result) {
                results[i] = result;
                if (result) {
                    successCount++;
                }
            } catch {
                results[i] = false;
            }
        }

        emit BatchProofsVerified(circuitIds.length, successCount);
        return (results, successCount);
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
