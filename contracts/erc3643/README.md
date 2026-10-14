# ERC-3643 contracts

An ERC-3643-style permissioned security token and its registries. The
token implements this repository's `IERC3643` interface (identity
registry, compliance hooks, agent mint/burn/freeze, wallet recovery,
pause); it is not the T-REX reference code (no forced transfers, batch
mints, separate claim-topics or trusted-issuers registries, or
compliance modules).

## Contracts

### Token.sol (VSC; GovernanceToken, VGT, is a subclass)

- Every transfer and mint is checked by `IdentityRegistry.isVerified`,
  `ComplianceRules.canTransfer` and, with an InvestorTypeRegistry bound,
  the registry's authorization, caps and cooldown (docs/SYSTEM_WORKFLOW_GUIDE.md, "Transfers")
- Agent-only mint, burn (free balance only, never gated by compliance),
  freezing, partial freezing and wallet recovery (`recoveryAddress`; the
  new wallet must control the identity, D41)
- Pause by the owner or the guardian, unpause by the owner; on VGT an
  agent (ops) may also unpause, so the guardian can pause again after a
  voted unpause; a pause has no expiry (D56; an audit item)
- Registries and compliance are replaced by owner setters
  (`setIdentityRegistry`, `setCompliance`, `setInvestorTypeRegistry`);
  there are no proxies

### IdentityRegistry.sol

- Binds a wallet to an OnchainID and a country (one wallet per
  identity); registration is agent only, the wallet must control the
  identity (owner, MANAGEMENT or ACTION key, D41) and the country must
  pass the token's ComplianceRules rule when a jurisdiction source is set
- Required topics, trusted issuers, `isVerified` and its per-identity
  verification cache in the base `RegistryVerification.sol`; each issuer
  call is bounded to 45,000 gas and one return word, and a failing issuer
  counts as no claim (`BoundedStaticCall.sol`, Task 5.1)

### InvestorTypeRegistry.sol

- Per-type transfer and holding caps, transfer cooldown and required
  whitelist tier; Token enforces the caps and the cooldown, ComplianceRules
  the tier (Task 4.10, docs/INVESTOR_TYPE_SYSTEM.md)
- `lastTransferAt` per sender, written by `recordTransfer` only from a
  token the registry authorized (`authorizeToken`)
- Its own config proposals and governors in the base
  `InvestorTypeGovernance.sol`

### Compliance

The compliance contract the token binds is
`contracts/compliance/ComplianceRules.sol` (per-token jurisdiction rules,
blacklist and whitelist gates, trusted contracts).
`contracts/test/mocks/ComplianceRegistry.sol` is a permissive test
double whose `isProductionCompliance()` is false, so the deployment
helper (`scripts/deploy-helpers.ts`) refuses it; Token itself does not
check.

## Interfaces (`interfaces/`)

- `IERC3643.sol` - the token interface Token implements
- `IIdentityRegistry.sol` - identity registry
- `ICompliance.sol` - `IComplianceHooks`, the token's view of compliance
- `IInvestorTypeRegistry.sol` - investor types

## Deploying

The demo's option 1a deploys and wires everything; in outline:

```solidity
IdentityRegistry registry = new IdentityRegistry();
ComplianceRules rules = new ComplianceRules(owner, allowedCountries, blockedCountries);
Token token = new Token("Vanguard Token", "VSC", address(registry), address(rules));
registry.setComplianceRules(address(rules), address(token)); // country check source
// then: trusted issuers and claim topics on the registry, list oracles and
// whitelist mode on ComplianceRules, the investor-type registry on the token
```

```solidity
// Agent only; the wallet must control the identity (D41)
registry.registerIdentity(investorWallet, onchainIDAddress, 840);
// Agent only; checked like a transfer to the recipient
token.mint(investorWallet, 1000 * 10**18);
```
