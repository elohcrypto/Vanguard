# Test contracts

Deployed only by the tests and, for `TestMultisig`, the local multisig
drive (`scripts/ci/multisig-exec.js`, runbook section 2.4); no production
deploy path uses them.

- `MockTarget.sol` - a call target for governance and execution tests
- `mocks/` - test doubles, each described in its file header:
  verifiers (`AlwaysTrueVerifier`, `FakeZKVerifier`), identities and
  recovery managers (`BloatedOnchainID`, `FalseReturningIdentity`,
  `EvilRecoveryManager`, `OddRecoveryManager`), issuers
  (`MockClaimIssuer`, `HostileIssuer`, `IssuerCallProbe`), registries and
  compliance (`MockIdentityRegistry`, `ComplianceRegistry`, a permissive
  double `scripts/deploy-helpers.ts` refuses, `YesCompliance`), tokens (`MockToken`,
  `MockTypedToken`, `MockPolicyToken`), oracles and engines
  (`MockQueryManager`, `RawWhitelistOracle`, `ShortWhitelistOracle`,
  `WeightlessEngine`, `MockWhitelistBinder`), `RefusingFeeRecipient` and
  `TestMultisig` (a 2-of-2 stand-in for a Safe as ops or the issuer
  admin, Task 5.13; not the production recommendation).

TypeScript test helpers live in `test/helpers/`; deployment helpers in
`scripts/deploy-helpers.ts`.
