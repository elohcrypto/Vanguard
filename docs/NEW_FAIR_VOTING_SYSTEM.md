# 🗳️ New Fair Voting System (1 Person = 1 Vote)

## 🎯 **System Overview**

### **Key Features:**
1. ✅ **1 Person = 1 Vote** (NOT token-weighted)
2. ✅ **KYC/AML Verification Required** (only verified investors can vote)
3. ✅ **Proposal Creation Cost** (must pay VGT to create proposal)
4. ✅ **Voting Cost** (must pay VGT to vote)
5. ✅ **Token Locking & Burning/Claiming**:
   - If proposal passes (quorum + approval met, target call succeeds): Tokens are BURNED 🔥
   - Otherwise: each participant CLAIMS their own deposit back 💰

---

## 📋 **How It Works**

### **Step 1: Create Proposal**
```
User wants to create proposal
↓
Check: Is user KYC/AML verified? ✅
↓
Check: Does user have enough VGT? (proposalCreationCost)
↓
User pays 10 VGT → LOCKED in governance contract
↓
Proposal created ✅
```

**Cost:** `proposalCreationCost` (default: 10 VGT)

---

### **Step 2: Users Vote**
```
User wants to vote
↓
Check: Is user KYC/AML verified? ✅
↓
Check: Has user already voted? ❌
↓
Check: Does user have enough VGT? (votingCost)
↓
User pays 10 VGT → LOCKED in governance contract
↓
Vote counted as 1 vote (equal weight) ✅
```

**Cost:** `votingCost` (default: 10 VGT per vote)
**Voting Power:** 1 vote per person (regardless of token amount)

---

### **Step 3: Proposal Execution**

Two gates must both pass. There is **no single 51% rule** — thresholds are
configured per proposal type (see the table below) and read from
`proposalThresholds(type)` on chain.

```
Voting period ends; ANYONE calls executeProposal(id)
↓
QUORUM:   totalVotes / eligibleVotersAtCreation  ≥  type quorum
          (a share of ELIGIBLE VOTERS, frozen when the proposal was
          created, so registering or deleting identities mid-vote
          cannot move the bar)
↓
APPROVAL: votesFor / totalVotes  ≥  type approval
↓
Both met, and execution delay elapsed:
  ├─ Call the target (or the DynamicListManager for list proposals)
  │
  ├─ Target call SUCCEEDS:
  │    ├─ BURN all locked tokens 🔥
  │    ├─ Status: Executed
  │    └─ Event: ProposalExecuted(id)
  │
  └─ Target call REVERTS:
       ├─ Status: Rejected (terminal; submit a corrected proposal)
       ├─ Every deposit becomes CLAIMABLE 💰
       └─ Event: ProposalExecutionFailed(id, reason)
             `reason` is the target's raw revert data, so the cause
             can be decoded off-chain

Either threshold NOT met (including zero votes):
  ├─ Status: Rejected
  ├─ Every deposit becomes CLAIMABLE 💰
  └─ Event: ProposalRejected(id)
```

> **executeProposal never reverts on an outcome.** A failed threshold, no
> votes at all, and a target that rejects the call are all settled in one
> mined transaction. It reverts only on an invalid call: wrong status,
> voting still open, execution delay not yet elapsed for a passing
> proposal, or the list manager address never configured. A UI must keep
> offering "execute" on failing proposals; that is the only way to close
> them and make the deposits claimable.

### **Step 4: Claim Your Deposit**

Settlement does **not** push VGT back. It records what each participant is
owed, and each one pulls it:

```solidity
function claimRefund(uint256 proposalId) external            // once, after settlement
function getClaimableRefund(uint256 proposalId, address a) external view returns (uint256)
```

Only Rejected and Cancelled proposals have anything to claim; a passed
proposal burned its deposits. The claim runs the VGT transfer through the
token's compliance gate, so a participant who is currently de-verified or
frozen cannot claim **yet**. Their deposit waits for them and nobody else
is affected. Before this, settlement pushed every refund in one loop, and
one unpayable participant reverted the loop and froze everyone's deposit
on that proposal forever.

### **Configured thresholds**

| Proposal type | Quorum | Approval |
|---|---|---|
| InvestorTypeConfig | 20% | 60% |
| ComplianceRules | 25% | 65% |
| OracleParameters | 20% | 60% |
| TokenParameters | 30% | 70% |
| SystemParameters | 25% | 65% |
| EmergencyAction | 10% | 75% |
| AddToWhitelist | 15% | 60% |
| RemoveFromWhitelist | 15% | 60% |
| AddToBlacklist | 20% | 70% |
| RemoveFromBlacklist | 20% | 65% |

Set once in `_initializeThresholds()`; there is no setter, so they cannot be
changed after deployment.

