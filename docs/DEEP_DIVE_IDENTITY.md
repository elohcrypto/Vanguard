# Technical Deep Dive: identity, recovery and governance

Checked against the code in Task 5.5 and again at 8c77e24 (2026-10-20,
after Task 5.17); listings are condensed from the
Solidity named next to each. The technical deep dive is three files: [transfer path](DEEP_DIVE_TRANSFER.md) (token, compliance, oracles), [identity, recovery and governance](DEEP_DIVE_IDENTITY.md) and [zero-knowledge circuits](DEEP_DIVE_ZK.md).

---

## 🔐 OnchainID Implementation Analysis

`OnchainID` is one deployed contract built from three files:
`OnchainIDKeys.sol` (abstract: ERC-734 keys, execution requests; Task
4.5), `OnchainIDOwnership.sol` (abstract: manager authorization, two-step
ownership, the recovery manager pin and its hooks; Task 4.11) and
`OnchainID.sol` (ERC-735 claims).
`OnchainIDFactory` deploys it with CREATE2.

### Key Management System

```solidity
uint256 public constant MANAGEMENT_KEY = 1;    // adds and removes keys
uint256 public constant ACTION_KEY = 2;        // proposes executions
uint256 public constant CLAIM_SIGNER_KEY = 3;  // may add claims
uint256 public constant ENCRYPTION_KEY = 4;

struct Key {
    uint256 purpose;
    uint256 keyType;      // ECDSA_TYPE (1) or RSA_TYPE (2)
    bytes32 key;          // keccak256(abi.encodePacked(address)) for an address key
    uint256 revokedAt;    // 0 while active
}
```

- `addKey` / `removeKey` need a MANAGEMENT key, the owner or an
  authorized manager (`onlyManagementKey`). They act at once (ERC-734):
  a MANAGEMENT key adds or removes any key, a MANAGEMENT key included,
  without the holder's consent. `addKey` re-activates a revoked key and
  refuses an active one, keeps at most 64 active keys per purpose
  (`TooManyKeys`) and adds no MANAGEMENT key while a recovery is approved
  (`ManagementAdditionsFrozen`).
- `removeKeyWithProof(key, purpose, signature)` is the holder-consented
  removal: still sent by a MANAGEMENT key, it recovers the signer from
  `getRemoveKeyMessage(key, purpose)`, the EIP-191 digest of
  `keccak256(abi.encodePacked("Remove key from OnchainID", identity, key,
purpose, removalNonces[key], chainid))`, and requires
  `keccak256(abi.encodePacked(signer)) == key`. Every removal raises the
  key's nonce, so a signature removes the key once and is stale after a
  re-add. ECDSA keys only; a revoked key is not removed again. The digest is already prefixed: the holder
  signs the inner keccak256 with `signMessage`; a `personal_sign` of the
  digest prefixes twice and is refused. Demo options 5 -> 1 and 5a.
- KeyManager's timelocks bind only the rotations and recoveries sent
  through it (`executeKeyRotation` calls `removeKey` and `addKey`;
  `executeKeyRecovery` calls the identity's `evictManagementKeys`, which
  seats the recovered key and removes the others). The defence against a rogue MANAGEMENT key or a stolen
  owner key is recovery (Task 4.11), through the identity's one pinned
  recovery manager (other managers hold key powers only and are cleared
  when the recovered wallet accepts): the owner seats at least two agents
  at a threshold of at least 2, none of them the owner, the identity, the
  KeyManager or a MANAGEMENT key (`AgentControlsIdentity`), so the owner
  first removes any MANAGEMENT key it does not know (A2F-4); a re-seat
  waits 48 hours and the seated agents can veto it; from
  the agents' approval only they cancel, at their threshold, and the
  owner's `authorizeManager`, `deauthorizeManager` and
  `transferOwnership` and new MANAGEMENT keys are frozen; 48 hours later
  execution evicts every other MANAGEMENT key (in batches of 100,
  `continueKeyEviction`); 7 days after the approval the recovered wallet
  is proposed as owner and accepts. Each step runs within a 7-day window,
  and a recovery to a key that is not an address hash adds the key but
  never moves ownership (A2F-7). Agents at the threshold can take the
  identity ("Identity key lifecycle" below).
- KeyManager's rotations and batches need `authorizeManager(KeyManager)`
  (owner only); recovery needs only the identity's pinned recovery
  manager (`recoveryManager`, set at creation by the factory or once by
  the owner), so deauthorizing KeyManager never switches recovery off. Any contract can also be added as a MANAGEMENT key
  with `addKey(keccak256(abi.encodePacked(contract)), 1, 1)` and then
  passes `onlyManagementKey`, which KeyManager does not count as an
  authorization.
