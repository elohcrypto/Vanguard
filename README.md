# Vanguard token (VSC): an ERC-3643 security token with OnchainID, list oracles and ZK KYC

## Overview

This project implements the Vanguard token (VSC), an ERC-3643-style
permissioned security token (its own implementation of the `IERC3643`
interface, not the T-REX reference code), with identities and claims on
OnchainID (ERC-734/ERC-735). It is under development and not audited.
VSC is not a stablecoin as coded: nothing in the contracts backs, redeems
or pegs it. The system provides:

- ✅ **Identity and claims**: OnchainID identities, KYC (topic 6) and AML (topic 7) claims from trusted `ClaimIssuer`s, and KeyManager key rotation and agent recovery
- ✅ **Whitelist/blacklist oracles with node consensus** (66% of the registered node weight by default, owner-settable in (50, 100]: two of three equal nodes; never a single node, except a designated emergency node's 7-day CRITICAL listing, renewable, and the OracleManager owner's `emergencyOverride`, which sets the OracleManager result alone; the list oracles apply it only with at least `minimumConsensusOracles` supporting nodes, default 2)
- ✅ **Zero-knowledge proofs** (5 Circom circuits, PLONK); only the whitelist binding gates transfers
- ✅ **Investor types** (Normal, Retail, Accredited, Institutional) with transfer and holding caps, cooldowns and whitelist tiers
- ✅ **One identity, one vote governance**, with VGT paying the proposal and voting fees
- ✅ **Escrow** (one 2-of-3 wallet per payment, with dispute resolution)
- ✅ **Investor custody** (the investor lock moves into an on-chain 2-of-2 `MultiSigWallet`; bank and user both sign to release)
- ✅ **Interactive demo**: 89 numbered options, 117 with their sub-options (1a, 27.5, 33a, 83c, ...)

**Current status**: under development. The contracts, the interactive demo, the tests and CI run end to end on a local Hardhat node; the remaining remediation phases and a third-party security audit come before any production or mainnet use.

> **Building from a fresh clone:** the ZK circuit artifacts are gitignored build output.
> Run `npm run setup:zk` before `npm test`; without the artifacts every suite that
> generates real proofs fails with `ENOENT`.
> `setup:zk` requires the **Rust circom 2.x** compiler (CI uses v2.2.3) — the `circom`
> npm package is the deprecated 0.5.x JS build and cannot compile these circuits. See
> [docs/ZK_CIRCUIT_BUILD_GUIDE.md](docs/ZK_CIRCUIT_BUILD_GUIDE.md).

## 🏗️ Project Structure

