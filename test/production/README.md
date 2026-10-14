# Production-simulation and handover-ceremony tests

Tests that rehearse production conditions on the local Hardhat network:
the identity side's production deploy, onboarding and resilience
simulations, the custody flow, and the handover ceremony (preflight,
window scan, completion). Nothing here runs against a public network.

## Files

```
test/production/
├── ProductionEnvironment.ts      # Simulation environment (deploys its own fixture)
├── ProductionUtils.ts            # Helpers, the simulation's start and finish
├── ProductionOnboarding.test.ts  # Corporate, individual and institutional onboarding
├── ProductionResilience.test.ts  # Recovery, congestion, performance, security probes
├── ProductionDeployOps.test.ts   # DeployProduction's ops-identity step
├── OpsKeyManager.test.ts         # scripts/production/opsKeyManager.ts
├── Onboard.test.ts               # The shared onboarding helper
├── CustodyFlow.test.ts           # Custody (InvestorRequestManager, MultiSigWallet)
├── GovernedCalls.test.ts         # Calls governance makes after the handover
├── deployHandoverFixture.ts      # The ceremony fixture
├── Handover*.test.ts             # The ceremony: preflight, steps, window, completion, CLI
├── PRODUCTION_CHECKLIST.md       # Pre-deployment checklist (a template)
└── README.md                     # This file
```

## Running

```bash
# The three production-simulation suites
npx hardhat test test/production/Production*.test.ts

# Everything in this directory runs with the rest of the suite
npm test

# test/integration plus the three Production*.test.ts suites, with a JSON
# summary in test-reports/production/. Local only: it refuses any network
# but hardhat/localhost, deploys nothing itself and runs the suites on the
# in-process network (plan v2 Task 4.13, D48).
npx hardhat run scripts/production/RunProductionTests.ts
```

The summary file is
`{ "timestamp": ..., "results": [{ "name", "passed", "failed", "pending", "exitCode", "seconds" }] }`;
there is no HTML report.

```bash
# The production deploy script on the in-process network
npx hardhat run scripts/production/DeployProduction.ts --network hardhat
```

`DeployProduction.ts` deploys the identity side (KeyManager, claim
issuers, IdentityRegistry, ComplianceRules, OnchainIDFactory), not the
token, custody, governance or the ceremony. A testnet deploy with
external signers is Phase 5 Task 5.7 (not done).

## What the simulation covers

- Onboarding with real signatures: corporate (several keys), individual
  and institutional identities, KYC and AML claims
- Key rotation through KeyManager and agent recovery
- Congestion: transactions at a 100 gwei gas price
- Security probes: an unauthorized key addition, a fake claim and an
  ownership takeover are attempted; the test asserts only that at least
  one is refused (each guard is tested on its own in test/onchain_id and
  test/guards)

Asserted thresholds (ProductionResilience): identity deployment under
30 s, `addKey` under 200,000 gas and under $10. Other timings, gas and
costs are logged, not checked.

## Timelocks are on chain, not configuration

The recovery timelock is the constant `RECOVERY_TIMELOCK` (48 hours).
The rotation timelock defaults to 24 hours (`DEFAULT_TIMELOCK`) and an
identity may set 1 hour to 7 days for itself (`setCustomTimelock`). No
environment variable or config file changes either.

## Environment variables the code reads

`MNEMONIC` or `PRIVATE_KEY` (signers), `SEPOLIA_RPC_URL` /
`MAINNET_RPC_URL`, `ETHERSCAN_API_KEY` (hardhat.config.ts),
`DEPLOY_GAS_LIMIT` and `OPS_IDENTITY` (DeployProduction.ts).

## Related

- [Production Checklist](./PRODUCTION_CHECKLIST.md)
- [Handover Ceremony](../../docs/TESTNET_CEREMONY.md)
- [Testnet Setup](../../docs/TESTNET_SETUP.md)
