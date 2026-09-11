# 🗳️ Voting System - Visual Diagrams

## 📊 Complete System Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│                    VANGUARD STABLECOIN ECOSYSTEM                         │
└─────────────────────────────────────────────────────────────────────────┘

┌──────────────────┐      ┌──────────────────┐      ┌──────────────────┐
│  Governance      │      │  Dynamic List    │      │  ZK Proof        │
│  Token (VGT)     │◄────►│  Manager         │◄────►│  System          │
│                  │      │                  │      │                  │
│  • Voting Power  │      │  • Whitelist     │      │  • Membership    │
│  • Proposals     │      │  • Blacklist     │      │  • Verification  │
│  • Token Locking │      │  • Status Track  │      │  • Nullifiers    │
└──────────────────┘      └──────────────────┘      └──────────────────┘
         │                         │                         │
         │                         │                         │
         └─────────────────────────┴─────────────────────────┘
                                   │
                          ┌────────▼────────┐
                          │  User Platform  │
                          │  Access Control │
                          └─────────────────┘
```

---

## 🔄 Voting Workflow - Detailed

### **Phase 1: Proposal Creation**

```
┌─────────────────────────────────────────────────────────────────┐
│  ALICE wants to add BOB to the whitelist                        │
└─────────────────────────────────────────────────────────────────┘

ALICE (Proposer)
   │
   │ 1. Has 10,000 VGT tokens and is KYC-verified
   │
   ├─► Check balance ≥ proposalCreationCost (10 VGT)
   │   ✅ Balance: 10,000 VGT
   │
   ├─► Approve VGT tokens
   │   approve(VanguardGovernance, 10 VGT)
   │
   ├─► Create proposal
   │   createListUpdateProposal(
   │       proposalType: AddToWhitelist,
   │       title: "Add Bob to Whitelist",
   │       description: "Bob passed KYC/AML",
   │       targetUser: 0xBob...,
   │       targetIdentity: 123456,
   │       reason: "KYC/AML verified"
   │   )
   │
   ├─► VGT tokens transferred & locked
   │   transferFrom(Alice, VanguardGovernance, 10 VGT)
   │   _lockedTokens[proposalId] += 10 VGT
   │
   └─► Proposal created
       ✅ Proposal ID: 1
       ✅ Status: Active
       ✅ Voting starts NOW
       ✅ Voting ends: NOW + 5 days
       ✅ Execution time: votingEnds + 1 day
       ✅ Eligible voters frozen: registeredIdentityCount() at this moment
          (say 10 verified people; the quorum bar cannot move after this)
```

---

### **Phase 2: Voting Period (5 Days)**

```
┌─────────────────────────────────────────────────────────────────┐
│  Community votes on Proposal #1                                  │
└─────────────────────────────────────────────────────────────────┘

DAY 1: ALICE tries to vote FOR
   │
   └─► ❌ "Proposer cannot vote on own proposal"

DAY 1: BOB votes FOR
   │
   ├─► Is KYC-verified; balance ≥ votingCost (10 VGT)
   │
   ├─► Approve VGT tokens
   │   approve(VanguardGovernance, 10 VGT)
   │
   ├─► Cast vote
   │   castVote(proposalId: 1, support: true, reason: "...")
   │
   ├─► VGT tokens locked
   │   transferFrom(Bob, VanguardGovernance, 10 VGT)
   │   _voterLockedTokens[1][Bob] = 10 VGT
   │
   └─► Vote recorded
       ✅ Votes FOR: 1        (1 person = 1 vote, balance irrelevant)
       ✅ Votes AGAINST: 0

DAY 2: CHARLIE votes FOR
   │
   ├─► Has 50,000 VGT tokens — still worth exactly 1 vote
   ├─► Locks 10 VGT for voting
   │
   └─► Vote recorded
       ✅ Votes FOR: 2
       ✅ Votes AGAINST: 0

DAY 3: DAVID votes AGAINST
   │
   ├─► Has 20,000 VGT tokens — still worth exactly 1 vote
   ├─► Locks 10 VGT for voting
   │
   └─► Vote recorded
       ✅ Votes FOR: 2
       ✅ Votes AGAINST: 1

DAY 5: Voting period ends
   │
   └─► Final tally
       ✅ Total votes: 3 of 10 eligible (30% turnout)
       ✅ Votes FOR: 2 (66.7%)
       ✅ Votes AGAINST: 1 (33.3%)
```

---

### **Phase 3: Execution**

```
┌─────────────────────────────────────────────────────────────────┐
│  Execute Proposal #1 (after voting period + 1 day delay)         │
└─────────────────────────────────────────────────────────────────┘

