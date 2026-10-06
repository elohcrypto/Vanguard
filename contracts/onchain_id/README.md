# OnchainID Contracts (ERC-734/ERC-735)

This directory contains OnchainID implementation contracts following ERC-734 and ERC-735 standards.

## Contracts

- `OnchainIDFactory.sol` - Factory for deploying OnchainID contracts
- `OnchainID.sol` - Core OnchainID contract: ERC-735 claims on top of `OnchainIDKeys`
- `OnchainIDKeys.sol` - Abstract base of OnchainID: ERC-734 keys, execution requests, manager authorization, ownership (one deployed contract; split for size in plan v2 Task 4.5)
- `ClaimIssuer.sol` - Trusted claim issuer contract
- `KeyManager.sol` - Timelocked key rotation and agent recovery for identities that authorize it (no owner)

## Interfaces

- `IERC734.sol` - ERC-734 Key Manager interface
- `IERC735.sol` - ERC-735 Claim Holder interface
- `IOnchainID.sol` - OnchainID interface for external integrations

## Keys and removal

- A MANAGEMENT key (or the owner, or an authorized manager such as
  KeyManager) adds and removes any key at once with `addKey` and
  `removeKey`, a MANAGEMENT key included and without the holder's consent
  (ERC-734). KeyManager's timelocks bind only the rotations and recoveries
  sent through it; the holder's defence against a rogue MANAGEMENT key is
  recovery (plan v2 Task 4.5, R-45-1).
- `removeKey` is the management action: KeyManager rotations and batches
  use it, and it is the only path for a key nobody can sign for (an
  RSA-type or passphrase key).
- `removeKeyWithProof(key, purpose, signature)` is the holder-consented
  removal. It is still sent by a MANAGEMENT key, and the key's own address
  must have signed. The contract recovers the signer from
  `getRemoveKeyMessage(key, purpose)`, which is
  `toEthSignedMessageHash(keccak256(abi.encodePacked("Remove key from
OnchainID", identity, key, purpose, chainid)))`, and requires
  `keccak256(abi.encodePacked(signer)) == key`, the way address keys are
  stored. The identity address and chain id in the message stop a
  signature from being replayed on another identity or chain. ECDSA keys
  only ("Only ECDSA keys support proof").
- `getRemoveKeyMessage` returns the already-prefixed digest to check, not
  the bytes to pass to `personal_sign` (that would prefix twice and be
  refused). Sign the inner message:

  ```javascript
  const inner = ethers.solidityPackedKeccak256(
    ["string", "address", "bytes32", "uint256", "uint256"],
    ["Remove key from OnchainID", identityAddress, keyHash, purpose, chainId],
  );
  const signature = await keyWallet.signMessage(ethers.getBytes(inner));
  // ethers.hashMessage(ethers.getBytes(inner)) == getRemoveKeyMessage(keyHash, purpose)
  await identity
    .connect(managementKey)
    .removeKeyWithProof(keyHash, purpose, signature);
  ```

  `demo/utils/KeyRemovalFlow.js` does this (demo options 5 -> 1 and 5a).

- A removed key keeps its record with `revokedAt` set; `addKey` can
  re-activate it.

## Ownership

Ownership is two-step: `transferOwnership`, then `acceptOwnership` by the
new owner (as ClaimIssuer). On acceptance the old owner's MANAGEMENT key
is revoked (unless the owner did not change) and the new owner ends with a
MANAGEMENT key: a revoked key is re-activated and a key held for another
purpose is moved to MANAGEMENT. Other keys and `authorizedManagers`
survive an ownership transfer; the new owner audits them
(`getKeysByPurpose`; `authorizedManagers` has no list or event, so check
the identity's `authorizeManager` transactions) and removes any it does
not want. `renounceOwnership` reverts and `initialize` runs once, so an
identity always has a controller. `authorizeManager` and
`deauthorizeManager` (owner only) are the one way to let a contract manage
keys.

## Claims

Claims on an identity are a record. `IdentityRegistry` holds the required
topics and trusted issuers, and `isVerified` asks each trusted issuer
(`ClaimIssuer.hasValidClaim(identity, topic)`, which checks expiry and
revocation); it never reads the identity's lists, so a claim the owner or
anyone naming itself as issuer writes counts for nothing. The identity
keeps no trusted-issuer list, required topics or compliance view of its
own.
