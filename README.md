# Vanguard RWA StableCoin -  ERC-3643 Compliant Digital Currency

## Overview

This project implements a **Vanguard RWA StableCoin (VSC)** system, under development and not yet audited, with comprehensive compliance management integrated with **ERC-3643** standard and **OnchainID (ERC-734/ERC-735)**. The system provides:

- ✅ **Real-time compliance validation** through oracle networks
- ✅ **Dynamic whitelist/blacklist management** with oracle consensus (66% of the registered node weight: two of three equal nodes)
- ✅ **Zero-knowledge privacy features** (5 Circom circuits)
- ✅ **Complete token lifecycle management** with audit trails
- ✅ **Investor type differentiation** (4 types: Normal, Retail, Accredited, Institutional)
- ✅ **Democratic governance** (1 Person = 1 Vote with VGT voting fees)
- ✅ **Enhanced escrow system** (2-of-3 multisig with dispute resolution)
- ✅ **Investor custody** (the investor lock moves into an on-chain 2-of-2 `MultiSigWallet`; bank and user both sign to release)
- ✅ **Payment protocol** with multi-type refunds
- ✅ **89 interactive demo options** for complete system testing

**Current Status**: under development. The contracts, the interactive demo, the tests and CI run end to end on a local Hardhat node; the remaining remediation phases and a third-party security audit come before any production or mainnet use.

> **Building from a fresh clone:** the ZK circuit artifacts are gitignored build output.
> Run `npm run setup:zk` before `npm test`; without the artifacts every suite that
> generates real proofs fails with `ENOENT`.
> `setup:zk` requires the **Rust circom 2.x** compiler — the `circom` npm package is the
> deprecated 0.5.x JS build and cannot compile these circuits. See
> [docs/ZK_CIRCUIT_BUILD_GUIDE.md](docs/ZK_CIRCUIT_BUILD_GUIDE.md).


## 🏗️ Project Structure

```
Vanguard/
├── contracts/                    # Smart Contract Implementation 
│   ├── onchain_id/              # OnchainID contracts (ERC-734/735)
│   ├── erc3643/                 # ERC-3643 T-REX contracts
│   ├── oracle/                  # Oracle management contracts
│   ├── compliance/              # ComplianceRules engine
│   ├── privacy/                 # ZK verification contracts
│   ├── investor/                # Investor type management
│   ├── governance/              # Governance system (1 Person = 1 Vote)
│   ├── payment/                 # Payment protocol with refunds
│   └── test/                    # Test contracts and helpers
├── circuits/                    # Zero-Knowledge Circuits 
│   ├── whitelist_membership.circom          # Whitelist membership proof
│   ├── blacklist_membership.circom          # Blacklist non-membership proof (non-gating, D2)
│   ├── jurisdiction_proof.circom            # Issuer-attested jurisdiction in the allowed set
│   ├── accreditation_proof.circom           # Issuer-attested accreditation >= minimum
│   ├── compliance_aggregation.circom        # Issuer-attested scores meet a weighted minimum
│   └── attestation.circom                   # Shared EdDSA-Poseidon attestation templates
├── demo/                        # Interactive Demo System 
│   ├── core/                    # Core demo functionality
│   ├── modules/                 # Demo modules (89 menu options)
│   ├── logging/                 # Demo logging utilities
│   ├── utils/                   # Demo helper utilities
│   └── index.js                 # Main demo entry point
├── scripts/                     # Deployment & Utility Scripts
│   ├── production/              # Production deployment scripts
│   ├── deploy-*.ts              # Contract deployment scripts
│   ├── test-*.js                # Testing and validation scripts
│   ├── generate-*.js            # ZK proof generation scripts
│   └── setup-*.js               # Setup and configuration scripts
├── test/                        # Comprehensive Test Suite
│   ├── circuits/                # ZK circuit tests
│   ├── compliance/              # Compliance system tests
│   ├── erc3643/                 # ERC-3643 token tests
│   ├── investor/                # Investor type system tests
│   ├── onchain_id/              # OnchainID tests
│   ├── oracle/                  # Oracle system tests
│   ├── privacy/                 # Privacy/ZK tests
│   ├── integration/             # Integration tests
│   ├── production/              # Production readiness tests
│   └── *.test.ts                # Individual test files
├── docs/                        # Comprehensive Documentation
│   ├── SYSTEM_OVERVIEW.md                      # System architecture overview
│   ├── NEW_FAIR_VOTING_SYSTEM.md               # Fair voting implementation
│   ├── INVESTOR_TYPE_SYSTEM.md                 # Investor type documentation
│   ├── PAYMENT_PROTOCOL_DESIGN.md              # Payment protocol docs
│   ├── SYSTEM_WORKFLOW_GUIDE.md                # User workflows and interactions
│   ├── TECHNICAL_DEEP_DIVE.md                  # In-depth technical analysis
│   ├── VANGUARD_RWA_TOKEN_ECOSYSTEM_GUIDE.md   # Complete ecosystem guide
│   ├── VOTING_SYSTEM_DIAGRAM.md                # Voting system visualization
│   ├── WORKFLOW_IMPLEMENTATION_SUMMARY.md      # Implementation workflow summary
│   ├── WORKING_DEMOS.md                        # Verified working demos guide
│   └── ZK_CIRCUIT_BUILD_GUIDE.md               # Zero-knowledge circuit build guide
├── utils/                       # Utility Functions
│   ├── merkle-tree-builder.js   # Merkle tree construction
│   └── proof-formatter.js       # ZK proof formatting
├── typechain-types/             # TypeScript contract types
├── hardhat.config.ts            # Hardhat configuration
├── tsconfig.json                # TypeScript configuration
├── foundry.toml                 # Foundry configuration
└── package.json                 # Project dependencies
```

