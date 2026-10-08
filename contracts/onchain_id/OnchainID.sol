// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./OnchainIDOwnership.sol";

/**
 * @title OnchainID
 * @dev OnchainID: ERC-734 keys (OnchainIDKeys, OnchainIDOwnership) and
 *      ERC-735 claims (here).
 *      Claims are stored for the identity; whether a wallet is verified is
 *      decided by IdentityRegistry, which asks each trusted ClaimIssuer
 *      (ClaimIssuer.hasValidClaim) and never reads these lists.
 * @author CMTA UTXO Compliance Team
 */
contract OnchainID is OnchainIDOwnership {
    // Claim topics
    uint256 public constant IDENTITY_TOPIC = 1;
    uint256 public constant BIOMETRIC_TOPIC = 2;
    uint256 public constant RESIDENCE_TOPIC = 3;
    uint256 public constant REGISTRY_TOPIC = 4;
    uint256 public constant ACCREDITATION_TOPIC = 5;
    uint256 public constant KYC_TOPIC = 6;
    uint256 public constant AML_TOPIC = 7;
    uint256 public constant INVESTOR_TYPE_TOPIC = 8;

    // Signature schemes
    uint256 public constant ECDSA_SCHEME = 1;
    uint256 public constant RSA_SCHEME = 2;
    uint256 public constant CONTRACT_SCHEME = 3;

    struct Claim {
        uint256 topic;
        uint256 scheme;
        address issuer;
        bytes signature;
        bytes data;
        string uri;
        uint256 validTo;
        uint256 validFrom;
    }

    mapping(bytes32 => Claim) private claims;
    mapping(uint256 => bytes32[]) private claimsByTopic;
    // Position + 1 of a claim id in claimsByTopic[topic].
    mapping(bytes32 => uint256) private _topicIndex;

    uint256 private claimRequestNonce;

    // ✅ DoS Protection: Maximum batch size to prevent gas limit attacks
    uint256 public constant MAX_BATCH_SIZE = 50;

    /**
     * @dev Constructor
     * @param _owner Initial owner of the identity (zero: initialize() sets one)
     */
    constructor(address _owner) OnchainIDOwnership(_owner) {}

    // ERC-735 Implementation

    /**
     * @dev Get claim
     */
    function getClaim(
        bytes32 _claimId
    )
        external
        view
        override
        returns (
            uint256 topic,
            uint256 scheme,
            address issuer,
            bytes memory signature,
            bytes memory data,
            string memory uri
        )
    {
        Claim memory claim = claims[_claimId];
        return (claim.topic, claim.scheme, claim.issuer, claim.signature, claim.data, claim.uri);
    }

    /**
     * @dev Get claim IDs by topic
     */
    function getClaimIdsByTopic(uint256 _topic) external view override returns (bytes32[] memory) {
        return claimsByTopic[_topic];
    }

    /**
     * @dev Add claim
     */
    function addClaim(
        uint256 _topic,
        uint256 _scheme,
        address _issuer,
        bytes calldata _signature,
        bytes calldata _data,
        string calldata _uri
    ) external override returns (bytes32 claimRequestId) {
        // `msg.sender == _issuer` is how a ClaimIssuer contract writes its
        // claim here (ClaimIssuer.issueClaim). It also lets ANY caller add a
        // claim naming itself as issuer. That only grows this identity's
        // lists: IdentityRegistry.isVerified asks the trusted issuers
        // (ClaimIssuer.hasValidClaim) and never reads these lists (2F.2, H2).
        require(
            msg.sender == owner() ||
                keyHasPurpose(keccak256(abi.encodePacked(msg.sender)), MANAGEMENT_KEY) ||
                keyHasPurpose(keccak256(abi.encodePacked(msg.sender)), CLAIM_SIGNER_KEY) ||
                msg.sender == _issuer,
            "OnchainID: Not authorized to add claim"
        );
        return _storeClaim(_topic, _scheme, _issuer, _signature, _data, _uri);
    }

    /**
     * @dev Remove claim. A management key removes any claim; an issuer
     *      removes only its own (ClaimIssuer.revokeClaim).
     */
    function removeClaim(bytes32 _claimId) external override returns (bool success) {
        Claim memory claim = claims[_claimId];
        require(claim.issuer != address(0), "OnchainID: Claim does not exist");
        require(
            msg.sender == claim.issuer ||
                keyHasPurpose(keccak256(abi.encodePacked(msg.sender)), MANAGEMENT_KEY) ||
                msg.sender == owner() ||
                authorizedManagers[msg.sender],
            "OnchainID: Not authorized to remove claim"
        );

        // ponytail: O(1) swap-and-pop via stored indices, so an identity
        // bloated by self-named junk claims can still remove any claim.
        _swapPop(claimsByTopic[claim.topic], _topicIndex, _claimId);

        emit ClaimRemoved(_claimId, claim.topic, claim.scheme, claim.issuer, claim.signature, claim.data, claim.uri);

        delete claims[_claimId];
        return true;
    }

    /**
     * @dev Batch add claims
     */
    function batchAddClaims(
        uint256[] calldata _topics,
        uint256[] calldata _schemes,
        address[] calldata _issuers,
        bytes[] calldata _signatures,
        bytes[] calldata _data,
        string[] calldata _uris
    ) external returns (uint256[] memory claimRequestIds) {
        // ✅ DoS Protection: Validate array length
        require(_topics.length > 0, "OnchainID: Empty array");
        require(_topics.length <= MAX_BATCH_SIZE, "OnchainID: Batch size exceeds maximum");

        require(
            _topics.length == _schemes.length &&
                _schemes.length == _issuers.length &&
                _issuers.length == _signatures.length &&
                _signatures.length == _data.length &&
                _data.length == _uris.length,
            "OnchainID: Array length mismatch"
        );

        claimRequestIds = new uint256[](_topics.length);

        for (uint256 i = 0; i < _topics.length; i++) {
            // Check authorization for each claim
            require(
                msg.sender == owner() ||
                    keyHasPurpose(keccak256(abi.encodePacked(msg.sender)), MANAGEMENT_KEY) ||
                    keyHasPurpose(keccak256(abi.encodePacked(msg.sender)), CLAIM_SIGNER_KEY) ||
                    msg.sender == _issuers[i] ||
                    authorizedManagers[msg.sender],
                "OnchainID: Not authorized to add claim"
            );

            claimRequestIds[i] = claimRequestNonce++;
            _storeClaim(_topics[i], _schemes[i], _issuers[i], _signatures[i], _data[i], _uris[i]);
        }

        return claimRequestIds;
    }

    /// @dev Store or update a claim. An id already present is updated in
    ///      place, never pushed twice, so one removeClaim always clears it.
    function _storeClaim(
        uint256 _topic,
        uint256 _scheme,
        address _issuer,
        bytes calldata _signature,
        bytes calldata _data,
        string calldata _uri
    ) private returns (bytes32 claimId) {
        require(_issuer != address(0), "OnchainID: Invalid issuer");
        claimId = keccak256(abi.encodePacked(_issuer, _topic, _data));
        if (claims[claimId].issuer != address(0)) {
            // The owner and management keys may remove an issuer's copy,
            // never overwrite it (2F.2 review, N2).
            require(msg.sender == _issuer, "OnchainID: Only the issuer updates its claim");
        } else {
            claimsByTopic[_topic].push(claimId);
            _topicIndex[claimId] = claimsByTopic[_topic].length;
        }
        claims[claimId] = Claim({
            topic: _topic,
            scheme: _scheme,
            issuer: _issuer,
            signature: _signature,
            data: _data,
            uri: _uri,
            validTo: 0, // 0 means no expiry
            validFrom: block.timestamp
        });
        emit ClaimAdded(claimId, _topic, _scheme, _issuer, _signature, _data, _uri);
    }

    /// @dev Remove `id` from `list` in O(1); `index` holds position + 1.
    function _swapPop(bytes32[] storage list, mapping(bytes32 => uint256) storage index, bytes32 id) private {
        uint256 i = index[id] - 1;
        bytes32 last = list[list.length - 1];
        list[i] = last;
        index[last] = i + 1;
        list.pop();
        delete index[id];
    }

    /**
     * @dev Get creation time
     */
    function getCreationTime() external view returns (uint256) {
        return creationTime;
    }
}
