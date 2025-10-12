# Investor Onboarding System

## 🎯 Overview

The Investor Onboarding System provides a sophisticated workflow for users to upgrade from Normal users to verified investors (Retail, Accredited, or Institutional) with multi-signature wallet token locking requirements.

## 📋 Components

### 1. **MultiSigWallet.sol**
A 2-of-2 multi-signature wallet requiring both bank and user signatures to unlock tokens.

**Key Features:**
- Token locking by user
- Proposal-based unlock mechanism
- Dual signature requirement (Bank + User)
- Secure token custody

**Functions:**
- `lockTokens(uint256 amount)` - User locks tokens
- `proposeUnlock(uint256 amount, address recipient, string reason)` - Create unlock proposal
- `signUnlock(bytes32 proposalId)` - Sign unlock proposal
- `getLockedBalance()` - View locked amount

### 2. **InvestorRequestManager.sol**
Manages the complete investor onboarding workflow.

**Key Features:**
- Investor status requests
- Multi-sig wallet creation
- Token lock verification
- Request approval/rejection
- Configurable lock requirements

**Functions:**
- `requestInvestorStatus(InvestorType type)` - User requests investor status
- `createMultiSigWallet(address user)` - Bank creates wallet for user
- `confirmTokensLocked()` - User confirms tokens locked
- `approveRequest(address user)` - Bank approves request
- `rejectRequest(address user, string reason)` - Bank rejects request

## 🔄 Complete Workflow

### Phase 1: User Registration & Compliance
```
1. User creates account
2. User completes KYC verification
3. User completes AML verification
4. User status: NORMAL USER (verified)
```

### Phase 2: Investor Request & Approval
```
5. User requests investor status (Retail/Accredited/Institutional)
   → Status: PENDING
   
6. Bank creates multi-sig wallet for user
   → Status: WALLET_CREATED
   → Wallet owners: [Bank, User]
   → Signature requirement: 2-of-2
   
7. User locks required tokens in multi-sig wallet
   → Retail: 10,000 tokens
   → Accredited: 100,000 tokens
   → Institutional: 1,000,000 tokens
   → Status: TOKENS_LOCKED
   
8. Bank approves request
   → User assigned investor type
   → Status: APPROVED
   → Tokens remain locked
```

### Phase 3: Investor Operations
```
9. User operates as investor
   → Higher transfer limits
   → Enhanced privileges
   → Locked tokens secured in multi-sig wallet
```

### Phase 4: Downgrade to Normal User
```
10. User requests downgrade
    → Creates unlock proposal
    
11. User signs unlock proposal
    → Signatures: 1 of 2
    
12. Bank signs unlock proposal
    → Signatures: 2 of 2
    → Tokens automatically unlocked
    → Tokens returned to user
    → User downgraded to NORMAL USER
```

## 💰 Token Lock Requirements

| Investor Type | Lock Amount | Transfer Limit | Holding Limit |
|--------------|-------------|----------------|---------------|
| **Retail** | 10,000 VSC | 8,000 VSC | 50,000 VSC |
| **Accredited** | 100,000 VSC | 50,000 VSC | 500,000 VSC |
| **Institutional** | 1,000,000 VSC | 500,000 VSC | 5,000,000 VSC |

## 🔒 Security Features

### Multi-Signature Protection
- **2-of-2 Requirement**: Both bank and user must sign to unlock tokens
- **Proposal System**: All unlocks require explicit proposals
- **Immutable Participants**: Bank and user addresses cannot be changed
- **Reentrancy Protection**: All state-changing functions protected

### Compliance Integration
- **KYC/AML Required**: Users must be verified before requesting investor status
- **Identity Registry**: Integration with OnchainID system
- **Investor Type Registry**: Automatic type assignment upon approval

### Token Security
- **Locked Balance Tracking**: Precise tracking of locked amounts
- **Transfer Verification**: Tokens cannot be unlocked without dual signatures
- **Balance Checks**: Continuous verification of locked amounts

## 📊 Request Status Flow

```
None → Pending → WalletCreated → TokensLocked → Approved
                                              ↘ Rejected
```

**Status Descriptions:**
- **None**: No request exists
- **Pending**: Request created, awaiting wallet creation
- **WalletCreated**: Multi-sig wallet deployed
- **TokensLocked**: Required tokens locked in wallet
- **Approved**: Request approved, investor type assigned
- **Rejected**: Request rejected by bank

## 🎮 Usage Examples

### Request Investor Status
```solidity
// User requests Accredited investor status
investorRequestManager.requestInvestorStatus(InvestorType.Accredited);
```

### Bank Creates Wallet
```solidity
// Bank creates multi-sig wallet for user
investorRequestManager.createMultiSigWallet(userAddress);
```

### User Locks Tokens
```solidity
// User approves tokens
token.approve(multiSigWalletAddress, 100_000 * 10**18);

// User locks tokens in multi-sig wallet
multiSigWallet.lockTokens(100_000 * 10**18);

// User confirms tokens locked
investorRequestManager.confirmTokensLocked();
```

### Bank Approves Request
```solidity
// Bank approves investor request
investorRequestManager.approveRequest(userAddress);
```

### Downgrade Process
```solidity
// User creates unlock proposal
bytes32 proposalId = multiSigWallet.proposeUnlock(
    100_000 * 10**18,
    userAddress,
    "Downgrade to normal user"
);

// User signs
multiSigWallet.signUnlock(proposalId);

// Bank signs (tokens automatically unlocked)
multiSigWallet.signUnlock(proposalId);
```

## 🔧 Configuration

### Update Lock Requirements
```solidity
// Owner updates lock requirement for Retail investors
investorRequestManager.updateLockRequirement(
    InvestorType.Retail,
    15_000 * 10**18  // New amount: 15,000 tokens
);
```

## 🧪 Testing

See `test/investor/InvestorOnboarding.test.ts` for comprehensive test coverage including:
- Complete onboarding workflow
- Multi-sig operations
- Edge cases and error conditions
- Security validations

## 📝 Events

### InvestorRequestManager Events
- `InvestorRequestCreated` - New investor request
- `MultiSigWalletCreated` - Wallet deployed
- `TokensLocked` - Tokens locked confirmation
- `InvestorRequestApproved` - Request approved
- `InvestorRequestRejected` - Request rejected
- `LockRequirementUpdated` - Lock amount changed

### MultiSigWallet Events
- `TokensLocked` - Tokens locked in wallet
- `UnlockProposalCreated` - New unlock proposal
- `ProposalSigned` - Signature added
- `TokensUnlocked` - Tokens released
- `ProposalCancelled` - Proposal cancelled

## 🚀 Deployment

```typescript
// Deploy InvestorRequestManager
const InvestorRequestManager = await ethers.getContractFactory("InvestorRequestManager");
const manager = await InvestorRequestManager.deploy(
    bankAddress,
    tokenAddress,
    investorRegistryAddress,
    identityRegistryAddress
);

// MultiSigWallet is deployed automatically by InvestorRequestManager
```

## 🔗 Integration

The system integrates with:
- **InvestorTypeRegistry**: Investor type management
- **IdentityRegistry**: KYC/AML verification
- **Token (ERC-3643)**: Compliant token transfers
- **OnchainID**: Identity claims

## 📚 Additional Resources

- [ERC-3643 Standard](https://erc3643.org/)
- [OnchainID Documentation](../onchain_id/README.md)
- [Investor Type Registry](../erc3643/README.md)