```
Vanguard/
├── contracts/                    # Solidity sources
│   ├── onchain_id/              # OnchainID, OnchainIDFactory, ClaimIssuer, KeyManager
│   │   └── interfaces/          # ERC-734, ERC-735, IOnchainID, IClaimIssuer
│   ├── erc3643/                 # Token (VSC), IdentityRegistry, InvestorTypeRegistry
│   │   └── interfaces/          # IERC3643, IIdentityRegistry, ICompliance, IInvestorTypeRegistry
│   ├── compliance/              # ComplianceRules (per-token rules, list gates, trust)
│   │   └── interfaces/          # IComplianceRules, ITrustedContracts
│   ├── oracle/                  # OracleManager, ConsensusOracle, Whitelist/BlacklistOracle
│   │   └── interfaces/          # IOracle, IOracleManager
│   ├── privacy/                 # PrivacyManager, ZKVerifierIntegrated, DynamicListManager
│   │   ├── interfaces/          # IZKVerifier
│   │   └── verifiers/           # Five snarkjs-generated PLONK verifiers
│   ├── investor/                # Custody: InvestorRequestManager, 2-of-2 MultiSigWallet
│   ├── governance/              # GovernanceToken (VGT), VanguardGovernance
│   ├── payment/                 # Escrow factory + one-time 2-of-3 escrow wallets
│   └── test/                    # MockTarget (tests only)
│       └── mocks/               # Test doubles (tests only)
├── circuits/                    # Zero-Knowledge Circuits
│   ├── whitelist_membership.circom          # Whitelist membership proof
│   ├── blacklist_membership.circom          # Blacklist non-membership proof (non-gating, D2)
│   ├── jurisdiction_proof.circom            # Issuer-attested jurisdiction in the allowed set
│   ├── accreditation_proof.circom           # Issuer-attested accreditation >= minimum
│   ├── compliance_aggregation.circom        # Issuer-attested scores meet a weighted minimum
│   ├── attestation.circom                   # Shared EdDSA-Poseidon attestation templates
│   └── merkletree.circom                    # Shared Merkle inclusion template
├── demo/                        # Interactive Demo System
│   ├── core/                    # Menu text and routing, state, deployer
│   ├── modules/                 # Option handlers by area
│   ├── logging/                 # Demo logging utilities
│   ├── utils/                   # The option flows
│   └── index.js                 # Main demo entry point
├── scripts/                     # Deployment & Utility Scripts
│   ├── ci/                      # CI step bodies and gates (.github/workflows/ci.yml)
│   ├── production/              # DeployProduction.ts (+ deploy* modules), RunProductionTests.ts, opsKeyManager.ts, the signer, post-ceremony and check CLIs
│   ├── zk/                      # Whitelist root, proof and attestation CLIs
│   ├── demo-smoke*.js           # Demo smoke test (CI) and its legs
│   ├── demo-drive.sh            # Drives the interactive demo (npm run demo:drive)
│   ├── handover.ts              # Handover ceremony CLI
│   ├── deploy-helpers.ts        # DeploymentHelper (compliance guards)
│   ├── gas-analysis.ts          # Transfer gas table and ratchet (npm run gas:claims)
│   ├── generate-real-proofs.js  # ZK proof generation
│   ├── setup-zk-circuits.js     # Circuit build (npm run setup:zk)
│   └── verify-zk-readiness.js   # Circuit and verifier check (npm run verify:zk)
├── test/                        # Test suite (npm test runs all of test/)
│   ├── ci/                      # Tests of the CI gate scripts
│   ├── circuits/                # ZK circuit tests
│   ├── compliance/              # ComplianceRules tests
│   ├── erc3643/                 # Token, registry and investor-type tests
│   ├── governance/              # Governance tests
│   ├── guards/                  # Guard tests; table/ classifies every require/revert
│   ├── helpers/                 # Shared test helpers
│   ├── integration/             # Integration tests
│   ├── investor/                # Custody (InvestorRequestManager, MultiSigWallet) tests
│   ├── onchain_id/              # OnchainID and KeyManager tests
│   ├── oracle/                  # Oracle tests
│   ├── payment/                 # Escrow tests
│   ├── privacy/                 # Privacy/ZK tests
│   ├── production/              # Production-simulation and handover ceremony tests
│   ├── proof-generation/        # Proof generator tests
│   ├── utils/                   # Utility tests
│   └── *.test.ts                # Individual test files
├── docs/                        # Documentation
│   ├── SYSTEM_OVERVIEW.md                      # System architecture overview
│   ├── NEW_FAIR_VOTING_SYSTEM.md               # Fair voting implementation
│   ├── INVESTOR_TYPE_SYSTEM.md                 # Investor type documentation
│   ├── SYSTEM_WORKFLOW_GUIDE.md                # User workflows and interactions
│   ├── DEEP_DIVE_TRANSFER.md                   # Token, compliance and oracle internals
│   ├── DEEP_DIVE_IDENTITY.md                   # OnchainID, recovery, governance internals
│   ├── DEEP_DIVE_ZK.md                         # The five circuits and their checks
│   ├── TESTNET_SETUP.md                        # Role wallets, time scale, rehearsal, gas
│   ├── TESTNET_DEMO_OPTIONS.md                 # Privacy, custody, oracle, key options
│   ├── TESTNET_CEREMONY.md                     # Handover ceremony, operator rules
│   ├── TESTNET_ZK_CLI.md                       # Whitelist root, proof and attestation CLIs
│   ├── OPERATOR_RUNBOOK.md                     # Operator runbook: index and local rehearsal
│   ├── runbook/                                # Runbook parts (keys, deploy, ceremony, after, operations)
│   ├── rehearsals/                             # Verbatim runbook rehearsal records
│   ├── VOTING_SYSTEM_DIAGRAM.md                # Voting system visualization
│   ├── ZK_CIRCUIT_BUILD_GUIDE.md               # Zero-knowledge circuit build guide
│   └── ZK_CIRCUITS_READINESS.md                # Circuit soundness status
├── utils/                       # Utility Functions
│   ├── merkle-tree-builder.js   # Merkle tree construction
│   ├── smt-builder.js           # Sparse Merkle tree (blacklist proof)
│   └── proof-formatter.js       # ZK proof formatting
├── typechain-types/             # TypeScript contract types (generated, gitignored)
├── hardhat.config.ts            # Hardhat configuration
├── tsconfig.json                # TypeScript configuration
├── foundry.toml                 # Foundry configuration
└── package.json                 # Project dependencies
```

