// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title RawWhitelistOracle
 * @dev Test double whose getWhitelistInfo returns whatever bytes the test
 *      stored, byte for byte, so ComplianceRules.setWhitelistOracle's shape
 *      probe (Task 4.16, review L-1) can be fed every malformed encoding:
 *      a bool word of 2, a truncated string tail, an array length with too
 *      few words, a dirty address word, an absurd array length. isWhitelisted
 *      answers false so the first probe passes.
 */
contract RawWhitelistOracle {
    bytes public raw;

    function setRaw(bytes calldata data) external {
        raw = data;
    }

    function isWhitelisted(address) external pure returns (bool) {
        return false;
    }

    // solhint-disable-next-line payable-fallback, no-complex-fallback
    fallback() external {
        bytes memory data = raw;
        // solhint-disable-next-line no-inline-assembly
        assembly {
            return(add(data, 32), mload(data))
        }
    }
}
