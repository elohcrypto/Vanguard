# Running the demo with real role wallets (local rehearsal and Sepolia)

The interactive demo was written against Hardhat's twenty pre-funded
accounts and its `evm_increaseTime` RPC. A public network has neither. This
document is the path from a local rehearsal that behaves like a testnet to
the testnet itself.

The testnet guide is three files: [setup](TESTNET_SETUP.md) (roles, time scale, governance rules, rehearsal, Sepolia, gas), [demo options](TESTNET_DEMO_OPTIONS.md) (privacy, custody, oracles, identity keys) and [ceremony](TESTNET_CEREMONY.md) (the handover and the operators' command lines).

## Roles are wallet indices

One BIP-39 mnemonic in `.env`; Hardhat derives twelve keys at
`m/44'/60'/0'/0/N`. Index N is the same role on every network, so demo code
that reads `signers[2]` means "the AML oracle node" whether the node is local or
Sepolia. Each role signs only its own transactions; the contracts' 26 access
modifiers are what enforce the separation.

| Index   | Role                                   | Signs                                                                                                                  |
| ------- | -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| 0       | Platform owner, deployer, central bank | deploys, agent grants, treasury mints (investor-limit exempt, D22), governance ownership (until the handover ceremony) |
| 1       | Fee wallet, compliance officer         | investor-type assignments; KYC oracle node (registered by option 31)                                                   |
| 2       | AML oracle node                        | oracle attestations (option 31); emergency designation (option 32)                                                     |
| 3       | Compliance oracle node                 | oracle attestations (option 31)                                                                                        |
| 4, 5    | Risk and fraud oracles                 | attestations                                                                                                           |
| 6, 7, 8 | Investors Alice, Bob, Carol            | proposals, votes, transfers, escrow parties                                                                            |
| 9       | Deliberately unverified; issuer admin  | rejection demonstrations; after the handover, owner of every claim issuer the deployer held (D25 b)                    |
| 10      | Ops multisig stand-in                  | agent roles, compliance officer, oracle ownership and the escrow factory's ADMIN_ROLE after handover                   |
| 11      | Guardian                               | pause only                                                                                                             |

On Sepolia and beyond, wallets 9, 10 and 11 must be multisig addresses, not
single keys, held by different parties: ops is an IdentityRegistry agent and
must never also own or sign for a claim issuer (2F.5, D25 b). The demo's
signer allocation never hands wallets 0-3 or 9-11 to an onboarded user.

```bash
cp .env.example .env
npx hardhat run scripts/print-role-wallets.js --network hardhat   # generates a phrase if MNEMONIC is empty
```

Put the phrase in `.env` as `MNEMONIC`. It is gitignored. Never commit it.

## Governance time scale

`VanguardGovernance` takes a `timeScale` constructor argument that divides
every voting period and execution delay. `1` is the mainnet schedule
(7-day votes); the ceiling is `1440`, at which the shortest duration in the
table (1 day) is still 60 s. The percentages are never scaled. The demo reads
`GOV_TIME_SCALE` from the environment at deploy time.

| GOV_TIME_SCALE | InvestorTypeConfig vote | delay  | Use                           |
| -------------- | ----------------------- | ------ | ----------------------------- |
| 1              | 7 days                  | 2 days | mainnet, tests                |
| 336            | 30 min                  | ~9 min | Sepolia walkthrough           |
| 1440           | 7 min                   | 1 min  | local rehearsal (the ceiling) |

## KYC claims and verification (2F.2)

`IdentityRegistry.isVerified` asks each issuer trusted for a required topic
(`ClaimIssuer.hasValidClaim(identity, topic)`); it does not read the
identity's own claim list, which anyone can pad with claims naming
themselves. The issuer's `issueClaim` still writes a copy onto the
OnchainID (ERC-735 view), but nothing reads that copy to decide
verification; correctness rests on the issuer's record. Verification
follows the issuer's latest claim per topic for that identity: revoking the
latest claim unverifies the holder at once after a `refreshVerified` (options
6 and 7 run it right after the revoke; see the verification cache below),
even if an older claim is unrevoked, and revoking an older, superseded claim
has no effect; the
issuer restores a holder by issuing a new claim. Batch-issued claims verify
and revoke the same way. `revokeClaim` also removes the identity-side copy
(a `ClaimRemovalFailed` event flags a copy the holder had already removed,
or a batch-issued claim that never had one). A wallet recovered with `Token.recoveryAddress` is bound
to the old OnchainID in the registry, but the identity's owner and keys are
unchanged, so it cannot propose or vote ("Wallet does not control its
identity") until it holds a key on that OnchainID: the designed path is
KeyManager recovery (the holder authorised KeyManager and named recovery
agents beforehand; the agents initiate and approve the new wallet's key, and
after the 48-hour timelock, and within the 7 days after it, anyone executes
it).

## Electorate rule (D7)

Quorum is a share of `registeredIdentityCount`, frozen into the proposal as
`eligibleVotersAtCreation` when it is created. Voting needs `isVerified`, which
turns false once a required claim expires or is revoked, yet the identity
stays registered and keeps counting toward the denominator. Operators must
call `deleteIdentity` for every such identity BEFORE creating a proposal;
deleting mid-vote does not move the bar of a proposal already open. The case
"expired claims inflate the denominator until deleteIdentity" in
`test/governance/QuorumIntegrity.test.ts` is the executable version of this rule.
Governance holds VGT fees as a trusted contract on VGT (option 74 adds it
while the deployer still owns ComplianceRules; trust is per token since Task
4.1, so governance is not trusted on VSC): it has no identity and never counts in
`registeredIdentityCount`, so the electorate is the onboarded humans.
Ops keeps the VGT agent role but cannot freeze, burn, move or recover
governance's VGT (D23). Ops can still stop voting reversibly through
voter-side powers: freezing or burning voters' VGT, deleting voter identities,
or revoking claims as issuer owner. A VGT pause is released by ops (VGT
agent) with one transaction and no vote, or by an unpause proposal passed
before the pause; ops cannot pause (D24). A governance pause is therefore
advisory against ops, which can release it at once; a pause meant to hold
against ops must be preceded by `removeAgent(ops)` in the same pre-voted
batch, and is then terminal again (governance is the only agent left and can
act only by vote).

## Vote rules (D25)

One identity, one wallet, one vote (plan 2F.1, D25). The IdentityRegistry
binds each OnchainID to at most one wallet (a second wallet on the same
identity is refused, "Identity already bound"; `moveIdentity` re-points it
on recovery) and records when the identity's current binding began
(`identityRegisteredAt`, kept across recovery (moveIdentity); a
delete-and-re-register or an updateIdentity to another OnchainID restarts
it).
`VanguardGovernance` counts one vote per identity, not per wallet, and
excludes the proposer's identity from voting on its own proposal. The voting
wallet must control its identity: be the OnchainID owner or hold a
MANAGEMENT or ACTION key on it ("Wallet does not control its identity"), so
a registry agent cannot vote as an investor by binding a wallet of its own
to the investor's identity. Only identities at least `minVoterAge` old when
the proposal is created may propose or vote ("Identity too new to vote"): 7
days divided by `TIME_SCALE` (420 s at 1440, 30 min at 336), tunable by a
SystemParameters vote within 1 to 30 days (scaled) and never to zero; each
proposal freezes its own cutoff. Quorum counts only those identities
(`eligibleVotersAtCreation = registeredIdentityCountAt(createdAt -
minVoterAge)`), so fresh identities neither vote nor raise the bar, and a
deletion lowers the bar only for proposals created `minVoterAge` later.
`executeProposal` needs 3,000,000 gas left before it runs a passed
proposal's call ("Insufficient gas for execution"). A target call that runs
out of gas reverts the execution (`InsufficientExecutionGas`) and leaves the
proposal Active, so anyone can retry with more gas; `eth_estimateGas` finds
a working limit. A target that can never complete (it burns all the gas it
is given) needs a rescue vote that calls `cancelProposal` on it.
`createProposal` refuses calldata under 4 bytes and the `transfer`,
`approve`, `transferFrom`, `renounceOwnership`, `distributeGovernanceTokens`
and `burn(uint256)` selectors on every type (governance is a VGT agent, so
the last two would spend the deposits it holds). ListUpdate accepts only
the DynamicListManager's four list writes, its owner setters (`setOracles`,
`setGovernanceContract`, `setProofExpiryDuration`) and
`transferOwnership`/`acceptOwnership` ("Selector not allowed"; the
whitelist root moved to PrivacyManager in 3.3, published by ops or a
PrivacyParameters vote), and only while the manager's `governanceContract` is this
governance ("List manager not bound to governance"). The residual
risk is collusion of a registry agent with an issuer key: they can still
mint fake identities, visibly on chain, but those cannot vote for
`minVoterAge`, which is the honest electorate's window to vote the colluding
keys out.
VGT delegation is recorded on the token and not counted by governance (D12,
plan v2 Task 4.6). `GovernanceToken.delegate` moves a holder's balance into
its delegate's `getVotingPower` and `getVotingPowerPercentage`; the
delegator keeps its own, so the readings count that balance twice;
`getTotalVotingPower` stays `totalSupply`. `castVote` adds exactly 1 per
verified identity and no governance path reads voting power: a delegate
still casts one vote and a delegator still casts its own
(`test/governance/DelegationNoEffect.test.ts`). VGT pays the proposal and
vote fees; it is not a vote weight. `canVote` is the token-side check
(verified and holding VGT); governance adds key control, `minVoterAge`, the
fee and its allowance. Wiring delegation into `castVote` (a delegate votes
for its delegators, checkpointed per proposal) is scheduled after the
external audit.
The handover ceremony votes, so its proposer and voters must be registered
`minVoterAge` before step 1: `scripts/handover.ts` refuses a younger identity
before any transaction and computes quorum over aged identities only; the
demo (83b, 83d) and the smoke advance past it with `ChainTime.advancePastVoterAge`,
which jumps on a dev node and waits on Sepolia.
Option 82 (Task 4.7, `demo/utils/GovernanceWorkflow.js`) runs one
ComplianceRules proposal end to end: the voter picker the ceremony votes
use (`demo/utils/VoterPicker.js`) chooses a proposer and at least three
voters among the verified wallets 0-9 (never 9, 10, 11; the proposer
never votes); an actor short of the two fees is minted the difference by
the VGT agent (the deployer before the ceremony, ops after it), else the
option stops with the 75a hint; the proposer approves exactly
`proposalCreationCost` and proposes VSC's current jurisdiction rule with
840, 826 and 124 allowed and 643 blocked (no other country changes; the
change lapses the private jurisdiction records, so 42 -> 3 again), each
voter approves exactly `votingCost` and votes; on a dev node it then
executes and reads the rule back, on a real network it prints the voting
period and delay read from chain and points to 78. A failure after the
proposal exists prints its id and "continue with 77/78".
`scripts/demo-smoke-workflow.js` runs it after the smoke's ceremony and
asserts Executed, the proposer's absent vote, the ops top-up and the
rule; `demo-drive.sh --strict 1 21 51 74 24:1:Alice 24:1:Bob 24:1:Carol
24:1:Dave 82:yes` drives it before the ceremony (the deployer tops up).

## Waiting instead of jumping

The four demo paths that used to call `evm_increaseTime` (governance option
79, ownership-by-vote 83b, escrow 73a and 73b) now go through
`demo/utils/ChainTime.advancePast`. It reads the real deadline from the
chain, jumps if the node allows it, and otherwise polls until the deadline
has passed. The 13-of-14-day escrow demonstration is dev-node only and says
so on a network that cannot jump. Option 73 runs 62 -> 63 -> 64 -> 65 -> 73b
-> 68 -> 69 -> 71 with no prompts and a chain-read verdict per step; on a
network that cannot jump it stops after the proof and prints when the
dispute window closes.

## Driving the demo without a terminal

`npm run demo:drive -- <choices>` (`scripts/demo-drive.sh`) runs the menu
under a pseudo-terminal and sends each choice when the demo asks. It sets
`DEMO_PROMPT_MARK=1`, under which `demo/index.js` prefixes every question
(the menu's and every option's) with `[[?]] `; the driver counts those
lines, so it answers sub-prompts too. A choice carries the answers to its
option's prompts after colons, in order: `82:yes`, `42:6:` (6, then Enter
for the default wallet), `47:1`. An empty field is Enter. Answers may
contain commas (`0,1,2`), not colons. A menu choice goes only to the menu
and a sub-answer only to another prompt: when an option asks a prompt the
argument does not answer, or returns to the menu with answers left, the
drive stops with exit 1 and names the prompt. `--strict` also fails on
any line starting with "❌".

