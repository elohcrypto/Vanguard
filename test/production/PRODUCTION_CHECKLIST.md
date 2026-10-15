# 🚀 Production Deployment Checklist (template)

A template for the checks before a production deploy. Nothing here is checked by code; a box is ticked by the people doing the deploy. `scripts/production/DeployProduction.ts` deploys the whole stack through an external signer and writes the handover ceremony's config (docs/OPERATOR_RUNBOOK.md, section 2); the ceremony itself is docs/TESTNET_CEREMONY.md.

## 📋 Pre-Deployment Validation

### ✅ Code Quality & Testing

- [ ] **All tests**: the whole suite passes

  ```bash
  npm test
  ```

- [ ] **Integration Tests**: test/integration passes

  ```bash
  npx hardhat test test/integration/*.test.ts test/integration/*.test.js
  ```

- [ ] **Production Simulation**: the three production suites pass

  ```bash
  npx hardhat test test/production/Production*.test.ts
  ```

- [ ] **Guards**: every require/revert classified (`node scripts/ci/guards-table.js`; guard tests in test/guards/)

- [ ] **Code Coverage**: no drop below the CI line baseline and the per-contract branch floors (`scripts/ci/coverage-ratchet.sh`, `scripts/ci/branch-floors.json`)
  ```bash
  npm run test:coverage
  ```

### ✅ Security Validation

- [ ] **Smart Contract Audit**: Professional security audit completed
  - [ ] Audit report reviewed and approved
  - [ ] All critical and high-severity issues resolved
  - [ ] Medium-severity issues addressed or accepted

- [ ] **Cryptographic Security**: Signature verification validated
  - [ ] ECDSA signature implementation verified
  - [ ] Message hash integrity confirmed
  - [ ] Replay attack resistance tested
  - [ ] Signature forgery protection validated

- [ ] **Access Control**: Permission systems validated
  - [ ] Role-based access control tested
  - [ ] Multi-signature requirements verified
  - [ ] Timelock mechanisms validated
  - [ ] Recovery procedures tested

- [ ] **Attack Resistance**: Security stress tests passed
  - [ ] Unauthorized key addition blocked
  - [ ] Fake claim injection prevented
  - [ ] Ownership hijacking blocked
  - [ ] Time-based attacks mitigated

### ✅ Performance & Gas Optimization

- [ ] **Gas and performance**: the production suite asserts identity
      deployment under 30 s and `addKey` under 200,000 gas and under $10
      (ProductionResilience); other figures are logged, not asserted. The
      transfer-path gas ratchet runs in CI (`npm run gas:claims`).

### ✅ Network & Infrastructure

- [ ] **Network Configuration**: Production settings validated
  - [ ] Mainnet RPC endpoints configured
  - [ ] Gas price strategy defined
  - [ ] Confirmation requirements set
  - [ ] Fallback providers configured

- [ ] **Deployment Scripts**: Production deployment tested

  ```bash
  OPS_IDENTITY=<ops OnchainID> SIGNER_RPC_URL=<signer endpoint> DEPLOY_CONFIG=<deploy.json> npx hardhat run scripts/production/DeployProduction.ts --network remote
  ```
  - [ ] KeyManager authorized on the ops identity: the deploy sends
        `authorizeManager(KeyManager)` itself only when the deploying
        wallet owns the ops identity; otherwise (or with `OPS_IDENTITY`
        unset) it prints `OnchainID(<ops identity>).authorizeManager(<keyManager>)`,
        which the ops identity's owner must send
  - [ ] KeyManager pinned as the ops identity's recovery manager: the
        deploy pins it when the deploying wallet owns the identity,
        prints the `pinRecoveryManager` call for another owner, and
        refuses an identity already pinned to another manager

- [ ] **Contract Verification**: Source code verification ready
  - [ ] Etherscan API key configured
  - [ ] Verification scripts tested
  - [ ] Constructor parameters documented

- [ ] **Monitoring Setup**: Observability systems ready
  - [ ] Transaction monitoring configured
  - [ ] Gas price alerts set up
  - [ ] Error tracking implemented
  - [ ] Performance metrics collection ready

### ✅ Operational Readiness

- [ ] **Key Management**: Production keys secured
  - [ ] Deployer private key secured (hardware wallet/HSM)
  - [ ] Multi-signature setup for admin functions
  - [ ] Recovery agent keys distributed securely
  - [ ] Key rotation procedures documented

- [ ] **Service Providers**: External integrations ready
  - [ ] KYC provider integration tested
  - [ ] AML service provider configured
  - [ ] Compliance service endpoints validated
  - [ ] API rate limits and authentication set up

- [ ] **Emergency Procedures**: Incident response ready
  - [ ] Emergency contact list prepared
  - [ ] Recovery procedures documented
  - [ ] Rollback procedures defined
  - [ ] Communication plan established

### ✅ Documentation & Compliance

- [ ] **Technical Documentation**: Complete and up-to-date
  - [ ] API documentation generated
  - [ ] Integration guides written
  - [ ] Deployment instructions documented
  - [ ] Troubleshooting guides prepared

- [ ] **Legal & Compliance**: Regulatory requirements met
  - [ ] Legal review completed
  - [ ] Privacy policy updated
  - [ ] Terms of service finalized
  - [ ] Regulatory compliance verified