---

## 💰 **Token Economics**

### **Proposal Creation:**
- **Cost:** 10 VGT (owner-adjustable, ≤ 1000 VGT)
- **Locked:** Yes
- **Claimable if it fails:** Yes, via `claimRefund`
- **Burned if it passes:** Yes

### **Voting:**
- **Cost:** 10 VGT per vote (owner-adjustable, ≤ 1000 VGT)
- **Locked:** Yes
- **Claimable if it fails:** Yes, via `claimRefund`
- **Burned if it passes:** Yes

### **Example Scenario:**

```
Proposal Created:
├─ Proposer pays: 10 VGT (locked)
└─ Total locked: 10 VGT

Voting:
├─ User A votes FOR: pays 10 VGT (locked)
├─ User B votes FOR: pays 10 VGT (locked)
├─ User C votes AGAINST: pays 10 VGT (locked)
├─ User D votes FOR: pays 10 VGT (locked)
└─ Total locked: 50 VGT

Result:
├─ Votes: 3 FOR, 1 AGAINST
├─ Percentage: 75% FOR (above this type's approval threshold)
├─ Status: PASSED ✅
└─ Action: BURN 50 VGT 🔥

Alternative (Failed):
├─ Votes: 1 FOR, 3 AGAINST
├─ Percentage: 25% FOR (below this type's approval threshold)
├─ Status: FAILED ❌
└─ Action: RETURN 50 VGT to all participants 💰
```

---

## 🔐 **KYC/AML Verification**

### **Requirements:**
- ✅ Must be verified in IdentityRegistry
- ✅ Must have valid KYC claim
- ✅ Must have valid AML claim

### **Checks:**
```solidity
require(identityRegistry.isVerified(msg.sender), "Must be KYC/AML verified");
```

### **Benefits:**
- ✅ Prevents Sybil attacks (one person creating multiple wallets)
- ✅ Ensures compliance with regulations
- ✅ Fair voting (verified identities only)

---

## ⚖️ **Fair Voting (1 Person = 1 Vote)**

### **Old System (Token-Weighted):**
```
User A: 100,000 VGT → 100,000 votes
User B: 1,000 VGT → 1,000 votes
User C: 500 VGT → 500 votes

Total: 101,500 votes
User A has 98.5% voting power! ❌ Unfair!
```

### **New System (Equal Voting):**
```
User A: 100,000 VGT → 1 vote
User B: 1,000 VGT → 1 vote
User C: 500 VGT → 1 vote

Total: 3 votes
Each user has 33.3% voting power! ✅ Fair!
```

---

## 🔥 **Token Burning vs Returning**

### **If Proposal Passes (quorum + approval both met):**
```
Proposal Result: 75% FOR
↓
All locked tokens are BURNED
↓
Proposer: 10 VGT → BURNED 🔥
Voter A: 10 VGT → BURNED 🔥
Voter B: 10 VGT → BURNED 🔥
Voter C: 10 VGT → BURNED 🔥
Voter D: 10 VGT → BURNED 🔥
↓
Total burned: 50 VGT
Total supply decreased by 50 VGT
```

**Why burn?**
- ✅ Reduces total supply
- ✅ Increases scarcity
- ✅ Rewards token holders (deflationary)

---

### **If Proposal Fails (a threshold not met, or the target call reverts):**
```
Proposal Result: 25% FOR
↓
executeProposal settles: status Rejected, nothing transferred
↓
Proposer: 10 VGT → CLAIMABLE, pulls it with claimRefund(id) 💰
Voter A: 10 VGT → CLAIMABLE 💰
Voter B: 10 VGT → CLAIMABLE 💰
Voter C: 10 VGT → CLAIMABLE 💰
Voter D: 10 VGT → CLAIMABLE 💰
↓
Total claimable: 50 VGT
No tokens burned
```

