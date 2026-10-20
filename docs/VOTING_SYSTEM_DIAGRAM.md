# 🗳️ Voting System - Visual Diagrams

## 📊 Complete System Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│              VANGUARD TOKEN (VSC): GOVERNANCE AND THE LISTS             │
└─────────────────────────────────────────────────────────────────────────┘

┌───────────────────┐ ListUpdate┌──────────────────┐ writes ┌────────────────┐
│ VanguardGovernance│──vote────►│ DynamicList      │───────►│ Whitelist /    │
│ + VGT (fee token) │           │ Manager          │        │ BlacklistOracle│
│ • Proposals       │           │ • list writes    │        └───────┬────────┘
│ • 1 identity =    │           │ • status history │                │ read
│   1 vote          │           └──────────────────┘                ▼
│ • VGT deposits    │                                     ┌──────────────────┐
└───────────────────┘  ┌──────────────────┐  binding read │ ComplianceRules  │
                       │ PrivacyManager   │──────────────►│ (per transfer)   │
                       │ (ZK whitelist    │               └──────────────────┘
                       │  root, bindings) │
                       └──────────────────┘
```

PrivacyManager never reads DynamicListManager: the whitelist root is
published to PrivacyManager by its list operator (ops after the handover)
or by a PrivacyParameters vote. ComplianceRules reads the oracles and,
by the token's whitelist mode, the ZK binding.

---

## 🔄 Voting Workflow - Detailed

### **Phase 1: Proposal Creation**

```

┌─────────────────────────────────────────────────────────────────┐
│ ALICE wants to add BOB to the whitelist │
└─────────────────────────────────────────────────────────────────┘

ALICE (Proposer)
│
│ 1. Has 10,000 VGT, is KYC-verified, controls her OnchainID, and
│ her identity was bound at least minVoterAge (7 days) ago
│
├─► Check balance ≥ proposalCreationCost (10 VGT)
│ ✅ Balance: 10,000 VGT
│
├─► Approve VGT tokens
│ approve(VanguardGovernance, 10 VGT)
│
├─► Create proposal
│ createProposal(
│ proposalType: ListUpdate,
│ title: "Add Bob to Whitelist",
│ description: "Bob passed KYC/AML",
│ target: dynamicListManager,
│ callData: addToWhitelist(0xBob..., 123456, tier 1, 365 days, "KYC/AML verified")
│ )
│
├─► VGT tokens transferred & locked
│ transferFrom(Alice, VanguardGovernance, 10 VGT)
│ _lockedTokens[proposalId] = 10 VGT
│ _voterLockedTokens[proposalId][aliceIdentity] = 10 VGT
│
└─► Proposal created
✅ Proposal ID: 1
✅ Status: Active
✅ Voting starts NOW
✅ Voting ends: NOW + 5 days
✅ Execution time: votingEnds + 1 day
✅ Eligible voters frozen: registeredIdentityCountAt(createdAt -
minVoterAge), the identities old enough to vote (say 10; the
quorum bar cannot move after this)

```

---

### **Phase 2: Voting Period (5 Days)**

```

┌─────────────────────────────────────────────────────────────────┐
│ Community votes on Proposal #1 │
└─────────────────────────────────────────────────────────────────┘

DAY 1: ALICE tries to vote FOR
│
└─► ❌ "Proposer cannot vote on own proposal"

DAY 1: BOB votes FOR
│
├─► Is KYC-verified; balance ≥ votingCost (10 VGT)
│
├─► Approve VGT tokens
│ approve(VanguardGovernance, 10 VGT)
│
├─► Cast vote
│ castVote(proposalId: 1, support: true, reason: "...")
│
├─► VGT tokens locked
│ transferFrom(Bob, VanguardGovernance, 10 VGT)
│ _voterLockedTokens[1][bobIdentity] = 10 VGT // keyed by Bob's OnchainID
│
└─► Vote recorded
✅ Votes FOR: 1 (1 person = 1 vote, balance irrelevant)
✅ Votes AGAINST: 0

DAY 2: CHARLIE votes FOR
│
├─► Has 50,000 VGT tokens — still worth exactly 1 vote
├─► Locks 10 VGT for voting
│
└─► Vote recorded
✅ Votes FOR: 2
✅ Votes AGAINST: 0

DAY 3: DAVID votes FOR
│
├─► Has 20,000 VGT tokens — still worth exactly 1 vote
├─► Locks 10 VGT for voting
│
└─► Vote recorded
✅ Votes FOR: 3
✅ Votes AGAINST: 0

