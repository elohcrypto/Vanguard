# 🏭 OnchainID Production Environment

This directory contains comprehensive production simulation and testing tools to ensure the OnchainID system is ready for mainnet deployment.

## 📁 Directory Structure

```
test/production/
├── README.md                    # This file
├── ProductionEnvironment.ts     # Production simulation environment
├── ProductionSimulation.test.ts # Comprehensive production tests
├── ProductionConfig.ts          # Production configuration management
└── PRODUCTION_CHECKLIST.md     # Pre-deployment checklist
```

## 🎯 Purpose

The production environment simulates real-world conditions to validate:

- **Real cryptographic signatures** and verification
- **Multi-party workflows** (KYC providers, AML services, recovery agents)
- **Network congestion** scenarios
- **Gas optimization** and cost analysis
- **Security stress testing** against various attack vectors
- **Emergency recovery** procedures
- **Performance benchmarks** under load

## 🚀 Quick Start

### 1. Run Production Simulation Tests

```bash
# Run all production tests
npx hardhat test test/production/ProductionSimulation.test.ts

# Run with specific network
npx hardhat test test/production/ProductionSimulation.test.ts --network sepolia

# Run with verbose output
VERBOSE=true npx hardhat test test/production/ProductionSimulation.test.ts
```

### 2. Run Complete Production Test Suite

```bash
# Run comprehensive test suite
npx hardhat run scripts/production/RunProductionTests.ts

# Run on specific network
npx hardhat run scripts/production/RunProductionTests.ts --network sepolia

# Generate detailed reports
npx hardhat run scripts/production/RunProductionTests.ts --network mainnet
```

### 3. Test Production Deployment

```bash
# Test deployment script
npx hardhat run scripts/production/DeployProduction.ts --network hardhat

# Deploy to testnet
npx hardhat run scripts/production/DeployProduction.ts --network sepolia
```

## 🧪 Test Scenarios

### 1. Enterprise Corporate Onboarding
- Multi-role key management (CEO, CFO, Compliance Officer)
- Enhanced KYC with corporate data structures
- AML compliance verification
- Enterprise-grade recovery systems
- Regulatory compliance framework setup

### 2. Individual User Journey
- Real cryptographic signature verification
- Biometric simulation and verification
- Multi-signature wallet operations
- Secure key rotation with timelocks
- Personal identity compliance

### 3. Institutional Investor Workflow
- Advanced compliance requirements
- Accreditation verification
- High-value transaction security
- Institutional recovery procedures
- Regulatory reporting compliance

### 4. Emergency Recovery Scenarios
- Multi-party key recovery coordination
- Timelock security mechanisms
- Recovery agent consensus
- Emergency key replacement
- Identity restoration procedures

### 5. Network Stress Testing
- High gas price scenarios
- Network congestion simulation
- Transaction batching optimization
- Mempool management
- Block confirmation delays

### 6. Security Stress Testing
- Multi-vector attack simulation
- Replay attack resistance
- Time-based attack prevention
- Unauthorized access attempts
- Signature forgery protection

## 📊 Performance Metrics

The production tests measure and validate:

### Gas Usage
- Identity deployment: < 3M gas
- Key addition: < 200K gas
- Claim issuance: < 300K gas
- Recovery operations: < 500K gas

### Transaction Costs (at 20 gwei, $2000 ETH)
- Identity creation: ~$1.20
- Key management: ~$0.08
- Claim operations: ~$0.12
- Recovery procedures: ~$0.20

### Performance Thresholds
- Deployment time: < 60 seconds
- Key operations: < 5 seconds
- Claim verification: < 2 seconds
- Recovery initiation: < 10 seconds

## 🔧 Configuration

### Network Configurations

The system supports multiple network configurations:

