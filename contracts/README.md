# Vanguard contracts

Solidity sources for the Vanguard token (VSC) system: an ERC-3643-style
security token with OnchainID identities, list oracles, ZK proofs,
custody, escrow and governance. Under development, not audited.

## Directory structure

```
contracts/
├── onchain_id/   OnchainID, OnchainIDFactory, ClaimIssuer, KeyManager (+ interfaces/)
├── erc3643/      Token (VSC), IdentityRegistry, InvestorTypeRegistry (+ interfaces/)
├── compliance/   ComplianceRules: per-token jurisdiction rules, list gates, trust (+ interfaces/)
├── oracle/       OracleManager, ConsensusOracle, WhitelistOracle, BlacklistOracle (+ interfaces/)
├── privacy/      PrivacyManager, ZKVerifierIntegrated, DynamicListManager, verifiers/ (+ interfaces/)
├── investor/     Custody: InvestorRequestManager, MultiSigWallet
├── payment/      Escrow: EscrowWalletFactory, MultiSigEscrowWallet
├── governance/   GovernanceToken (VGT), VanguardGovernance
└── test/         MockTarget and mocks/ (tests only)
```

The abstract bases each contract is built on are listed in
`docs/SYSTEM_WORKFLOW_GUIDE.md` ("Contracts").

## Development

1. Install dependencies: `npm install`
2. Compile: `npx hardhat compile`
3. Build the circuits: `npm run setup:zk` (needed by the proof tests)
4. Test: `npm test`
5. Deploy locally: `npm run node`, then `npm run demo:interactive:proof`
   and option 1a (or 1 and the options after it).
   `scripts/production/DeployProduction.ts` deploys the whole stack
   through an external signer and writes the ceremony's handover.json
   (docs/OPERATOR_RUNBOOK.md, section 2).

## Networks

`hardhat.config.ts` defines `hardhat`, `localhost`, `devnode` (when
`DEMO_RPC_URL` is set), `remote` (an external signer, when `SIGNER_RPC_URL`
is set), `sepolia` and `mainnet`. Nothing is deployed on a public network yet (the deploy
tooling is Tasks 5.7 and 5.15; the Sepolia rehearsal is Task 5.8).

## Security

Not audited. What the contracts guard and how is in the README's
Security section; every `require`/`revert` is classified in
`test/guards/table/` and checked by `scripts/ci/guards-table.js`.
