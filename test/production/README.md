# Production-simulation and handover-ceremony tests

Tests that rehearse production conditions on the local Hardhat network:
the production deploy's inputs and record, onboarding and resilience
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
├── ProductionSigner.test.ts      # scripts/production/signer.js end to end
├── Signer*.test.ts               # The signer: prompt, nonce record, bump, retry, token guard
├── DeployConfig.test.ts          # Deploy inputs, key refusals, CLI refusals
├── DeployRecord*.test.ts         # The deploy record: resume, replay, tamper, stale pending
├── DeployFrontRun.test.ts        # A front-run deploy transaction
├── DeployRolePause.test.ts       # Multisig roles: the deploy's pause and effect checks
├── DevChainGuards.test.ts        # Dev-chain-only refusals; LiveKeys.test.ts, CliGuards.test.ts
├── WalletPins*.test.ts           # The handover.json "accounts" pins
├── Rpc*.test.ts                  # rpc-check, RPC credentials, RPC retry
├── ScanCount.test.ts             # The scan cross-check; CostTable.test.ts, the budget table
├── PostCeremony*.test.ts         # Post-ceremony votes, removal hazards, pending senders
├── OracleRotation.test.ts        # Node rotation by vote after the ceremony
├── ClaimSigners.test.ts          # The claim-signer CLI
├── OpsKeyManager.test.ts         # scripts/production/opsKeyManager.ts
├── Onboard.test.ts               # The shared onboarding helper
├── CustodyFlow.test.ts           # Custody (InvestorRequestManager, MultiSigWallet)
├── GovernedCalls.test.ts         # Calls governance makes after the handover
├── *ProposalFlow.test.ts         # The demo's vote and execute flows; ProposeAfterCeremony,
│                                 #   RoleCallsValues, ZkCliChain .test.ts
├── deployHandoverFixture.ts      # The ceremony fixture
├── Handover*.test.ts             # The ceremony: preflight, steps, window, completion, CLI
├── PRODUCTION_CHECKLIST.md       # Pre-deployment checklist (a template)
└── README.md                     # This file
```

## Running

```bash
# The four Production*.test.ts suites (simulation, ops step, signer)
npx hardhat test test/production/Production*.test.ts

# Everything in this directory runs with the rest of the suite
npm test

# test/integration plus ProductionOnboarding, ProductionResilience and
# ProductionDeployOps, with a JSON
# summary in test-reports/production/. Local only: it refuses any network
# but hardhat/localhost, deploys nothing itself and runs the suites on the
# in-process network (plan v2 Task 4.13, D48).
npx hardhat run scripts/production/RunProductionTests.ts
```

The summary file is
`{ "timestamp": ..., "results": [{ "name", "passed", "failed", "pending", "exitCode", "seconds" }] }`;
there is no HTML report.

`scripts/production/DeployProduction.ts` (Task 5.7) deploys the whole
stack through an external signer, records it in
`deployments/<chainId>.json` and writes the ceremony's handover.json;
`scripts/ci/deploy-drive.sh` runs it end to end on a local node with a
second process as the signer. The commands:
[OPERATOR_RUNBOOK](../../docs/OPERATOR_RUNBOOK.md), section 2.

## What the simulation covers

- Onboarding with real signatures: corporate (several keys), individual
  and institutional identities, KYC and AML claims
- Key rotation through KeyManager and agent recovery
- Congestion: transactions at a 100 gwei gas price
- Security probes: a stranger's MANAGEMENT key and ownership takeover
  are refused with their reasons; a self-issued claim lands in the
  identity's list but verifies nobody (`isVerified` asks the trusted
  issuers), while an identity with both trusted claims verifies

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
`MAINNET_RPC_URL`, `ETHERSCAN_API_KEY`, `SIGNER_RPC_URL` (the `remote`
network; hardhat.config.ts), `DEPLOY_GAS_LIMIT` (ProductionEnvironment),
`DEPLOY_CONFIG`, `DEPLOY_RECORD`, `HANDOVER_CONFIG` and `OPS_IDENTITY`
(DeployProduction.ts, which refuses `MNEMONIC` / `PRIVATE_KEY`). The
signer and the other production CLIs read their own (`SIGNER_*`,
`RPC_CHECK_URLS*`, `NEW_NODES`, `CLAIM_SIGNERS`, `SCAN_*`): the runbook.

## Related

- [Production Checklist](./PRODUCTION_CHECKLIST.md)
- [Handover Ceremony](../../docs/TESTNET_CEREMONY.md)
- [Testnet Setup](../../docs/TESTNET_SETUP.md)