**Why claim rather than push?**
- ✅ Fair to voters (didn't waste tokens on a failed proposal)
- ✅ No penalty for voting on failed proposals
- ✅ One participant the token cannot pay (de-verified, frozen) blocks
     only their own claim, never anyone else's settlement

---

## 🎛️ **Governance-Controlled Costs**

### **Update Proposal Creation Cost:**
```solidity
function setProposalCreationCost(uint256 newCost) external onlyOwner
```

**Example:**
```
Current cost: 10 VGT
↓
Owner raises it to 50 VGT (any value in 1 .. 1000 VGT)
↓
New proposals now cost 50 VGT to create
```

Both setters revert with `CostOutOfRange` outside `1 <= cost <= MAX_COST`
(1000 VGT) and emit the old and new values. The bound stops an owner from
pricing every holder out of governance in one call.

---

### **Update Voting Cost:**
```solidity
function setVotingCost(uint256 newCost) external onlyOwner
// 0 < newCost <= MAX_COST (1000 VGT); emits VotingCostUpdated(old, new).
// The bound stops an owner from pricing every holder out of governance.
```

**Example:**
```
Current cost: 10 VGT per vote
↓
Governance decides to decrease to 5 VGT
↓
New votes now cost 5 VGT each
```

---

## 📊 **Comparison: Old vs New System**

| Feature | Old System | New System |
|---------|------------|------------|
| **Voting Power** | Token-weighted | 1 person = 1 vote |
| **Fairness** | ❌ Whales dominate | ✅ Equal voting |
| **Proposal Cost** | ❌ Free | ✅ Costs VGT |
| **Voting Cost** | ❌ Free | ✅ Costs VGT |
| **Token Locking** | ❌ No | ✅ Yes |
| **Token Burning** | ❌ No | ✅ If passed |
| **Token Return** | N/A | ✅ If failed |
| **KYC/AML Required** | ❌ No | ✅ Yes |
| **Sybil Resistance** | ❌ Low | ✅ High |

---

## 🔧 **Contract Changes**

### **VanguardGovernance.sol:**

**New State Variables:**
```solidity
IIdentityRegistry public identityRegistry;
uint256 public proposalCreationCost = 10 * 10**18; // 10 VGT
uint256 public votingCost = 10 * 10**18; // 10 VGT
mapping(uint256 => uint256) private _lockedTokens;
mapping(uint256 => mapping(address => uint256)) private _voterLockedTokens;
mapping(uint256 => address[]) private _proposalVoters;
```

**Updated Functions:**
- `createProposal()` - Charges creation cost, locks tokens
- `castVote()` - Charges voting cost, locks tokens, 1 vote per person
- `executeProposal()` - Burns tokens if passed; otherwise settles and makes deposits claimable

**New Functions:**
- `setProposalCreationCost()` - Update creation cost
- `setVotingCost()` - Update voting cost (bounded, emits `VotingCostUpdated`)
- `cancelProposal()` - Owner-only; settles like a rejection, deposits become claimable
- `claimRefund()` - Pull your own deposit from a Rejected or Cancelled proposal (once)
- `getClaimableRefund()` - View what an address may still claim from a proposal
- `getLockedTokens()` - View total locked while Active (zero after settlement)
- `getVoterLockedTokens()` - View one participant's locked or still-claimable amount

---

### **GovernanceToken.sol:**

**New Function:**
```solidity
function burn(uint256 amount) external onlyAgent {
    _burn(address(this), amount);
}
```

---

## 🚀 **Testing the New System**

### **Step 1: Deploy**
```bash
npm run demo:interactive:proof

Option 79: Deploy Governance Token (VGT)
→ Deploys with new fair voting system
```

### **Step 2: Distribute Tokens**
```bash
Option 80: Distribute Governance Tokens
→ Users need tokens to pay for proposals/voting
```

### **Step 3: Create Proposal (Costs 10 VGT)**
```bash
Option 81: Create Governance Proposal
→ User pays 10 VGT (locked)
→ Proposal created
```

### **Step 4: Vote (Costs 10 VGT per vote)**
```bash
Option 82: Vote on Proposal
→ Each user pays 10 VGT (locked)
→ Each user gets 1 vote (equal weight)
```

### **Step 5: Execute**
```bash
Option 78: Execute Proposal
→ Quorum AND approval met, target call succeeds: burn all locked tokens
→ Otherwise: proposal Rejected, every deposit becomes claimable

Option 78a: Claim Refund
→ Each participant pulls their own deposit from Rejected/Cancelled proposals
```

---

## ✅ **Benefits of New System**

1. **Fair Voting**
   - ✅ 1 person = 1 vote
   - ✅ No whale domination
   - ✅ Democratic governance

2. **Economic Incentives**
   - ✅ Costs to create proposals (prevents spam)
   - ✅ Costs to vote (ensures serious participation)
   - ✅ Token burning (deflationary, increases value)

3. **Security**
   - ✅ KYC/AML required (prevents Sybil attacks)
   - ✅ Token locking (commitment to vote)
   - ✅ Fair deposit claim (no penalty for failed proposals)

4. **Governance Control**
   - ✅ Adjustable costs
   - ✅ Flexible parameters
   - ✅ Community-driven

---

## 🎉 **Summary**

**The new fair voting system ensures:**
- ✅ Equal voting power for all verified investors
- ✅ Economic costs to prevent spam
- ✅ Token burning for successful proposals (deflationary)
- ✅ Deposits claimable after failed proposals (fair)
- ✅ KYC/AML compliance
- ✅ Democratic governance

**Ready to deploy and test!** 🚀

