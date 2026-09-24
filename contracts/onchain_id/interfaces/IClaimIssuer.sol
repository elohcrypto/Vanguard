// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

/**
 * @title IClaimIssuer
 * @dev The slice of ClaimIssuer that IdentityRegistry consults when deciding
 *      whether a claim found on an identity is still good. `claimId` is the
 *      issuer-side id: keccak256(abi.encodePacked(issuer, identity, topic, data)).
 */
interface IClaimIssuer {
    function isClaimValid(bytes32 claimId) external view returns (bool);
}