- Ownership is two-step (`transferOwnership`, then `acceptOwnership` by
  the new owner). On acceptance the old owner's MANAGEMENT key is revoked
  and the new owner ends with one; other keys and `authorizedManagers`
  survive, and the new owner audits them (`getKeysByPurpose`;
  `getManagers()` lists the authorized managers, at most 8, with
  `ManagerAuthorized` / `ManagerDeauthorized` events). `renounceOwnership`
  reverts and `initialize` runs once and only from the deployer
  (`NotCreator`, Task 5.2), so an identity always has a controller.
- `execute` from a MANAGEMENT key (or the owner) runs at once; from an
  ACTION key it waits until `executionThreshold` (default 2, never below 2) approvals are counted: the request counts as one and each other
  ACTION or MANAGEMENT key (or the owner) adds one, never the requester.

### Claim Management System

```solidity
struct Claim {
    uint256 topic;        // KYC=6, AML=7, ...
    uint256 scheme;
    address issuer;
    bytes signature;
    bytes data;
    string uri;
    uint256 validTo;      // stored as 0; expiry lives at the ClaimIssuer
    uint256 validFrom;
}
```

- The claim id is `keccak256(abi.encodePacked(issuer, topic, data))`.
  `addClaim` accepts the owner, a MANAGEMENT or CLAIM_SIGNER key, an
  authorized manager, or a caller naming itself as issuer (`batchAddClaims`,
  up to 50, applies the same rule) (how `ClaimIssuer.issueClaim` writes its
  copy); only the issuer updates an existing id. `removeClaim` accepts
  the issuer, a MANAGEMENT key, the owner or an authorized manager.
  Lists are indexed per topic (`getClaimIdsByTopic`) with O(1) removal.
- These lists are a record, not the verification. `IdentityRegistry`
  holds the required topics and trusted issuers and `isVerified` asks
  each trusted issuer (`ClaimIssuer.hasValidClaim(identity, topic)`,
  which checks expiry and revocation; each call gets 45,000 gas and one
  return word, `ISSUER_CALL_GAS`, Task 5.1, and an issuer that reverts or
  misbehaves counts as no claim); it never reads the identity's
  lists, so a claim the owner or a stranger writes naming an issuer
  counts for nothing. A passing walk can be cached per identity by
  `refreshVerified` (24h, capped at claim expiry; Task 4.9). The
  identity keeps no trusted-issuer list, required topics or
  `isCompliant` of its own (removed in Task 4.5 as a third copy).

## Identity key lifecycle (KeyManager)