## ✅ Implementation Status

### **Core System** 
1. ✅ OnchainID System (ERC-734/735) - Blockchain identity management
2. ✅ ERC-3643 System - Compliant security token
3. ✅ Oracle System - Consensus-based access control
4. ✅ ComplianceRules - per-token jurisdiction rules, list gates and trusted contracts
5. ✅ Privacy System - 5 ZK circuits for privacy-preserving compliance

### **Investor Management** 
6. ✅ Investor Type System - 4 types with differentiated limits
7. ✅ Transfer Limits - Type-specific transfer and holding limits
8. ✅ Whitelist Tiers - Required tiers per investor type
9. ✅ Large Transfer Detection - Compliance officer notifications
10. ✅ Investor Custody - `InvestorRequestManager` deploys a 2-of-2 `MultiSigWallet` per request; the lock is a token transfer into it, released only by bank + user

### **Governance & Escrow**
14. ✅ VanguardGovernance - 1 Person = 1 Vote governance
15. ✅ GovernanceToken (VGT) - ERC-3643 compliant voting fee token
16. ✅ Enhanced Escrow - 2-of-3 multisig with dispute resolution
17. ✅ EscrowWalletFactory - One-time-use escrow wallets

### **Interactive Demo System** 
18. ✅ 83 Menu Options - Complete workflow coverage
19. ✅ End-to-End Testing - All systems integrated
20. ✅ User-Friendly Interface - Step-by-step guided workflows



## 📚 Documentation

### **System Overview & Architecture**
- [System Overview](/docs/SYSTEM_OVERVIEW.md) - Complete system architecture (83 menu options, 5 ZK circuits, 32+ contracts)
- [Testnet Demo](/docs/TESTNET_DEMO.md) - Role wallets from one mnemonic, governance time scale, local rehearsal before Sepolia
- [Vanguard RWA StableCoin Ecosystem Guide](/docs/VANGUARD_RWA_TOKEN_ECOSYSTEM_GUIDE.md) - Complete ecosystem overview
- [Technical Deep Dive](/docs/TECHNICAL_DEEP_DIVE.md) - In-depth technical analysis
- [Working Demos](/docs/WORKING_DEMOS.md) - Verified working demos guide

