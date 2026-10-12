// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title RawWhitelistOracle
 * @dev Test double whose every unknown call (whitelistStanding, the one
 *      ComplianceRules.setWhitelistOracle probes since Task 4.17) returns
 *      whatever bytes the test stored, byte for byte, so the shape probe
 *      (Task 4.16, review L-1) can be fed every malformed encoding: a bool
 *      word of 2, a tier word above 255, a short return.
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
