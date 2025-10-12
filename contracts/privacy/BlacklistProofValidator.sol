// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "./interfaces/IZKVerifier.sol";
import "./ZKVerifierIntegrated.sol";
import "./PrivacyManager.sol";

/**
 * @title BlacklistProofValidator
 * @dev Validator for blacklist non-membership proofs using zero-knowledge proofs
 * @notice Allows users to prove they are NOT on a blacklist without revealing identity
 */
contract BlacklistProofValidator is Ownable, ReentrancyGuard {
    IZKVerifier public zkVerifier;
    PrivacyManager public privacyManager;

    struct BlacklistProof {
        bytes32 blacklistRoot;
        uint256 nullifierHash;
        uint256 challengeHash;
        IZKVerifier.Proof zkProof;
        uint256 timestamp;
        bool isUsed;
    }

    struct NonMembershipCommitment {
        bytes32 commitment;
        uint256 validityPeriod;
        uint256 expiryTime;
        bool isActive;
    }

    // Storage
    mapping(address => BlacklistProof) public userBlacklistProofs;
    mapping(bytes32 => bool) public usedNullifiers;
    mapping(bytes32 => NonMembershipCommitment) public nonMembershipCommitments;
    mapping(address => bytes32[]) public userCommitments;

    // Blacklist management
    bytes32 public currentBlacklistRoot;
    mapping(bytes32 => bool) public validBlacklistRoots;
    bytes32[] public blacklistRootHistory;

    // Configuration
    uint256 public constant PROOF_VALIDITY_PERIOD = 24 hours;
    uint256 public constant CHALLENGE_VALIDITY_PERIOD = 1 hours;
    uint256 public proofCount;

    // Events
    event BlacklistProofSubmitted(
        address indexed user,
        bytes32 indexed blacklistRoot,
        uint256 nullifierHash,
        uint256 challengeHash,
        uint256 timestamp
    );

    event NonMembershipCommitmentCreated(bytes32 indexed commitment, uint256 validityPeriod, uint256 expiryTime);

    event BlacklistRootUpdated(bytes32 indexed oldRoot, bytes32 indexed newRoot, uint256 timestamp);

    event NullifierUsed(bytes32 indexed nullifier, address indexed user);

    modifier validBlacklistRoot(bytes32 root) {
        require(validBlacklistRoots[root], "BlacklistProofValidator: Invalid blacklist root");
        _;
    }

    modifier unusedNullifier(uint256 nullifierHash) {
        bytes32 nullifier = bytes32(nullifierHash);
        require(!usedNullifiers[nullifier], "BlacklistProofValidator: Nullifier already used");
        _;
    }

    modifier validChallenge(uint256 challengeHash) {
        require(challengeHash != 0, "BlacklistProofValidator: Invalid challenge");
        _;
    }

    constructor(address _zkVerifier, address _privacyManager) Ownable(msg.sender) {
        require(_zkVerifier != address(0), "BlacklistProofValidator: Invalid ZK verifier");
        require(_privacyManager != address(0), "BlacklistProofValidator: Invalid privacy manager");
        
        zkVerifier = IZKVerifier(_zkVerifier);
        privacyManager = PrivacyManager(_privacyManager);
        
        // Initialize with empty blacklist root
        currentBlacklistRoot = keccak256("EMPTY_BLACKLIST");
        validBlacklistRoots[currentBlacklistRoot] = true;
        blacklistRootHistory.push(currentBlacklistRoot);
    }

    /**
     * @dev Submit a zero-knowledge proof of blacklist non-membership
     * @param blacklistRoot Merkle root of the blacklist
     * @param nullifierHash Nullifier to prevent double-spending
     * @param challengeHash Challenge hash for non-membership proof
     * @param zkProof Zero-knowledge proof
     * @return True if proof is valid and accepted
     */
    function submitBlacklistProof(
        bytes32 blacklistRoot,
        uint256 nullifierHash,
        uint256 challengeHash,
        IZKVerifier.Proof memory zkProof
    ) external 
        validBlacklistRoot(blacklistRoot) 
        unusedNullifier(nullifierHash) 
        validChallenge(challengeHash)
        nonReentrant 
        returns (bool) 
    {
        // Prepare public inputs for ZK proof verification
        // Note: The circuit outputs isNotBlacklisted (1 if user is NOT in blacklist)
        // The blacklistRoot, nullifierHash, and challengeHash are private inputs to the circuit
        uint256[1] memory publicInputs = [uint256(1)]; // Expected output: user is NOT blacklisted

        // Verify the zero-knowledge proof using integrated verifier
        bool isValid = ZKVerifierIntegrated(address(zkVerifier)).verifyBlacklistNonMembership(
            zkProof.a,
            zkProof.b,
            zkProof.c,
            publicInputs
        );

        require(isValid, "BlacklistProofValidator: Invalid ZK proof");

        // Mark nullifier as used
        bytes32 nullifier = bytes32(nullifierHash);
        usedNullifiers[nullifier] = true;

        // Store the proof
        userBlacklistProofs[msg.sender] = BlacklistProof({
            blacklistRoot: blacklistRoot,
            nullifierHash: nullifierHash,
            challengeHash: challengeHash,
            zkProof: zkProof,
            timestamp: block.timestamp,
            isUsed: true
        });

        proofCount++;

        emit BlacklistProofSubmitted(msg.sender, blacklistRoot, nullifierHash, challengeHash, block.timestamp);
        emit NullifierUsed(nullifier, msg.sender);

        return true;
    }

    /**
     * @dev Verify if user has valid blacklist non-membership proof
     * @param user User address to check
     * @return True if user has valid proof of not being blacklisted
     */
    function hasValidBlacklistProof(address user) external view returns (bool) {
        BlacklistProof storage proof = userBlacklistProofs[user];
        
        return proof.isUsed && 
               block.timestamp <= proof.timestamp + PROOF_VALIDITY_PERIOD &&
               validBlacklistRoots[proof.blacklistRoot];
    }

    /**
     * @dev Create a non-membership commitment for privacy-preserving verification
     * @param commitment Hash commitment of non-membership details
     * @param validityPeriod Validity period for the commitment
     */
    function createNonMembershipCommitment(bytes32 commitment, uint256 validityPeriod) external onlyOwner {
        require(validityPeriod > 0 && validityPeriod <= 365 days, "BlacklistProofValidator: Invalid validity period");
        require(!nonMembershipCommitments[commitment].isActive, "BlacklistProofValidator: Commitment already exists");

        uint256 expiryTime = block.timestamp + validityPeriod;

        nonMembershipCommitments[commitment] = NonMembershipCommitment({
            commitment: commitment,
            validityPeriod: validityPeriod,
            expiryTime: expiryTime,
            isActive: true
        });

        emit NonMembershipCommitmentCreated(commitment, validityPeriod, expiryTime);
    }

    /**
     * @dev Update blacklist merkle root
     * @param newRoot New blacklist merkle root
     */
    function updateBlacklistRoot(bytes32 newRoot) external onlyOwner {
        require(newRoot != bytes32(0), "BlacklistProofValidator: Invalid root");
        require(!validBlacklistRoots[newRoot], "BlacklistProofValidator: Root already exists");

        bytes32 oldRoot = currentBlacklistRoot;
        currentBlacklistRoot = newRoot;
        validBlacklistRoots[newRoot] = true;
        blacklistRootHistory.push(newRoot);

        emit BlacklistRootUpdated(oldRoot, newRoot, block.timestamp);
    }

    /**
     * @dev Invalidate old blacklist root
     * @param root Root to invalidate
     */
    function invalidateBlacklistRoot(bytes32 root) external onlyOwner {
        require(validBlacklistRoots[root], "BlacklistProofValidator: Root not valid");
        require(root != currentBlacklistRoot, "BlacklistProofValidator: Cannot invalidate current root");
        
        validBlacklistRoots[root] = false;
    }

    /**
     * @dev Get user's blacklist proof information
     * @param user User address
     * @return blacklistRoot Blacklist root used in proof
     * @return nullifierHash Nullifier hash
     * @return challengeHash Challenge hash
     * @return timestamp Proof submission timestamp
     * @return isValid True if proof is still valid
     */
    function getUserProofInfo(
        address user
    ) external view returns (
        bytes32 blacklistRoot, 
        uint256 nullifierHash, 
        uint256 challengeHash,
        uint256 timestamp, 
        bool isValid
    ) {
        BlacklistProof storage proof = userBlacklistProofs[user];
        blacklistRoot = proof.blacklistRoot;
        nullifierHash = proof.nullifierHash;
        challengeHash = proof.challengeHash;
        timestamp = proof.timestamp;

        isValid = proof.isUsed &&
                  block.timestamp <= proof.timestamp + PROOF_VALIDITY_PERIOD &&
                  validBlacklistRoots[proof.blacklistRoot];
    }

    /**
     * @dev Get blacklist root history
     * @return Array of historical blacklist roots
     */
    function getBlacklistRootHistory() external view returns (bytes32[] memory) {
        return blacklistRootHistory;
    }

    /**
     * @dev Check if nullifier has been used
     * @param nullifierHash Nullifier hash to check
     * @return True if nullifier has been used
     */
    function isNullifierUsed(uint256 nullifierHash) external view returns (bool) {
        return usedNullifiers[bytes32(nullifierHash)];
    }

    /**
     * @dev Get total number of proofs submitted
     * @return Total proof count
     */
    function getTotalProofs() external view returns (uint256) {
        return proofCount;
    }

    /**
     * @dev Generate challenge hash for non-membership proof
     * @param user User address
     * @param timestamp Current timestamp
     * @return Challenge hash
     */
    function generateChallengeHash(address user, uint256 timestamp) external pure returns (uint256) {
        return uint256(keccak256(abi.encodePacked(user, timestamp, "BLACKLIST_CHALLENGE")));
    }
}