### **Governance & Voting System**
- [New Fair Voting System](/docs/NEW_FAIR_VOTING_SYSTEM.md) - Fair voting implementation (1 Person = 1 Vote)
- [Voting System Diagram](/docs/VOTING_SYSTEM_DIAGRAM.md) - Voting system visualization

### **Investor & Payment Systems**
- [Investor Type System](/docs/INVESTOR_TYPE_SYSTEM.md) - 4 investor types with limits
- [Payment Protocol Design](/docs/PAYMENT_PROTOCOL_DESIGN.md) - Payment protocol architecture

### **Workflow & Implementation Guides**
- [System Workflow Guide](/docs/SYSTEM_WORKFLOW_GUIDE.md) - User workflows and interactions
- [Workflow Implementation Summary](/docs/WORKFLOW_IMPLEMENTATION_SUMMARY.md) - Implementation workflow summary
- [ZK Circuit Build Guide](/docs/ZK_CIRCUIT_BUILD_GUIDE.md) - Zero-knowledge circuit build guide



## 🛠️ Quick Start

### Prerequisites
- Node.js 18+
- Hardhat
- Circom (for ZK circuits)
- snarkjs (for ZK proof generation)

### Installation

```bash
# 1. Clone the repository
git clone <repository-url>
cd ERC-3643

# 2. Install dependencies
npm install

# 3. Compile contracts
npx hardhat compile

# 4. Compile ZK circuits (optional - pre-compiled artifacts included)

npm run setup:zk             # Setup ZK circuits (one-time)


### Available NPM Scripts

**Core Development** (Most Used):
```bash
npm run compile              # Compile smart contracts
npm run test                 # Run all tests
npm run node                 # Start local Hardhat node
npm run clean                # Clean build artifacts
npm run demo:interactive:proof  # Run main interactive demo (89 options)
```


**Testing & Analysis**:
```bash
npm run test            # Run all tests
npm run test:coverage   # Run all tests under solidity-coverage
```


### Running the Interactive Demo

```bash
# 1. Start Hardhat node in one terminal
npm run node

# 2. Run the interactive demo in another terminal
npm run demo:interactive:proof
```

**The interactive demo provides 89 menu options covering:**
- User onboarding (KYC/AML verification)
- Token minting and transfers
- Oracle access control (whitelist/blacklist)
- Privacy & ZK verification
- Token burning with quotas
- Investor type management
- Enhanced escrow with dispute resolution
- Payment protocol with refunds
- Governance (1 Person = 1 Vote)
- Dynamic governance cost management (NEW!)
- Complete system integration

### Running Tests

```bash
# Run all tests
npx hardhat test

# Run specific test file
npx hardhat test test/VanguardGovernance.test.ts

# Run with gas reporting
REPORT_GAS=true npx hardhat test