## Local rehearsal (do this before Sepolia)

```bash
MNEMONIC="<your phrase>" npx hardhat node          # funds the 12 role wallets
GOV_TIME_SCALE=1440 npm run demo:interactive:proof   # in another terminal
```

Then walk: 1 (deploy, privacy pair and KeyManager included), 12 (key
rotation and recovery on wallet 1's identity), 74 (governance), 75 (distribute VGT to 6-8), 76
(Alice proposes), 77 (Bob and Carol vote), 79 (wait ~8 min), 78 (execute),
78a (claim on a rejected one). Every action is signed by its role's key.
Name the treasury wallet and exempt it from investor limits (option 22 or 51,
or `setInvestorLimitExempt` directly) BEFORE the ceremony, while the deployer
owns the registry; afterwards only an InvestorTypeConfig vote can (option 76,
type 0, choice 2). Do the same for the two escrow fee wallets (the owner fee
wallet given to the factory and each investor's fee wallet; options 61 and
62 do it while the deployer owns the registry): the human side of a trusted
transfer is cap-checked (D26), so without the exemption every release
eventually reverts on a fee wallet's holding cap. A release or refund that
would put any recipient (payee, payer, either fee wallet) over its holding
cap reverts atomically with "Holding limit exceeded" and the escrow stays
Active with the funds in it. Exits: the over-cap party moves balance out,
the registry raises its type, or it is exempted (D22). The refund stays
open only while the payer has room under its own cap. After a wallet
recovery, re-assign the investor type (and the exemption) to the new
wallet: recovery moves the balance but not the type.

Rehearsed on 2026-09-11 with the poll branch forced at a since-removed
scale of 10080: a 60-second vote plus 17-second delay waited 78 seconds of
real time and executed. The ceiling was then lowered to 1440 because at
10080 the one-day delay was 8 s, below a public chain's block time. The
unverified wallet at index 9 was rejected by `createProposal` from its own
key.

## Sepolia

1. `SEPOLIA_RPC_URL` in `.env` (Alchemy or Infura free tier).
2. Fund index 0 with ~0.3 ETH and indices 1 to 9 with ~0.02 each from a
   faucet. `print-role-wallets.js --network sepolia` shows balances.
3. `GOV_TIME_SCALE=336 npx hardhat run demo/index.js --network sepolia`.
4. Same menu walk. Option 79 waits about 40 minutes of real time.
5. The rehearsal includes one real EIP-7702 (type-4) delegation: delegate a
   role wallet, call `addTrustedContract(VSC, wallet)` on it and expect the revert
   "ComplianceRules: delegated wallet". Sending a type-4 transaction needs an
   ethers version with authorization-list support.

## Transfer gas by required claim topics

`Token.transfer` verifies each party once (`IdentityRegistry.isVerified` on
sender and recipient); `ComplianceRules.canTransfer` verifies only the escrow
counterparty on trusted transfers. `scripts/gas-analysis.ts` measures a real
second transfer (after a warm-up) for five deployments: the permissive
`MockIdentityRegistry` with compliance bound to it as the baseline (A), one
required topic (B, KYC), two (C, KYC+AML), and two with both identities
refreshed into the verification cache (D), and D with an authorized
investor-type registry (E, Task 4.10). Re-run with `npm run gas:claims`
(fresh in-process Hardhat network, no external node needed).

**Task 4.9 (measured 2026-10-07).** Before: 88d9454, no cache. After: the
cache (D17 = a) with the review fixes.

| Scenario                           | before gasUsed | before isVerified est. | after gasUsed | after delta vs A | after isVerified est. |
| ---------------------------------- | -------------- | ---------------------- | ------------- | ---------------- | --------------------- |
| A: MockIdentityRegistry (baseline) | 96,503         | 23,938                 | 96,503        | 0                | 23,938                |
| B: 1 topic (KYC), unrefreshed      | 136,673        | 48,942                 | 142,647       | +46,144          | 51,885                |
| C: 2 topics (KYC+AML), unrefreshed | 167,737        | 68,724                 | 174,287       | +77,784          | 71,955                |
| D: C + both identities refreshed   | n/a            | n/a                    | 105,849       | +9,346           | 29,236                |

`refreshVerified` for one wallet with two topics costs 100,139 gas (one
`claimValidTo` call per topic on top of the walk). D is within the 40,000
gas tolerance over A. An unrefreshed identity pays the walk as before plus
a cold read of its (empty) cache entry: B and C rose by about 6,000, about
4,200 of it the two parties' cold reads and about 1,800 the restructured
walk. Earlier history: 447,939 for C before Task
2A.7, 386,716 after it, 165,190 after Task 2F.2 (issuer-side
`hasValidClaim`, no OnchainID read).

**With an investor-type registry (Task 4.10, measured 2026-10-07).**
Scenario E is D with an authorized `InvestorTypeRegistry` on the token;
the measured transfer runs after the sender's cooldown, so its clock
write overwrites a set slot. Before: ec505cb (caps only, no cooldown).
After: the cooldown, the authorization and the clock write, after the
gas round below.

| Scenario                                 | before gasUsed | after gasUsed | after delta vs A |
| ---------------------------------------- | -------------- | ------------- | ---------------- |
| A: MockIdentityRegistry (baseline)       | 96,503         | 96,902        | 0                |
| D: 2 topics, both refreshed, no registry | 105,849        | 106,248       | +9,346           |
| E: D + investor-type registry            | 133,947        | 135,584       | +38,682          |
| E first transfer (warm-up)               | 151,047        | 169,784       | n/a              |

The gas round, E (and E's first transfer) after each step: first cut
146,961 (181,161); the three cap views read one config field from
storage instead of copying the seven-field struct, 139,359 (173,559);
one registry call, `transferCheck`, answers the authorization, the
transfer cap and the cooldown, 136,376 (170,576); `recordTransfer` skips
exempt senders, 136,580 (170,780); the token reuses the sender's trust
flag for the clock write instead of asking ComplianceRules again,
135,478 (169,678); the review's zero-amount guard (H1), 135,584
(169,784). E is within the 40,000 D17 tolerance over A after the
sender's first transfer (it was 37,444 over A at ec505cb, the caps
alone); a sender's first transfer pays the clock's zero-to-nonzero
write. Every transfer pays 399 more than at ec505cb without a registry
(the clock branch, the zero-amount guard and the trust flag in
`_checkTransferFull`).

**The verification cache.** `IdentityRegistry` (claim half in
`RegistryVerification.sol`) caches a passing claim walk per identity, not
per wallet. `refreshVerified(wallet)` and `refreshIdentity(identity)` run
the full walk and may be called by anyone; they only write the truth: a
passing walk stores an entry, a failing walk clears it. An entry lives
until the earlier of 24 hours after the refresh and the `validTo` of every
claim the walk accepted (`ClaimIssuer.claimValidTo`), so claim expiry is
exact; an issuer without that view is never cached. While it is fresh,
`isVerified` answers without asking the issuers. A revoked or superseded
claim keeps verifying until the entry lapses (at most 24 hours); to make
that latency zero, the issuer's operator (or anyone) calls
`refreshVerified` right after `revokeClaim`. `addClaimTopic` and
`removeTrustedIssuer` bump `verificationGeneration`, which voids every
entry in the same transaction, so a removed issuer stops counting at
once. `verifiedUntil(identity)` shows the fresh entry. The blacklist
oracle path and token freezes do not go through the cache and stay
immediate. The demo refreshes after onboarding claims and after a revoke in
options 6/7, and prints "verification cached until <date>" (or, after a
revoke, "walk fails (no live claim), cache entry cleared").

Deploying all eleven contracts costs under 0.01 ETH at 1.3 gwei.
