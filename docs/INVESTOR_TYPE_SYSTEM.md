# Investor Type System

Each VSC holder has an investor type in `InvestorTypeRegistry`
(`contracts/erc3643/InvestorTypeRegistry.sol`). The type sets two caps the
token enforces on every transfer and mint, and five more parameters the
registry records but no contract enforces today (decision D37 is open).
This page describes the contract as it is in this tree.

## Types and their defaults

`IInvestorTypeRegistry.InvestorType` is `Normal` (0), `Retail` (1),
`Accredited` (2), `Institutional` (3). An address with no assigned type is
`Normal`. The constructor sets these configurations (`InvestorTypeConfig`):

| Type | maxTransferAmount | maxHoldingAmount | requiredWhitelistTier | transferCooldownMinutes | largeTransferThreshold | enhancedLogging | enhancedPrivacy |
|---|---|---|---|---|---|---|---|
| Normal | 8,000 VSC | 50,000 VSC | 1 | 60 | 3,000 VSC | false | false |
| Retail | 8,000 VSC | 50,000 VSC | 2 | 60 | 5,000 VSC | false | false |
| Accredited | 50,000 VSC | 500,000 VSC | 3 | 30 | 10,000 VSC | true | true |
| Institutional | 500,000 VSC | 5,000,000 VSC | 4 | 15 | 100,000 VSC | true | true |

`getInvestorTypeConfig(type)` and `getAllInvestorTypeConfigs()` return the
current values; `updateInvestorTypeConfig(type, config)` (owner only)
replaces one, requiring both caps above zero and a tier from 1 to 5, and
emits `InvestorTypeConfigUpdated`.

## What the token enforces

`Token.setInvestorTypeRegistry(registry)` (Token owner) binds the registry.
With a registry bound, `Token._checkTransfer` (behind `transfer`,
`transferFrom`, `canTransfer` and `mint`) applies:

- **Transfer cap**: `canTransferAmount(from, amount)`, `amount <=
  maxTransferAmount` of the sender's type, per transfer. There is no daily
  or cumulative total. Refusal: `Transfer amount limit exceeded`.
- **Holding cap**: `canHoldAmount(to, balanceOf(to) + amount)` for the
  recipient. Refusal: `Holding limit exceeded`.

`mint` runs the same check as `canTransfer(address(0), to, amount)` and
reverts with the first failure: `Recipient frozen`, `Identity not
verified`, `Compliance check failed` or `Holding limit exceeded`. A
trusted contract (an escrow wallet, a custody `MultiSigWallet`,
governance on VGT) has no type, so only its own side skips the cap: the
human side of a trusted transfer is still capped (D26).

**Treasury exemption (D22 a).** A treasury is not an investor.
`setInvestorLimitExempt(account, true)` (owner only) emits
`InvestorLimitExemptionUpdated` and makes `canTransferAmount` and
`canHoldAmount` return true for that address. It lifts only the two caps;
freeze, identity and compliance still apply. It is a governance decision:
the deployer sets it before the handover, an InvestorTypeConfig vote
(option 76, type 0) after it; a compliance officer cannot. The demo
exempts the treasury (signer 0) and the two escrow fee wallets. The
production deploy (`scripts/production/DeployProduction.ts`) deploys no
InvestorTypeRegistry and names no treasury; no cap is raised to fit a
fixture.

## Recorded, not enforced (D37)

`getRequiredWhitelistTier(investor)`, `getTransferCooldown(investor)`
(minutes), `isLargeTransfer(investor, amount)` (`amount >
largeTransferThreshold`), `hasEnhancedLogging(investor)` and
`hasEnhancedPrivacy(investor)` return the type's values. No contract reads
them: the token checks no tier, no cooldown and no large-transfer
approval, and nothing changes with the two flags.
`IdentityRegistry.getRequiredWhitelistTier` only forwards the first.
Demo options 16 and 17 (and 20c, 20d) print the cooldowns and tiers as
"recorded, not enforced"; 57 and 58 read the threshold and cooldowns.