## 📚 Documentation

- [System Overview](/docs/SYSTEM_OVERVIEW.md) - Architecture, components, contracts
- [System Workflow Guide](/docs/SYSTEM_WORKFLOW_GUIDE.md) - Workflows with the demo option for each step
- [Testnet Setup](/docs/TESTNET_SETUP.md) - Role wallets from one mnemonic, governance time scale, local rehearsal
- [Testnet Demo Options](/docs/TESTNET_DEMO_OPTIONS.md) - Privacy, custody, oracle and identity-key options on a live node
- [Handover Ceremony](/docs/TESTNET_CEREMONY.md) - The handover ceremony and the operators' rules; [ZK command lines](/docs/TESTNET_ZK_CLI.md)
- [Operator Runbook](/docs/OPERATOR_RUNBOOK.md) - The ordered deploy, ceremony and operations procedure, Sepolia path included
- Technical deep dive: [transfer path](/docs/DEEP_DIVE_TRANSFER.md), [identity, recovery and governance](/docs/DEEP_DIVE_IDENTITY.md), [ZK circuits](/docs/DEEP_DIVE_ZK.md)
- [New Fair Voting System](/docs/NEW_FAIR_VOTING_SYSTEM.md) and [Voting System Diagram](/docs/VOTING_SYSTEM_DIAGRAM.md)
- [Investor Type System](/docs/INVESTOR_TYPE_SYSTEM.md) - Caps, cooldowns, tiers, custody
- [ZK Circuit Build Guide](/docs/ZK_CIRCUIT_BUILD_GUIDE.md) and [ZK Circuits Readiness](/docs/ZK_CIRCUITS_READINESS.md)

## 🛠️ Quick Start

### Prerequisites

- Node.js 20, 22 or 24 (the `engines` range in package.json; CI uses 22) and npm; Hardhat and snarkjs come with `npm install`
- Rust circom 2.x on `PATH` (or `CIRCOM_BIN`) for `npm run setup:zk`

### Installation

```bash
git clone <repository-url>
cd Vanguard
npm install
npx hardhat compile
npm run setup:zk             # builds the circuits (required before npm test; build/ is gitignored)
```

### NPM scripts

```bash
npm run compile                 # Compile smart contracts
npm test                        # Run all tests
npm run test:coverage           # All tests under solidity-coverage
npm run test:gas                # Tests with the gas reporter
npm run gas:claims              # Transfer gas table (scripts/gas-analysis.ts)
npm run node                    # Start a local Hardhat node
npm run demo:interactive:proof  # The interactive demo, against the local node
npm run demo:drive -- <choices> # Drive the demo without a terminal
npm run setup:zk                # Build the circuits
npm run verify:zk               # Check circuits and committed verifiers
npm run lint                    # solhint
npm run clean                   # Clean build artifacts
```

### Running the interactive demo

```bash
npm run node                    # terminal 1
npm run demo:interactive:proof  # terminal 2
```

The menu covers onboarding (KYC/AML claims), identity keys and recovery,
ComplianceRules, the token, oracles and consensus, privacy and ZK proofs,
investor types and custody, escrow, governance (including cost changes by
proposal, option 83a, and the handover ceremony, 83c-83e) and dynamic
lists.

### Running tests

```bash
npm test                                       # every suite under test/
npx hardhat test test/GovernanceSystem.test.ts # one file
npm run test:coverage                          # coverage (sets DEPLOY_GAS_LIMIT for instrumented code)
```

## 🎯 Key Features

### Identity & compliance

- **OnchainID (ERC-734/735)**: keys and claims; `ClaimIssuer` signatures cover `claimDigest` (chain id, issuer, revocation epoch, identity, topic, scheme, data, uri, validTo) and a revocation voids every earlier signature for that identity and topic (Task 5.2). `IdentityRegistry.isVerified` asks each trusted issuer, with each call bounded to 45,000 gas and one return word (`BoundedStaticCall`, Task 5.1)
- **KeyManager**: timelocked rotation for identities that authorize it; agent recovery (threshold at least 2) for identities that pin it as their recovery manager
- **ComplianceRules**: per-token jurisdiction rules, blacklist and whitelist gates (oracle or ZK binding), and per-token trusted contracts; investor-type caps live in `InvestorTypeRegistry`, which the token enforces

### Oracles

