# Running the demo with real role wallets (local rehearsal and Sepolia)

The interactive demo was written against Hardhat's twenty pre-funded
accounts and its `evm_increaseTime` RPC. A public network has neither. This
document is the path from a local rehearsal that behaves like a testnet to
the testnet itself.

## Roles are wallet indices

One BIP-39 mnemonic in `.env`; Hardhat derives twelve keys at
`m/44'/60'/0'/0/N`. Index N is the same role on every network, so demo code
that reads `signers[2]` means "the KYC issuer" whether the node is local or
Sepolia. Each role signs only its own transactions; the contracts' 26 access
modifiers are what enforce the separation.

| Index | Role | Signs |
|---|---|---|
| 0 | Platform owner, deployer, central bank | deploys, agent grants, treasury mints (investor-limit exempt, D22), governance ownership (until the handover ceremony) |
| 1 | Fee wallet, compliance officer | investor-type assignments |
| 2 | KYC issuer | KYC claims, identity registration |
| 3 | AML issuer | AML claims |
| 4, 5 | Risk and fraud oracles | attestations |
| 6, 7, 8 | Investors Alice, Bob, Carol | proposals, votes, transfers, escrow parties |
| 9 | Deliberately unverified | rejection demonstrations |
| 10 | Ops multisig stand-in | agent roles, compliance officer, oracle + issuer ownership after handover |
| 11 | Guardian | pause only |

On Sepolia and beyond, wallets 10 and 11 must be multisig addresses, not
single keys.

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

| GOV_TIME_SCALE | InvestorTypeConfig vote | delay | Use |
|---|---|---|---|
| 1 | 7 days | 2 days | mainnet, tests |
| 336 | 30 min | ~9 min | Sepolia walkthrough |
| 1440 | 7 min | 1 min | local rehearsal (the ceiling) |

## Electorate rule (D7)

Quorum is a share of `registeredIdentityCount`, frozen into the proposal as
`eligibleVotersAtCreation` when it is created. Voting needs `isVerified`, which
turns false once a required claim expires or is revoked, yet the identity
stays registered and keeps counting toward the denominator. Operators must
call `deleteIdentity` for every such identity BEFORE creating a proposal;
deleting mid-vote does not move the bar of a proposal already open. The case
"expired claims inflate the denominator until deleteIdentity" in
`test/governance/QuorumIntegrity.test.ts` is the executable version of this rule.
Governance holds VGT fees as a trusted contract (option 74 adds it while the
deployer still owns ComplianceRules): it has no identity and never counts in
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

## Handover ceremony

