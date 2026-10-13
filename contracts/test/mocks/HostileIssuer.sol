// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

/**
 * @title HostileIssuer
 * @dev A trusted issuer that misbehaves (Task 5.1, A2F-5): mode 1 burns
 *      all the gas it is given in hasValidClaim, mode 2 returns over 1 MB
 *      from it; modes 3 and 4 answer hasValidClaim yes but burn gas or
 *      return over 1 MB from claimValidTo; mode 5 answers hasValidClaim yes
 *      with 64 KB, as much as fits in the stipend (a 1 MB return runs the
 *      callee out of gas first); mode 6 returns 31 bytes ending in 0x01
 *      (short: not a word); mode 7 answers yes only when it enters with
 *      at least GAUGE gas, so a starved call reads as "no". Each view
 *      returns (word, bytes):
 *      the first word is what IClaimIssuer would return, the bytes are the
 *      padding (1 MB in the bomb modes); the selectors are IClaimIssuer's.
 */
contract HostileIssuer {
    uint256 public immutable MODE;
    uint256 public constant GAUGE = 40_000;

    // solhint-disable-next-line func-visibility
    constructor(uint256 mode) {
        MODE = mode;
    }

    function hasValidClaim(address, uint256) external view returns (uint256, bytes memory) {
        if (MODE == 1) _burn();
        if (MODE == 2) return (1, new bytes(1 << 20)); // "yes" under 1 MB
        if (MODE == 5) {
            // solhint-disable-next-line no-inline-assembly
            assembly {
                mstore(0, 1)
                return(0, 0x10000) // "yes", then 64 KB of zeros
            }
        }
        if (MODE == 6) {
            // solhint-disable-next-line no-inline-assembly
            assembly {
                mstore(0, 1)
                return(0x01, 0x1f) // the word 1 less its first byte
            }
        }
        if (MODE == 7) return (gasleft() >= GAUGE ? 1 : 0, "");
        return (1, "");
    }

    function claimValidTo(address, uint256) external view returns (uint256, bytes memory) {
        if (MODE == 3) _burn();
        if (MODE == 4) return (0, new bytes(1 << 20));
        return (0, "");
    }

    function _burn() private view {
        uint256 x;
        while (gasleft() > 0) x++; // never ends: out of gas
    }
}
