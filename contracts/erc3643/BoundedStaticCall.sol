// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

/**
 * @title BoundedStaticCall
 * @dev A staticcall with a fixed gas stipend that reads at most one word
 *      of return data (Task 5.1, A2F-5). Solidity's `addr.staticcall(...)`
 *      forwards all but 1/64 of the gas left and copies the whole return
 *      data into memory, so one trusted issuer that burns gas or returns a
 *      megabyte made `isVerified` revert for every identity it was asked
 *      about. Here the callee gets `stipend` and nothing more, and only the
 *      first 32 bytes are copied; the rest of the return data is never
 *      touched (the caller pays no memory for it).
 */
library BoundedStaticCall {
    /// @notice Less gas is left than the stipend plus the 1/64 the EVM
    ///         withholds: the callee would run short and an honest answer
    ///         would read as "no". Revert instead (a starved call must not
    ///         become a negative, e.g. a refresh clearing a cache entry).
    error StipendUnavailable(uint256 gasLeft, uint256 stipend);

    /**
     * @dev Staticcall `target` with `data` and exactly `stipend`. Returns
     *      (true, word) when the call succeeded and returned at least 32
     *      bytes, `word` being the first 32; (false, 0) otherwise.
     */
    function word(address target, bytes memory data, uint256 stipend) internal view returns (bool ok, uint256 w) {
        // 63/64 rule: the callee receives min(stipend, available - available/64).
        // Requiring available > stipend + stipend/63 + 10k (the call's own
        // overhead: cold account access 2600, memory, stack) keeps it whole.
        if (gasleft() <= stipend + stipend / 63 + 10_000) revert StipendUnavailable(gasleft(), stipend);
        // Assembly: Solidity's staticcall copies all return data (the bug).
        // solhint-disable-next-line no-inline-assembly
        assembly ("memory-safe") {
            let out := mload(0x40) // scratch at the free pointer, not advanced
            let success := staticcall(stipend, target, add(data, 0x20), mload(data), out, 0x20)
            if and(success, gt(returndatasize(), 0x1f)) {
                ok := 1
                w := mload(out)
            }
        }
    }
}