After the ceremony the deployer (wallet 0) holds no power: governance owns
Token, GovernanceToken (VGT), IdentityRegistry, ComplianceRules,
OracleManager, InvestorTypeRegistry (when deployed) and itself; ops
(wallet 10) holds the agent roles, the compliance-officer role and the
oracles and claim issuers the deployer owned; the guardian (wallet 11) can
pause the token but not unpause it. Issuer ownership moves by nominate and
accept: the deployer's `transferOwnership` only nominates ops, so on Sepolia
— where ops is a multisig, not a signer the script controls — the ops
multisig must itself execute `acceptOwnership` and the deployer-key revoke
for each claim issuer. Deploy governance (option 74) after the
oracle system (option 31) so OracleManager is a bound target. In the demo,
run 83c (deployer grants ops and guardian, removes itself, nominates
governance), then 83d (one acceptOwnership vote per nominated contract,
InvestorTypeRegistry included as an InvestorTypeConfig vote), then 83e
(prints every check as pass or fail). 83b stays as the single-registry
shortcut; if it ran first the ceremony skips the registry's nomination and
queues its officer changes as InvestorTypeConfig proposals, which 83d votes
through after the ownership votes (ops becomes officer, the deployer stops
being one).
Before its first transaction the ceremony runs a read-only preflight and
refuses to start rather than stop halfway: governance bound to every plan
contract; each plan contract owned by the deployer, or already by governance
where the deployer never calls it (Token, VGT, IdentityRegistry and
ComplianceRules must still be the deployer's); no issuer where the deployer
holds a key but not ownership; ops a signer wherever it must accept or revoke
on an issuer, and no ops key on it that is revoked or of another purpose
(it cannot be re-added as MANAGEMENT_KEY); each oracle owned by the
deployer or ops, and an ops-owned oracle whose `listManager` is still the
deployer fails, because only ops can clear it.
Two hazards are fixed rather than only reported: step 1 clears any VGT
guardian ("VGT guardian cleared: no guardian may pause the vote token; a VGT
pause blocks every vote until ops or a pre-voted unpause releases it"), and
step 2 moves an oracle's `listManager` off the
deployer to the DynamicListManager, or to zero when there is none.
83e also checks: GovernanceToken has no guardian, no oracle's `listManager`
is the deployer, the deployer is not an InvestorTypeRegistry governor or a
trusted contract, governance is a trusted contract and has no registry
identity (D21), and every address still trusted on ComplianceRules (found
from `TrustedContractAdded` events) is a deployed contract, not a wallet or
delegated wallet; a wallet trusted before 2E.1 must be removed by the owner
before the handover counts as complete. Preflight refuses to start on a
governance that is untrusted or still registered (a pre-D21 deployment).
The votes need a proposer plus quorum voters that are verified VGT holders
among wallets 0 to 9: options 23/24 and 3/4 onboard them, 75a then 75/75b
fund them; without them 83d refuses exactly as 83b does. Onboard first:
after 83c the deployer can no longer register identities.
After the ceremony governance owns VGT and ops (a VGT agent) distributes it;
`distributeGovernanceTokens` sends from the caller's own balance, so option
75 (signed by wallet 0) must fund voters before 83c, and afterwards ops mints.
When option 84 has deployed `DynamicListManager`, the ceremony nominates it
and governance accepts it by a ListUpdate vote like the core contracts; the
oracles' list-manager writer role (`setListManager`) is set by the oracle
owner, which is the deployer (option 84) before the ceremony and ops after it.
A ListUpdate add carries the duration voters approved in its calldata
(seconds, or no expiry as `type(uint256).max`; the manager rejects 0), so
no entry lapses by an unstated default; a permanent entry still ends by a
removal vote, by the oracle owner (ops) or by an oracle consensus clearing;
an emergency listing never shortens an entry (the longer expiry wins).

Outside the demo, `HANDOVER_CONFIG=<path.json> npx hardhat run
scripts/handover.ts --network <net>` runs the same ceremony and exits
non-zero on any failure. The JSON holds the addresses `token`,
`governanceToken`, `identityRegistry`, `complianceRules`, `oracleManager`, `governance`, the
optional `investorTypeRegistry` and `dynamicListManager`, the `oracles` and `issuers` arrays, the
optional `fromBlock` (the ComplianceRules deploy block, where the trusted-contract
event scan starts; the scan reads logs in 5000-block chunks), and the
wallet indices `ops`, `guardian`, `proposer` and `voters` (an array).

## Waiting instead of jumping

The four demo paths that used to call `evm_increaseTime` (governance option
79, ownership-by-vote 83b, escrow 73a and 73b) now go through
`demo/utils/ChainTime.advancePast`. It reads the real deadline from the
chain, jumps if the node allows it, and otherwise polls until the deadline
has passed. The 13-of-14-day escrow demonstration is dev-node only and says
so on a network that cannot jump.

## Local rehearsal (do this before Sepolia)

```bash
MNEMONIC="<your phrase>" npx hardhat node          # funds the 12 role wallets
GOV_TIME_SCALE=1440 npm run demo:interactive:proof   # in another terminal
```

Then walk: 1 (deploy), 74 (governance), 75 (distribute VGT to 6-8), 76
(Alice proposes), 77 (Bob and Carol vote), 79 (wait ~8 min), 78 (execute),
78a (claim on a rejected one). Every action is signed by its role's key.
Name the treasury wallet and exempt it from investor limits (option 22 or 51,
or `setInvestorLimitExempt` directly) BEFORE the ceremony, while the deployer
owns the registry; afterwards only an InvestorTypeConfig vote can (option 76,
type 0, choice 2).

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
   role wallet, call `addTrustedContract` on it and expect the revert
   "ComplianceRules: delegated wallet". Sending a type-4 transaction needs an
   ethers version with authorization-list support.

## Transfer gas by required claim topics

`Token.transfer` verifies each party once (`IdentityRegistry.isVerified` on
sender and recipient); `ComplianceRules.canTransfer` verifies only the escrow
counterparty on trusted transfers. `scripts/gas-analysis.ts` measures a real
second transfer (after a warm-up) for three deployments: the permissive
`MockIdentityRegistry` with compliance bound to it as the baseline, one
required topic (KYC), and two (KYC+AML). The remaining cost is one cold
`isVerified` walk per party per topic: three external calls
(`IdentityRegistry -> OnchainID -> ClaimIssuer`) plus a claim-struct copy.
The two-topic delta is still about 7x the 40,000 gas tolerance, so the next
lever is plan v2 decision D17 (verified-until cache) or a leaner claim read
on OnchainID.

**Before Task 2A.7 (measured 2026-09-26):**

| Scenario | transfer gasUsed | delta vs A | isVerified est. |
|---|---|---|---|
| A: MockIdentityRegistry (baseline) | 77,361 | 0 | 23,938 |
| B: IdentityRegistry, 1 topic (KYC) | 276,471 | +199,110 | 104,428 |
| C: IdentityRegistry, 2 topics (KYC+AML) | 447,939 | +370,578 | 179,670 |

The 2-topic delta over baseline (370,578 gas) is well above the 40,000
gas threshold the cleanup plan uses as a trigger for a per-wallet
verified-until cache — each additional required topic adds a full
`IdentityRegistry -> OnchainID -> ClaimIssuer` cross-contract call chain
per verified party, not just a single storage read. Re-run with
`npm run gas:claims` (fresh in-process Hardhat network, no external node
needed).

**After Task 2A.7 (measured 2026-09-27):**

| Scenario | transfer gasUsed | delta vs A | isVerified est. |
|---|---|---|---|
| A: MockIdentityRegistry (baseline) | 93,696 | 0 | 23,938 |
| B: IdentityRegistry, 1 topic (KYC) | 244,732 | +151,036 | 104,428 |
| C: IdentityRegistry, 2 topics (KYC+AML) | 386,716 | +293,020 | 179,670 |

Task 2A.7 made Token the single identity gate (ERC-3643 shape), so
`ComplianceRules.canTransfer` no longer re-verifies sender and recipient on
the normal path (two `isVerified` calls per transfer instead of four), and
scenario A now binds `ComplianceRules` to the mock (whose `investorCountry`
returns `uint16`), which is why the baseline rose while B and C fell.

Deploying all eleven contracts costs under 0.01 ETH at 1.3 gwei.