# Run with coverage
npx hardhat coverage
```

## 🎯 Key Features

### **1. Identity & Compliance**
- ✅ **OnchainID (ERC-734/735)**: Blockchain-based identity with key and claim management
- ✅ **ERC-3643 T-REX**: Compliant security token standard
- ✅ **KYC/AML Verification**: Trusted claim issuers for identity verification
- ✅ **ComplianceRules**: per-token jurisdiction rules, blacklist and whitelist gates (oracle or ZK binding), and per-token trusted contracts; investor-type transfer and holding caps live in `InvestorTypeRegistry`, which the token enforces

### **2. Oracle Access Control**
- ✅ **Dynamic Whitelist**: 5-tier whitelist with oracle consensus (66% of the registered node weight)
- ✅ **Real-time Blacklist**: 4-severity blacklist with emergency override
- ✅ **Oracle Consensus**: M-of-N consensus mechanism with reputation scoring
- ✅ **Fallback Mechanisms**: Graceful degradation on oracle failures

### **3. Privacy & Zero-Knowledge**
- ✅ **5 ZK Circuits**: Whitelist, blacklist, jurisdiction, accreditation, compliance aggregation
- ✅ **PLONK Proofs**: Privacy-preserving compliance validation (universal setup, all five circuits)
- ✅ **What stays private**: which identity on the whitelist a wallet belongs to (each leaf is a commitment `Poseidon(identity, secret)`), and the attested attributes (an issuer-signed jurisdiction, accreditation amount or compliance scores, proved against a policy). The prover's wallet is public: ERC-3643 transfers name it and every proof binds it (`walletBinding`).
- ✅ **What gates transfers**: only the whitelist binding (`PrivacyManager.hasValidWhitelistProof`), read by `ComplianceRules` when a token's whitelist mode is ZkOnly or Either. The attestation proofs are views (`validatePrivate*`) that nothing on the transfer path reads, and the blacklist proof gates nothing; sanctions are enforced by the blacklist oracle.

### **4. Investor Type Management**
- ✅ **4 Investor Types**: Normal (0), Retail (1), Accredited (2), Institutional (3)
- ✅ **Type-Specific Limits**: Transfer limits (8K/50K/500K VSC), Holding limits (50K/500K/5M VSC)
- ⚠️ **Whitelist Tiers**: required tiers per investor type (1/2/3/4) are recorded in InvestorTypeRegistry; Token does not enforce them today (D37)
- ⚠️ **Transfer Cooldowns**: type-specific cooldowns (60/60/30/15 minutes) are recorded in InvestorTypeRegistry; Token does not enforce them today (D37)

### **5. Governance System**
- ✅ **1 Person = 1 Vote**: Equal voting power for all verified users
- ✅ **VGT Voting Fees**: 10 VGT proposal creation, 10 VGT per vote
- ✅ **Token Burning**: Passed proposals burn deposits; failed ones make them claimable per participant
- ✅ **Per-Type Thresholds**: Quorum 10-30% of eligible voters and approval 60-75%, set per proposal type
- ✅ **KYC/AML Required**: Only verified users can participate in governance

### **6. Enhanced Escrow System**
- ✅ **2-of-3 Multisig, Explicit Direction**: Investor MUST sign + (Payer OR Payee). The investor states release or refund; the matching counterparty signature must already be there, it is never inferred from who signed first
- ✅ **One-Time-Use Wallets**: Unique escrow wallet per payment, funded once through the factory (`EscrowAlreadyFunded` on a second attempt)
- ✅ **Verified Shipment Proof**: Signed by the payee and bound to the escrow address and chain id, so it cannot be replayed; opens the 14-day dispute window
- ✅ **Dispute Resolution**: Payer may dispute within the window; the investor refunds or reopens with all signatures cleared
- ✅ **Fee Distribution**: Fixed at creation (3% investor, 2% owner), paid on release and recorded per investor in the factory (`getInvestorProfile().totalFeesEarned`); the investor fee can be routed to the investor's 2-of-2 `MultiSigWallet`
- ✅ **Trust by Registrar**: the factory is a ComplianceRules registrar on VSC and trusts each escrow it deploys; a registrar may trust only accounts with the compiled `MultiSigEscrowWallet` (or, for `InvestorRequestManager`, `MultiSigWallet`) code hash
- ✅ **Sweep**: Tokens sent to a settled escrow outside the factory are returned by `sweepExcess()` (demo option 70a)
- 📖 Step by step, with the demo option for each step: [Escrow Payment Workflow](/docs/SYSTEM_WORKFLOW_GUIDE.md#escrow-payment-workflow)

### **8. Token Lifecycle Management**
- ✅ **Issuer-Only Minting**: Exclusive minting authority with economic rationale
- ✅ **Quota-Based Burning**: Daily/weekly/monthly quotas with consistency checks
- ✅ **Supply Management**: Complete supply tracking with audit trails
- ✅ **Compliance Validation**: All operations validated through ComplianceRules

## 🔒 Security

### **Smart Contract Security**
- ✅ **Access Control**: Role-based access control for all critical functions
- ✅ **Reentrancy Protection**: ReentrancyGuard on all state-changing functions
- ✅ **Input Validation**: Comprehensive validation of all inputs
- ✅ **Safe Math**: Built-in overflow protection (Solidity 0.8+)

### **Oracle Security**
- ✅ **Weighted Consensus**: an oracle verdict needs 66% of the registered node weight (two of three equal nodes); governance list updates go through DynamicListManager instead
- ✅ **Reputation Management**: Oracle scoring and reputation tracking
- ✅ **Emergency Override**: Emergency blacklist for immediate threat response
- ✅ **Fallback Mechanisms**: Graceful degradation on oracle failures

### **Privacy & Compliance**
- ✅ **Zero-Knowledge Proofs**: Privacy-preserving compliance validation
- ✅ **Private allow-list membership**: a wallet proves it holds a whitelist slot without revealing which identity's slot; the wallet itself stays public
- ✅ **Audit Trail**: Immutable compliance event logging
- ✅ **KYC/AML Verification**: Trusted claim issuers for identity verification

### **Governance Security**
- ✅ **Sybil Resistance**: KYC/AML required for all governance participants
- ✅ **Proposer Restriction**: Proposers cannot vote on their own proposals
- ✅ **Token Locking**: Voting fees locked during voting period
- ✅ **Equal Voting Power**: 1 Person = 1 Vote prevents whale domination

## 📊 System Architecture

### **Smart Contract Layers**

```
┌─────────────────────────────────────────────────────────────────┐
│                    VANGUARD RWA STABLECOIN SYSTEM               │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐           │
│  │  OnchainID   │  │ ERC-3643     │  │ Oracle       │           │
│  │  (Identity)  │  │ (Compliance) │  │ (Access)     │           │
│  └──────────────┘  └──────────────┘  └──────────────┘           │
│         │                 │                  │                  │
│         └─────────────────┼──────────────────┘                  │
│                           │                                     │
│  ┌────────────────────────────────────────────────────────┐     │
│  │         ComplianceRules (admin base + evaluation)      │     │
│  │  - Jurisdiction rules per token                        │     │
│  │  - Blacklist / whitelist gates (oracle or ZK binding)  │     │
│  │  - Trusted contracts and rule administrators per token │     │
│  │  (investor-type caps: InvestorTypeRegistry)            │     │
│  └────────────────────────────────────────────────────────┘     │
│                           │                                     │
│  ┌────────────────────────────────────────────────────────┐     │
│  │      Vanguard RWA StableCoin Token (VSC) - ERC-3643    │     │
│  │  - Compliant transfers with multi-layer validation     │     │
│  │  - Investor type-specific limits                       │     │
│  │  - Issuer-only minting with quotas                     │     │
│  │  - Quota-based burning with audit trails               │     │
│  └────────────────────────────────────────────────────────┘     │
│                                                                 │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐           │
│  │ Governance   │  │ Escrow       │  │ Payment      │           │
│  │ (1P=1V)      │  │ (2-of-3)     │  │ (Refunds)    │           │
│  └──────────────┘  └──────────────┘  └──────────────┘           │
│                                                                 │
│  ┌────────────────────────────────────────────────────────┐     │
│  │      Privacy Layer (5 ZK Circuits - PLONK)             │     │
│  │  - Whitelist/Blacklist membership proofs               │     │
│  │  - Jurisdiction compliance proofs                      │     │
│  │  - Accreditation status proofs                         │     │
│  │  - Compliance aggregation proofs                       │     │
│  └────────────────────────────────────────────────────────┘     │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### **Contract Categories**

