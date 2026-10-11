// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @dev The identity hook the mock drives (Task 4.14, M16 / L-A).
interface IHookedIdentity {
    function transferOwnershipByRecovery(address newOwner) external;
}

/**
 * @title OddRecoveryManager
 * @dev Test-only. Answers every view it is asked (recoveryLocked,
 *      isRecoveryOwner, hasValidClaim, claimValidTo...) with one raw
 *      32-byte word the test sets: 2 is neither true nor false, so a
 *      strict decoder must read it as "no" without reverting (A2 L-A);
 *      0 is a manager that reports no recovery (mutant M16). Pinned as an
 *      identity's recovery manager, or named a registry's trusted issuer.
 */
contract OddRecoveryManager {
    uint256 public word;

    constructor(uint256 _word) {
        word = _word;
    }

    function setWord(uint256 _word) external {
        word = _word;
    }

    /// @dev Calls the identity's recovery hook; the identity asks back.
    function propose(address identity, address newOwner) external {
        IHookedIdentity(identity).transferOwnershipByRecovery(newOwner);
    }

    // solhint-disable-next-line payable-fallback, no-complex-fallback
    fallback() external {
        uint256 w = word;
        // solhint-disable-next-line no-inline-assembly
        assembly {
            mstore(0, w)
            return(0, 32)
        }
    }
}
