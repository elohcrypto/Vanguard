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
Check: Does the wallet control its OnchainID (owner, MANAGEMENT or ACTION
       key)? Was the identity bound at least minVoterAge ago?
↓
Check: Is target the contract this type is bound to (boundTarget(type)),
       and is the function selector allowed?
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
Check: Is the voter's identity the proposer's? (refused) Does the wallet
       control the identity? Was it bound before the voter-age cutoff?
↓
Check: Has this identity already voted? ❌
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
          (eligibleVotersAtCreation is the registry's identity count at
          the voter-age cutoff, creation time minus minVoterAge, read
          once at creation, so registering or deleting identities
          mid-vote cannot move the bar)
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
> voting still open, and, for a passing proposal, execution delay not yet
> elapsed, less than 3,000,000 gas left (`MIN_EXECUTION_GAS`, "Insufficient
> gas for execution"), or a target call that ran out of gas
> (`InsufficientExecutionGas`; the proposal stays Active and anyone retries
> with a higher gas limit). A UI must keep
> offering "execute" on failing proposals; that is the only way to close
> them and make the deposits claimable.

### **Step 4: Claim Your Deposit**

Settlement does **not** push VGT back. It records what each participant is
owed, and each one pulls it:

```solidity
function claimRefund(uint256 proposalId) external            // once per identity, after settlement
function claimRefundFor(uint256 proposalId, address identity) external // a deleted identity's controller
function getClaimableRefund(uint256 proposalId, address identity) external view returns (uint256)
```

Only Rejected and Cancelled proposals have anything to claim; a passed
proposal burned its deposits. The claim runs the VGT transfer through the
token's compliance gate, so a participant who is currently de-verified or
frozen cannot claim **yet**. Their deposit waits for them and nobody else
is affected. Before this, settlement pushed every refund in one loop, and
one unpayable participant reverted the loop and froze everyone's deposit
on that proposal forever.

### **Configured thresholds**

| Proposal type              | Quorum | Approval |
| -------------------------- | ------ | -------- |
| InvestorTypeConfig         | 20%    | 60%      |
| ComplianceRules            | 25%    | 65%      |
| OracleParameters           | 20%    | 60%      |
| TokenParameters            | 30%    | 70%      |
| SystemParameters           | 25%    | 65%      |
| EmergencyAction            | 10%    | 75%      |
| ListUpdate                 | 20%    | 70%      |
| IdentityRegistryParameters | 25%    | 65%      |
| GovernanceTokenParameters  | 30%    | 70%      |
| EscrowFactoryParameters    | 30%    | 70%      |
| IdentityFactoryParameters  | 30%    | 70%      |
| PrivacyParameters          | 30%    | 70%      |
| VerifierParameters         | 30%    | 70%      |

Set once in `_initializeThresholds()`; there is no setter, so they cannot be
changed after deployment. Voting period and delay: 7 and 2 days for most
types, 7 and 3 for TokenParameters, GovernanceTokenParameters, the two
factory types, PrivacyParameters and VerifierParameters, 5 and 1 for
ListUpdate, all divided by the deployment's `TIME_SCALE`. EmergencyAction
has a row but no bound target (`boundTarget` returns zero), so
`createProposal` refuses it (`TargetNotBoundToType`).

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
└─ Action: 50 VGT becomes claimable; each participant pulls its own
   deposit with claimRefund(id) 💰
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

- ✅ One vote per identity, not per wallet: the registry binds each OnchainID to one wallet, governance keys votes on the identity, and the voting wallet must own the OnchainID or hold a MANAGEMENT/ACTION key on it (plan 2F.1, D25)
- ✅ Only identities at least `minVoterAge` old (7 days / TIME_SCALE) at proposal creation vote or count toward quorum
- ⚠️ Residual: a registry agent colluding with an issuer key can still create fake identities; that is visible on chain, and the fakes cannot vote for `minVoterAge`, the window in which honest voters remove those keys
- ✅ Fair voting (verified identities only)

---

## ⚖️ **Fair Voting (1 Person = 1 Vote)**

Every verified identity casts one vote whatever its VGT balance; VGT pays
the fees and is not a vote weight.

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

- Burning reduces total supply by the burned deposits. VGT agents can
  still mint (`mint` is `onlyAgent`), so supply is not guaranteed to fall.

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
Owner raises it to 50 VGT (any value above 0 and at most 1000 VGT)
↓
New proposals now cost 50 VGT to create
```

Both setters revert with `CostOutOfRange` outside `0 < cost <= MAX_COST`
(1000 VGT; the floor is 1 wei, not 1 VGT) and emit the old and new values. The bound stops an owner from
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

| Feature              | Old System         | New System                                     |
| -------------------- | ------------------ | ---------------------------------------------- |
| **Voting Power**     | Token-weighted     | 1 person = 1 vote                              |
| **Fairness**         | ❌ Whales dominate | ✅ Equal voting                                |
| **Proposal Cost**    | ❌ Free            | ✅ Costs VGT                                   |
| **Voting Cost**      | ❌ Free            | ✅ Costs VGT                                   |
| **Token Locking**    | ❌ No              | ✅ Yes                                         |
| **Token Burning**    | ❌ No              | ✅ If passed                                   |
| **Token Return**     | N/A                | ✅ If failed                                   |
| **KYC/AML Required** | ❌ No              | ✅ Yes                                         |
| **Sybil Resistance** | ❌ Low             | ✅ One vote per aged identity (residual above) |

---

## 🔧 **Contract Changes**

### **VanguardGovernance (one deployed contract, split by inheritance in Task 4.8):**

**New State Variables:**

```solidity
// GovernanceConfig.sol
IIdentityRegistry public identityRegistry;
uint256 public proposalCreationCost = 10 * 10**18; // 10 VGT
uint256 public votingCost = 10 * 10**18; // 10 VGT
// GovernanceProposals.sol
mapping(uint256 => uint256) internal _lockedTokens;
mapping(uint256 => mapping(address => uint256)) internal _voterLockedTokens;
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
- `claimRefund()` - Pull your identity's deposit from a Rejected or Cancelled proposal (once; the wallet must be bound to and control the identity, so a recovered wallet claims and the lost one cannot)
- `claimRefundFor(proposalId, identity)` - The same for a named identity: a wallet controlling it claims while no wallet is bound to it (an identity the agent deleted), else only the bound wallet (Task 5.17)
- `getClaimableRefund()` - View what an identity may still claim from a proposal
- `getLockedTokens()` - View total locked while Active; zero after a Rejected or Cancelled settlement; after execution it still reports the amount that was burned
- `getVoterLockedTokens()` - View one identity's deposit (locked while Active, claimable after Rejected or Cancelled until claimed; on an Executed proposal it shows the burned deposit)

---

### **GovernanceToken.sol:**

**New Function:**

```solidity
function burn(uint256 amount) external onlyAgent {
    _burn(msg.sender, amount); // the caller's balance; governance is the caller
}
```

Delegation (`delegate`, `getVotingPower` and the other voting-power views)
is recorded on the token but not counted: governance counts one vote per
identity and never reads voting power (D12 b; wiring it is scheduled after
the external audit).

---

## 🚀 **Testing the New System**

### **Step 1: Deploy**

```bash
npm run demo:interactive:proof

Option 74: Deploy Governance System (VGT and VanguardGovernance)
→ Deploys with new fair voting system
```

### **Step 2: Distribute Tokens**

```bash
Option 75: Distribute Governance Tokens
→ Users need tokens to pay for proposals/voting
```

Option 75c approves governance to spend VGT; proposals and votes need it.

### **Step 3: Create Proposal (Costs 10 VGT)**

```bash
Option 76: Create Proposal
→ User pays 10 VGT (locked)
→ Proposal created
```

### **Step 4: Vote (Costs 10 VGT per vote)**

```bash
Option 77: Vote on Proposal
→ Each user pays 10 VGT (locked)
→ Each user gets 1 vote (equal weight)
```

### **Step 5: Execute**

Execution needs the voting period and the delay over: on a local node
option 79 moves the clock forward 9 days first.

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
   - ✅ Token burning (passed proposals' deposits are destroyed)

3. **Security**
   - ✅ KYC/AML required (an agent colluding with an issuer can still mint identities; see the residual above)
   - ✅ Token locking (commitment to vote)
   - ✅ Fair deposit claim (no penalty for failed proposals)

4. **Governance Control**
   - ✅ Costs and the minimum voter age are owner settings (governance
     itself after the handover ceremony)
   - Thresholds are fixed at deployment

---

Runs end to end on a local node with the demo (options 74-79).
