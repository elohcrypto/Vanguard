# OnchainID Contracts (ERC-734/ERC-735)

This directory contains OnchainID implementation contracts following ERC-734 and ERC-735 standards.

## Contracts

- `OnchainIDFactory.sol` - Factory for deploying OnchainID contracts
- `OnchainID.sol` - Core OnchainID contract: ERC-735 claims on top of `OnchainIDKeys`
- `OnchainIDKeys.sol` - Abstract base of OnchainID: ERC-734 keys and execution requests (one deployed contract; split for size in plan v2 Task 4.5)
- `OnchainIDOwnership.sol` - Abstract base of OnchainID over OnchainIDKeys: manager authorization, two-step ownership, the recovery hook (`transferOwnershipByRecovery`) and the freeze while a recovery is approved (split in Task 4.11)
- `ClaimIssuer.sol` - Trusted claim issuer contract: issued claims, revocation, `hasValidClaim` and `claimValidTo`
- `ClaimIssuerKeys.sol` - Abstract base of ClaimIssuer, not deployed: the issuer's keys, trusted-issuer list, issuer info and the signer checks (split in Task 4.8)
- `KeyManager.sol` - Timelocked key rotation and agent recovery for identities that authorize it (no owner)
- `KeyManagerRecovery.sol` - Abstract base of KeyManager, not deployed: recovery agents, candidates, approvals, cancel votes, execution with eviction, `recoveryLocked` (split in Task 4.8)
- `KeyManagerOwnerTransfer.sol` - Abstract base of KeyManager over KeyManagerRecovery: the owner transfer 7 days after an approval (Task 4.11)

## Interfaces

- `IERC734.sol` - ERC-734 Key Manager interface
- `IERC735.sol` - ERC-735 Claim Holder interface
- `IOnchainID.sol` - OnchainID interface for external integrations

## Keys and removal

- A MANAGEMENT key (or the owner, or an authorized manager such as
  KeyManager) adds and removes any key at once with `addKey` and
  `removeKey`, a MANAGEMENT key included and without the holder's consent
  (ERC-734). KeyManager's timelocks bind only the rotations and
  recoveries sent through it (plan v2 Task 4.5, R-45-1).
- Recovery is the defence against a rogue MANAGEMENT key and a stolen
  owner key (Task 4.11, D38 = c). Who can do what, and when:
  the identity's owner alone seats the agents and threshold
  (`setupKeyRecovery`), never while a recovery is approved; an agent opens
  a candidate (`initiateKeyRecovery`); until the agents' approvals reach
  the threshold its initiator or the owner may cancel it, a MANAGEMENT key
  may not; from that approval only the agents cancel it, at the same
  threshold, and the identity refuses its owner's `authorizeManager`,
  `deauthorizeManager` and `transferOwnership` (`ownershipFrozen`) and
  any new MANAGEMENT key (`ManagementAdditionsFrozen`); 48
  hours after the approval (`RECOVERY_TIMELOCK`), within 7 days, anyone
  executes it: the recovered key is added and every other MANAGEMENT key,
  the owner's included, is removed (ACTION, CLAIM and ENCRYPTION keys
  stay), 100 keys per call (`MAX_EVICTIONS_PER_CALL`, ~50k gas each), the
  rest through `continueKeyEviction` or the owner transfer's own batch; 7
  days after the approval (`OWNER_TRANSFER_TIMELOCK`), within 7
  days, anyone proposes the recovered wallet as owner
  (`executeOwnerTransfer`) and that wallet accepts it itself. Until then
  `owner()` keeps its other powers (it still passes `onlyManagementKey`).
  Agents at the threshold can therefore take the identity: choose agents
  you would trust with it. The owner sees the approval on chain and has
  the 48 hours to move assets through the issuer's `Token.recoveryAddress`,
  which stays the asset-side bound. Authorizing a manager trusts it with
  the ownership move.
- `removeKey` is the management action: KeyManager rotations and batches
  use it, and it is the only path for a key nobody can sign for (an
  RSA-type or passphrase key).
- `removeKeyWithProof(key, purpose, signature)` is the holder-consented
  removal. It is still sent by a MANAGEMENT key, and the key's own address
  must have signed. The contract recovers the signer from
  `getRemoveKeyMessage(key, purpose)`, which is
  the EIP-191 digest of the packed message `"Remove key from OnchainID"`,
  identity, key, purpose, `removalNonces(key)` and chain id, and requires
  `keccak256(abi.encodePacked(signer)) == key`, the way address keys are
  stored. The identity address and chain id stop a signature from being
  replayed on another identity or chain; the key's removal nonce (raised
  by every removal) makes it good for one removal, so it cannot remove
  the key again after the key is re-added. ECDSA keys only ("Only ECDSA
  keys support proof"). A revoked key is not removed again ("Key already
  revoked").
- `getRemoveKeyMessage` returns the already-prefixed digest to check, not
  the bytes to pass to `personal_sign` (that would prefix twice and be
  refused). Sign the inner message:

  ```javascript
  const inner = ethers.solidityPackedKeccak256(
    ["string", "address", "bytes32", "uint256", "uint256", "uint256"],
    [
      "Remove key from OnchainID",
      identityAddress,
      keyHash,
      purpose,
      await identity.removalNonces(keyHash),
      chainId,
    ],
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
`deauthorizeManager` (owner only) are the one way KeyManager accepts
(its `_checkAuthorized`). Any contract can also be added as a MANAGEMENT
key with `addKey(keccak256(abi.encodePacked(contract)), 1, 1)`; it then
passes `onlyManagementKey`, but KeyManager does not treat that as an
authorization.

## Claims

Claims on an identity are a record. `IdentityRegistry` holds the required
topics and trusted issuers, and `isVerified` asks each trusted issuer
(`ClaimIssuer.hasValidClaim(identity, topic)`, which checks expiry and
revocation); it never reads the identity's lists, so a claim the owner or
anyone naming itself as issuer writes counts for nothing. The identity
keeps no trusted-issuer list, required topics or compliance view of its
own.
