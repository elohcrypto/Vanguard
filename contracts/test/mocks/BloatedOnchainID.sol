// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {OnchainID} from "../../onchain_id/OnchainID.sol";

/**
 * @title BloatedOnchainID
 * @dev Test-only (Task 4.14, H-1). An OnchainID whose purpose lists can be
 *      grown past MAX_KEYS_PER_PURPOSE through the internal _addKey, as a
 *      list grown before the cap would be: tests prove recovery's eviction
 *      stays O(1) against it and that addKey refuses the 65th key.
 *      Deployed without an owner: the test calls initialize().
 */
contract BloatedOnchainID is OnchainID(address(0)) {

    /// @dev Adds `n` fresh keys of `purpose`, uncapped.
    function bloat(uint256 purpose, uint256 n, uint256 salt) external {
        for (uint256 i = 0; i < n; i++) {
            _addKey(keccak256(abi.encode(salt, i)), purpose, ECDSA_TYPE);
        }
    }

    /// @dev Adds one key of `purpose`, uncapped: the candidate at the tail.
    function addRaw(bytes32 key, uint256 purpose) external {
        _addKey(key, purpose, ECDSA_TYPE);
    }
}
