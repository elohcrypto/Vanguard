# Vanguard token (VSC) - System Overview

## Summary

VSC is an ERC-3643-style permissioned security token (its own
implementation of the `IERC3643` interface, not the T-REX reference code)
with OnchainID identities, KYC/AML claims, list oracles with node
consensus, a ZK allow list, investor types, custody and escrow wallets and
one-identity-one-vote governance. It is not a stablecoin as coded: nothing
in the contracts backs, redeems or pegs it. The system is under
development and not audited; it runs end to end on a local Hardhat node
(contracts, the interactive demo, the tests and CI).

## Architecture

```
Token (VSC) transfer / mint
  ├─ IdentityRegistry.isVerified(party)  ── asks each trusted ClaimIssuer
  │                                         about the party's OnchainID
  ├─ ComplianceRules.canTransfer(token,…)
  │    ├─ BlacklistOracle            (list writes: owner, DynamicListManager
  │    ├─ WhitelistOracle  (by mode)  votes, OracleManager + ConsensusOracle
  │    ├─ PrivacyManager   (by mode)  verdicts)
  │    └─ country rule, trusted contracts per token
  └─ InvestorTypeRegistry: authorization, transfer cap, cooldown, holding cap

VanguardGovernance (fees in VGT) owns the core contracts after the handover
ceremony; ops holds the agent roles and the list oracles; KeyManager
recovers identities.
```

## Components

### 1. Identity (OnchainID, ERC-734/735)

- `OnchainIDFactory` deploys identities with CREATE2; `ClaimIssuer` issues
  and revokes KYC (topic 6) and AML (topic 7) claims. A claim's signature
  covers `claimDigest` (chain id, issuer, revocation epoch, identity,
  topic, scheme, data, uri, validTo; Task 5.2); a revocation bumps the
  epoch. `IdentityRegistry.isVerified` asks each trusted issuer, never the
  identity's own claim list, and can cache a passing walk for 24 hours
  (capped at the claims' expiry).
- `KeyManager` rotates keys behind a timelock and recovers an identity
  through seated agents (threshold at least 2) after 48 hours, with an
  owner transfer at 7 days (docs/DEEP_DIVE_IDENTITY.md).
- Events record issuance and revocation; the demo also records
  rejections. Demo options 2-12b.

### 2. Token (VSC, ERC-3643)

- Mint and burn are agent only (the deployer before the handover, ops
  after it). Burn needs free balance and is never gated by compliance.
- Every transfer checks freezes, both parties' verification, the free
  balance, `ComplianceRules.canTransfer` and, with an InvestorTypeRegistry
  bound, the registry's authorization, the sender's per-transfer cap and
  cooldown and the recipient's holding cap.
- The guardian can pause; unpause is the owner's (governance after the
  handover). The guardian can pause again after a voted unpause and a
  pause has no expiry (D56; pause expiry is an audit item).
- Demo options 21-30.

### 3. ComplianceRules (per token)

- Blacklist oracle gate on every path but burn; whitelist gate by mode
  (OracleOnly, ZkOnly, Either); a party passing by its oracle entry needs
  its investor type's whitelist tier (D37 a); in Either with an oracle
  bound, a party with no entry passes on a ZK binding only if its type
  requires tier 1 (D46 a).
- A country rule per token (`setJurisdictionRule`); the default blocked
  list always applies. Demo default: allowed 840, 826, 124, 276, 250, 392,
  702, 36, 344, 756; blocked 156 (China), 643 (Russia), 408 (North
  Korea), 364 (Iran) and 760 (Syria).
- Trusted contracts per token, added by the owner or by a registrar for
  one runtime code hash. The investor-type, holding-period and
  compliance-level rules ComplianceRules once stored were removed in Task
  4.1 (no transfer read them).
- Demo options 13-14 and 18-20a (15-17 and 20b-20d show the
  InvestorTypeRegistry).

### 4. Oracles (OracleManager, ConsensusOracle, list oracles)

- Whitelist tiers 1-5; blacklist severities LOW, MEDIUM, HIGH, CRITICAL.
- A verdict needs 66% of the registered node weight by default (two of
  three equal nodes; the owner sets the threshold in (50, 100]). A query opens only with at least two registered nodes and no
  single node meeting the bar; a list oracle applies a verdict only when
  at least two distinct nodes voted its way (Task 5.1).
- Nodes raise tiers 1-4 and severities up to HIGH; only the OracleManager
  owner raises tier 5 or CRITICAL. The list oracles' own owner (ops after
  the handover) writes any entry directly, with no vote (D44 a; the
  ownership posture is an audit item). Never a single node, except a
  designated emergency node's CRITICAL listing (7 days, renewable by
  listing again) and the OracleManager owner's `emergencyOverride`, which
  flips the recorded verdict alone; the list oracles apply it only with
  at least two supporting nodes (`TooFewVoters`).
- The blacklist gates VSC once bound (`setBlacklistOracle`); the whitelist
  once bound (option 38a, or a ComplianceRules vote after the handover).
- Demo options 31-40.

### 5. Privacy (PLONK, five Circom circuits)

