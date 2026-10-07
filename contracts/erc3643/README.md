# ERC-3643 T-REX Smart Contracts

This directory contains the complete implementation of ERC-3643 (T-REX) standard smart contracts for compliant security tokens.

## 🏗️ Core Contracts Implemented

### 1. **Token.sol** - ERC-3643 Compliant Security Token
- Full ERC-3643 implementation with compliance checks
- Integrated with Identity Registry and Compliance Registry
- Support for token freezing, partial freezing, and recovery
- Agent-based access control for administrative functions
- Pausable functionality for emergency situations

### 2. **IdentityRegistry.sol** - Investor Identity Management
- OnchainID integration for blockchain-based identity verification
- Country code management for jurisdiction compliance
- Batch registration capabilities for efficient onboarding
- Agent-based access control with owner oversight
- Required topics, trusted issuers, `isVerified` and its per-identity
  verification cache in the base `RegistryVerification.sol`

### 3. **ComplianceRegistry.sol** - Compliance Rule Engine
- Modular compliance system supporting pluggable rules
- Integration with Identity Registry for verification
- Token binding for secure compliance enforcement
- Module management for extensible compliance logic

### 4. **InvestorTypeRegistry.sol** - Investor Types
- Per-type transfer and holding caps, transfer cooldown and required
  whitelist tier; Token enforces the caps and the cooldown, ComplianceRules
  the tier (Task 4.10, docs/INVESTOR_TYPE_SYSTEM.md)
- `lastTransferAt` per sender, written by `recordTransfer` only from a
  token the registry authorized (`authorizeToken`)
- Its own config proposals and governors in the base
  `InvestorTypeGovernance.sol`

## 🔗 Interface Definitions

All contracts implement comprehensive interfaces located in `interfaces/`:

- **IERC3643.sol** - Core T-REX token interface
- **IIdentityRegistry.sol** - Identity management interface
- **ICompliance.sol** - Compliance validation interface

## 🎯 Key Features Implemented

### ✅ **ERC-3643 Standard Compliance**
- Full T-REX standard implementation
- Transfer restrictions and compliance validation
- Identity verification requirements
- Claim-based authorization system

### ✅ **Security Features**
- Address and token freezing capabilities
- Recovery mechanism for lost wallets
- Agent-based access control
- Emergency pause functionality

### ✅ **Modular Architecture**
- Pluggable compliance modules
- Extensible claim validation system
- Configurable transfer restrictions
- Upgradeable registry system

### ✅ **Integration Ready**
- OnchainID (ERC-734/ERC-735) compatibility
- Oracle network integration points
- UTXO compliance system hooks
- Regulatory reporting event emissions

## 🚀 Usage Examples

### Deploy Token System
```solidity
// 1. Deploy registries
IdentityRegistry identityRegistry = new IdentityRegistry();
ComplianceRegistry compliance = new ComplianceRegistry(address(identityRegistry));

// 2. Deploy token
Token token = new Token(
    "Security Token",
    "SEC",
    address(identityRegistry),
    address(compliance)
);

// 3. Bind token to compliance
compliance.bindToken(address(token));
```

### Register Investor Identity
```solidity
// Register investor with OnchainID and country
identityRegistry.registerIdentity(
    investorWallet,
    onchainIDAddress,
    840 // US country code
);
```

### Mint Compliant Tokens
```solidity
// Mint tokens to verified investor
token.mint(investorWallet, 1000 * 10**18);
```

## 🔧 Next Steps

This completes **Task 3.1: Implement ERC-3643 core contracts**. The implementation provides:

1. ✅ Complete ERC-3643 T-REX standard implementation
2. ✅ Identity registry with OnchainID integration
3. ✅ Modular compliance system
4. ✅ Trusted issuers and claim topics management
5. ✅ Security features (freezing, recovery, pause)
6. ✅ Agent-based access control

Ready for **Task 3.2: Implement ERC-3643 compliance modules** to add specific compliance rules like country restrictions, investor limits, and transfer restrictions.