- **Whitelist** tiers 1-5 and **blacklist** severities LOW to CRITICAL, written by consensus verdicts, governance ListUpdate votes (DynamicListManager) or the list oracles' owner
- **Weighted consensus**: a side needs 66% (the default; the owner sets it in (50, 100]) of the weight of every node registered when the query opened; a query no single node can resolve alone (`SingleNodeQuorum`) and a verdict a list oracle applies only with at least 2 supporting nodes (`TooFewVoters`) (Task 5.1). Reputation is owner-set and gates a node's unpause; it does not weight votes
- **Owner writes**: ops, as the list oracles' owner after the handover, can write any tier (5 included) or severity (CRITICAL included) directly, without consensus; a consensus verdict's severity only sets the listing's duration. The list-oracle ownership posture is an audit item (D44 a)
- **Emergency listing**: any designated emergency node, alone, may list CRITICAL for 7 days, renewable by listing again (`emergencyBlacklist`); the OracleManager owner may also set the OracleManager result of a query alone (`emergencyOverride`), but a list oracle applies that result only when at least `minimumConsensusOracles` nodes (default 2, never below 2) voted that side (`TooFewVoters`)
- **Fail closed**: ComplianceRules calls the oracles without a fallback, so an oracle that reverts makes the transfer revert (fail closed). Unbinding an oracle removes its gate until a working one is rebound: with no blacklist oracle nobody is sanctions-checked; OracleOnly with no whitelist oracle passes every party; Either with no whitelist oracle falls back to the ZK binding alone. The remedy for a failing oracle is rebinding a working one (or pausing the token), not unbinding

### Privacy & zero-knowledge

- **5 ZK circuits** (PLONK, universal setup): whitelist, blacklist, jurisdiction, accreditation, compliance aggregation
- **What stays private**: which identity on the whitelist a wallet belongs to (each leaf is a commitment `Poseidon(identity, secret)`), and the attested attributes (an issuer-signed jurisdiction, accreditation amount or compliance scores, proved against a policy). The prover's wallet is public: ERC-3643 transfers name it and every proof binds it (`walletBinding`).
- **What gates transfers**: only the whitelist binding (`PrivacyManager.hasValidWhitelistProof`), read by `ComplianceRules` when a token's whitelist mode is ZkOnly or Either. In Either with a bound whitelist oracle, a party with no live entry passes by a ZK binding only if its type requires tier 1 (D46 a: a proof carries no tier); Either with no oracle bound acts as ZkOnly. The attestation records are read through `validatePrivate*` (state-changing only to emit `PrivateComplianceValidated`), which nothing on the transfer path calls, and the blacklist proof gates nothing; sanctions are enforced by the blacklist oracle.

### Investor types and custody

- **4 investor types**: Normal (0), Retail (1), Accredited (2), Institutional (3)
- **Caps** (defaults): per transfer 8,000 / 8,000 / 50,000 / 500,000 VSC, holding 50,000 / 50,000 / 500,000 / 5,000,000 VSC
- **Whitelist tiers** 1/2/3/4: ComplianceRules refuses a party whose whitelist oracle entry tier is below its type's (OracleOnly, or Either with an entry; D46 a above for Either without one; not applicable in ZkOnly) (D37 = a, Task 4.10)
- **Cooldowns** 60/60/30/15 minutes: Token refuses a sender inside its cooldown ("Transfer cooldown"); the registry writes each sender's clock only for a token it authorized
- **Large-transfer threshold**: stored per type and readable with `isLargeTransfer` (a view; nothing emits or notifies)
- **Custody**: `InvestorRequestManager` deploys a 2-of-2 `MultiSigWallet` per request; the lock is a token transfer into it, at most the Normal cap (`LockAboveNormalCap`), released only by bank + user

### Governance

- **1 identity = 1 vote**: equal votes for verified identities at least `minVoterAge` old; VGT delegation is recorded, not counted (D12)
- **VGT fees**: 10 VGT to create a proposal, 10 VGT per vote (owner-adjustable above 0 and up to 1,000 VGT)
- **Deposits**: passed proposals burn them; rejected or cancelled ones make them claimable per identity, by a wallet the registry binds to it and that controls it (Task 5.2), or, for an identity no wallet is bound to (deleted), by a wallet that controls it (`claimRefundFor`, Task 5.17)
- **Per-type thresholds**: quorum 10-30% of the identities registered at the voter-age cutoff, approval 60-75%
- **Proposer restriction**: a proposer's identity never votes on its own proposal

### Escrow

