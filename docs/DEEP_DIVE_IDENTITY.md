# Technical Deep Dive: identity, recovery and governance

The technical deep dive is three files: [transfer path](DEEP_DIVE_TRANSFER.md) (token, compliance, oracles), [identity, recovery and governance](DEEP_DIVE_IDENTITY.md) and [zero-knowledge circuits](DEEP_DIVE_ZK.md).

---

## 🔐 OnchainID Implementation Analysis

`OnchainID` is one deployed contract built from two files (plan v2 Task
4.5): `OnchainIDKeys.sol` (abstract, ERC-734 keys, execution requests,
manager authorization, ownership) and `OnchainID.sol` (ERC-735 claims).
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
  refuses an active one.
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
  through it (`executeKeyRotation` / `executeKeyRecovery` call `addKey`
  themselves). The defence against a rogue MANAGEMENT key or a stolen
  owner key is recovery (Task 4.11), through the identity's one pinned
  recovery manager (other managers hold key powers only and are cleared
  when the recovered wallet accepts): the owner seats the agents (a
  re-seat waits 48 hours and the seated agents can veto it); from
  the agents' approval only they cancel, at their threshold, and the
  owner's `authorizeManager`, `deauthorizeManager` and
  `transferOwnership` and new MANAGEMENT keys are frozen; 48 hours later
  execution evicts every other MANAGEMENT key (in batches of 100,
  `continueKeyEviction`); 7 days after the approval the recovered wallet
  is proposed as owner and accepts. Agents at the threshold can take the
  identity (docs/SYSTEM_WORKFLOW_GUIDE.md, "Identity key lifecycle").
- `authorizeManager` / `deauthorizeManager` (owner only) are the one way
  KeyManager accepts. Any contract can also be added as a MANAGEMENT key
  with `addKey(keccak256(abi.encodePacked(contract)), 1, 1)` and then
  passes `onlyManagementKey`, which KeyManager does not count as an
  authorization.
- Ownership is two-step (`transferOwnership`, then `acceptOwnership` by
  the new owner). On acceptance the old owner's MANAGEMENT key is revoked
  and the new owner ends with one; other keys and `authorizedManagers`
  survive, and the new owner audits them (`getKeysByPurpose`;
  `authorizedManagers` has no list or event, so read the identity's
  `authorizeManager` transactions). `renounceOwnership` reverts and
  `initialize` runs once, so an identity always has a controller.
- `execute` from a MANAGEMENT key (or the owner) runs at once; from an
  ACTION key it waits for `executionThreshold` (at least 2) approvals
  from distinct keys other than the requester.

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
  `addClaim` accepts the owner, a MANAGEMENT or CLAIM_SIGNER key, or a
  caller naming itself as issuer (how `ClaimIssuer.issueClaim` writes its
  copy); only the issuer updates an existing id. `removeClaim` accepts
  the issuer, a MANAGEMENT key, the owner or an authorized manager.
  Lists are indexed per topic (`getClaimIdsByTopic`) with O(1) removal.
- These lists are a record, not the verification. `IdentityRegistry`
  holds the required topics and trusted issuers and `isVerified` asks
  each trusted issuer (`ClaimIssuer.hasValidClaim(identity, topic)`,
  which checks expiry and revocation); it never reads the identity's
  lists, so a claim the owner or a stranger writes naming an issuer
  counts for nothing. A passing walk can be cached per identity by
  `refreshVerified` (24h, capped at claim expiry; Task 4.9). The
  identity keeps no trusted-issuer list, required topics or
  `isCompliant` of its own (removed in Task 4.5 as a third copy).

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
    _voterLockedTokens[proposalId][msg.sender] += votingCost;

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
    bool quorumMet   = totalVotes * 10000 >= proposal.eligibleVotersAtCreation * t.quorumPercentage;
    bool approvalMet = totalVotes > 0 && (proposal.votesFor * 10000) / totalVotes >= t.approvalPercentage;
    bool passed      = totalVotes > 0 && quorumMet && approvalMet;

    if (!passed) {
        _settleWithRefund(proposalId, ProposalStatus.Rejected);   // deposits claimable
        emit ProposalRejected(proposalId);
        return;
    }

    require(block.timestamp >= proposal.executionTime, "Execution delay not met");
    (bool success, bytes memory reason) = isListType(proposal.proposalType)
        ? _executeListUpdate(proposalId)                          // DynamicListManager call
        : proposal.target.call(proposal.callData);

    if (!success) {
        _settleWithRefund(proposalId, ProposalStatus.Rejected);   // terminal; resubmit
        emit ProposalExecutionFailed(proposalId, reason);         // target's raw revert data
        return;
    }

    governanceToken.burn(_lockedTokens[proposalId]);
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
function claimRefund(uint256 proposalId) external nonReentrant {
    ProposalStatus s = _proposals[proposalId].status;
    require(s == ProposalStatus.Rejected || s == ProposalStatus.Cancelled, "Proposal not settled");
    address id = identityRegistry.identity(msg.sender);
    uint256 amount = id == address(0) ? 0 : _voterLockedTokens[proposalId][id];
    require(amount > 0, "Nothing to claim");
    require(_controls(msg.sender, id), "Wallet does not control its identity");
    _voterLockedTokens[proposalId][id] = 0;
    require(governanceToken.transfer(msg.sender, amount), "Refund transfer failed");
    emit RefundClaimed(proposalId, msg.sender, amount);
}
```

Every VGT transfer runs the token's compliance gate. Pushing refunds inside
settlement meant one participant the token refused to pay (identity
deleted, address frozen) reverted the whole settlement and trapped every
other participant's deposit on that proposal. With the pull design an
unpayable participant blocks only their own claim, until they are payable
again.

---