`KeyManager` rotates and recovers the keys of an OnchainID behind
timelocks. It has no owner and no allowlist of its own. An identity opts in
with `OnchainID.authorizeManager(keyManager)`, which only the identity's
owner can send; while it is authorized, KeyManager may add and remove the
identity's keys. Every KeyManager rotation or batch for an identity needs
the caller to hold a MANAGEMENT key on it and the identity to have
authorized KeyManager ("KeyManager: Identity has not authorized
KeyManager" otherwise). Recovery instead needs the identity to have
pinned KeyManager as its recovery manager (Task 4.11, below).

`deauthorizeManager` pauses KeyManager's rotations and batches for the
identity (refused while a recovery is approved); it does not cancel, and
it does not pause recovery. `cancelKeyRotation` and `cancelKeyRecovery`
work while withdrawn and are how to stop an item. A rotation or recovery executes
only within `EXECUTION_WINDOW` (7 days) after its execution time; after
that it reverts ("execution window passed, re-initiate"), so an item
paused for longer cannot revive when the identity re-authorizes.

- **Rotation**: a MANAGEMENT key calls `initiateKeyRotation(identity,
oldKey, newKey, purpose)`; after the timelock anyone calls
  `executeKeyRotation`, which adds the new key and revokes the old one. The
  timelock is 24 hours (`DEFAULT_TIMELOCK`) unless the identity's own
  MANAGEMENT key set another with `setCustomTimelock` (1 hour to 7 days;
  it applies to rotations initiated afterwards). A rotation whose initiator
  lost its MANAGEMENT key before execution does not run; any current
  MANAGEMENT key can `cancelKeyRotation`. The timelock binds only rotations
  through KeyManager: a MANAGEMENT key adds and removes keys at once
  (ERC-734), through `batchAddKeys`/`batchRemoveKeys` or `OnchainID.addKey`/
  `removeKey`, so the timelock gives the holder visibility, not a control
  against a compromised MANAGEMENT key. This is by design (Task 4.5,
  R-45-1): `executeKeyRotation` and `executeKeyRecovery` themselves call
  `addKey`, so a timelock inside `addKey` would either block them or tie
  the identity to one manager. The defence against a rogue MANAGEMENT key
  is recovery (below).
- **Removal with the holder's consent**: `removeKey` is the management
  action (no consent; KeyManager batches and rotations use it, and it is
  the only path for a non-ECDSA key). `OnchainID.removeKeyWithProof(key,
purpose, signature)` is still sent by a MANAGEMENT key but also needs
  the key's own address to have signed `getRemoveKeyMessage(key,
purpose)` (identity, key, purpose, the key's removal nonce and chain id,
  so a signature removes the key once; the returned digest is
  already EIP-191 prefixed, so the holder signs the inner keccak256 with
  `signMessage`). Demo options 5 -> 1 and 5a.
- **Recovery** (Tasks 4.11 and 4.14, D38 = c) is the defence against a rogue
  MANAGEMENT key and a stolen owner key. It runs only through the identity's
  one pinned recovery manager (`recoveryManager()`): the factory pins its
  KeyManager at creation (the compiled code hash, `recoveryManagerCodeHash`, or
  none); a directly deployed identity is pinned by its creator in the creating
  block or by its owner. The pin is final and outlives ownership transfers, so
  a new owner checks `recoveryManager()` first and, after an ordinary transfer,
  re-seats the agents. The owner seats two to ten agents with a threshold of
  at least 2 (`setupKeyRecovery`, `ThresholdBelowTwo`, D59); MANAGEMENT keys,
  the identity and KeyManager itself are refused as agents at seating and
  re-seat apply, the owner at every vote as well (D53). First the owner
  removes every MANAGEMENT key it does not recognise (`getKeysByPurpose(1)`):
  an unknown one can make the chosen agents MANAGEMENT keys and block the
  seating (A2F-4). A re-seat waits 48
  hours, the seated agents can veto it, an approved recovery blocks it and it
  applies only while its proposer still owns the identity (else `StaleReseat`;
  anyone drops it, `dropStaleRecoverySetup`). An agent's open is its approval
  (D39); before the threshold only the initiator cancels, never the owner;
  after, only the agents cancel, at the threshold, and the owner's
  `authorizeManager`, `deauthorizeManager`, `transferOwnership`, any new
  MANAGEMENT key and any `acceptOwnership` but the nominee the manager still
  names are refused. 48 hours after the approval, within 7 days, anyone
  executes: the recovered key is added and every other MANAGEMENT key is
  removed in one call (64 keys a purpose, D42; O(1) removal). From 7 to 14 days
  after the approval someone must call `executeOwnerTransfer` and the recovered
  wallet must accept (only a key of the form keccak256(address) can become the
  owner: a recovery to any other key adds and evicts keys but never moves
  ownership, A2F-7), or the lock lifts, the old owner keeps the identity and
  an agent's next open re-opens recovery (D52). Until the transfer the old
  owner can still remove claims, ACTION or CLAIM keys and the recovered key
  (restored by the transfer). The acceptance removes every other MANAGEMENT key
  and every manager but the recovery manager; the thief's ACTION and CLAIM keys
  survive, so the recovered owner reviews `getKeysByPurpose(2|3)` (D40). Agents
  at the threshold can take the identity: choose them as you would an heir; the
  owner has the 48 hours to move assets through the issuer's
  `Token.recoveryAddress`. Every registry binding (register, batch, update,
  move, token recovery) requires the wallet to control the identity then
  (owner, MANAGEMENT or ACTION key: D41, a consistency rule, not a defence
  against a rogue agent or key holder, A2F-6); control lost later keeps the
  entry and governance refuses the vote. A holder without seated agents whose owner
  key is lost is burned and re-issued by the agent. Demo options 12 and 5 -> 2.
- **Batch and multi-signature keys**: `batchAddKeys` and `batchRemoveKeys`
  write several keys in one call; `addMultiSigKey` records an N-of-M
  signer set that `signMultiSigOperation` and `checkMultiSigThreshold`
  count. The multi-signature record is bookkeeping: nothing in KeyManager
  executes on it.

A wallet recovered with `Token.recoveryAddress` votes only once it holds a
key on its OnchainID; KeyManager recovery is the designed path. The demo
exercises the lifecycle in options 12, 12a, 12b, 5 and 5a
(docs/TESTNET_DEMO_OPTIONS.md, "Identity keys through KeyManager"); its resume
works within one demo session only.

## Token-side recovery (`recoveryAddress`)

`Token.recoveryAddress(lost, new, identity)` (agent only, `whenNotPaused`)
moves a holder's balance to a new wallet after the wallet is lost:

1. `_checkAgentTarget` on both wallets (VGT refuses a trusted contract,
   D23); "Token: recovery into trusted contract"; "Invalid identity" for a
   zero identity.
2. The lost wallet holds the identity in the shared IdentityRegistry, or a
   sibling token's recovery already moved it to the new wallet (the lost
   wallet unbound, the new one bound to it, `formerIdentity(lost)` the
   identity); the new wallet has no other identity ("New wallet already
   has identity").
3. D41: the new wallet controls the identity (owner, MANAGEMENT or ACTION
   key; `WalletDoesNotControlIdentity`). This keeps the token side and the
   identity side consistent; it is not a defence against a rogue agent,
   which can still recover into a wallet that holds a key on the identity
   (A2F-6).
4. The whole balance moves through OpenZeppelin's internal `_transfer` (no
   compliance or free-balance check), the frozen amount is added to the
   new wallet's, and an address freeze on either wallet survives (OR).
5. `IdentityRegistry.moveIdentity(lost, new)` unless already moved, then
   `ComplianceRules.canReceive(new)` (the lists only: a holder whose country
   was blocked after onboarding still recovers), then `RecoverySuccess`.

The investor type does not move: a compliance officer re-assigns it (and
any exemption) to the new wallet.

---

## 🎯 Governance System Deep Dive

### Fair Voting Implementation

The listings below are condensed from `contracts/governance/`: `castVote` lives
in `GovernanceProposals.sol`, `executeProposal`, `_settleWithRefund` and
`claimRefund` in `VanguardGovernance.sol` (one deployed contract, split by
inheritance in Task 4.8).
An earlier version of this section showed code that never existed in the repo (a
`Succeeded` status, an `executionWindow`, `ParameterChange` and `UpgradeContract`
types, `forVotes++`); it is replaced here with the shape actually deployed.

**1 Person = 1 Vote Mechanism (one vote per identity, plan 2F.1 / D25):**

```solidity
function castVote(uint256 proposalId, bool support, string calldata reason)
    external nonReentrant
{
    Proposal storage proposal = _proposals[proposalId];
    require(proposal.status == ProposalStatus.Active, "Proposal not active");
    require(block.timestamp <= proposal.votingEnds, "Voting period ended");
    // The vote is keyed by the wallet's OnchainID, not the wallet.
    address id = identityRegistry.identity(msg.sender);
    require(id != address(0), "Must be KYC/AML verified");
    require(!_hasVoted[proposalId][id], "Already voted");
    require(id != proposal.proposerIdentity, "Proposer cannot vote on own proposal");
    // isVerified, wallet holds a key on id, id registered by voterAgeCutoff
    _requireEligible(msg.sender, id, proposal.voterAgeCutoff);

    require(governanceToken.balanceOf(msg.sender) >= votingCost, "Insufficient tokens for voting");
    require(governanceToken.transferFrom(msg.sender, address(this), votingCost), "Token transfer failed");

    _hasVoted[proposalId][id] = true;
    _voteChoice[proposalId][id] = support;
    _proposalVoters[proposalId].push(msg.sender);        // for the refund ledger
    _lockedTokens[proposalId] += votingCost;
    _voterLockedTokens[proposalId][id] = votingCost;       // per identity (Task 5.2, Q6)

    if (support) proposal.votesFor += 1; else proposal.votesAgainst += 1;   // 1 person = 1 vote
    emit VoteCast(proposalId, msg.sender, support, 1, reason);
}
```

Eligibility is checked when the vote is cast, against a cutoff frozen at
creation: `createProposal` stores `voterAgeCutoff = createdAt -
minVoterAge` and `eligibleVotersAtCreation =
registeredIdentityCountAt(voterAgeCutoff)`. Only an identity registered by
the cutoff may vote (`"Identity too new to vote"`), and the quorum
denominator counts only those identities. Balance and verification are read
live: a voter whose aged identity is verified and funded after creation may
vote.

VGT delegation (`GovernanceToken.delegate`, `getVotingPower` and the other
voting-power views) is recorded on the token and not counted: `castVote`
adds 1 per verified identity and never reads voting power, so a delegate
casts one vote and its delegator still casts its own
(`test/governance/DelegationNoEffect.test.ts`). Wiring delegation into
`castVote` is scheduled after the external audit (D12, plan v2 Task 4.6).

**Proposal Execution (settles every outcome, reverts only on invalid calls):**

```solidity
function executeProposal(uint256 proposalId) external nonReentrant {
    Proposal storage proposal = _proposals[proposalId];
    require(proposal.status == ProposalStatus.Active, "Proposal not active");
    require(block.timestamp > proposal.votingEnds, "Voting period not ended");

    ProposalThresholds memory t = proposalThresholds[proposal.proposalType];
    uint256 totalVotes = proposal.votesFor + proposal.votesAgainst;
    // Quorum is a share of eligible voters FROZEN at creation, not of supply.
    uint256 eligible = proposal.eligibleVotersAtCreation;
    bool quorumMet   = eligible > 0 && totalVotes * 10000 >= eligible * t.quorumPercentage;
    bool approvalMet = totalVotes > 0 && (proposal.votesFor * 10000) / totalVotes >= t.approvalPercentage;
    bool passed      = totalVotes > 0 && quorumMet && approvalMet;

    if (!passed) {
        _settleWithRefund(proposalId, ProposalStatus.Rejected);   // deposits claimable
        emit ProposalRejected(proposalId);
        return;
    }

    require(block.timestamp >= proposal.executionTime, "Execution delay not met");
    require(gasleft() >= MIN_EXECUTION_GAS, "Insufficient gas for execution"); // 3,000,000
    uint256 gasBefore = gasleft();
    // A list update targets the DynamicListManager bound to this governance,
    // checked at creation (_requireGovernedListManager).
    (bool success, bytes memory reason) = proposal.target.call(proposal.callData);

    if (!success) {
        // Out of gas: revert, the proposal stays Active and anyone retries.
        if (gasleft() <= gasBefore / 63) revert InsufficientExecutionGas();
        _settleWithRefund(proposalId, ProposalStatus.Rejected);   // terminal; resubmit
        emit ProposalExecutionFailed(proposalId, reason);         // target's raw revert data
        return;
    }

    // The call may have settled the proposal itself (cancelProposal(self)).
    if (proposal.status != ProposalStatus.Active) { emit ProposalExecuted(proposalId); return; }
    if (_lockedTokens[proposalId] > 0) governanceToken.burn(_lockedTokens[proposalId]);
    proposal.status = ProposalStatus.Executed;
    emit ProposalExecuted(proposalId);
}
```

**Refunds are pulled, not pushed:**

```solidity
// Settlement only records; no transfer, so it cannot be blocked.
function _settleWithRefund(uint256 proposalId, ProposalStatus terminal) internal {
    _proposals[proposalId].status = terminal; _lockedTokens[proposalId] = 0; // per-identity amounts stay
}

