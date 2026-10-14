# Test contracts

Deployed only by the tests; no deploy path uses them.

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
  `WeightlessEngine`, `MockWhitelistBinder`) and `RefusingFeeRecipient`.

TypeScript test helpers live in `test/helpers/`; deployment helpers in
`scripts/deploy-helpers.ts`.
