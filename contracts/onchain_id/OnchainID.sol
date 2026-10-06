// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable2Step.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import "./interfaces/IOnchainID.sol";

/**
 * @title OnchainID
 * @dev Implementation of OnchainID with ERC-734 and ERC-735 standards
 * @author CMTA UTXO Compliance Team
 */
contract OnchainID is IOnchainID, Ownable2Step, ReentrancyGuard {
    using ECDSA for bytes32;

    // Key purposes
    uint256 public constant MANAGEMENT_KEY = 1;
    uint256 public constant ACTION_KEY = 2;
    uint256 public constant CLAIM_SIGNER_KEY = 3;
    uint256 public constant ENCRYPTION_KEY = 4;

    // Key types
    uint256 public constant ECDSA_TYPE = 1;
    uint256 public constant RSA_TYPE = 2;

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

    // Structs
    struct Key {
        uint256 purpose;
        uint256 keyType;
        bytes32 key;
        uint256 revokedAt;
    }

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

    // Additional Events (beyond ERC-734/735)
    event IdentityCreated(address indexed identity, address indexed owner, bytes32 managementKey);
    event Approved(uint256 indexed executionId, bool approved);

    // State variables
    mapping(bytes32 => Key) private keys;
    mapping(uint256 => bytes32[]) private keysByPurpose;
    mapping(bytes32 => Claim) private claims;
    mapping(uint256 => bytes32[]) private claimsByTopic;

    // Position + 1 of a claim id in claimsByTopic[topic].
    mapping(bytes32 => uint256) private _topicIndex;

    uint256 private executionNonce;
    uint256 private claimRequestNonce;
    uint256 private creationTime;
    bool private initialized;

    // ✅ DoS Protection: Maximum batch size to prevent gas limit attacks
    uint256 public constant MAX_BATCH_SIZE = 50;

    mapping(uint256 => ExecutionRequest) private executionRequests;
    mapping(address => bool) public authorizedManagers;

    struct ExecutionRequest {
        address to;
        uint256 value;
        bytes data;
        bool executed;
        uint256 approvals;
        address requester;
    }

    /**
     * @notice Approvals required before a pending execution request runs.
     * @dev Two by default: the requester's own implicit approval plus one
     *      independent approver. approve() previously executed on the FIRST
     *      approval regardless of who gave it, so one ACTION key could both
     *      request and approve. Settable by a MANAGEMENT key, but never below
     *      2 — a threshold of 1 restores the vulnerability.
     */
    uint256 public executionThreshold = 2;

    event ExecutionThresholdUpdated(uint256 oldThreshold, uint256 newThreshold);

    /// @dev A threshold below 2 would let the requester approve their own request.
    error ThresholdAllowsSelfApproval(uint256 requested);
    /// @dev The requester of an execution may not also be its approver.
    error SelfApprovalNotAllowed();

    /// @dev One approver, one approval: a key may not approve the same request twice.
    error AlreadyApproved();

    /**
     * @dev Who has already approved a given request. Approvals were counted
     *      PER CALL rather than per distinct approver, so one non-requester key
     *      could call approve() repeatedly until any threshold was met, and the
     *      configured N-of-M was never actually enforced. Caught reviewing PR #3.
     */
    mapping(uint256 => mapping(address => bool)) private _hasApproved;

    /**
     * @notice A request was created but has NOT run: it needs more approvals.
     * @param executionId     The pending request.
     * @param approvalsNeeded How many further approvals are required.
     * @dev Without this, a request from an ACTION key looked identical to a
     *      successful one from the caller's side — no event said "still
     *      waiting", so an integrator expecting 1-of-1 execution would hang
     *      with no signal. Emitted only when the request does not auto-execute.
     */
    event ExecutionPending(uint256 indexed executionId, uint256 approvalsNeeded);

    /**
     * @notice Set how many approvals an execution request needs.
     * @dev Management-key only. Floor of 2 is deliberate: see executionThreshold.
     */
    function setExecutionThreshold(uint256 _threshold) external onlyManagementKey {
        if (_threshold < 2) revert ThresholdAllowsSelfApproval(_threshold);
        emit ExecutionThresholdUpdated(executionThreshold, _threshold);
        executionThreshold = _threshold;
    }

    /**
     * @dev Modifier to check if sender has management key
     */
    modifier onlyManagementKey() {
        require(
            keyHasPurpose(keccak256(abi.encodePacked(msg.sender)), MANAGEMENT_KEY) ||
                msg.sender == owner() ||
                authorizedManagers[msg.sender],
            "OnchainID: Sender does not have management key"
        );
        _;
    }

    /**
     * @dev Modifier to check if sender has action key
     */
    modifier onlyActionKey() {
        require(
            keyHasPurpose(keccak256(abi.encodePacked(msg.sender)), ACTION_KEY) ||
                keyHasPurpose(keccak256(abi.encodePacked(msg.sender)), MANAGEMENT_KEY) ||
                msg.sender == owner(),
            "OnchainID: Sender does not have action key"
        );
        _;
    }

    /**
     * @dev Constructor
     * @param _owner Initial owner of the identity
     */
    constructor(address _owner) Ownable(_owner == address(0) ? address(this) : _owner) {
        creationTime = block.timestamp;
        // Deployed without an owner: initialize() sets one, once.
        initialized = _owner != address(0);

        // Add owner's address as management key (only if not zero address)
        if (_owner != address(0)) {
            bytes32 ownerKey = keccak256(abi.encodePacked(_owner));
            _addKey(ownerKey, MANAGEMENT_KEY, ECDSA_TYPE);
            emit IdentityCreated(address(this), _owner, bytes32(0));
        }
    }

    /**
     * @dev Override owner function to satisfy both interfaces
     */
    function owner() public view override(Ownable) returns (address) {
        return Ownable.owner();
    }

    /// @dev An identity must always have a controller. Renouncing used to
    ///      reopen initialize() to anyone (2F.2, L6).
    function renounceOwnership() public pure override {
        revert("OnchainID: identity needs an owner");
    }

    /// @dev Two-step, as ClaimIssuer (D18). On acceptance the old owner's
    ///      MANAGEMENT key is retired (unless the owner did not change) and
    ///      the new owner ends with a MANAGEMENT key: a revoked key is
    ///      re-activated and a key held for another purpose is moved to
    ///      MANAGEMENT (2F.2, L8; review F4). Other keys and
    ///      authorizedManagers survive; the new owner audits them.
    function acceptOwnership() public override {
        address previous = owner();
        super.acceptOwnership();
        bytes32 newKey = keccak256(abi.encodePacked(msg.sender));
        if (previous != msg.sender) {
            bytes32 oldKey = keccak256(abi.encodePacked(previous));
            if (keyHasPurpose(oldKey, MANAGEMENT_KEY)) _removeKey(oldKey, MANAGEMENT_KEY);
        }
        if (!keyHasPurpose(newKey, MANAGEMENT_KEY)) {
            Key storage held = keys[newKey];
            if (held.key != bytes32(0) && held.revokedAt == 0) _removeKey(newKey, held.purpose);
            _addKey(newKey, MANAGEMENT_KEY, ECDSA_TYPE);
        }
    }

    /**
     * @dev Initialize function (for factory pattern)
     */
    function initialize(address _owner, bytes32 _managementKey) external {
        require(!initialized, "OnchainID: Already initialized");
        require(_owner != address(0), "OnchainID: Invalid owner");
        initialized = true;
        _transferOwnership(_owner);
        creationTime = block.timestamp;

        _addKey(_managementKey, MANAGEMENT_KEY, ECDSA_TYPE);

        emit IdentityCreated(address(this), _owner, _managementKey);
    }

    // ERC-734 Implementation

    /**
     * @dev Get key information
     */
    function getKey(
        bytes32 _key
    ) external view override returns (uint256 purpose, uint256 keyType, bytes32 key, uint256 revokedAt) {
        Key memory k = keys[_key];
        return (k.purpose, k.keyType, k.key, k.revokedAt);
    }

    /**
     * @dev Check if key has purpose
     */
    function keyHasPurpose(bytes32 _key, uint256 _purpose) public view override returns (bool exists) {
        Key memory key = keys[_key];
        return key.key != bytes32(0) && key.purpose == _purpose && key.revokedAt == 0;
    }

    /**
     * @dev Get keys by purpose
     */
    function getKeysByPurpose(uint256 _purpose) external view override returns (bytes32[] memory) {
        return keysByPurpose[_purpose];
    }

    /**
     * @dev Add key
     */
    function addKey(
        bytes32 _key,
        uint256 _purpose,
        uint256 _keyType
    ) external override onlyManagementKey returns (bool success) {
        return _addKey(_key, _purpose, _keyType);
    }

    /**
     * @dev Remove key (legacy - no ownership proof required)
     * @notice DEPRECATED: Use removeKeyWithProof for better security
     */
    function removeKey(bytes32 _key, uint256 _purpose) external override onlyManagementKey returns (bool success) {
        require(keys[_key].key != bytes32(0), "OnchainID: Key does not exist");
        require(keys[_key].purpose == _purpose, "OnchainID: Purpose mismatch");
        _removeKey(_key, _purpose);
        return true;
    }

    /// @dev Revoke `_key` and drop it from keysByPurpose[_purpose].
    function _removeKey(bytes32 _key, uint256 _purpose) private {
        keys[_key].revokedAt = block.timestamp;

        bytes32[] storage purposeKeys = keysByPurpose[_purpose];
        for (uint256 i = 0; i < purposeKeys.length; i++) {
            if (purposeKeys[i] == _key) {
                purposeKeys[i] = purposeKeys[purposeKeys.length - 1];
                purposeKeys.pop();
                break;
            }
        }

        emit KeyRemoved(_key, _purpose, keys[_key].keyType);
    }

    /**
     * @dev Remove key with ownership proof (RECOMMENDED)
     * @param _key The key hash to remove
     * @param _purpose The purpose of the key
     * @param _signature Signature proving ownership of the key being removed
     * @return success True if the key was removed successfully
     *
     * @notice This function requires cryptographic proof that the caller owns the key being removed.
     * For address-based keys: Sign the message with the private key of the address
     * For string-based keys: This function cannot be used (use removeKey with caution)
     *
     * Security: Prevents unauthorized key removal by requiring signature verification
     */
    function removeKeyWithProof(
        bytes32 _key,
        uint256 _purpose,
        bytes calldata _signature
    ) external onlyManagementKey returns (bool success) {
        require(keys[_key].key != bytes32(0), "OnchainID: Key does not exist");
        require(keys[_key].purpose == _purpose, "OnchainID: Purpose mismatch");
        require(keys[_key].keyType == ECDSA_TYPE, "OnchainID: Only ECDSA keys support proof");

        // Construct the message that should have been signed
        bytes32 message = keccak256(abi.encodePacked(
            "Remove key from OnchainID",
            address(this),
            _key,
            _purpose,
            block.chainid
        ));

        // Recover the signer from the signature
        bytes32 ethSignedMessageHash = MessageHashUtils.toEthSignedMessageHash(message);
        address signer = ECDSA.recover(ethSignedMessageHash, _signature);

        // Verify the signer owns the key being removed. Address keys are
        // stored as keccak256(abi.encodePacked(address)) (constructor,
        // onlyManagementKey); abi.encode here could never match (2F.2, L8).
        bytes32 signerKeyHash = keccak256(abi.encodePacked(signer));
        require(signerKeyHash == _key, "OnchainID: Signature does not prove ownership of key");

        _removeKey(_key, _purpose);
        return true;
    }

    /**
     * @dev Get the message hash that needs to be signed for removeKeyWithProof
     * @param _key The key hash to remove
     * @param _purpose The purpose of the key
     * @return messageHash The hash that should be signed
     *
     * @notice Helper function to generate the correct message for signing.
     * Users should sign this message with the private key of the address being removed.
     *
     * Example usage:
     * 1. Call getRemoveKeyMessage(keyHash, purpose)
     * 2. Sign the returned hash with your wallet
     * 3. Call removeKeyWithProof(keyHash, purpose, signature)
     */
    function getRemoveKeyMessage(
        bytes32 _key,
        uint256 _purpose
    ) external view returns (bytes32 messageHash) {
        bytes32 message = keccak256(abi.encodePacked(
            "Remove key from OnchainID",
            address(this),
            _key,
            _purpose,
            block.chainid
        ));
        return MessageHashUtils.toEthSignedMessageHash(message);
    }

    /**
     * @dev Execute transaction
     */
    function execute(
        address _to,
        uint256 _value,
        bytes calldata _data
    ) external override onlyActionKey returns (uint256 executionId) {
        executionId = executionNonce++;

        executionRequests[executionId] = ExecutionRequest({
            to: _to,
            value: _value,
            data: _data,
            executed: false,
            approvals: 1,
            requester: msg.sender
        });

        emit ExecutionRequested(executionId, _to, _value, _data);

        // Auto-execute if sender is owner or has management key.
        //
        // THE OPERATING MODEL, stated once because it is easy to misread:
        //   MANAGEMENT key (and the owner) -> executes immediately, 1-of-1.
        //     This is where automation belongs: a relayer or bot holding a
        //     management key is unaffected by executionThreshold.
        //   ACTION key -> PROPOSES only. The request waits for an independent
        //     approver, because approve() refuses self-approval. An action key
        //     that could also approve itself would be 1-of-1 in disguise.
        if (msg.sender == owner() || keyHasPurpose(keccak256(abi.encodePacked(msg.sender)), MANAGEMENT_KEY)) {
            _executeRequest(executionId);
        } else {
            // Requester's own approval counts as the first, so one fewer is needed.
            emit ExecutionPending(executionId, executionThreshold - 1);
        }

        return executionId;
    }

    /**
     * @dev Approve execution
     */
    function approve(uint256 _id, bool _approve) external override onlyActionKey returns (bool success) {
        require(executionRequests[_id].to != address(0), "OnchainID: Execution request does not exist");
        require(!executionRequests[_id].executed, "OnchainID: Already executed");

        if (_approve) {
            // An ACTION key may PROPOSE; it must not also be the one that
            // approves its own proposal. This function used to execute on the
            // first approval with no check on who was approving, so a single
            // action key could call execute() then approve() and move
            // everything the identity holds — collapsing the multi-key model
            // to 1-of-1. A MANAGEMENT key still auto-executes in execute().
            if (msg.sender == executionRequests[_id].requester) revert SelfApprovalNotAllowed();

            // One approver, one approval. Approvals were counted PER CALL, so a
            // single independent key satisfied any threshold above 2 by calling
            // approve() repeatedly — the configured N-of-M was never enforced.
            if (_hasApproved[_id][msg.sender]) revert AlreadyApproved();
            _hasApproved[_id][msg.sender] = true;

            executionRequests[_id].approvals++;
            emit Approved(_id, true);

            if (executionRequests[_id].approvals >= executionThreshold) {
                _executeRequest(_id);
            }
        } else {
            emit Approved(_id, false);
        }

        return true;
    }

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

    // Internal functions

    /**
     * @dev Internal add key function
     */
    /// @dev Adds `_key`, or re-activates it if it was revoked (2F.2 review,
    ///      F4); only an active key is refused.
    function _addKey(bytes32 _key, uint256 _purpose, uint256 _keyType) internal returns (bool) {
        require(_key != bytes32(0), "OnchainID: Invalid key");
        bool known = keys[_key].key != bytes32(0);
        require(!known || keys[_key].revokedAt != 0, "OnchainID: Key already exists");

        keys[_key] = Key({purpose: _purpose, keyType: _keyType, key: _key, revokedAt: 0});

        keysByPurpose[_purpose].push(_key);

        emit KeyAdded(_key, _purpose, _keyType);
        return true;
    }

    /**
     * @dev Internal execute request function
     */
    function _executeRequest(uint256 _executionId) internal {
        ExecutionRequest storage request = executionRequests[_executionId];
        require(!request.executed, "OnchainID: Already executed");

        request.executed = true;

        (bool success, ) = request.to.call{value: request.value}(request.data);

        if (success) {
            emit Executed(_executionId, request.to, request.value, request.data);
        } else {
            emit ExecutionFailed(_executionId, request.to, request.value, request.data);
        }
    }

    /**
     * @dev Authorize a manager to perform management operations
     * @param _manager The manager address to authorize
     */
    function authorizeManager(address _manager) external {
        require(msg.sender == owner(), "OnchainID: Only owner can authorize managers");
        require(_manager != address(0), "OnchainID: Invalid manager address");
        authorizedManagers[_manager] = true;
    }

    /**
     * @dev Remove authorization from a manager
     * @param _manager The manager address to deauthorize
     */
    function deauthorizeManager(address _manager) external {
        require(msg.sender == owner(), "OnchainID: Only owner can deauthorize managers");
        authorizedManagers[_manager] = false;
    }
}