## Assigning a type

| Call | Who | Rule |
|---|---|---|
| `assignInvestorType(investor, type)` | compliance officer or owner | any type |
| `upgradeInvestorType(investor, newType)` | compliance officer or owner | `newType` above the current one ("Not an upgrade") |
| `downgradeInvestorType(investor, newType)` | compliance officer or owner | `newType` below the current one ("Not a downgrade") |

Events: `InvestorTypeAssigned`, `InvestorTypeUpgraded`,
`InvestorTypeDowngraded`, each naming the officer. A wallet recovery
(`Token.recoveryAddress`) moves the balance but not the type: re-assign
the type (and any exemption) to the new wallet.

**Investor custody (Task 4.3, D13 b).** A type upgrade normally goes
through `InvestorRequestManager` (`contracts/investor/`), a compliance
officer of the registry: the user requests a type
(`requestInvestorStatus`), the bank (ops) creates a 2-of-2
`MultiSigWallet` for the user (`createMultiSigWallet`), the user locks the
type's `lockRequirements` amount in it (`lockTokens`, then
`confirmTokensLocked`), and the bank approves (`approveRequest`), which
assigns the type. A downgrade is a 2-of-2 unlock, then the type goes back
to Normal. Details: `docs/SYSTEM_WORKFLOW_GUIDE.md`, "Investor custody".

## Roles

- **Owner** (`Ownable2Step`): the deployer, then VanguardGovernance after
  the handover (accepted by a vote, option 83b or 83d). It updates
  configurations, sets exemptions, compliance officers, governors and the
  internal governance parameters, authorizes tokens and cancels internal
  proposals. A governed call is an InvestorTypeConfig proposal (type 0).
- **Compliance officers** (`setComplianceOfficer`): assign, upgrade and
  downgrade types. The constructor makes the deployer one; the handover
  makes ops one and removes the deployer (and the deployer as a governor).
- **Authorized tokens** (`authorizeToken`, `isTokenAuthorized`): recorded
  only; no registry function checks the list today.

**The registry's own proposals.** `createProposal(type, config,
description)` (governor or owner), `approveProposal` (governors) and
`executeProposal` (anyone, after `governanceDelay`, 2 days by default,
within `PROPOSAL_LIFETIME`, 7 days, with `requiredApprovals`, 2 by
default) change a configuration with governor approvals. `setGovernor`
bumps `governorEpoch`, which voids every open proposal created under the
previous governor set. This layer does not protect owner calls:
`updateInvestorTypeConfig` is `onlyOwner` and bypasses it; once
VanguardGovernance is the owner, its vote is the protection.

## Demo options

- 51 deploys the registry, wires it into VSC and, when VSC exists, the
  investor custody (Task 4.3); 52 shows the configurations; 53 assigns
  types; 54 upgrades or downgrades.
- 55 and 56 test the transfer and holding caps; 57 and 58 show the large
  transfer threshold and the cooldowns (recorded only); 59 runs 52, 56, 57
  and 58; 60 is the dashboard.
- 15, 16 and 17 (with 20b, 20c, 20d) show the caps, cooldowns and tiers.
- 23 is the custody flow above; 83 manages the registry through
  governance; 83b has governance accept its ownership by vote.

## Tests

`test/InvestorTypeSystem.test.ts`, `test/InvestorTypeBasic.test.ts`,
`test/erc3643/InvestorTypeRegistry.Display.test.js`,
`test/erc3643/MintLimits.test.ts` (mint against the holding cap),
`test/erc3643/TrustedPathCaps.test.ts` (D26),
`test/investor/InvestorOnboarding.test.ts` (custody),
`test/simple-transfer-limits-test.js` and
`test/transfer-limits-verification.js`. All run under `npm test`.
