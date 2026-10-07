# Investor Type System

Each VSC holder has an investor type in `InvestorTypeRegistry`
(`contracts/erc3643/InvestorTypeRegistry.sol`, with its proposal system in
the abstract base `InvestorTypeGovernance.sol`: one contract, one address).
The type sets two caps and a transfer cooldown the token enforces, a
whitelist tier ComplianceRules enforces (D37 = a, Task 4.10), and three
parameters the registry records but no contract reads. This page
describes the contract as it is in this tree.

## Types and their defaults

`IInvestorTypeRegistry.InvestorType` is `Normal` (0), `Retail` (1),
`Accredited` (2), `Institutional` (3). An address with no assigned type is
`Normal`. The constructor sets these configurations (`InvestorTypeConfig`):

| Type          | maxTransferAmount | maxHoldingAmount | requiredWhitelistTier | transferCooldownMinutes | largeTransferThreshold | enhancedLogging | enhancedPrivacy |
| ------------- | ----------------- | ---------------- | --------------------- | ----------------------- | ---------------------- | --------------- | --------------- |
| Normal        | 8,000 VSC         | 50,000 VSC       | 1                     | 60                      | 3,000 VSC              | false           | false           |
| Retail        | 8,000 VSC         | 50,000 VSC       | 2                     | 60                      | 5,000 VSC              | false           | false           |
| Accredited    | 50,000 VSC        | 500,000 VSC      | 3                     | 30                      | 10,000 VSC             | true            | true            |
| Institutional | 500,000 VSC       | 5,000,000 VSC    | 4                     | 15                      | 100,000 VSC            | true            | true            |

`getInvestorTypeConfig(type)` and `getAllInvestorTypeConfigs()` return the
current values; `updateInvestorTypeConfig(type, config)` (owner only)
replaces one, requiring both caps above zero and a tier from 1 to 5, and
emits `InvestorTypeConfigUpdated`.

## What the token enforces

`Token.setInvestorTypeRegistry(registry)` (Token owner) binds the registry,
and the registry's owner must authorize the token
(`authorizeToken(token, true)`). With a registry bound, `Token._checkTransfer`
(behind `transfer`, `transferFrom`, `canTransfer` and `mint`) applies:

- **Authorization (fail closed)**: while the bound registry has not
  authorized the token (`isTokenAuthorized(token)` false), every mint and
  every transfer is refused with `Token not authorized by investor
registry` (burn is not gated). A misconfiguration is loud, not a silent
  skip of the cooldown.

- **Transfer cap**: `amount <= maxTransferAmount` of the sender's type,
  per transfer: the comparison `canTransferAmount(from, amount)` makes,
  asked by the token through `transferCheck(from, amount)` (code 2). There is no daily
  or cumulative total. Refusal: `Transfer amount limit exceeded`.
- **Transfer cooldown** (Task 4.10): the `canTransferNow(from)` rule for
  a non-trusted sender, right after the transfer cap, asked through
  `transferCheck` (code 3). Refusal: `Transfer
cooldown`. See "Cooldown and tier" below.
- **Holding cap**: `canHoldAmount(to, balanceOf(to) + amount)` for the
  recipient. Refusal: `Holding limit exceeded`.

`mint` runs the same check as `canTransfer(address(0), to, amount)` and
reverts with the first failure: `Recipient frozen`, `Identity not
verified`, `Compliance check failed`, `Token not authorized by investor
registry` or `Holding limit exceeded`. A
trusted contract (an escrow wallet, a custody `MultiSigWallet`,
governance on VGT) has no type, so only its own side skips the cap: the
human side of a trusted transfer is still capped and cooled down (D26).

**Treasury exemption (D22 a).** A treasury is not an investor.
`setInvestorLimitExempt(account, true)` (owner only) emits
`InvestorLimitExemptionUpdated` and makes `canTransferAmount`,
`canHoldAmount` and `canTransferNow` return true for that address, and
lifts its whitelist tier rule. It lifts only the caps, the cooldown and the
tier; freeze, identity, the lists and jurisdiction still apply. It is a governance decision:
the deployer sets it before the handover, an InvestorTypeConfig vote
(option 76, type 0) after it; a compliance officer cannot. The demo
exempts the treasury (signer 0) and the two escrow fee wallets. The
production deploy (`scripts/production/DeployProduction.ts`) deploys no
InvestorTypeRegistry and names no treasury; no cap is raised to fit a
fixture.

## Cooldown and tier: enforced (D37 = a, Task 4.10)

