# Vanguard StableCoin - System Workflow Guide

## Overview

This document explains the complete system workflow for users to interact with the Vanguard StableCoin (VSC) system. The system provides 11 core workflows: **User Onboarding**, **Token Minting**, **Token Transfer**, **Oracle Access Control**, **Privacy & ZK Verification**, **Token Burning**, **Investor Type Management**, **Governance**, **Enhanced Escrow**, **Payment Protocol**, and **Complete System Integration**, all with comprehensive compliance validation through the interactive demo system (83 menu options).

## System Architecture

The system is built on a comprehensive smart contract architecture located in the `contracts/` directory:

```
contracts/
├── onchain_id/
│   ├── OnchainIDFactory.sol      # OnchainID factory contract
│   ├── OnchainID.sol             # Core OnchainID contract (ERC-734/735)
│   ├── ClaimIssuer.sol           # Claim issuer contract
│   ├── KeyManager.sol            # Key management utilities
│   └── interfaces/
│       ├── IERC734.sol           # ERC-734 interface
│       ├── IERC735.sol           # ERC-735 interface
│       └── IOnchainID.sol        # OnchainID interface
├── erc3643/
│   ├── Token.sol                 # Vanguard StableCoin token contract
│   ├── TokenMinting.sol          # Token minting system with limits
│   ├── TokenBurning.sol          # Token burning system
│   ├── IdentityRegistry.sol      # Identity registry contract
│   ├── ComplianceRegistry.sol    # Compliance registry contract
│   ├── TrustedIssuersRegistry.sol # Trusted issuers registry
│   ├── ClaimTopicsRegistry.sol   # Claim topics registry
│   └── interfaces/
│       ├── IERC3643.sol          # ERC-3643 interface
│       ├── IIdentityRegistry.sol # Identity registry interface
│       └── ICompliance.sol       # Compliance interface
├── oracle/
│   ├── OracleManager.sol         # Oracle management contract
│   ├── WhitelistOracle.sol       # Whitelist oracle contract
│   ├── BlacklistOracle.sol       # Blacklist oracle contract
│   ├── ConsensusOracle.sol       # Oracle consensus contract
│   └── interfaces/
│       ├── IOracle.sol           # Oracle interface
│       └── IOracleManager.sol    # Oracle manager interface
├── compliance/
│   ├── UTXOCompliance.sol        # UTXO compliance contract
│   ├── ComplianceValidator.sol   # Compliance validation contract
│   ├── TransferRestrictions.sol  # Transfer restrictions contract
│   └── interfaces/
│       ├── IUTXOCompliance.sol   # UTXO compliance interface
│       └── IComplianceValidator.sol # Compliance validator interface
├── privacy/
│   ├── ZKVerifier.sol            # Zero-knowledge proof verifier
│   ├── PrivacyManager.sol        # Privacy management contract
│   └── interfaces/
│       └── IZKVerifier.sol       # ZK verifier interface
├── test/
│   ├── mocks/
│   │   ├── MockOnchainID.sol     # Mock OnchainID for testing
│   │   ├── MockOracle.sol        # Mock oracle for testing
│   │   └── MockERC3643.sol       # Mock ERC-3643 for testing
│   └── helpers/
│       ├── TestHelpers.sol       # Test helper functions
│       └── DeploymentHelpers.sol # Deployment helper functions
├── hardhat.config.js
├── package.json
└── README.md
```

All user workflows interact with these smart contracts through the Rust backend, which provides additional validation, caching, and off-chain compliance management.

### Architecture Overview

For the complete system architecture and high-level workflow diagrams, see the [Design Document](.kiro/specs/cmta-utxo-poc/design.md) which provides:

- **High-Level System Workflow**: Overall transaction validation flow
- **Component Architecture**: Detailed system component interactions
- **Integration Patterns**: OnchainID and ERC-3643 integration architecture
- **Oracle Network Design**: Oracle consensus and list management
- **Privacy Layer Design**: Zero-knowledge proof integration

