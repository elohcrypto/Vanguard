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
   │ 1. Has 10,000 VGT tokens
   │
   ├─► Check balance ≥ proposalCreationCost (1,000 VGT)
   │   ✅ Balance: 10,000 VGT
   │
   ├─► Approve VGT tokens
   │   approve(VanguardGovernance, 1,000 VGT)
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
   │   transferFrom(Alice, VanguardGovernance, 1,000 VGT)
   │   _lockedTokens[proposalId] += 1,000 VGT
   │
   └─► Proposal created
       ✅ Proposal ID: 1
       ✅ Status: Active
       ✅ Voting starts NOW
       ✅ Voting ends: NOW + 5 days
       ✅ Execution time: votingEnds + 1 day
```

---

### **Phase 2: Voting Period (5 Days)**

```
┌─────────────────────────────────────────────────────────────────┐
│  Community votes on Proposal #1                                  │
└─────────────────────────────────────────────────────────────────┘

DAY 1: ALICE votes FOR
   │
   ├─► Check balance ≥ votingCost (100 VGT)
   │   ✅ Balance: 9,000 VGT (10,000 - 1,000 locked)
   │
   ├─► Approve VGT tokens
   │   approve(VanguardGovernance, 100 VGT)
   │
   ├─► Cast vote
   │   vote(proposalId: 1, support: true)
   │
   ├─► VGT tokens locked
   │   transferFrom(Alice, VanguardGovernance, 100 VGT)
   │   _voterLockedTokens[1][Alice] = 100 VGT
   │
   └─► Vote recorded
       ✅ Votes FOR: 100 VGT
       ✅ Votes AGAINST: 0 VGT

DAY 2: CHARLIE votes FOR
   │
   ├─► Has 50,000 VGT tokens
   ├─► Locks 100 VGT for voting
   │
   └─► Vote recorded
       ✅ Votes FOR: 100 + 100 = 200 VGT
       ✅ Votes AGAINST: 0 VGT

DAY 3: DAVID votes AGAINST
   │
   ├─► Has 20,000 VGT tokens
   ├─► Locks 100 VGT for voting
   │
   └─► Vote recorded
       ✅ Votes FOR: 200 VGT
       ✅ Votes AGAINST: 100 VGT

DAY 5: Voting period ends
   │
   └─► Final tally
       ✅ Total votes: 300 VGT
       ✅ Votes FOR: 200 VGT (66.7%)
       ✅ Votes AGAINST: 100 VGT (33.3%)
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
   │   Total votes: 300 VGT
   │   FOR votes: 200 VGT (66.7%)
   │   AGAINST votes: 100 VGT (33.3%)
   │
   ├─► Check quorum (15% for AddToWhitelist)
   │   Total VGT supply: 1,000,000
   │   Required: 150,000 VGT (15%)
   │   Actual: 300 VGT
   │   ❌ QUORUM NOT MET (in this example)
   │
   │   [In real scenario with enough votes:]
   │   Actual: 200,000 VGT
   │   ✅ QUORUM MET
   │
   ├─► Check approval (60% for AddToWhitelist)
   │   Required: 60% FOR votes
   │   Actual: 66.7% FOR votes
   │   ✅ APPROVAL MET
   │
   ├─► Execute proposal
   │   dynamicListManager.addToWhitelist(
   │       user: 0xBob...,
   │       identity: 123456,
   │       reason: "KYC/AML verified"
   │   )
   │
   ├─► Burn locked tokens (proposal passed)
   │   governanceToken.burn(1,100 VGT)
   │   // 1,000 (proposal) + 100 (votes)
   │
   └─► Proposal executed
       ✅ Status: EXECUTED
       ✅ Bob's status: WHITELISTED
       ✅ Locked tokens: BURNED
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
Cost: 1,000 VGT (configurable)

If proposal PASSES:
   ✅ Tokens BURNED
   ✅ Reduces total supply
   ✅ Increases scarcity

If proposal FAILS:
   ✅ Tokens RETURNED to proposer
   ✅ No penalty for failed proposals
```

### **Voting**
```
Cost: 100 VGT per vote (configurable)

If proposal PASSES:
   ✅ All voting tokens BURNED
   ✅ Rewards participation in successful governance

If proposal FAILS:
   ✅ All voting tokens RETURNED
   ✅ No penalty for voting on failed proposals
```

### **Example Scenario**
```
Proposal #1: Add Bob to Whitelist
   Proposer: Alice (1,000 VGT locked)
   Voters:
      - Alice: 100 VGT (FOR)
      - Charlie: 100 VGT (FOR)
      - David: 100 VGT (AGAINST)
   
   Total locked: 1,300 VGT

Result: PASSED (66.7% approval)
   ✅ 1,300 VGT BURNED
   ✅ Total supply reduced by 1,300 VGT
   ✅ Bob added to whitelist
```

---

## 🎯 Quick Reference

### **Voting Thresholds**

| Proposal Type | Quorum | Approval | Example |
|---------------|--------|----------|---------|
| AddToWhitelist | 15% | 60% | 150k votes, 90k FOR |
| RemoveFromWhitelist | 15% | 60% | 150k votes, 90k FOR |
| AddToBlacklist | 20% | 70% | 200k votes, 140k FOR |
| RemoveFromBlacklist | 20% | 65% | 200k votes, 130k FOR |

*Assuming 1M total VGT supply*

### **Timeline**
```
Day 0: Proposal created
Day 0-5: Voting period
Day 6: Execution delay
Day 6+: Proposal can be executed
```

### **Costs**
```
Proposal creation: 1,000 VGT
Voting: 100 VGT per vote
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
4. Execute proposal (burn or return VGT)
5. Status change applied automatically

**Try It**: Run Option 88 to see the complete lifecycle! 🚀

