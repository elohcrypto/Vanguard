// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable2Step.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import "./interfaces/IOnchainID.sol";

/**
 * @title OnchainIDKeys
 * @dev The ERC-734 half of OnchainID: keys, execution requests, manager
 *      authorization and the identity's ownership. OnchainID adds the
 *      ERC-735 claims; one contract is deployed (plan v2 Task 4.5, split
 *      by inheritance as ComplianceRules was in 4.1).
 *
 *      A MANAGEMENT key adds and removes any key at once (ERC-734);
 *      KeyManager timelocks bind only what is sent through it (R-45-1).
 *      The defence against a rogue MANAGEMENT key is KeyManager recovery
 *      (Task 4.11): agents at the threshold evict every other MANAGEMENT
 *      key after RECOVERY_TIMELOCK and move the ownership after
 *      OWNER_TRANSFER_TIMELOCK; a MANAGEMENT key can neither cancel an
 *      approved recovery nor re-seat its agents. The owner keeps its
 *      powers (owner() always passes onlyManagementKey) except while a
 *      recovery is approved: see OnchainIDOwnership.
 */
abstract contract OnchainIDKeys is IOnchainID, Ownable2Step {
    using ECDSA for bytes32;

    // Key purposes
    uint256 public constant MANAGEMENT_KEY = 1;
    uint256 public constant ACTION_KEY = 2;
    uint256 public constant CLAIM_SIGNER_KEY = 3;
    uint256 public constant ENCRYPTION_KEY = 4;

    // Key types
    uint256 public constant ECDSA_TYPE = 1;
    uint256 public constant RSA_TYPE = 2;

    // Structs
    struct Key {
        uint256 purpose;
        uint256 keyType;
        bytes32 key;
        uint256 revokedAt;
    }

    // Additional Events (beyond ERC-734/735)
    event IdentityCreated(address indexed identity, address indexed owner, bytes32 managementKey);
    event Approved(uint256 indexed executionId, bool approved);

    // State variables
    mapping(bytes32 => Key) internal keys;
    mapping(uint256 => bytes32[]) internal keysByPurpose;

    uint256 private executionNonce;
    uint256 internal creationTime;
    bool private initialized;

    mapping(uint256 => ExecutionRequest) private executionRequests;
    /// @notice How many times each key has been removed. Part of the
    ///         removeKeyWithProof message, so a holder's signature removes
    ///         the key once: after it is re-added the old signature is
    ///         stale (review of 4.5, L-1).
    mapping(bytes32 => uint256) public removalNonces;
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
     * @dev Remove a key: the management action. Any MANAGEMENT key (or the
     *      owner, or an authorized manager such as KeyManager) removes any
     *      key, with no consent from its holder; KeyManager rotations and
     *      batches use this path, and it is the only one for a non-ECDSA
     *      key. For the holder-consented removal see removeKeyWithProof.
     */
    function removeKey(bytes32 _key, uint256 _purpose) external override onlyManagementKey returns (bool success) {
        require(keys[_key].key != bytes32(0), "OnchainID: Key does not exist");
        require(keys[_key].purpose == _purpose, "OnchainID: Purpose mismatch");
        require(keys[_key].revokedAt == 0, "OnchainID: Key already revoked");
        _removeKey(_key, _purpose);
        return true;
    }

    /// @dev Revoke `_key` and drop it from keysByPurpose[_purpose].
    function _removeKey(bytes32 _key, uint256 _purpose) internal {
        keys[_key].revokedAt = block.timestamp;
        removalNonces[_key]++;

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
     * @dev Remove a key with its holder's consent.
     * @param _key The key hash to remove
     * @param _purpose The purpose of the key
     * @param _signature Signature by the key's address over the message
     *        getRemoveKeyMessage describes
     * @return success True if the key was removed successfully
     *
     * @notice Still sent by a MANAGEMENT key; the signature proves the
     * holder of `_key` agreed. Only ECDSA (address) keys can sign; any other
     * key is removed with removeKey.
     */
    function removeKeyWithProof(
        bytes32 _key,
        uint256 _purpose,
        bytes calldata _signature
    ) external onlyManagementKey returns (bool success) {
        require(keys[_key].key != bytes32(0), "OnchainID: Key does not exist");
        require(keys[_key].purpose == _purpose, "OnchainID: Purpose mismatch");
        require(keys[_key].revokedAt == 0, "OnchainID: Key already revoked");
        require(keys[_key].keyType == ECDSA_TYPE, "OnchainID: Only ECDSA keys support proof");

        // Recover the signer from the digest getRemoveKeyMessage returns
        address signer = ECDSA.recover(_removeKeyDigest(_key, _purpose), _signature);

        // Verify the signer owns the key being removed. Address keys are
        // stored as keccak256(abi.encodePacked(address)) (constructor,
        // onlyManagementKey); abi.encode here could never match (2F.2, L8).
        bytes32 signerKeyHash = keccak256(abi.encodePacked(signer));
        require(signerKeyHash == _key, "OnchainID: Signature does not prove ownership of key");

        _removeKey(_key, _purpose);
        return true;
    }

    /**
     * @dev The digest removeKeyWithProof recovers the signer from.
     * @param _key The key hash to remove
     * @param _purpose The purpose of the key
     * @return messageHash toEthSignedMessageHash(keccak256(abi.encodePacked(
     *         "Remove key from OnchainID", address(this), _key, _purpose,
     *         removalNonces[_key], block.chainid)))
     *
     * @notice Already EIP-191 prefixed: it is the digest to check, not the
     * bytes to pass to personal_sign (that would prefix twice). Sign the
     * inner keccak256 with signMessage(getBytes(inner)); the result
     * recovers against this digest. The nonce makes a signature good for
     * one removal of the key.
     */
    function getRemoveKeyMessage(
        bytes32 _key,
        uint256 _purpose
    ) external view returns (bytes32 messageHash) {
        return _removeKeyDigest(_key, _purpose);
    }

    /// @dev One definition of the removal digest for both paths.
    function _removeKeyDigest(bytes32 _key, uint256 _purpose) private view returns (bytes32) {
        bytes32 message = keccak256(
            abi.encodePacked(
                "Remove key from OnchainID",
                address(this),
                _key,
                _purpose,
                removalNonces[_key],
                block.chainid
            )
        );
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

    // Internal functions

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

        // Marked executed before the external call: a re-entrant approve()
        // cannot run the same request twice ("Already executed"). This is
        // the reentrancy defence; the inherited ReentrancyGuard was never
        // used and is gone (review of 4.5, N-3).
        request.executed = true;

        (bool success, ) = request.to.call{value: request.value}(request.data);

        if (success) {
            emit Executed(_executionId, request.to, request.value, request.data);
        } else {
            emit ExecutionFailed(_executionId, request.to, request.value, request.data);
        }
    }
}