```typescript
// Mainnet production config
const mainnetConfig = {
    deploymentFee: "0.01", // 0.01 ETH
    recoveryTimelock: 48 * 60 * 60, // 48 hours
    keyRotationTimelock: 24 * 60 * 60, // 24 hours
    maxGasPrice: "100", // 100 gwei max
    minConfirmations: 3
};

// Testnet config (faster for testing)
const testnetConfig = {
    deploymentFee: "0.001", // 0.001 ETH
    recoveryTimelock: 10 * 60, // 10 minutes
    keyRotationTimelock: 5 * 60, // 5 minutes
    maxGasPrice: "50", // 50 gwei max
    minConfirmations: 1
};
```

### Environment Variables

```bash
# Network selection
export HARDHAT_NETWORK=sepolia

# Test configuration
export VERBOSE=true
export GENERATE_REPORTS=true

# Gas optimization
export MAX_GAS_PRICE=50000000000  # 50 gwei
export GAS_LIMIT=5000000

# Security settings
export RECOVERY_TIMELOCK=172800   # 48 hours
export KEY_ROTATION_TIMELOCK=86400 # 24 hours
```

## 📈 Test Reports

The production test suite generates comprehensive reports:

### JSON Report
```json
{
  "timestamp": "2024-01-15T10:30:00.000Z",
  "network": "sepolia",
  "totalTests": 45,
  "passedTests": 45,
  "failedTests": 0,
  "totalDuration": 120000,
  "gasAnalysis": {
    "totalGasUsed": 15000000,
    "averageGasPerTest": 333333,
    "maxGasUsed": 2800000,
    "minGasUsed": 50000
  },
  "recommendations": [
    "All tests passed! System appears ready for production deployment."
  ]
}
```

### HTML Report
Interactive HTML report with:
- Visual test results
- Gas usage charts
- Performance metrics
- Detailed recommendations
- Error analysis

## 🛡️ Security Validation

### Cryptographic Security
- ✅ ECDSA signature verification
- ✅ Message hash integrity
- ✅ Replay attack resistance
- ✅ Signature forgery protection

### Access Control
- ✅ Role-based permissions
- ✅ Multi-signature requirements
- ✅ Timelock mechanisms
- ✅ Recovery procedures

### Attack Resistance
- ✅ Unauthorized key addition
- ✅ Fake claim injection
- ✅ Ownership hijacking
- ✅ Time-based attacks

## 🚨 Emergency Procedures

### Key Compromise Response
1. **Detection**: Monitor for suspicious activities
2. **Isolation**: Prevent further unauthorized access
3. **Recovery**: Initiate multi-party recovery process
4. **Restoration**: Deploy new secure keys
5. **Verification**: Validate system integrity

### System Recovery
1. **Assessment**: Evaluate system state
2. **Coordination**: Engage recovery agents
3. **Execution**: Perform recovery operations
4. **Validation**: Verify successful recovery
5. **Documentation**: Record incident details

## 📋 Pre-Production Checklist

Before mainnet deployment, ensure:

- [ ] All production tests pass (100% success rate)
- [ ] Gas costs are within acceptable limits
- [ ] Security audits completed
- [ ] Recovery procedures tested
- [ ] Performance benchmarks met
- [ ] Documentation updated
- [ ] Monitoring systems ready
- [ ] Emergency procedures documented

## 🔍 Monitoring and Observability

### Key Metrics to Monitor
- Transaction success rates
- Gas usage patterns
- Response times
- Error rates
- Security events

### Alerting Thresholds
- Gas price > 100 gwei
- Transaction failure rate > 1%
- Response time > 30 seconds
- Unauthorized access attempts
- Recovery procedure activations

## 🤝 Contributing

When adding new production tests:

1. Follow the existing test structure
2. Include comprehensive error handling
3. Add performance benchmarks
4. Document security implications
5. Update this README

## 📞 Support

For production environment issues:

1. Check the test reports in `test-reports/production/`
2. Review the production checklist
3. Validate network configuration
4. Check gas price settings
5. Verify contract deployments

## 🔗 Related Documentation

- [Production Checklist](./PRODUCTION_CHECKLIST.md)
- [Security Audit Report](../security/SECURITY_AUDIT.md)
- [Performance Benchmarks](../performance/BENCHMARKS.md)
- [Deployment Guide](../../docs/DEPLOYMENT.md)