## Supported Workflows

The system supports the following core workflows, each with comprehensive compliance validation:

| Workflow | Description | Key Components |
|----------|-------------|----------------|
| **User Onboarding** | KYC/AML verification and OnchainID creation | OnchainID Factory, Claims Issuer, Identity Registry |
| **Token Minting** | Authorized token creation with compliance validation | ERC-3643 Token, Compliance Validator, Oracle Network |
| **Token Transfer** | Peer-to-peer transfers with UTXO compliance | UTXO Compliance, Transfer Restrictions, Oracle Consensus |
| **Token Payment** | Payment processing with atomic transfers | Payment Processor, Compliance Validator, Event Reporter |
| **Escrow Payment** | Conditional payment held in a one-time escrow, settled 2-of-3 with an explicit direction | EscrowWalletFactory, MultiSigEscrowWallet, ComplianceRules (trusted contracts) |
| **Token Burning** | Authorized token destruction and compliance tracking | Token Contract, UTXO Store, Regulatory Reporter |

## Table of Contents

1. [User Onboarding Process](#user-onboarding-process)
2. [Token Minting Workflow](#token-minting-workflow)
3. [Token Transfer Workflow](#token-transfer-workflow)
4. [Token Payment Workflow](#token-payment-workflow)
5. [Escrow Payment Workflow](#escrow-payment-workflow)
6. [Token Burning Workflow](#token-burning-workflow)
7. [Compliance Monitoring](#compliance-monitoring)
8. [Error Handling](#error-handling)

---

## User Onboarding Process

### Phase 1: Identity Verification

```mermaid
sequenceDiagram
    participant User as Investor
    participant KYC as KYC Provider
    participant OnchainID as OnchainID Registry
    participant Claims as Claims Issuer
    participant Identity as Identity Registry

    User->>KYC: Submit identity documents
    KYC->>KYC: Verify identity, residence, accreditation
    KYC->>Claims: Issue verified claims
    Claims->>OnchainID: Create OnchainID with claims
    OnchainID->>Identity: Register identity
    Identity->>User: Identity verification complete
```

#### Step 1: KYC/AML Verification
- **Required Documents**: 
  - Government-issued ID (passport, driver's license)
  - Proof of address (utility bill, bank statement)
  - Accreditation documents (for accredited investors)
  - Source of funds documentation
- **Verification Process**: 
  - Identity verification (name, date of birth, address)
  - AML screening against sanctions lists
  - Accreditation status verification
  - Country eligibility check

#### Step 2: OnchainID Creation and Smart Contract Registration
```javascript
// Smart contract interaction for OnchainID creation
const onchainIDFactory = await ethers.getContractAt("OnchainIDFactory", FACTORY_ADDRESS);

// Create OnchainID for user
const tx = await onchainIDFactory.createIdentity(
    userAddress,
    ethers.utils.keccak256(ethers.utils.toUtf8Bytes("unique_salt"))
);
const receipt = await tx.wait();
const onchainIDAddress = receipt.events[0].args.identity;

// Register identity in ERC-3643 Identity Registry
const identityRegistry = await ethers.getContractAt("IdentityRegistry", IDENTITY_REGISTRY_ADDRESS);
await identityRegistry.registerIdentity(
    userAddress,
    onchainIDAddress,
    countryCode // e.g., 840 for US
);
```

#### Step 3: Claims Issuance
```javascript
// Issue KYC claim
const claimIssuer = await ethers.getContractAt("ClaimIssuer", CLAIM_ISSUER_ADDRESS);
const kycClaimTopic = 1;
const kycClaimData = ethers.utils.toUtf8Bytes("KYC_VERIFIED");

await claimIssuer.issueClaim(
    onchainIDAddress,
    kycClaimTopic,
    kycClaimData
);

// Issue accreditation claim (if applicable)
const accreditationClaimTopic = 5;
const accreditationData = ethers.utils.toUtf8Bytes("ACCREDITED_INVESTOR");

await claimIssuer.issueClaim(
    onchainIDAddress,
    accreditationClaimTopic,
    accreditationData
);
```

#### Step 2: OnchainID Creation
- **OnchainID Deployment**: 
  - KYC provider calls OnchainIDFactory to deploy new OnchainID contract
  - OnchainID implements ERC-734 (Key Management) and ERC-735 (Claim Holder)
  - User's wallet address added as management key
  - Deterministic address generation using CREATE2
- **Claims Issued**:
  - `IDENTITY_CLAIM` (Topic 1): Verified identity information
  - `RESIDENCE_CLAIM` (Topic 3): Country of residence
  - `ACCREDITATION_CLAIM` (Topic 5): Investor type and accreditation status
  - `KYC_CLAIM` (Topic 6): KYC verification status
  - `AML_CLAIM` (Topic 7): AML screening results
  - `INVESTOR_TYPE_CLAIM` (Topic 8): Investor classification
- **Claim Verification**:
  - Each claim cryptographically signed by trusted issuer
  - Claims stored in OnchainID contract with signature verification
  - Claim topics registered in ClaimTopicsRegistry

#### Step 3: Identity Registry Registration
- OnchainID address registered in ERC-3643 Identity Registry
- Claims verified by trusted issuers through ClaimIssuer contract
- Country and investor type extracted from OnchainID claims
- Identity verification status updated in registry

### Phase 2: Oracle Whitelist Approval

```mermaid
sequenceDiagram
    participant User as Investor
    participant Oracle1 as Oracle 1
    participant Oracle2 as Oracle 2
    participant Oracle3 as Oracle 3
    participant Consensus as Oracle Consensus
    participant Whitelist as Whitelist Manager

    User->>Oracle1: Request whitelist approval
    User->>Oracle2: Request whitelist approval
    User->>Oracle3: Request whitelist approval
    
    Oracle1->>Oracle1: Verify compliance
    Oracle2->>Oracle2: Verify compliance
    Oracle3->>Oracle3: Verify compliance
    
    Oracle1->>Consensus: Vote: Approve (Tier 7)
    Oracle2->>Consensus: Vote: Approve (Tier 8)
    Oracle3->>Consensus: Vote: Approve (Tier 7)
    
    Consensus->>Whitelist: Add to whitelist (Tier 7)
    Whitelist->>User: Whitelist approved
```

#### Whitelist Tiers
- **Tier 1-3**: Retail investors (limited access)
- **Tier 4-6**: Professional investors
- **Tier 7-8**: Accredited investors
- **Tier 9-10**: Institutional investors

---

## Token Minting Workflow

### Authorized Minting Process

```mermaid
sequenceDiagram
    participant Issuer as Token Issuer
    participant Validator as ERC-3643 Validator
    participant Oracle as Oracle Network
    participant Recipient as Investor
    participant UTXO as UTXO Manager

    Issuer->>Validator: Request mint (recipient, amount)
    Validator->>Oracle: Verify recipient eligibility
    Oracle->>Validator: Recipient approved (Tier 8)
    Validator->>Validator: Check investor limits
    Validator->>UTXO: Create compliance UTXO
    UTXO->>Recipient: Tokens minted
    Validator->>Issuer: Mint successful
```

### Minting Requirements

#### For the Issuer:
- Must have `MINTER_ROLE` in the token contract
- Must specify valid recipient address
- Must not exceed total supply limits

#### For the Recipient:
- Must be KYC/AML verified
- Must be whitelisted by oracles
- Must be registered in identity registry
- Must not exceed investor count limits
- Country must be in allowed jurisdictions

### Minting Process Steps

1. **Issuer Initiates Mint**
   ```solidity
   function mint(address to, uint256 amount) external onlyRole(MINTER_ROLE) {
       require(canReceive(to, amount), "Recipient not compliant");
       _mint(to, amount);
   }
   ```

2. **Compliance Validation**
   - Verify recipient's OnchainID exists
   - Check required claims are present and valid
   - Verify oracle whitelist status
   - Check blacklist status
   - Validate country restrictions
   - Check investor count limits

3. **UTXO Creation**
   ```rust
   let compliance_utxo = ERC3643ComplianceUTXO {
       value: amount,
       token_address: token_contract,
       onchain_id: recipient_identity,
       whitelist_tier: 8,
       country_code: 840, // US
       investor_type: InvestorType::AccreditedInvestor,
       oracle_whitelist_status: OracleWhitelistStatus::Approved,
       // ... other fields
   };
   ```

4. **Event Emission**
   ```solidity
   emit Transfer(address(0), to, amount);
   emit ComplianceMint(to, amount, whitelistTier);
   ```

---

## Token Transfer Workflow

### Standard Transfer Process

```mermaid
sequenceDiagram
    participant Sender as Token Sender
    participant Wallet as Compliance Wallet
    participant Validator as ERC-3643 Validator
    participant Oracle as Oracle Network
    participant Recipient as Token Recipient
    participant UTXO as UTXO Manager

    Sender->>Wallet: Initiate transfer
    Wallet->>Validator: Submit transaction
    
    Validator->>Oracle: Check sender compliance
    Oracle->>Validator: Sender approved
    
    Validator->>Oracle: Check recipient compliance
    Oracle->>Validator: Recipient approved
    
    Validator->>Validator: Validate transfer rules
    Validator->>UTXO: Update UTXOs
    
    UTXO->>Sender: Deduct tokens
    UTXO->>Recipient: Add tokens
    
    Validator->>Wallet: Transfer confirmed
    Wallet->>Sender: Transaction complete
```

### Transfer Validation Checklist

#### Sender Validation:
- ✅ Identity verified and active
- ✅ Whitelisted by oracles
- ✅ Not blacklisted
- ✅ Sufficient token balance
- ✅ Holding period satisfied
- ✅ Claims still valid

#### Recipient Validation:
- ✅ Identity verified and active
- ✅ Whitelisted by oracles
- ✅ Not blacklisted
- ✅ Country allowed
- ✅ Investor type permitted
- ✅ Investor count not exceeded

#### Transfer Rules:
- ✅ Transfer amount within limits
- ✅ No transfer restrictions active
- ✅ Transfer agent approval (if required)

### Transfer Process Steps

1. **User Interface**
   ```
   ┌─────────────────────────────────────┐
   │ Send CMTA Tokens                    │
   ├─────────────────────────────────────┤
   │ To Address: 0x742d35Cc6634C0532... │
   │ Amount: 1,000 CMTA                  │
   │ ⚠️  Validating compliance...        │
   │                                     │
   │ Sender Status: ✅ Verified          │
   │ Recipient Status: ⏳ Checking...    │
   └─────────────────────────────────────┘
   ```

2. **Real-time Validation**
   ```rust
   async fn validate_transfer(
       from: &Address,
       to: &Address,
       amount: u64,
   ) -> Result<ValidationResult> {
       // Check sender compliance
       let sender_status = oracle_network.verify_compliance(from).await?;
       if !sender_status.is_compliant() {
           return Err(ValidationError::SenderNotCompliant);
       }
       
       // Check recipient compliance
       let recipient_status = oracle_network.verify_compliance(to).await?;
       if !recipient_status.is_compliant() {
           return Err(ValidationError::RecipientNotCompliant);
       }
       
       // Validate transfer rules
       validate_transfer_rules(from, to, amount).await
   }
   ```

3. **UTXO Updates**
   - Spend sender's UTXOs
   - Create new UTXOs for recipient
   - Update compliance metadata
   - Record transaction in audit trail

---

## Token Payment Workflow

### Payment Processing

```mermaid
sequenceDiagram
    participant Payer as Token Payer
    participant Merchant as Payment Recipient
    participant Gateway as Payment Gateway
    participant Validator as ERC-3643 Validator
    participant Oracle as Oracle Network
    participant Settlement as Settlement System

    Payer->>Gateway: Initiate payment
    Gateway->>Validator: Validate payment compliance
    Validator->>Oracle: Check payer/merchant status
    Oracle->>Validator: Both parties compliant
    Validator->>Settlement: Process payment
    Settlement->>Merchant: Tokens received
    Settlement->>Payer: Payment confirmed
```

### Payment Types

#### 1. Direct Token Payment
- **Use Case**: Direct transfer for goods/services
- **Process**: Standard transfer with payment metadata
- **Compliance**: Both parties must be compliant

#### 2. Escrow Payment
- **Use Case**: Conditional payments with release conditions
- **Process**: Tokens held in a one-time `MultiSigEscrowWallet`; see [Escrow Payment Workflow](#escrow-payment-workflow)
- **Compliance**: Escrow contract must be a trusted contract in ComplianceRules

#### 3. Recurring Payment
- **Use Case**: Subscription or installment payments
- **Process**: Pre-authorized recurring transfers
- **Compliance**: Ongoing compliance monitoring required

### Payment Validation

```rust
pub struct PaymentRequest {
    pub payer: Address,
    pub recipient: Address,
    pub amount: u64,
    pub payment_type: PaymentType,
    pub metadata: PaymentMetadata,
}

pub enum PaymentType {
    Direct,
    Escrow { release_conditions: Vec<Condition> },
    Recurring { frequency: Duration, total_payments: u32 },
}

async fn process_payment(request: PaymentRequest) -> Result<PaymentResult> {
    // Validate both parties
    validate_payment_compliance(&request.payer, &request.recipient).await?;
    
    // Check payment-specific rules
    match request.payment_type {
        PaymentType::Direct => process_direct_payment(request).await,
        PaymentType::Escrow { .. } => process_escrow_payment(request).await,
        PaymentType::Recurring { .. } => process_recurring_payment(request).await,
    }
}
```

---

## Escrow Payment Workflow

A conditional VSC payment between a **payer** and a **payee**, mediated by a registered **investor**. Each payment gets its own `MultiSigEscrowWallet`, deployed by `EscrowWalletFactory` and used exactly once. Demo options 61 to 73b.

### Parties and money

| Party | Does | Must be |
|-------|------|---------|
| Payer | Funds the escrow. May dispute. Signs to allow a refund. | KYC/AML verified. May be unknown at creation (marketplace): the first verified funder becomes the payer. |
| Payee | Ships, submits the signed shipment proof, signs to allow a release. | KYC/AML verified. |
| Investor | Creates the escrow, states the settlement direction, mediates disputes, may refund. | Registered on the factory (`registerInvestor`, `INVESTOR_ROLE`). |
| Platform | Receives the owner fee. | Fee wallet set on the factory. |

The escrow holds **amount + 3% investor fee + 2% owner fee**, all fixed at creation. A 1000 VSC payment is funded with 1050 VSC. On release the payee gets 1000, the investor fee wallet 30, the platform fee wallet 20. On refund the payer gets the full 1050 back.

The escrow, the payer, and the payee are added to ComplianceRules as trusted contracts when the escrow is created (the demo does this; on your own deployment the ComplianceRules owner must). That is what lets VSC move in and out of a contract that has no identity of its own. The other party to every transfer is still checked.

### Lifecycle

```mermaid
stateDiagram-v2
    [*] --> Active : createEscrowWallet
    Active --> Disputed : raiseDispute (payer, within 14 days of the proof)
    Disputed --> Active : resolveDispute(false), all signatures cleared
    Disputed --> Refunded : resolveDispute(true)
    Active --> Released : signAsInvestor(true), needs payee signature
    Active --> Refunded : signAsInvestor(false), needs payer signature
    Active --> Refunded : manualRefund (investor)
    Disputed --> Refunded : manualRefund (investor)
    Released --> Released : sweepExcess
    Refunded --> Refunded : sweepExcess
```

`Active`, `Released`, `Refunded`, `Disputed` are the on-chain states. Funding, the shipment proof, and the payer and payee signatures all happen while the escrow is `Active` and do not change its state; whether it has been funded is a separate on-chain flag, `funded`.

### Steps

**1. Deploy the factory (61).** Needs the ERC-3643 token (21). The demo also adds the platform fee wallet as a trusted contract here.

**2. Register the investor (62).** The investor's fee wallet is set at registration and never changes. In the demo, onboard the investor through option 23 (steps 1 to 6) so they hold a multi-sig wallet, which is a trusted contract and can receive the fee. A user created through option 24 has no such wallet; the demo falls back to a reserved signer that is not verified, and the release later reverts with `Compliance check failed`.

**3. Create the escrow (63).** The investor names the payer (or "Unknown" for a marketplace escrow), the payee, and the amount. The factory checks both known parties are verified, deploys the wallet, and emits `EscrowWalletCreated` with the payment id and wallet address.

**4. Fund it (64).** The payer approves the factory for the total and calls `fundEscrowWallet(paymentId)`. The factory pulls the tokens in and then marks the wallet `funded`. **Funding is once only**: a second call reverts `EscrowAlreadyFunded`. The demo checks the flag before asking for the approval, so no gas is spent on a doomed attempt.

**5. Ship and prove (65).** The payee submits the shipment data, its hash, and a signature. The contract recovers the signer from a digest that binds the string `VanguardShipmentProof`, **this escrow's address**, **the chain id**, and the hash, and requires it to be the payee. A signature copied from another escrow or another chain is rejected with `ProofNotSignedByPayee`. Submission starts the **14-day dispute window**.

**6. Dispute window.** While it is open the payer may `raiseDispute` (66) and the payee cannot sign. The investor resolves (67): refund the payer, or reopen the escrow. Reopening clears **all three** signatures, so nothing signed before the dispute carries over. On a local node use 73b to jump past the window; on a real network it closes on its own.

**7. Settle, 2-of-3 with an explicit direction.** The payee signs (68) once the window has closed; the payer may sign at any time while the escrow is active. Neither signature moves funds. The investor then signs (69) and **states the direction**:

| Investor says | Requires | Result |
|---------------|----------|--------|
| release | payee has signed | amount to payee, fees to the two fee wallets, state `Released` |
| refund | payer has signed | full total back to the payer, state `Refunded` |

If the required counterparty signature is missing the call reverts (`PayeeHasNotSigned` / `PayerHasNotSigned`). The direction is never inferred from who signed first; that inference used to let a payer pre-sign and turn an intended release into a refund to themselves.

**8. Manual refund (70).** The investor may refund the payer at any time while the escrow is `Active` or `Disputed`, without any other signature.

**9. Sweep what settlement left behind (70a).** See below.

### Why an escrow can hold more than it pays out, and what to do

Release and refund pay **fixed** sums. Anything else that reaches the escrow address is not part of the settlement and stays there:

| How tokens arrive | Stopped? | What happens |
|-------------------|----------|--------------|
| `fundEscrowWallet` through the factory | Yes, once only (`funded`) | Second call reverts. |
| A plain `transfer(escrowAddress, x)` by any verified holder | No. The factory never sees it. | Lands in the escrow. Settlement ignores it. |

Once the escrow is `Released` or `Refunded`, **anyone** may call `sweepExcess()`. It sends the entire remaining VSC balance to the payer, the party who funds escrows and the only one who plausibly paid twice. If no payer was ever set (a marketplace escrow settled purely from direct transfers) it goes to the platform fee wallet instead, never to the zero address. It reverts while the escrow is still active (`EscrowStillActive`) and when there is nothing to sweep (`NothingToSweep`). It only ever touches the one token the escrow was created for.

Escrows deployed from earlier bytecode do not have this function. Tokens stranded in one of those need a separate recovery decision.

### A demo run that shows the whole thing

On a local node, this order works from a fresh start:

```
1 → 21 → 51 → 22 → 25/1/1          deploy, mint to the central bank
24/1 Alice, 24/1 Bob               payer and payee
23/1 Ivan, then 23/2 … 23/6 for Ivan   investor with a multi-sig fee wallet
61 → 62 (Ivan) → 63 (Ivan, Alice → Bob, 1000)
64                                  fund: escrow holds 1050
   (send another 1050 straight to the escrow address, outside the factory)
65 → 73b → 68 → 69/1                proof, close the window, payee signs, investor releases
71                                  Released, escrow still holds 1050
70a                                 "Stranded tokens returned … To: <Alice> Amount: 1050.0"
71                                  escrow holds 0
```

Option 71 shows the on-chain state and every party's balance; 71a shows all balances at once.

---

## Token Burning Workflow

### Authorized Burning Process

```mermaid
sequenceDiagram
    participant Holder as Token Holder
    participant Validator as ERC-3643 Validator
    participant Oracle as Oracle Network
    participant UTXO as UTXO Manager
    participant Registry as Token Registry

    Holder->>Validator: Request burn (amount)
    Validator->>Oracle: Verify holder compliance
    Oracle->>Validator: Holder approved
    Validator->>UTXO: Validate UTXOs
    UTXO->>UTXO: Destroy UTXOs
    Validator->>Registry: Update total supply
    Registry->>Holder: Burn confirmed
```

### Burning Requirements

#### For Token Holders:
- Must own sufficient tokens
- Must be compliant (not blacklisted)
- Must satisfy any lock-up periods
- May require transfer agent approval

#### For the System:
- Must update total supply
- Must destroy corresponding UTXOs
- Must maintain audit trail
- Must check for any restrictions

### Burning Process Steps

1. **Burn Request**
   ```solidity
   function burn(uint256 amount) external {
       require(balanceOf(msg.sender) >= amount, "Insufficient balance");
       require(canBurn(msg.sender, amount), "Burn not allowed");
       _burn(msg.sender, amount);
   }
   ```

2. **Compliance Validation**
   ```rust
   async fn validate_burn(
       holder: &Address,
       amount: u64,
   ) -> Result<BurnValidation> {
       // Check holder is not blacklisted
       let blacklist_status = oracle_network.check_blacklist(holder).await?;
       if blacklist_status.is_blacklisted() {
           return Err(BurnError::HolderBlacklisted);
       }
       
       // Check lock-up periods
       let lockup_status = check_lockup_periods(holder, amount).await?;
       if !lockup_status.can_burn() {
           return Err(BurnError::TokensLocked);
       }
       
       Ok(BurnValidation::Approved)
   }
   ```

3. **UTXO Destruction**
   - Select UTXOs to burn
   - Validate UTXO ownership
   - Destroy selected UTXOs
   - Update holder's balance

---

## Compliance Monitoring

### Continuous Monitoring System

```mermaid
graph TB
    subgraph "Monitoring Components"
        Monitor[Compliance Monitor]
        Oracle[Oracle Network]
        Alerts[Alert System]
        Reports[Reporting Engine]
    end
    
    subgraph "Monitored Events"
        Transfers[Token Transfers]
        Claims[Claim Updates]
        Lists[Whitelist/Blacklist Changes]
        Violations[Compliance Violations]
    end
    
    Monitor --> Oracle
    Monitor --> Alerts
    Monitor --> Reports
    
    Transfers --> Monitor
    Claims --> Monitor
    Lists --> Monitor
    Violations --> Monitor
```

### Monitoring Activities

#### 1. Real-time Compliance Checks
- **Identity Status**: Monitor OnchainID validity
- **Claims Expiry**: Track claim expiration dates
- **Oracle Lists**: Monitor whitelist/blacklist changes
- **Regulatory Updates**: Track regulatory requirement changes

#### 2. Automated Alerts
- **Compliance Violations**: Immediate alerts for violations
- **Claim Expiry**: Warnings before claims expire
- **Suspicious Activity**: Unusual transaction patterns
- **Regulatory Changes**: Updates to compliance requirements

#### 3. Periodic Reviews
- **Quarterly Reviews**: Comprehensive compliance assessment
- **Annual Audits**: Full system compliance audit
- **Regulatory Reporting**: Automated regulatory reports
- **Performance Metrics**: System performance analysis

---

## Error Handling

### Common Error Scenarios

#### 1. Identity Verification Errors
```
❌ Identity Verification Failed
Error Code: ID_001
Reason: OnchainID not found in registry
Resolution: Complete identity verification process
Estimated Time: 2-5 business days
```

#### 2. Compliance Validation Errors
```
❌ Transfer Rejected
Error Code: COMP_003
Reason: Recipient not whitelisted
Details: 
- Recipient address: 0x742d35Cc...
- Required whitelist tier: 5
- Current status: Not whitelisted
Resolution: Recipient must complete oracle whitelist approval
```

#### 3. Oracle Consensus Errors
```
❌ Oracle Consensus Failed
Error Code: ORC_002
Reason: Insufficient oracle responses
Details:
- Required consensus: 3 of 5 oracles
- Received responses: 2 of 5 oracles
- Failed oracles: Oracle-3, Oracle-5
Resolution: Retry transaction or wait for oracle recovery
```

#### 4. Regulatory Compliance Errors
```
❌ Regulatory Violation
Error Code: REG_005
Reason: Country restriction violation
Details:
- Sender country: United States
- Recipient country: Restricted Territory
- Applicable regulation: OFAC Sanctions
Resolution: Transfer not permitted under current regulations
```

### Error Recovery Process

1. **Automatic Retry**: System automatically retries failed operations
2. **Fallback Mechanisms**: Use cached data when oracles unavailable
3. **Manual Review**: Complex cases escalated to compliance team
4. **User Notification**: Clear error messages with resolution steps

---

## System Status Dashboard

### User Dashboard Example
```
┌─────────────────────────────────────────────────────────┐
│ CMTA Token Compliance Dashboard                         │
├─────────────────────────────────────────────────────────┤
│ Account Status: ✅ Fully Compliant                     │
│ Whitelist Tier: 8 (Accredited Investor)                │
│ Token Balance: 25,000 CMTA                             │
│ Available for Transfer: 25,000 CMTA                    │
├─────────────────────────────────────────────────────────┤
│ Compliance Status:                                      │
│ • Identity Verified: ✅ Valid until 2025-12-31        │
│ • KYC Status: ✅ Current                               │
│ • AML Screening: ✅ Clear                              │
│ • Accreditation: ✅ Valid until 2025-06-30            │
│ • Oracle Whitelist: ✅ Tier 8                         │
│ • Blacklist Status: ✅ Clear                          │
├─────────────────────────────────────────────────────────┤
│ Recent Activity:                                        │
│ • 2024-01-15: Received 5,000 CMTA from 0x123...       │
│ • 2024-01-10: Sent 2,000 CMTA to 0x456...             │
│ • 2024-01-05: Compliance review completed              │
├─────────────────────────────────────────────────────────┤
│ Actions:                                                │
│ [Send Tokens] [Request Payment] [View History]         │
└─────────────────────────────────────────────────────────┘
```

This comprehensive workflow ensures that all token operations (mint, burn, transfer, payment) maintain full regulatory compliance while providing a smooth user experience for qualified investors.