ANYONE can execute (usually proposer)
   │
   ├─► Check voting period ended
   │   ✅ Current time > votingEnds
   │
   ├─► Check execution delay met
   │   ✅ Current time ≥ executionTime
   │
   ├─► Calculate results
   │   Total votes: 3
   │   FOR: 2 (66.7%)   AGAINST: 1 (33.3%)
   │
   ├─► Check quorum (15% for AddToWhitelist)
   │   Denominator: eligible voters FROZEN at creation = 10
   │   Required: 15% of 10 = 1.5 → 2 votes
   │   Actual: 3 votes
   │   ✅ QUORUM MET
   │
   ├─► Check approval (60% for AddToWhitelist)
   │   Required: 60% FOR
   │   Actual: 66.7% FOR
   │   ✅ APPROVAL MET
   │
   ├─► Execute proposal
   │   dynamicListManager.addToWhitelist(
   │       user: 0xBob...,
   │       identity: 123456,
   │       reason: "KYC/AML verified"
   │   )
   │
   ├─► Manager call SUCCEEDS → burn locked tokens
   │   governanceToken.burn(40 VGT)
   │   // 10 (proposal) + 3 × 10 (votes)
   │
   └─► Proposal executed
       ✅ Status: EXECUTED
       ✅ Bob's status: WHITELISTED
       ✅ Locked tokens: BURNED

   [If the manager call had REVERTED — e.g. governance not yet
    authorised on the DynamicListManager:]
   │
   ├─► Status: REJECTED (terminal; resubmit once the cause is fixed)
   ├─► Event: ProposalExecutionFailed(1, "Only owner or governance")
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
│  BOB generates whitelist proof                                   │
└─────────────────────────────────────────────────────────────────┘

BOB
   │
   ├─► Check status in DynamicListManager
   │   status = getUserStatus(0xBob...)
   │   ✅ Status: WHITELISTED
   │
   ├─► Generate ZK proof (Option 1)
   │   • Add identity to Merkle tree
   │   • Generate witness
   │   • Generate Groth16 proof (~50 seconds)
   │   • Proof: [pA, pB, pC, publicSignals]
   │
   ├─► Submit proof to ZKVerifierIntegrated
   │   verifyWhitelistProof(pA, pB, pC, publicSignals)
   │
   ├─► Verification checks
   │   1. ✅ ZK proof cryptography valid
   │   2. ✅ User status: WHITELISTED (DynamicListManager)
   │   3. ✅ Proof not expired (< 30 days)
   │   4. ✅ Nullifier not used before
   │
   └─► Proof accepted
       ✅ Bob can use platform features
```

---

## 🔄 Status Change & Proof Invalidation

```
┌─────────────────────────────────────────────────────────────────┐
│  BOB violates terms → Community votes to blacklist              │
└─────────────────────────────────────────────────────────────────┘

DAY 10: New proposal created
   │
   ├─► Proposal: "Add Bob to Blacklist"
   ├─► Reason: "Fraudulent activity detected"
   ├─► Voting period: 5 days
   │
   └─► Community votes

DAY 15: Proposal executed
   │
   ├─► dynamicListManager.addToBlacklist(Bob, ...)
   │
   ├─► Bob's status changed
   │   OLD: WHITELISTED ✅
   │   NEW: BLACKLISTED ❌
   │
   ├─► Whitelist version incremented
   │   whitelistVersion: 1 → 2
   │
   └─► Status change recorded
       ✅ Timestamp: Day 15
       ✅ Old status: WHITELISTED
       ✅ New status: BLACKLISTED
       ✅ Reason: "Fraudulent activity"

BOB tries to use old whitelist proof
   │
   ├─► Submit old proof (generated on Day 8)
   │
   ├─► Verification checks
   │   1. ✅ ZK proof cryptography valid
   │   2. ❌ User status: BLACKLISTED (not WHITELISTED)
   │   3. ❌ PROOF REJECTED
   │
   └─► Access denied
       ❌ Bob cannot use platform
       ❌ Old proof invalidated
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
   Voters (1 vote each, 10 VGT locked each):
      - Bob: FOR
      - Charlie: FOR
      - David: AGAINST

   Total locked: 40 VGT

Result: PASSED (3 of 10 eligible = 30% turnout ≥ 15% quorum;
                2 of 3 = 66.7% ≥ 60% approval)
   ✅ 40 VGT BURNED
   ✅ Total supply reduced by 40 VGT
   ✅ Bob added to whitelist
```

---

## 🎯 Quick Reference

### **Voting Thresholds**

| Proposal Type | Quorum | Approval | Example (100 eligible voters) |
|---------------|--------|----------|-------------------------------|
| AddToWhitelist | 15% | 60% | ≥15 voters, ≥60% of them FOR |
| RemoveFromWhitelist | 15% | 60% | ≥15 voters, ≥60% of them FOR |
| AddToBlacklist | 20% | 70% | ≥20 voters, ≥70% of them FOR |
| RemoveFromBlacklist | 20% | 65% | ≥20 voters, ≥65% of them FOR |

*Quorum is a share of eligible (KYC-verified) voters counted when the
proposal was created, not of VGT supply. Votes are one per person.*

### **Timeline**
```
Day 0: Proposal created
Day 0-5: Voting period
Day 6: Execution delay
Day 6+: Proposal can be executed
```

### **Costs**
```
Proposal creation: 10 VGT   (owner-adjustable, 1 .. 1000)
Voting:            10 VGT per vote (same bound)
```

---

## 🎉 Summary

**Creating Proofs**:
1. User must be WHITELISTED (via governance vote)
2. Generate ZK proof (Option 1-6)
3. Proof valid as long as status is WHITELISTED
4. Status change → proof invalidated

**Voting Process**:
1. Create proposal (lock VGT)
2. Community votes (lock VGT)
3. Wait for voting period (5 days)
4. Execute proposal (burn on pass; otherwise each participant claims their VGT)
5. Status change applied automatically

**Try It**: Run Option 88 to see the complete lifecycle! 🚀

