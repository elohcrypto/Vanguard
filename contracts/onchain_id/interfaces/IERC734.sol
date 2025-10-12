// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title IERC734 - Key Manager Interface
 * @dev Interface for ERC-734 Key Manager standard
 * @author CMTA UTXO Compliance Team
 */
interface IERC734 {
    /**
     * @dev Key structure
     */
    struct Key {
        uint256 purpose;
        uint256 keyType;
        bytes32 key;
        uint256 revokedAt;
    }

    /**
     * @dev Events
     */
    event KeyAdded(bytes32 indexed key, uint256 indexed purpose, uint256 indexed keyType);
    event KeyRemoved(bytes32 indexed key, uint256 indexed purpose, uint256 indexed keyType);
    event ExecutionRequested(uint256 indexed executionId, address indexed to, uint256 indexed value, bytes data);
    event Executed(uint256 indexed executionId, address indexed to, uint256 indexed value, bytes data);
    event ExecutionFailed(uint256 indexed executionId, address indexed to, uint256 indexed value, bytes data);
    event Approved(uint256 indexed executionId, bool approved);

    /**
     * @dev Returns the full key data, if present in the identity.
     * @param _key The key bytes to look up.
     * @return purpose The purpose of the key
     * @return keyType The type of the key
     * @return key The key bytes
     * @return revokedAt Timestamp when the key was revoked (0 if not revoked)
     */
    function getKey(
        bytes32 _key
    ) external view returns (uint256 purpose, uint256 keyType, bytes32 key, uint256 revokedAt);

    /**
     * @dev Returns TRUE if a key has is present and has the given purpose.
     * @param _key The key bytes to check.
     * @param _purpose The purpose to check for.
     * @return exists True if the key exists and has the purpose
     */
    function keyHasPurpose(bytes32 _key, uint256 _purpose) external view returns (bool exists);

    /**
     * @dev Returns an array of public key bytes32 held by this identity.
     * @param _purpose The purpose of the keys to return.
     * @return keys Array of key bytes
     */
    function getKeysByPurpose(uint256 _purpose) external view returns (bytes32[] memory keys);

    /**
     * @dev Adds a _key to the identity. The _purpose specifies the purpose of key.
     * @param _key The key bytes to add.
     * @param _purpose The purpose of the key.
     * @param _keyType The type of the key.
     * @return success True if the key was added successfully
     */
    function addKey(bytes32 _key, uint256 _purpose, uint256 _keyType) external returns (bool success);

    /**
     * @dev Removes _key from the identity.
     * @param _key The key bytes to remove.
     * @param _purpose The purpose of the key to remove.
     * @return success True if the key was removed successfully
     */
    function removeKey(bytes32 _key, uint256 _purpose) external returns (bool success);

    /**
     * @dev Passes an execution instruction to an ERC725 identity.
     * @param _to The address to execute the call on.
     * @param _value The value to send with the call.
     * @param _data The data to send with the call.
     * @return executionId The ID of the execution request
     */
    function execute(address _to, uint256 _value, bytes calldata _data) external payable returns (uint256 executionId);

    /**
     * @dev Approves an execution or claim addition.
     * @param _id The ID of the execution or claim to approve.
     * @param _approve True to approve, false to reject.
     * @return success True if the approval was processed successfully
     */
    function approve(uint256 _id, bool _approve) external returns (bool success);
}