DAY 5: Voting period ends
│
└─► Final tally
✅ Total votes: 3 of 10 eligible (30% turnout)
✅ Votes FOR: 3 (100%)
✅ Votes AGAINST: 0 (0%)

```

---

### **Phase 3: Execution**

```

┌─────────────────────────────────────────────────────────────────┐
│ Execute Proposal #1 (after voting period + 1 day delay) │
└─────────────────────────────────────────────────────────────────┘

ANYONE can execute (usually proposer)
│
├─► Check voting period ended
│ ✅ Current time > votingEnds
│
├─► Check execution delay met
│ ✅ Current time ≥ executionTime
│
├─► Check gas left ≥ MIN_EXECUTION_GAS (3,000,000) for a passing proposal
│
├─► Calculate results
│ Total votes: 3
│ FOR: 3 (100%) AGAINST: 0 (0%)
│
├─► Check quorum (20% for ListUpdate)
│ Denominator: eligible voters FROZEN at creation = 10
│ Required: 20% of 10 = 2 votes
│ Actual: 3 votes
│ ✅ QUORUM MET
│
├─► Check approval (70% for ListUpdate)
│ Required: 70% FOR
│ Actual: 100% FOR
│ ✅ APPROVAL MET
│
├─► Execute proposal
│ dynamicListManager.addToWhitelist(
│ user: 0xBob...,
│ identity: 123456,
│ tier: 1,
│ duration: 365 days, // or type(uint256).max = no expiry; 0 reverts
│ reason: "KYC/AML verified"
│ )
│ └─► whitelistOracle.addToWhitelist(0xBob..., 1, 365 days, "KYC/AML verified")
│
├─► Manager call SUCCEEDS → burn locked tokens
│ governanceToken.burn(40 VGT)
│ // 10 (proposal) + 3 × 10 (votes)
│
└─► Proposal executed
✅ Status: EXECUTED
✅ Bob whitelisted in WhitelistOracle (the list transfers check)
✅ Locked tokens: BURNED

[If the manager call had REVERTED — e.g. the WhitelistOracle owner
never ran setListManager(DynamicListManager):]
│
├─► Status: REJECTED (terminal; resubmit once the cause is fixed)
├─► Event: ProposalExecutionFailed(1, <raw revert data of
│ "WhitelistOracle: Only owner or list manager">)
└─► Alice, Bob, Charlie, David each call claimRefund(1) for 10 VGT

[If a threshold had NOT been met:]
│
├─► Status: REJECTED
├─► Event: ProposalRejected(1)
└─► Same claim step

```

---

### **Phase 4: Proof Generation & Validation**

```

┌─────────────────────────────────────────────────────────────────┐
│ BOB generates whitelist proof │
└─────────────────────────────────────────────────────────────────┘

BOB
│
├─► Check his commitment is in the whitelist root the list operator
│ published to PrivacyManager (publishWhitelistRoot)
│
├─► Generate ZK proof (Option 42 -> 1)
│ • Commitment Poseidon(identity, secret) in the published root
│ • Generate witness
│ • Generate PLONK proof (~5 seconds)
│ • Proof: 24 words, signals [nullifier, merkleRoot, walletBinding]
│
├─► Submit proof to PrivacyManager (it calls ZKVerifierIntegrated)
│ submitWhitelistProof(proof, signals)
│
├─► Verification checks
│ 1. ✅ merkleRoot is the current published root
│ 2. ✅ walletBinding == Bob's wallet (msg.sender)
│ 3. ✅ nullifier not bound to another wallet under this root version
│ 4. ✅ PLONK proof verifies (ZKVerifierIntegrated)
│
└─► Binding recorded, valid for proofValidityPeriod (30 days by
default, 1-365 owner-settable) or until the next root
✅ hasValidWhitelistProof(Bob) is true. Under ZkOnly (or Either
with no whitelist oracle) that satisfies VSC's whitelist; under
Either with a bound oracle it serves only if Bob's investor
type requires tier 1 (D46 a)

```

---

## 🔄 Status Change & Proof Invalidation

```

┌─────────────────────────────────────────────────────────────────┐
│ BOB violates terms → Community votes to blacklist │
└─────────────────────────────────────────────────────────────────┘

DAY 10: New proposal created
│
├─► Proposal: "Add Bob to Blacklist"
├─► Reason: "Fraudulent activity detected"
├─► Voting period: 5 days
│
└─► Community votes

