// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";
import "./interfaces/IZKVerifier.sol";
import "./ZKVerifierIntegrated.sol";
import "./PrivacyManager.sol";

/**
 * @title ComplianceProofValidator
 * @dev Validator for whitelist membership proofs using zero-knowledge proofs
 */
contract ComplianceProofValidator is Ownable, ReentrancyGuard {
    IZKVerifier public zkVerifier;
    PrivacyManager public privacyManager;

    struct WhitelistProof {
        bytes32 merkleRoot;
        uint256 nullifierHash;
        IZKVerifier.Proof zkProof;
        uint256 timestamp;
        bool isUsed;
    }

    struct MembershipCommitment {
        bytes32 commitment;
        uint256 tier;
        uint256 expiryTime;
        bool isActive;
    }

    // Storage
    mapping(address => WhitelistProof) public userWhitelistProofs;
    mapping(bytes32 => bool) public usedNullifiers;
    mapping(bytes32 => MembershipCommitment) public membershipCommitments;
    mapping(address => bytes32[]) public userCommitments;

    // Whitelist management
    bytes32 public currentWhitelistRoot;
    mapping(bytes32 => bool) public validWhitelistRoots;
    bytes32[] public whitelistRootHistory;

    // Configuration
    uint256 public constant PROOF_VALIDITY_PERIOD = 24 hours;
    uint256 public constant MAX_TIER = 5;
    uint256 public proofCount;

    // Events
    event WhitelistProofSubmitted(
        address indexed user,
        bytes32 indexed merkleRoot,
        uint256 nullifierHash,
        uint256 timestamp
    );

    event MembershipCommitmentCreated(bytes32 indexed commitment, uint256 tier, uint256 expiryTime);

    event WhitelistRootUpdated(bytes32 indexed oldRoot, bytes32 indexed newRoot, uint256 timestamp);

    event NullifierUsed(bytes32 indexed nullifier, address indexed user);

    modifier validMerkleRoot(bytes32 root) {
        require(validWhitelistRoots[root], "ComplianceProofValidator: Invalid merkle root");
        _;
    }

    modifier unusedNullifier(uint256 nullifierHash) {
        bytes32 nullifier = bytes32(nullifierHash);
        require(!usedNullifiers[nullifier], "ComplianceProofValidator: Nullifier already used");
        _;
    }

    constructor(address _zkVerifier, address _privacyManager) Ownable(msg.sender) {
        require(_zkVerifier != address(0), "ComplianceProofValidator: Invalid ZK verifier");
        require(_privacyManager != address(0), "ComplianceProofValidator: Invalid privacy manager");

        zkVerifier = IZKVerifier(_zkVerifier);
        privacyManager = PrivacyManager(_privacyManager);

        // Initialize with empty root
        currentWhitelistRoot = bytes32(0);
        validWhitelistRoots[bytes32(0)] = true;
        whitelistRootHistory.push(bytes32(0));
    }

    /**
     * @dev Submit a zero-knowledge proof of whitelist membership
     * @param merkleRoot Merkle root of the whitelist
     * @param nullifierHash Nullifier to prevent double-spending
     * @param zkProof Zero-knowledge proof
     * @return True if proof is valid and accepted
     */
    function submitWhitelistProof(
        bytes32 merkleRoot,
        uint256 nullifierHash,
        IZKVerifier.Proof memory zkProof
    ) external validMerkleRoot(merkleRoot) unusedNullifier(nullifierHash) nonReentrant returns (bool) {
        // Prepare public inputs for ZK proof verification (whitelist only needs nullifier)
        uint256[1] memory publicInputs = [nullifierHash];

        // Verify the zero-knowledge proof using integrated verifier
        bool isValid = ZKVerifierIntegrated(address(zkVerifier)).verifyWhitelistMembership(
            zkProof.a,
            zkProof.b,
            zkProof.c,
            publicInputs
        );

        require(isValid, "ComplianceProofValidator: Invalid ZK proof");

        // Mark nullifier as used
        bytes32 nullifier = bytes32(nullifierHash);
        usedNullifiers[nullifier] = true;

        // Store the proof
        userWhitelistProofs[msg.sender] = WhitelistProof({
            merkleRoot: merkleRoot,
            nullifierHash: nullifierHash,
            zkProof: zkProof,
            timestamp: block.timestamp,
            isUsed: true
        });

        proofCount++;

        emit WhitelistProofSubmitted(msg.sender, merkleRoot, nullifierHash, block.timestamp);
        emit NullifierUsed(nullifier, msg.sender);

        return true;
    }

    /**
     * @dev Verify if user has valid whitelist membership proof
     * @param user User address
     * @return True if user has valid proof
     */
    function verifyWhitelistMembership(address user) public view returns (bool) {
        WhitelistProof storage proof = userWhitelistProofs[user];

        if (proof.timestamp == 0 || !proof.isUsed) {
            return false;
        }

        // Check if proof is still valid (not expired)
        if (block.timestamp > proof.timestamp + PROOF_VALIDITY_PERIOD) {
            return false;
        }

        // Check if the merkle root is still valid
        return validWhitelistRoots[proof.merkleRoot];
    }

    /**
     * @dev Create a membership commitment for privacy-preserving verification
     * @param commitment Hash commitment of membership details
     * @param tier Membership tier (1-5)
     * @param expiryTime Expiry timestamp for the commitment
     */
    function createMembershipCommitment(bytes32 commitment, uint256 tier, uint256 expiryTime) external onlyOwner {
        require(tier > 0 && tier <= MAX_TIER, "ComplianceProofValidator: Invalid tier");
        require(expiryTime > block.timestamp, "ComplianceProofValidator: Invalid expiry time");
        require(!membershipCommitments[commitment].isActive, "ComplianceProofValidator: Commitment already exists");

        membershipCommitments[commitment] = MembershipCommitment({
            commitment: commitment,
            tier: tier,
            expiryTime: expiryTime,
            isActive: true
        });

        emit MembershipCommitmentCreated(commitment, tier, expiryTime);
    }

    /**
     * @dev Verify membership commitment
     * @param commitment Hash commitment to verify
     * @return isValid True if commitment is valid
     * @return tier Membership tier
     * @return expiryTime Expiry timestamp
     */
    function verifyMembershipCommitment(
        bytes32 commitment
    ) external view returns (bool isValid, uint256 tier, uint256 expiryTime) {
        MembershipCommitment storage membershipCommit = membershipCommitments[commitment];

        isValid = membershipCommit.isActive && block.timestamp <= membershipCommit.expiryTime;
        tier = membershipCommit.tier;
        expiryTime = membershipCommit.expiryTime;
    }

    /**
     * @dev Update whitelist merkle root
     * @param newRoot New merkle root
     */
    function updateWhitelistRoot(bytes32 newRoot) external onlyOwner {
        require(newRoot != bytes32(0), "ComplianceProofValidator: Invalid root");
        require(!validWhitelistRoots[newRoot], "ComplianceProofValidator: Root already exists");

        bytes32 oldRoot = currentWhitelistRoot;
        currentWhitelistRoot = newRoot;
        validWhitelistRoots[newRoot] = true;
        whitelistRootHistory.push(newRoot);

        emit WhitelistRootUpdated(oldRoot, newRoot, block.timestamp);
    }

    /**
     * @dev Invalidate old whitelist root
     * @param root Root to invalidate
     */
    function invalidateWhitelistRoot(bytes32 root) external onlyOwner {
        require(validWhitelistRoots[root], "ComplianceProofValidator: Root not valid");
        require(root != currentWhitelistRoot, "ComplianceProofValidator: Cannot invalidate current root");

        validWhitelistRoots[root] = false;
    }

    /**
     * @dev Get user's whitelist proof information
     * @param user User address
     * @return merkleRoot Merkle root used in proof
     * @return nullifierHash Nullifier hash
     * @return timestamp Proof submission timestamp
     * @return isValid True if proof is still valid
     */
    function getUserProofInfo(
        address user
    ) external view returns (bytes32 merkleRoot, uint256 nullifierHash, uint256 timestamp, bool isValid) {
        WhitelistProof storage proof = userWhitelistProofs[user];
        merkleRoot = proof.merkleRoot;
        nullifierHash = proof.nullifierHash;
        timestamp = proof.timestamp;

        isValid =
            proof.isUsed &&
            block.timestamp <= proof.timestamp + PROOF_VALIDITY_PERIOD &&
            validWhitelistRoots[proof.merkleRoot];
    }

    /**
     * @dev Get whitelist root history
     * @return Array of historical merkle roots
     */
    function getWhitelistRootHistory() external view returns (bytes32[] memory) {
        return whitelistRootHistory;
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
    function getTotalProofCount() external view returns (uint256) {
        return proofCount;
    }

    /**
     * @dev Get total number of proofs submitted (alias for compatibility)
     * @return Total proof count
     */
    function getTotalProofs() external view returns (uint256) {
        return proofCount;
    }

    /**
     * @dev Check if user has valid whitelist proof
     * @param user Address to check
     * @return True if user has valid proof
     */
    function hasValidWhitelistProof(address user) external view returns (bool) {
        return verifyWhitelistMembership(user);
    }

    /**
     * @dev Batch verify multiple users' whitelist membership
     * @param users Array of user addresses
     * @return results Array of verification results
     */
    function batchVerifyWhitelistMembership(address[] calldata users) external view returns (bool[] memory results) {
        results = new bool[](users.length);

        for (uint256 i = 0; i < users.length; i++) {
            results[i] = this.verifyWhitelistMembership(users[i]);
        }
    }

    /**
     * @dev Emergency function to clear expired proofs
     * @param users Array of user addresses to clean up
     */
    function cleanupExpiredProofs(address[] calldata users) external onlyOwner {
        for (uint256 i = 0; i < users.length; i++) {
            WhitelistProof storage proof = userWhitelistProofs[users[i]];

            if (proof.timestamp > 0 && block.timestamp > proof.timestamp + PROOF_VALIDITY_PERIOD) {
                // Clear the proof
                delete userWhitelistProofs[users[i]];
            }
        }
    }
}
