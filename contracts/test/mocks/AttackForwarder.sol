// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @notice Test-only (review D-1, D2-1): a deployer-owned executor that
/// is no Safe (no getOwners) and no ClaimIssuer.
contract AttackForwarder {
    address public owner;

    error NotOwner();

    // solhint-disable-next-line func-visibility
    constructor() {
        owner = msg.sender;
    }

    /// @notice Run one call as this contract; the owner only.
    function exec(address to, bytes calldata data) external {
        if (msg.sender != owner) revert NotOwner();
        // solhint-disable-next-line avoid-low-level-calls
        (bool ok, bytes memory r) = to.call(data);
        if (!ok) {
            // solhint-disable-next-line no-inline-assembly
            assembly {
                revert(add(r, 32), mload(r))
            }
        }
    }
}