- [ ] **User Documentation**: End-user guides ready
  - [ ] User onboarding guides
  - [ ] Identity management instructions
  - [ ] Recovery procedure guides
  - [ ] FAQ documentation

## 🔧 Production Configuration Validation

### Deploy settings (scripts/production/DeployProduction.ts)

- No identity fee; gas price and limits from the signer; 1 confirmation
  per transaction on a dev chain, 3 elsewhere (`confirmations` in the
  config); about 64.3 M gas in all.
- Timelocks are on chain, not configuration: `RECOVERY_TIMELOCK` is a
  48-hour constant; the rotation timelock defaults to 24 hours and an
  identity may set 1 hour to 7 days (`setCustomTimelock`).

### Environment variables the code reads

```bash
SIGNER_RPC_URL=...      # the external signer (network remote); no MNEMONIC / PRIVATE_KEY
DEPLOY_CONFIG=...       # DeployProduction: roles, nodes, lock amounts, attestor key
OPS_IDENTITY=0x...      # DeployProduction: the ops OnchainID
MAINNET_RPC_URL=...     # or SEPOLIA_RPC_URL (other scripts)
ETHERSCAN_API_KEY=...
```

## 🚨 Final Pre-Deployment Steps

### 1. Final Test Run

```bash
# Run the production test set on the in-process network: test/integration
# (listed with fs) and the three Production*.test.ts suites. The runner
# refuses any network but hardhat/localhost and deploys nothing; a
# live-network rehearsal is the deploy script below plus the handover
# ceremony (docs/TESTNET_CEREMONY.md)
npx hardhat run scripts/production/RunProductionTests.ts

# Verify all tests pass
echo "✅ All tests must pass before proceeding"
```

### 2. Gas Price Check

```bash
# Check current mainnet gas prices
curl -s "https://api.etherscan.io/api?module=gastracker&action=gasoracle&apikey=YOUR_API_KEY"

# Ensure gas prices are reasonable for deployment
echo "⛽ Current gas price should be < 50 gwei for deployment"
```

### 3. Final Security Review

- [ ] Review all contract addresses
- [ ] Verify deployer account balance
- [ ] Confirm multi-signature setup
- [ ] Validate recovery agent addresses

### 4. Deployment Execution

```bash
# Deploy to mainnet (FINAL STEP)
SIGNER_RPC_URL=<signer endpoint> DEPLOY_CONFIG=<deploy.json> npx hardhat run scripts/production/DeployProduction.ts --network remote

# Verify deployment
npx hardhat verify --network mainnet FACTORY_ADDRESS "CONSTRUCTOR_ARGS"
```

## 📊 Post-Deployment Validation

### Immediate Checks (0-1 hour)

- [ ] All contracts deployed successfully
- [ ] Contract verification completed on Etherscan
- [ ] Basic functionality tests pass
- [ ] Monitoring systems active

### Short-term Validation (1-24 hours)

- [ ] First identity deployments successful
- [ ] Gas usage within expected ranges
- [ ] No security alerts triggered
- [ ] Performance metrics normal

### Long-term Monitoring (24+ hours)

- [ ] System stability confirmed
- [ ] User adoption metrics tracked
- [ ] Cost analysis completed
- [ ] Feedback collection initiated

## 🔄 Rollback Procedures

If issues are discovered post-deployment:

### Immediate Actions

1. **Pause Operations**: Use emergency pause if available
2. **Assess Impact**: Determine scope of the issue
3. **Communicate**: Notify stakeholders immediately
4. **Document**: Record all relevant information

### Recovery Options

1. **Hot Fix**: Deploy corrected contracts if possible
2. **Migration**: Move to new contract system
3. **Rollback**: Revert to previous stable version
4. **Manual Recovery**: Individual account recovery

## ✅ Sign-off Requirements

Before mainnet deployment, obtain sign-off from:

- [ ] **Technical Lead**: Code quality and architecture
- [ ] **Security Team**: Security audit and validation
- [ ] **DevOps Team**: Infrastructure and monitoring
- [ ] **Product Team**: Feature completeness and UX
- [ ] **Legal Team**: Compliance and regulatory approval
- [ ] **Executive Team**: Business approval and go-live

## 📞 Emergency Contacts

### Technical Team

- **Lead Developer**: [contact info]
- **Security Engineer**: [contact info]
- **DevOps Engineer**: [contact info]

### Business Team

- **Product Manager**: [contact info]
- **Legal Counsel**: [contact info]
- **Executive Sponsor**: [contact info]

### External Partners

- **Security Auditor**: [contact info]
- **Infrastructure Provider**: [contact info]
- **Legal Advisor**: [contact info]

---

## 🎯 Final Checklist Summary

**CRITICAL**: All items must be checked before mainnet deployment.

**Final Approval**:

- [ ] All checklist items completed
- [ ] All stakeholders have signed off
- [ ] Emergency procedures are in place
- [ ] Monitoring systems are active

**Deployment Authorization**:

- [ ] **GO/NO-GO Decision**: ✅ GO / ❌ NO-GO
- [ ] **Authorized By**: [Name, Title, Date]
- [ ] **Deployment Date**: [Scheduled Date/Time]

---

_This checklist should be reviewed and updated regularly to reflect current best practices and lessons learned from previous deployments._