- **2-of-3, explicit direction**: the investor signs with the payee (release) or the payer (refund); the matching counterparty signature must already be there, it is never inferred from who signed first. Before a shipment proof, or in a dispute, the investor may refund alone (`manualRefund`)
- **One-time-use wallets**: one escrow wallet per payment, funded once through the factory (`EscrowAlreadyFunded` on a second attempt)
- **Shipment proof**: signed by the payee and bound to the escrow address and chain id, so it cannot be replayed; opens the 14-day dispute window
- **Dispute resolution**: the payer may dispute within the window; the investor refunds or reopens with all signatures cleared
- **Fees**: fixed at creation (3% investor, 2% owner), paid on release and recorded per investor in the factory (`getInvestorProfile().totalFeesEarned`); the investor fee can be routed to the investor's 2-of-2 `MultiSigWallet`
- **Trust by registrar**: the factory is a ComplianceRules registrar on VSC and trusts each escrow it deploys; a registrar may trust only accounts with the compiled `MultiSigEscrowWallet` (or, for `InvestorRequestManager`, `MultiSigWallet`) code hash
- **Sweep**: tokens sent to a settled escrow outside the factory are returned by `sweepExcess()` (demo option 70a)
- Step by step, with the demo option for each step: [Escrow Payment Workflow](/docs/SYSTEM_WORKFLOW_GUIDE.md#escrow-payment-workflow)

### Token lifecycle

- **Agent-only mint and burn**: every mint is checked like a transfer to the recipient (identity, ComplianceRules, holding cap); a burn needs free (unfrozen) balance and is not gated by ComplianceRules
- **Pause**: by the owner or the guardian; unpause by the owner. On VGT an agent (ops) may also unpause, and the guardian can pause again after a voted unpause; a pause has no expiry (D56; an audit item)

## 🔒 Security

- **Access control**: owner, agent, operator and registrar roles per contract; the handover ceremony moves ownership to governance and the operational roles to ops (docs/TESTNET_CEREMONY.md)
- **Reentrancy**: `ReentrancyGuard` on the contracts that move tokens or call out (governance, custody, escrow, ClaimIssuer, KeyManager, OracleManager, the list oracles, PrivacyManager, ZKVerifierIntegrated), not on every function: `MultiSigWallet.proposeUnlock`, `signUnlock` (its execution leg is guarded) and `cancelProposal`, and `InvestorRequestManager.rejectRequest` and `updateLockRequirement`, have none, nor do Token, IdentityRegistry, InvestorTypeRegistry, ComplianceRules, OnchainID (it marks an execution done before its call), OnchainIDFactory, ConsensusOracle and DynamicListManager
- **Guards**: every `require`/`revert` in `contracts/` is classified (tested or unreachable) in `test/guards/table/`, checked in CI by `scripts/ci/guards-table.js`
- **No proxies**: a component is replaced by redeploying it and re-pointing its owner-only setters
- **Not audited**: a third-party audit is pending

## 📈 Testing and CI

CI (`.github/workflows/ci.yml`) runs eight jobs, tests and coverage in
two shards each: compile; tests (with the transfer gas ratchet);
guard-runs (every tested guard row bound to a test that passed);
coverage and coverage-merge (merged line coverage may not drop below the
recorded baseline; an overall branch baseline and per-contract branch
floors in `scripts/ci/branch-floors.json`; a near-timeout guard flags
slow tests); zk-coverage; demo (smoke, ceremony, production deploy,
multisig and regression drives on a node); and gates (line count, docs,
deleted names, scripts reachable, guard table, lint and audit ratchets).
The docs gate checks structure and existence (closed fences, this
README's tree, links and anchors, demo option numbers, cited script
paths and commands), not whether prose or quoted output is true; that
comes from the verbatim rehearsals of the
[operator runbook](docs/OPERATOR_RUNBOOK.md) (`docs/rehearsals/`). Step
bodies live in `scripts/ci/`.

## 📄 License

MIT License (the `license` field of package.json; the repository has no LICENSE file)

## 🎯 Project Status

**Current phase**: remediation plan v2, Phases 0 to 4 done; Phase 5 in progress (see the plan for the task status), then the Sepolia rehearsal of the production deploy through an external signer (5.8; the tooling is built, Tasks 5.7 and 5.15) and the audit package. Mainnet is Phase 6.

- **Smart contracts**: 26 deployable contracts (21 written, 5 generated PLONK verifiers), implemented and tested locally, not audited
- **Not done**: security audit, testnet and production deployment, gas optimisation beyond the transfer-path ratchet, monitoring

This is not production software yet: the remaining remediation phases and a third-party security audit come before any mainnet deployment.