**Cooldown.** The registry keeps one `lastTransferAt(sender)` (the only
storage write a transfer adds). `recordTransfer(sender)` writes
`block.timestamp` (nothing for an `investorLimitExempt` sender, which has
no cooldown) and is callable only by an authorized token
(`onlyAuthorizedToken`): `authorizeToken` / `isTokenAuthorized`, inert
since Phase 1, are the hook through which a token writes the clock.
`canTransferNow(sender)` is true when the sender is
`investorLimitExempt`, when its type's `transferCooldownMinutes` is 0, or
when at least that many whole minutes have passed since `lastTransferAt`
(60 / 60 / 30 / 15 minutes by default). Token asks the same question in
one call, `transferCheck(sender, amount)`, which answers for the calling
token 0 (allowed), 1 (token not authorized), 2 (over the transfer cap) or
3 (inside the cooldown), and maps each code to its reason; a trusted
sender is asked only `isTokenAuthorized`. After a successful `transfer` or
`transferFrom` of a non-zero amount, Token calls `recordTransfer(from)`
when the registry is set and the sender is not a trusted contract; a
zero-value transfer writes no clock, since anyone may `transferFrom` a
holder's wallet for 0 without an allowance (review H1). A cooldown is
at most `MAX_COOLDOWN_MINUTES` (43,200, 30 days; R-410-12):
`updateInvestorTypeConfig` and `createProposal` refuse a longer one
(`CooldownAboveMax`). The clock is one per registry, not per
token: a send on any token the registry authorizes starts the sender's
cooldown on every token it authorizes (only VSC today). Mint, burn and `recoveryAddress` write no clock;
receiving starts none; `transferFrom` writes the owner's clock, not the
spender's. On the trusted path (D26) the human side follows the rule: an
investor funding an escrow or locking into custody starts its cooldown,
an escrow or custody `MultiSigWallet` releasing tokens has no type, no
cooldown and no clock. A wallet recovery moves no clock, so the recovered
wallet may send at once.

**Tier.** `ComplianceRules` applies it wherever a party passes the
whitelist by its oracle entry: when the token's whitelist mode is
OracleOnly, or Either and the party has a live `WhitelistOracle` entry,
the entry's `tier` (from `getWhitelistInfo`) must be at least the party's
`getRequiredWhitelistTier` (1 / 2 / 3 / 4 by default) in the token's own
investor-type registry (`Token.investorTypeRegistry()`; none bound, no
rule). It covers both parties of a transfer, the human party on the
trusted path (the contract is exempt from the whitelist), the mint
recipient and a recovery wallet. A tier-short live entry is refused even
in Either. Not applicable: in ZkOnly, and for a party that passes Either
by a proof binding with no live entry, since a proof binding carries no
tier. `investorLimitExempt` parties skip it. Token reports the refusal as
`Compliance check failed`; `ComplianceRules.whitelistTierAllows(token,
party)` is false exactly when the tier rule is the cause. The
IdentityRegistry holds no investor-type registry (its pointer and
forwarders were deleted in Task 4.8); the token's registry is the only one.

In the demo no deploy path binds a `WhitelistOracle` to VSC, so VSC reads
no entry and the tier rule does not apply to VSC today; option 58 proves
it on a probe token. GovernanceToken (VGT) never gets an investor-type
registry on any deploy, ceremony or demo path, so neither rule throttles
voting (governance pulls vote fees by `transferFrom`).

## Recorded, not enforced

`isLargeTransfer(investor, amount)` (`amount > largeTransferThreshold`),
`hasEnhancedLogging(investor)` and `hasEnhancedPrivacy(investor)` return
the type's values. No contract reads them: the token requires no
large-transfer approval and nothing changes with the two flags. Option 57
reads the threshold.

## Assigning a type

| Call                                       | Who                         | Rule                                                |
| ------------------------------------------ | --------------------------- | --------------------------------------------------- |
| `assignInvestorType(investor, type)`       | compliance officer or owner | any type                                            |
| `upgradeInvestorType(investor, newType)`   | compliance officer or owner | `newType` above the current one ("Not an upgrade")  |
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
- **Authorized tokens** (`authorizeToken`, `isTokenAuthorized`): the only
  callers of `recordTransfer`. A token whose registry has not authorized it
  refuses every mint and transfer. Every path that binds a registry to VSC
  also authorizes it: option 21 (when the registry exists), option 51 and
  `scripts/demo-smoke.js` (`demo/utils/InvestorTypeRules.js`
  `wireInvestorRegistry`); after the handover it is an InvestorTypeConfig
  vote (option 76, type 0).

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
- 55 and 56 test the transfer and holding caps; 57 shows the large
  transfer threshold (recorded only); 58 proves on chain, with no prompts,
  that a send inside the cooldown is refused on VSC (`Transfer cooldown`)
  and passes after a dev-node time jump, and that a tier-short entry is
  refused on a probe token (`Compliance check failed`) and passes when
  re-listed at the required tier; 59 runs 52, 56, 57 and 58 and reports
  58's two verdicts; 60 is the dashboard.
- 15, 16 and 17 (with 20b, 20c, 20d) show the caps, the cooldowns with each
  demo wallet's clock, and the tiers with VSC's whitelist mode and each
  wallet's entry, all as enforced and read from chain
  (`demo/utils/InvestorTypeRules.js`, `InvestorTypeProof.js`).
- 23 is the custody flow above; 83 manages the registry through
  governance; 83b has governance accept its ownership by vote.

## Tests

`test/InvestorTypeSystem.test.ts`, `test/InvestorTypeBasic.test.ts`,
`test/erc3643/InvestorTypeRegistry.Display.test.js`,
`test/erc3643/MintLimits.test.ts` (mint against the holding cap),
`test/erc3643/TrustedPathCaps.test.ts` (D26),
`test/erc3643/InvestorTypeCooldown.test.ts` and
`test/erc3643/InvestorTypeTier.test.ts` (Task 4.10),
`test/investor/InvestorOnboarding.test.ts` (custody),
`test/simple-transfer-limits-test.js` and
`test/transfer-limits-verification.js`. All run under `npm test`.
`scripts/demo-smoke-investor.js` (a leg of `scripts/demo-smoke.js`) runs
option 58 and asserts both rules from chain.
