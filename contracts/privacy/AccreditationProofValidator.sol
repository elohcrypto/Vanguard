// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "./interfaces/IZKVerifier.sol";

/**
 * @title AccreditationProofValidator
 * @dev Validator for private accreditation verification without revealing details
 */
contract AccreditationProofValidator is Ownable, ReentrancyGuard {
    IZKVerifier public zkVerifier;

    struct AccreditationProof {
        uint256 minimumAccreditation;
        uint256 proofCommitment;
        IZKVerifier.Proof zkProof;
        uint256 timestamp;
        bool isValid;
    }

    struct AccreditationTier {
        string name;
        uint256 minimumAmount;
        uint256 validityPeriod;
        bool isActive;
    }

    // Storage
    mapping(address => AccreditationProof) public userAccreditationProofs;
    mapping(uint256 => AccreditationTier) public accreditationTiers;
    mapping(address => uint256) public userAccreditationLevels;

    // Configuration
    uint256 public constant PROOF_VALIDITY_PERIOD = 30 days;
    uint256 public constant MAX_ACCREDITATION_TIERS = 10;
    uint256 public nextTierId;

    // Events
    event AccreditationProofSubmitted(
        address indexed user,
        uint256 minimumAccreditation,
        uint256 proofCommitment,
        uint256 timestamp,
        bool isValid
    );

    event AccreditationTierCreated(uint256 indexed tierId, string name, uint256 minimumAmount, uint256 validityPeriod);

    event AccreditationTierUpdated(
        uint256 indexed tierId,
        uint256 minimumAmount,
        uint256 validityPeriod,
        bool isActive
    );

    event UserAccreditationLevelUpdated(address indexed user, uint256 oldLevel, uint256 newLevel);

    constructor(address _zkVerifier) Ownable(msg.sender) {
        require(_zkVerifier != address(0), "AccreditationProofValidator: Invalid ZK verifier");
        zkVerifier = IZKVerifier(_zkVerifier);
        nextTierId = 1;

        // Initialize default accreditation tiers
        _initializeDefaultTiers();
    }

    /**
     * @dev Submit accreditation proof without revealing actual amount
     * @param minimumAccreditation Minimum accreditation level being proven
     * @param proofCommitment Commitment to the actual accreditation amount
     * @param zkProof Zero-knowledge proof of accreditation
     * @return True if proof is valid
     */
    function submitAccreditationProof(
        uint256 minimumAccreditation,
        uint256 proofCommitment,
        IZKVerifier.Proof memory zkProof
    ) external nonReentrant returns (bool) {
        require(minimumAccreditation > 0, "AccreditationProofValidator: Invalid minimum accreditation");
        require(proofCommitment != 0, "AccreditationProofValidator: Invalid proof commitment");

        // Prepare public inputs for ZK proof verification
        uint256[] memory publicInputs = new uint256[](2);
        publicInputs[0] = minimumAccreditation;
        publicInputs[1] = proofCommitment;

        // Verify the zero-knowledge proof
        bool isValid = zkVerifier.verifyCircuitProof(zkVerifier.ACCREDITATION_PROOF_CIRCUIT(), zkProof, publicInputs);

        // Store the proof
        userAccreditationProofs[msg.sender] = AccreditationProof({
            minimumAccreditation: minimumAccreditation,
            proofCommitment: proofCommitment,
            zkProof: zkProof,
            timestamp: block.timestamp,
            isValid: isValid
        });

        emit AccreditationProofSubmitted(msg.sender, minimumAccreditation, proofCommitment, block.timestamp, isValid);

        return isValid;
    }

    /**
     * @dev Verify user's accreditation level
     * @param user User address
     * @param requiredLevel Required accreditation level
     * @return True if user meets the required accreditation level
     */
    function verifyAccreditationLevel(address user, uint256 requiredLevel) external view returns (bool) {
        AccreditationProof storage proof = userAccreditationProofs[user];

        // Check if proof exists and is valid
        if (proof.timestamp == 0 || !proof.isValid) {
            return false;
        }

        // Check if proof is still valid (not expired)
        if (block.timestamp > proof.timestamp + PROOF_VALIDITY_PERIOD) {
            return false;
        }

        // Check if user's proven minimum accreditation meets the requirement
        return proof.minimumAccreditation >= requiredLevel;
    }

    /**
     * @dev Verify user meets accreditation tier requirements
     * @param user User address
     * @param tierId Accreditation tier ID
     * @return True if user meets the tier requirements
     */
    function verifyAccreditationTier(address user, uint256 tierId) external view returns (bool) {
        require(tierId > 0 && tierId < nextTierId, "AccreditationProofValidator: Invalid tier ID");

        AccreditationTier storage tier = accreditationTiers[tierId];
        require(tier.isActive, "AccreditationProofValidator: Tier not active");

        return this.verifyAccreditationLevel(user, tier.minimumAmount);
    }

    /**
     * @dev Get user's highest verified accreditation tier
     * @param user User address
     * @return tierId Highest tier ID user qualifies for (0 if none)
     * @return tierName Name of the tier
     * @return minimumAmount Minimum amount for the tier
     */
    function getUserHighestTier(
        address user
    ) external view returns (uint256 tierId, string memory tierName, uint256 minimumAmount) {
        AccreditationProof storage proof = userAccreditationProofs[user];

        if (proof.timestamp == 0 || !proof.isValid || block.timestamp > proof.timestamp + PROOF_VALIDITY_PERIOD) {
            return (0, "", 0);
        }

        // Find highest tier user qualifies for
        uint256 highestTier = 0;
        for (uint256 i = 1; i < nextTierId; i++) {
            AccreditationTier storage tier = accreditationTiers[i];
            if (tier.isActive && proof.minimumAccreditation >= tier.minimumAmount) {
                highestTier = i;
            }
        }

        if (highestTier > 0) {
            AccreditationTier storage tier = accreditationTiers[highestTier];
            return (highestTier, tier.name, tier.minimumAmount);
        }

        return (0, "", 0);
    }

    /**
     * @dev Create new accreditation tier
     * @param name Tier name
     * @param minimumAmount Minimum accreditation amount
     * @param validityPeriod Validity period for proofs in this tier
     * @return tierId New tier ID
     */
    function createAccreditationTier(
        string memory name,
        uint256 minimumAmount,
        uint256 validityPeriod
    ) external onlyOwner returns (uint256 tierId) {
        require(bytes(name).length > 0, "AccreditationProofValidator: Empty tier name");
        require(minimumAmount > 0, "AccreditationProofValidator: Invalid minimum amount");
        require(validityPeriod > 0, "AccreditationProofValidator: Invalid validity period");
        require(nextTierId <= MAX_ACCREDITATION_TIERS, "AccreditationProofValidator: Too many tiers");

        tierId = nextTierId++;

        accreditationTiers[tierId] = AccreditationTier({
            name: name,
            minimumAmount: minimumAmount,
            validityPeriod: validityPeriod,
            isActive: true
        });

        emit AccreditationTierCreated(tierId, name, minimumAmount, validityPeriod);
    }

    /**
     * @dev Update accreditation tier
     * @param tierId Tier ID to update
     * @param minimumAmount New minimum amount
     * @param validityPeriod New validity period
     * @param isActive New active status
     */
    function updateAccreditationTier(
        uint256 tierId,
        uint256 minimumAmount,
        uint256 validityPeriod,
        bool isActive
    ) external onlyOwner {
        require(tierId > 0 && tierId < nextTierId, "AccreditationProofValidator: Invalid tier ID");
        require(minimumAmount > 0, "AccreditationProofValidator: Invalid minimum amount");
        require(validityPeriod > 0, "AccreditationProofValidator: Invalid validity period");

        AccreditationTier storage tier = accreditationTiers[tierId];
        tier.minimumAmount = minimumAmount;
        tier.validityPeriod = validityPeriod;
        tier.isActive = isActive;

        emit AccreditationTierUpdated(tierId, minimumAmount, validityPeriod, isActive);
    }

    /**
     * @dev Set user's accreditation level (admin function)
     * @param user User address
     * @param level Accreditation level
     */
    function setUserAccreditationLevel(address user, uint256 level) external onlyOwner {
        uint256 oldLevel = userAccreditationLevels[user];
        userAccreditationLevels[user] = level;

        emit UserAccreditationLevelUpdated(user, oldLevel, level);
    }

    /**
     * @dev Get user's accreditation proof information
     * @param user User address
     * @return minimumAccreditation Minimum accreditation proven
     * @return proofCommitment Proof commitment
     * @return timestamp Proof submission timestamp
     * @return isValid True if proof is valid
     * @return isExpired True if proof is expired
     */
    function getUserAccreditationProof(
        address user
    )
        external
        view
        returns (uint256 minimumAccreditation, uint256 proofCommitment, uint256 timestamp, bool isValid, bool isExpired)
    {
        AccreditationProof storage proof = userAccreditationProofs[user];
        minimumAccreditation = proof.minimumAccreditation;
        proofCommitment = proof.proofCommitment;
        timestamp = proof.timestamp;
        isValid = proof.isValid;
        isExpired = timestamp > 0 && block.timestamp > timestamp + PROOF_VALIDITY_PERIOD;
    }

    /**
     * @dev Get accreditation tier information
     * @param tierId Tier ID
     * @return name Tier name
     * @return minimumAmount Minimum amount for tier
     * @return validityPeriod Validity period for tier
     * @return isActive True if tier is active
     */
    function getAccreditationTier(
        uint256 tierId
    ) external view returns (string memory name, uint256 minimumAmount, uint256 validityPeriod, bool isActive) {
        require(tierId > 0 && tierId < nextTierId, "AccreditationProofValidator: Invalid tier ID");

        AccreditationTier storage tier = accreditationTiers[tierId];
        name = tier.name;
        minimumAmount = tier.minimumAmount;
        validityPeriod = tier.validityPeriod;
        isActive = tier.isActive;
    }

    /**
     * @dev Get all active accreditation tiers
     * @return tierIds Array of active tier IDs
     * @return names Array of tier names
     * @return minimumAmounts Array of minimum amounts
     */
    function getActiveAccreditationTiers()
        external
        view
        returns (uint256[] memory tierIds, string[] memory names, uint256[] memory minimumAmounts)
    {
        // Count active tiers
        uint256 activeCount = 0;
        for (uint256 i = 1; i < nextTierId; i++) {
            if (accreditationTiers[i].isActive) {
                activeCount++;
            }
        }

        // Populate arrays
        tierIds = new uint256[](activeCount);
        names = new string[](activeCount);
        minimumAmounts = new uint256[](activeCount);

        uint256 index = 0;
        for (uint256 i = 1; i < nextTierId; i++) {
            if (accreditationTiers[i].isActive) {
                tierIds[index] = i;
                names[index] = accreditationTiers[i].name;
                minimumAmounts[index] = accreditationTiers[i].minimumAmount;
                index++;
            }
        }
    }

    /**
     * @dev Batch verify accreditation levels for multiple users
     * @param users Array of user addresses
     * @param requiredLevel Required accreditation level
     * @return results Array of verification results
     */
    function batchVerifyAccreditationLevel(
        address[] calldata users,
        uint256 requiredLevel
    ) external view returns (bool[] memory results) {
        results = new bool[](users.length);

        for (uint256 i = 0; i < users.length; i++) {
            results[i] = this.verifyAccreditationLevel(users[i], requiredLevel);
        }
    }

    /**
     * @dev Initialize default accreditation tiers
     */
    function _initializeDefaultTiers() internal {
        // Retail Investor
        accreditationTiers[nextTierId++] = AccreditationTier({
            name: "Retail Investor",
            minimumAmount: 1000, // $1,000
            validityPeriod: 30 days,
            isActive: true
        });

        // Qualified Investor
        accreditationTiers[nextTierId++] = AccreditationTier({
            name: "Qualified Investor",
            minimumAmount: 50000, // $50,000
            validityPeriod: 60 days,
            isActive: true
        });

        // Accredited Investor
        accreditationTiers[nextTierId++] = AccreditationTier({
            name: "Accredited Investor",
            minimumAmount: 100000, // $100,000
            validityPeriod: 90 days,
            isActive: true
        });

        // High Net Worth
        accreditationTiers[nextTierId++] = AccreditationTier({
            name: "High Net Worth",
            minimumAmount: 1000000, // $1,000,000
            validityPeriod: 180 days,
            isActive: true
        });

        // Ultra High Net Worth
        accreditationTiers[nextTierId++] = AccreditationTier({
            name: "Ultra High Net Worth",
            minimumAmount: 10000000, // $10,000,000
            validityPeriod: 365 days,
            isActive: true
        });
    }
}