| Category | Contracts | Status |
|----------|-----------|--------|
| **OnchainID** | 5 contracts | ✅ COMPLETE |
| **ERC-3643** | 6 contracts | ✅ COMPLETE |
| **Oracle** | 4 contracts | ✅ COMPLETE |
| **Compliance** | 1 contract | ✅ COMPLETE |
| **Privacy** | 7 contracts | ✅ COMPLETE |
| **Investor Type** | 2 contracts | ✅ COMPLETE |
| **Governance** | 2 contracts | ✅ COMPLETE |
| **Escrow** | 2 contracts | ✅ COMPLETE |
| **Payment** | 3 contracts | ✅ COMPLETE |
| **Total** | **32+ contracts** | Implemented and tested; audit pending |

## 🚀 Getting Started with the Demo

### **Step 1: Deploy the System**
```bash
# Start Hardhat node
npx hardhat node

# In another terminal, run the demo
npm run demo:interactive:proof


**See [Complete Demo Workflow](/docs/COMPLETE_DEMO_WORKFLOW.md) for detailed step-by-step guide.**

## 📈 Performance & Scalability

### **Gas Optimization**
- ✅ Efficient storage patterns (packed structs, minimal storage writes)
- ✅ Batch operations for multiple actions
- ✅ Optimized loops and data structures
- ⏳ **PENDING**: Comprehensive gas benchmarking and optimization

### **Scalability**
- ✅ Modular architecture for easy upgrades
- ✅ Oracle consensus for distributed validation
- ✅ Efficient caching mechanisms
- ✅ Designed for high-throughput transaction processing

### **Monitoring & Observability**
- ✅ Comprehensive event logging for all operations
- ✅ Audit trails for compliance and governance
- ⏳ **PENDING**: Real-time monitoring and alerting setup
- ⏳ **PENDING**: Performance metrics and dashboards

## 🤝 Contributing

### **Development Guidelines**
1. ✅ Maintain comprehensive test coverage
2. ✅ Update documentation with any changes
3. ✅ Follow security best practices
4. ✅ Submit detailed test results
5. ✅ Follow existing code style and patterns

### **Testing Requirements**
- All new features must include unit tests
- Integration tests for cross-contract interactions
- Gas optimization tests for critical functions
- Security testing for access control and validation

### **Documentation Requirements**
- Update relevant documentation files
- Add inline code comments for complex logic
- Create workflow guides for new features
- Update API documentation for contract changes

## 📄 License

MIT License - See LICENSE file for details

## 🆘 Support & Resources

### **Documentation**
- [System Overview](/docs/SYSTEM_OVERVIEW.md) - Start here for system architecture
- [Vanguard RWA StableCoin Ecosystem Guide](/docs/VANGUARD_STABLECOIN_ECOSYSTEM_GUIDE.md) - Complete ecosystem overview
- [Working Demos](/docs/WORKING_DEMOS.md) - Verified working demos guide
- [System Workflow Guide](/docs/SYSTEM_WORKFLOW_GUIDE.md) - User workflows and interactions

### **Getting Help**
1. Check the comprehensive documentation in the `/docs` folder
2. Review the interactive demo (83 menu options)
3. Examine test files for usage examples
4. Submit issues with detailed reproduction steps

---

## 🎯 Project Status

**Current Phase**: remediation plan v2, Phases 0 to 3 done (Phase 3 closed by Task 3.9); next are Task 3.10 (attestation lifetime) and Phase 4 (wire or delete), then Phase 5 (docs, coverage, third-party audit).
**Before any mainnet deployment**: the remaining phases, gas optimization and a security audit.

### **Implementation Summary**
- ✅ **11 Core Requirements**: All fully implemented
- ✅ **32+ Smart Contracts**: implemented and tested, not yet audited
- ✅ **5 ZK Circuits**: Privacy-preserving compliance
- ✅ **83 Demo Options**: Complete system testing
- ✅ **Comprehensive Documentation**: Complete guides and technical deep dives

### **Production Readiness**
- ✅ **Smart Contracts**: Complete and tested
- ✅ **Integration**: All systems working together
- ✅ **Documentation**: Comprehensive and up-to-date
- ⏳ **Security Audits**: Pending professional audits
- ⏳ **Gas Optimization**: Pending benchmarking and optimization
- ⏳ **Mainnet Deployment**: Pending production deployment

This is not production software yet: the remaining remediation phases and a third-party security audit come before any mainnet deployment.