DAY 16: Proposal executed (5-day vote + 1-day delay)
│
├─► dynamicListManager.addToBlacklist(Bob, ...)
│
├─► Bob's status changed
│ OLD: WHITELISTED ✅
│ NEW: BLACKLISTED ❌ (the whitelist entry stays; the blacklist wins)
│
└─► Status change recorded
✅ Timestamp: Day 16
✅ Old status: WHITELISTED
✅ New status: BLACKLISTED
✅ Reason: "Fraudulent activity"

BOB tries to use old whitelist proof
│
├─► His ZK binding is still recorded: PrivacyManager does not read the
│ lists (the binding lapses at the next root or at expiry)
│
└─► Every VSC transfer to or from Bob fails: ComplianceRules checks
the blacklist first, for every party, with no bypass
To revoke the proof itself, the list operator publishes a new root
without Bob's commitment

```

---

## 📊 Token Economics

### **Proposal Creation**

```

Cost: 10 VGT (owner-adjustable, ≤ 1000 VGT)

If proposal PASSES and its call succeeds:
✅ Tokens BURNED
✅ Reduces total supply

Otherwise (threshold not met, or the call reverted):
✅ Proposer CLAIMS the deposit back via claimRefund(id)
✅ No penalty for failed proposals

```

### **Voting**

```

Cost: 10 VGT per vote (owner-adjustable, ≤ 1000 VGT)

If proposal PASSES and its call succeeds:
✅ All voting deposits BURNED

Otherwise:
✅ Each voter CLAIMS their deposit back via claimRefund(id)
✅ No penalty for voting on failed proposals
✅ A voter the token cannot pay right now (de-verified, frozen)
blocks only their own claim, never the settlement

```

### **Example Scenario**

```

Proposal #1: Add Bob to Whitelist
Proposer: Alice (10 VGT locked; may not vote on her own proposal)
Voters (1 vote each, 10 VGT locked each): - Bob: FOR - Charlie: FOR - David: FOR

Total locked: 40 VGT

Result: PASSED (3 of 10 eligible = 30% turnout ≥ 20% quorum;
3 of 3 = 100% ≥ 70% approval)
✅ 40 VGT BURNED
✅ Total supply reduced by 40 VGT
✅ Bob added to whitelist

```

---

## 🎯 Quick Reference

### **Voting Thresholds**

| Proposal Type              | Quorum | Approval | Example (100 eligible voters) |
| -------------------------- | ------ | -------- | ----------------------------- |
| ListUpdate                 | 20%    | 70%      | ≥20 voters, ≥70% of them FOR  |
| IdentityRegistryParameters | 25%    | 65%      | ≥25 voters, ≥65% of them FOR  |
| GovernanceTokenParameters  | 30%    | 70%      | ≥30 voters, ≥70% of them FOR  |
| EscrowFactoryParameters    | 30%    | 70%      | ≥30 voters, ≥70% of them FOR  |
| IdentityFactoryParameters  | 30%    | 70%      | ≥30 voters, ≥70% of them FOR  |

_Quorum is a share of the identities registered at the proposal's
voter-age cutoff (creation minus minVoterAge), not of VGT supply. Votes are
one per identity._

### **Timeline**

```

Day 0: Proposal created
Day 0-5: Voting period
Day 5-6: Execution delay
Day 6+: Proposal can be executed

```

### **Costs**

```

Proposal creation: 10 VGT (owner-adjustable, above 0, at most 1000 VGT)
Voting: 10 VGT per vote (same bound)

```

---

## 🎉 Summary

**Creating Proofs**:

1. The user's commitment must be in the whitelist root PrivacyManager
   publishes (list operator). On-chain listings come from a ListUpdate
   vote, oracle consensus, or the oracle owner directly (ops after the
   handover can write any tier, tier 5 included, D44 a; who should own the
   list oracles is an audit item)
2. Generate ZK proof (option 42 -> 1; 42 -> 2 to 6 for the other circuits)
3. Binding valid until proofValidityPeriod expires or a new root is published
4. A blacklisting blocks the holder's VSC transfers whatever the binding

**Voting Process**:

1. Create proposal (lock VGT)
2. Community votes (lock VGT)
3. Wait for voting period (5 days)
4. Execute proposal (burn on pass; otherwise each participant claims their VGT)
5. Status change applied when anyone calls executeProposal after the delay

**Try it**: option 86 creates a ListUpdate proposal (then 77, 79, 78);
option 88 walks the same status changes with direct owner writes, no vote.
