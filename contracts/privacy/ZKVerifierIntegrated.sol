// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "./interfaces/IZKVerifier.sol";
import "./ZKVerifierAdmin.sol";


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
contract ZKVerifierIntegrated is ZKVerifierAdmin, ReentrancyGuard {
    /**
     * @param _testingMode True for mock verification (testnet), false for real ZK verification (mainnet)
     * @notice testingMode is IMMUTABLE and cannot be changed after deployment
     * @notice Deploy with testingMode=true for testing, testingMode=false for production
     */
    constructor(bool _testingMode) Ownable(msg.sender) ZKVerifierAdmin(_testingMode) {}

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
}
