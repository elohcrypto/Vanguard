// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title IOnchainID
 * @dev Interface for OnchainID contracts (ERC-734/ERC-735)
 */
interface IOnchainID {
    // ERC-734 Key Management
    event KeyAdded(bytes32 indexed key, uint256 indexed purpose, uint256 indexed keyType);
    event KeyRemoved(bytes32 indexed key, uint256 indexed purpose, uint256 indexed keyType);
    event ExecutionRequested(uint256 indexed executionId, address indexed to, uint256 indexed value, bytes data);
    event Executed(uint256 indexed executionId, address indexed to, uint256 indexed value, bytes data);
    event ExecutionFailed(uint256 indexed executionId, address indexed to, uint256 indexed value, bytes data);

    // ERC-735 Claim Management
    event ClaimRequested(
        uint256 indexed claimRequestId,
        uint256 indexed topic,
        uint256 scheme,
        address indexed issuer,
        bytes signature,
        bytes data,
        string uri
    );
    event ClaimAdded(
        bytes32 indexed claimId,
        uint256 indexed topic,
        uint256 scheme,
        address indexed issuer,
        bytes signature,
        bytes data,
        string uri
    );
    event ClaimRemoved(
        bytes32 indexed claimId,
        uint256 indexed topic,
        uint256 scheme,
        address indexed issuer,
        bytes signature,
        bytes data,
        string uri
    );
    event ClaimChanged(
        bytes32 indexed claimId,
        uint256 indexed topic,
        uint256 scheme,
        address indexed issuer,
        bytes signature,
        bytes data,
        string uri
    );

    // Key Management Functions
    function getKey(
        bytes32 key
    ) external view returns (uint256 purpose, uint256 keyType, bytes32 key_, uint256 revokedAt);

    function keyHasPurpose(bytes32 key, uint256 purpose) external view returns (bool exists);

    function getKeysByPurpose(uint256 purpose) external view returns (bytes32[] memory keys);

    function addKey(bytes32 key, uint256 purpose, uint256 keyType) external returns (bool success);

    function removeKey(bytes32 key, uint256 purpose) external returns (bool success);

    // Execution Functions
    function execute(address to, uint256 value, bytes calldata data) external returns (uint256 executionId);

    function approve(uint256 id, bool approve) external returns (bool success);

    // Claim Management Functions
    function getClaim(
        bytes32 claimId
    )
        external
        view
        returns (
            uint256 topic,
            uint256 scheme,
            address issuer,
            bytes memory signature,
            bytes memory data,
            string memory uri
        );

    function getClaimIdsByTopic(uint256 topic) external view returns (bytes32[] memory claimIds);

    function addClaim(
        uint256 topic,
        uint256 scheme,
        address issuer,
        bytes calldata signature,
        bytes calldata data,
        string calldata uri
    ) external returns (bytes32 claimRequestId);

    function removeClaim(bytes32 claimId) external returns (bool success);
}
