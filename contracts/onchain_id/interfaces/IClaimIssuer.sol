// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

/**
 * @title IClaimIssuer
 * @dev The slice of ClaimIssuer that IdentityRegistry consults. `claimId` is
 *      the issuer-side id: keccak256(abi.encodePacked(issuer, identity, topic, data)).
 */
interface IClaimIssuer {
    function isClaimValid(bytes32 claimId) external view returns (bool);

    /// @dev True if the issuer holds a live claim on `topic` for `identity`.
    function hasValidClaim(address identity, uint256 topic) external view returns (bool);
}