- Whitelist membership: a wallet proves it holds a commitment in the
  published root without revealing which identity's; the binding is the
  only proof any transfer reads (by whitelist mode).
- Blacklist non-membership: a demonstration; nothing on chain gates on it
  (D2).
- Jurisdiction, accreditation and compliance aggregation: issuer-signed
  attestations (D31 a) recorded by PrivacyManager and read by the
  `validatePrivate*` functions; no transfer checks them.
- Demo options 41-50.

### 6. Investor types and custody

- Four types; per-transfer caps 8,000 (Normal, Retail), 50,000
  (Accredited), 500,000 (Institutional) VSC; holding caps 50,000 / 50,000
  / 500,000 / 5,000,000; cooldowns 60 / 60 / 30 / 15 minutes; required
  whitelist tiers 1 / 2 / 3 / 4 (defaults in InvestorTypeRegistry).
- A large-transfer threshold is stored per type and read only by the
  `isLargeTransfer` view; no transfer reads it.
- Custody: `InvestorRequestManager` deploys a 2-of-2 `MultiSigWallet`
  (bank and user) per request; the lock is a transfer into it, capped at
  the Normal cap (`LockAboveNormalCap`, Task 5.1).
- Demo options 51-60 and 23.

### 7. Governance

- One verified identity, one vote; VGT pays the fees (10 VGT to propose,
  10 VGT per vote, owner-adjustable above 0 and up to 1,000 VGT) and is
  not a vote weight. VGT delegation is recorded, not counted (D12).
- Quorum 10-30% of the identities registered at the voter-age cutoff,
  approval 60-75%, per proposal type. Passed proposals burn the deposits;
  on Rejected or Cancelled each identity's controlling wallet claims its
  deposit back (keyed by identity, Task 5.2).
- Each proposal type is bound to one target: investor types, compliance
  rules, oracles, token, system, list update, identity registry, VGT,
  escrow factory, identity factory, privacy, verifier (EmergencyAction has
  no target and cannot be proposed).
- Demo options 74-83f; dynamic lists 84-89.

### 8. Escrow

- One `MultiSigEscrowWallet` per payment from `EscrowWalletFactory`,
  funded once; release needs the investor and the payee, refund the
  investor and the payer; before a shipment proof or in a dispute the
  investor may refund alone (`manualRefund`).
- The payee's shipment proof is bound to the escrow address and chain id
  and opens a 14-day dispute window. Fees fixed at creation (3% investor,
  2% owner). `sweepExcess()` (payer, payee, investor or platform owner)
  returns tokens sent to a settled escrow outside the factory.
- Demo options 61-73b (70a sweeps).

### 9. Interactive demo

- 117 menu entries (89 numbered options and 28 sub-options such as 1a,
  33a, 83c), from `demo/core/MenuSystem.js`. CI drives a scripted smoke
  of it (`scripts/ci/demo-smoke.sh`), a strict ceremony drive
  (`scripts/ci/strict-drive.sh`) and regression drives
  (`scripts/ci/regression-drives.sh`).

## Contracts

| Folder      | Deployable contracts                                                  |
| ----------- | --------------------------------------------------------------------- |
| onchain_id/ | OnchainIDFactory, OnchainID, ClaimIssuer, KeyManager                  |
| erc3643/    | Token, IdentityRegistry, InvestorTypeRegistry                         |
| compliance/ | ComplianceRules                                                       |
| oracle/     | OracleManager, ConsensusOracle, WhitelistOracle, BlacklistOracle      |
| privacy/    | PrivacyManager, ZKVerifierIntegrated, DynamicListManager, 5 verifiers |
| investor/   | InvestorRequestManager, MultiSigWallet                                |
| payment/    | EscrowWalletFactory, MultiSigEscrowWallet                             |
| governance/ | GovernanceToken, VanguardGovernance                                   |

26 deployable contracts (the rest are abstract bases, libraries,
interfaces and test mocks; docs/SYSTEM_WORKFLOW_GUIDE.md, "Contracts").

## Testing and CI

Nine CI jobs (`.github/workflows/ci.yml`; tests and coverage in two
shards each): compile, tests, guard-runs, coverage and coverage-merge
(merged line coverage may not drop below the recorded baseline; an
overall branch baseline and per-contract floors,
`scripts/ci/branch-floors.json`), zk-coverage, demo (smoke, ceremony,
production deploy, multisig and regression drives on a node), gates
(guard table: every require/revert in `contracts/` classified in
`test/guards/table/`; line count; docs; lint and audit ratchets) and
required (passes only when every other job succeeded). A gas
ratchet runs in the tests job. The docs gate checks structure and
existence (fences, the README tree, links, option numbers, cited
commands), not the truth of prose; that comes from the verbatim runbook
rehearsals (`docs/rehearsals/`).

## Not done yet

- A third-party security audit, the Sepolia rehearsal of the production
  deploy through an external signer (Phase 5 Task 5.8; the tooling is
  built) and a production deploy (mainnet is Phase 6).
- Formal verification of the circuits, load testing, monitoring.
- Oracle-driven KYC/AML claim updates; delegation counted in votes (after
  the audit).

This is not production software yet: the remaining remediation phases and
a third-party security audit come before any mainnet deployment.