// Deposits are per identity (Task 5.2, Q6): a wallet bound to and controlling it pulls, once.
// Task 5.17: claimRefundFor(proposalId, identity) names the identity; while no wallet is bound
// (an agent deleted it) any wallet controlling it pulls; while one is bound, only that one.
function claimRefund(uint256 proposalId) external nonReentrant {
    _claimRefund(proposalId, identityRegistry.identity(msg.sender));
}
function _claimRefund(uint256 proposalId, address id) private {
    ProposalStatus s = _proposals[proposalId].status;
    require(s == ProposalStatus.Rejected || s == ProposalStatus.Cancelled, "Proposal not settled");
    uint256 amount = id == address(0) ? 0 : _voterLockedTokens[proposalId][id];
    require(amount > 0, "Nothing to claim");
    address bound = identityRegistry.walletOf(id);
    if (bound != address(0) && bound != msg.sender) revert IdentityBoundToAnotherWallet(id, bound);
    require(_controls(msg.sender, id), "Wallet does not control its identity");
    _voterLockedTokens[proposalId][id] = 0;
    require(governanceToken.transfer(msg.sender, amount), "Refund transfer failed");
    emit RefundClaimed(proposalId, msg.sender, id, amount);
}
```

Every VGT transfer runs the token's compliance gate. Pushing refunds inside
settlement meant one participant the token refused to pay (identity
deleted, address frozen) reverted the whole settlement and trapped every
other participant's deposit on that proposal. With the pull design an
unpayable participant blocks only their own claim, until they are payable
again.

---
