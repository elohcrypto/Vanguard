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
| 9 | Deliberately unverified; issuer admin | rejection demonstrations; after the handover, owner of every claim issuer the deployer held (D25 b) |
| 10 | Ops multisig stand-in | agent roles, compliance officer, oracle ownership and the escrow factory's ADMIN_ROLE after handover |
| 11 | Guardian | pause only |

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

| GOV_TIME_SCALE | InvestorTypeConfig vote | delay | Use |
|---|---|---|---|
| 1 | 7 days | 2 days | mainnet, tests |
| 336 | 30 min | ~9 min | Sepolia walkthrough |
| 1440 | 7 min | 1 min | local rehearsal (the ceiling) |

## KYC claims and verification (2F.2)

`IdentityRegistry.isVerified` asks each issuer trusted for a required topic
(`ClaimIssuer.hasValidClaim(identity, topic)`); it does not read the
identity's own claim list, which anyone can pad with claims naming
themselves. The issuer's `issueClaim` still writes a copy onto the
OnchainID (ERC-735 view), but nothing reads that copy to decide
verification; correctness rests on the issuer's record. Verification
follows the issuer's latest claim per topic for that identity: revoking the
latest claim unverifies the holder in the same block, even if an older claim
is unrevoked, and revoking an older, superseded claim has no effect; the
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

## Handover ceremony

After the ceremony the deployer (wallet 0) holds no power: governance owns
Token, GovernanceToken (VGT), IdentityRegistry, ComplianceRules,
OracleManager, InvestorTypeRegistry (when deployed), the EscrowWalletFactory
and OnchainIDFactory (when deployed), PrivacyManager and ZKVerifierIntegrated
(option 1 deploys them) and itself; ops (wallet 10) holds the
agent roles, the compliance-officer role, the escrow factory's ADMIN_ROLE,
PrivacyManager's `listOperator` (it publishes the whitelist root), the
oracles the deployer owned and OracleManager's operator role (pause,
unpause and emergency designation of nodes, Task 4.4); the issuer admin (wallet 9) owns the
claim issuers the deployer held; the guardian (wallet 11) can pause the
token but not unpause it. Issuer ownership moves by nominate and accept:
the deployer's `transferOwnership` only nominates the issuer admin, so on
Sepolia, where it is a multisig the script does not control, that multisig
must itself execute `acceptOwnership` and the deployer-key revoke for each
claim issuer. The demo's issuers are owned by wallets 2 and 3 from deploy,
so the ceremony leaves them there (no ops key on them; the separation check
passes).
The deployer's powers are read from chain, not from the config (2F.5): the
oracles ComplianceRules binds to VSC and VGT, the registry's trusted issuers
of each required topic, each oracle's `listManager`, the DynamicListManager
governance is bound to, and the contracts bound to types 9 to 12 (the two
factories, PrivacyManager, ZKVerifierIntegrated). Step 3 nominates each
and binds its type (`setEscrowWalletFactory`, `setOnchainIDFactory`,
`setPrivacyManager`, `setZKVerifier`, which accept only a contract whose
pending or current owner is governance) while the deployer still owns
governance; step 4 accepts each by an EscrowFactoryParameters,
IdentityFactoryParameters, PrivacyParameters or VerifierParameters vote;
the factory's DEFAULT_ADMIN_ROLE follows ownership, and step 5 grants ops
the escrow factory's ADMIN_ROLE before the deployer renounces it and makes
ops PrivacyManager's `listOperator`. After the ceremony a whitelist root
is published by ops or by a PrivacyParameters vote, never by the deployer,
and `updateVerifier` needs a VerifierParameters vote. A contract that is
not deployed is skipped with a line. Deploy governance (option 74) after the
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
holds a key but not ownership; the issuer admin a signer wherever it must
accept or revoke on an issuer, and no issuer-admin key on it that is revoked
or of another purpose (it cannot be re-added as MANAGEMENT_KEY); each oracle
owned by the deployer or ops, and an ops-owned oracle whose `listManager` is
still the deployer fails, because only ops can clear it. Since 2F.5 it also
refuses: an `oracles` or `issuers` list that omits a contract bound on chain
(an extra one is handed over with a warning; leave a list out to use the
chain's set); a config that does not name a DynamicListManager, factory or privacy
contract governance is already bound to; a `zkVerifier` that is not the
verifier PrivacyManager uses, and a testingMode verifier; a PrivacyManager,
ZKVerifierIntegrated or any of the wrapper's five circuit verifiers whose
runtime code hash is not the compiled artifact's (an always-true verifier
swapped in, or a look-alike wrapper that reports governance as owner; the
refusal names both hashes, and 83e checks the same pins); a missing issuer admin while any issuer is
trusted, or one that is the deployer, ops, the guardian or governance; any
IdentityRegistry agent (ops after step 5, and any other agent found in
`AgentAdded` events) that owns, is the pending owner of, or holds a live
MANAGEMENT or CLAIM_SIGNER key on a trusted issuer, and an issuer admin
that is a registry agent; an oracle `listManager` that is neither the
deployer nor the governance-bound DynamicListManager; an open
InvestorTypeRegistry proposal (cancel it first) and any registry governor
besides the deployer (`GovernorUpdated` events). Run the ceremony from a clean checkout of the reviewed commit after `npx hardhat clean && npx hardhat compile`: the pins compare against the local `artifacts/`, so a tree compiled by `npx hardhat coverage` (instrumented bytecode) or re-generated by `setup:zk` after the deployment refuses an honest deployment, and a tree with edited sources would accept its own edits (the completion report names the commit and flags a dirty tree). It also refuses a guardian
or ops that is the deployer or governance, a paused VGT (every acceptance
vote would revert), and a blacklist oracle bound to VGT. Never bind a
blacklist oracle to VGT (D23): a listed governance halts every fee flow.
For the same reason it refuses VGT in whitelist mode ZkOnly or Either
(D33): every vote and proposal fee would then need a whitelist binding,
so ops, the list operator, could halt governance by publishing one root,
and the acceptance votes would revert halfway; set VGT back to OracleOnly
first. It also refuses a VSC or VGT whose `compliance()` is not the
config's `complianceRules` (governance would own a ComplianceRules the
token does not enforce).
An `investorTypeRegistry` governance is not bound to is left out with a
warning only when the Token does not enforce it; if the Token does, preflight
refuses (redeploy governance after the registry, or point the Token at the
bound one), and 83e keeps a line for any registry left out.
Two hazards are fixed rather than only reported: step 1 clears any VGT
guardian ("VGT guardian cleared: no guardian may pause the vote token; a VGT
pause blocks every vote until ops or a pre-voted unpause releases it"), and
step 2 moves an oracle's `listManager` off the
deployer to the DynamicListManager, or to zero when there is none, and
makes ops OracleManager's operator.
83e also checks: GovernanceToken has no guardian, no oracle's `listManager`
is the deployer, the deployer is not an InvestorTypeRegistry governor nor a
trusted contract on VSC or VGT, governance is a trusted contract on VGT and
has no registry identity (D21), and every (token, address) pair still
trusted on ComplianceRules (found from the token-indexed
`TrustedContractAdded` events) is a deployed contract, not a wallet or
delegated wallet; a wallet trusted before 2E.1 must be removed by the owner
before the handover counts as complete. Each live ComplianceRules
trusted-contract registrar (from the token-indexed `TrustedRegistrarSet`
events) gets a line naming its token and code hash; it passes only when the
registrar has code and the hash is the compiled `MultiSigWallet` or
`MultiSigEscrowWallet`, and the preflight refuses either failure before
step 1 (clear it with `setTrustedRegistrar(token, registrar, 0)`). A
further line fails when any registrar, or any InvestorTypeRegistry
compliance officer that is a contract, is not owned by ops or governance
(a deployer-owned InvestorRequestManager could still assign investor
types). It also fails on any live
ComplianceRules rule administrator other than governance and ops, on any
token (found from the token-indexed `RuleAdministratorUpdated` events, plus
the deployer on VSC and VGT; the constructor authorizes nobody): a rule
administrator sets that token's jurisdiction rule, which also lapses every
private jurisdiction record. The ceremony makes governance the rule
administrator for VSC and VGT and removes the deployer from both. And it checks
"GovernanceToken whitelist mode is OracleOnly (D33)" and that VSC and VGT
enforce the config's ComplianceRules. It checks every contract read from
chain as well as those the config names, "EscrowWalletFactory owned by
governance, deployer holds no role", "OnchainIDFactory owned by
governance", "no IdentityRegistry agent owns or holds a key on a trusted
issuer (D25 b)" and "InvestorTypeRegistry: no governor but governance, no
open proposal". It prints warnings that do not fail it: the deployer's
remaining VSC with its exemption and verification (the demo deployer keeps
100M VSC, verified and exempt, as the treasury artifact: move it and remove
the exemption by vote), escrow fee wallets that are not exempt or were
registered after the handover, and a current whitelist root the deployer
published ("republish as ops so deployer-era bindings lapse") or an issuer
key the deployer trusted on PrivacyManager; when either of these two
fires, `scripts/handover.ts` and 83e close with "Handover complete with
warnings: see above" instead of "the deployer holds no power". The InvestorTypeRegistry's own proposals
now belong to the governor set they were created under (every `setGovernor`
bumps `governorEpoch`, so the ceremony's removal of the deployer kills any
planted proposal), expire 7 days after their execution time, and pass the
same whitelist-tier check as `updateInvestorTypeConfig`. Preflight refuses to start on a
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
Oracle consensus verdicts (a query in OracleManager, resolved by the
registered oracle nodes, then applied by one node's `provideAttestation`)
follow four rules. A query is raised only by the OracleManager owner or an
active oracle, and a blacklist query fixes its severity (so its duration)
when it is raised (`abi.encode(uint8)`, empty = MEDIUM); the severity a
node passes when it attests is ignored. Answering yes accepts the query's
severity, and a node can raise at most HIGH: only the OracleManager owner
raises a CRITICAL (365-day) query. A resolved verdict is final (no
responses after it resolves), except that the OracleManager owner's
`emergencyOverride` may flip it before it is applied; it is applied once
per oracle contract (`VerdictAlreadyApplied`). It is usable for
`maxVerdictAge` after it resolved, 1 day by default, owner-settable between
1 hour and 30 days (`VerdictExpired`). Verdicts are ordered by resolution
time, not by when a node applies them: each oracle keeps `lastWriteAt` per
subject (the time of a governance vote, including a no-expiry sanction, an
emergency listing, an owner write or a removal; for an applied verdict,
even one that changed nothing, its resolution time), and a verdict that
resolved at or before it is refused (`VerdictSuperseded`). So an older
verdict applied late never undoes a newer one, and a newer one still
applies after it. Options 33a, 34a, 35a, 37 and 40 raise OracleManager
queries; ConsensusOracle is the manager's engine and keeps no queries of
its own (Task 4.4, "Oracle nodes and consensus" below).

Outside the demo, `HANDOVER_CONFIG=<path.json> npx hardhat run
scripts/handover.ts --network <net>` runs the same ceremony and exits
non-zero on any failure. The JSON holds the addresses `token`,
`governanceToken`, `identityRegistry`, `complianceRules`, `oracleManager`, `governance`, the
optional `investorTypeRegistry` and `dynamicListManager`, the required keys
`escrowWalletFactory` and `onchainIDFactory` (an address, or `null` when not
deployed: only the OnchainIDFactory is unreachable from the core
contracts; the escrow factory is also read from every trusted escrow's
`factory()`, and a config that does not name it is refused), the required
keys `privacyManager` and `zkVerifier` (an address, or `null` when not
deployed; `null` is refused when governance is already bound to the
contract, `zkVerifier` must be the verifier PrivacyManager uses, so it
cannot be `null` while a PrivacyManager is named, and a testingMode
verifier is refused; a PrivacyManager that ComplianceRules wires for VSC
or VGT, `privacyManager(token)` for the ZkOnly/Either whitelist modes, is
in the ceremony even before governance is bound to it, so `privacyManager`
must name it, and two different ones wired or bound are refused), the optional `oracles` and `issuers` arrays (omitted: the
set read from chain), the optional `feeWallets` array (escrow fee wallets
to check for the exemption), the
optional `fromBlock` (where the event scans start: trusted contracts,
registry agents, registry governors, escrow investors and roles; a block
no later than the IdentityRegistry deploy, refused when the registry
already has code before it; the demo records the IdentityRegistry deploy
block at option 1) and `logChunk` (the
scan's block range, default 5000, halved down to 100 when the RPC refuses a
range), and the wallet indices `ops`, `guardian`, `issuerAdmin` (required
whenever the registry trusts an issuer), `proposer` and `voters`
(an array). Before step 1 it checks that the proposer and every voter are
verified and hold the VGT fees for every proposal. After a partial run,
`HANDOVER_PHASE=accept` skips the deployer steps and votes only the
acceptances and registry proposals still pending, then verifies.

### Runbook rules for the ceremony and after (plan 2F)

- Register every voter at least 7 days (`minVoterAge`) before the
  ceremony's first proposal (D25); a dev node jumps, Sepolia waits.
- Exempt the escrow fee wallets and the treasury before the ceremony, while
  the deployer owns the InvestorTypeRegistry; after it only an
  InvestorTypeConfig vote can (R-2F4-2). The completion check warns about a
  fee wallet that is not exempt.
- Settle every open proposal (vote it through or let it settle and refund)
  before any vote that moves a bound contract's ownership, and trust the
  new owner first (A-N3, R-2F1-1): a ComplianceRules owner that does not
  trust governance makes `createProposal` revert and strands open deposits.
- A wallet recovered with `recoveryAddress` votes only after KeyManager
  recovery gives it a key on its OnchainID (R-2F2-3).
- Oracle consensus may clear a permanent (governance, no-expiry) blacklist
  entry when its verdict resolved after the governance write (D27 = a):
  watch `BlacklistUpdated` events whose reason is "Oracle consensus
  clearing" on permanent entries. The emergency-oracle key and the
  oracle-owner key (ops) must be held by parties able to re-list within
  hours. Node operators' runbook: clearing a governance sanction is visible
  on chain and accountable; ops, the OracleManager operator, can pause a
  node at once, and governance removes it (`removeOracle`) by an
  OracleParameters vote (option 76, type 2).
- Before step 1, cancel every open InvestorTypeRegistry proposal and remove
  every registry governor but the deployer; the ceremony refuses otherwise.
- Never give one key both an IdentityRegistry agent role and an issuer
  owner or signer role (D25 b), and never vote away the last trusted issuer
  of a required topic or the last topic (the registry refuses both).
- Option 61 after the handover creates a ComplianceRules proposal naming
  the new escrow factory a trusted-contract registrar on VSC
  (`setTrustedRegistrar(VSC, factory, MultiSigEscrowWallet code hash)`;
  vote with 77, execute with 78); no escrow can be created until it passes.
  Option 63 needs no vote: the factory trusts each escrow it deploys.
- Revoking a whitelist binding is root rotation: publish a root without
  the commitment (ops, or a PrivacyParameters vote). Expiry alone does not
  revoke, since a holder may resubmit the same proof under the same root
  to refresh it. Under ComplianceRules whitelist mode ZkOnly (and Either
  without a whitelist oracle) a root rotation, or an expired binding,
  pauses every affected holder, escrow releases to them included, until
  they re-prove; burns stay open.

### Whitelist roots and proofs from the command line (Task 3.5)

The investor keeps a secret and hands the operator only the commitment
`Poseidon(identity, secret)`, where the identity is the investor's
OnchainID address. The secret is read from a file or `WHITELIST_SECRET`,
never from the command line, and is never printed. Generate it with
`--new-secret`: a secret below 2^128 is refused, because the leaves and the
OnchainID addresses are public, so a small secret can be recovered by
trying values, and whoever recovers it binds their own wallet first.

```bash
# Investor, once: a fresh secret (31 random bytes) in a new file with mode
# 0600 (an existing file is refused); keep the file offline
node scripts/zk/prove-whitelist.js --new-secret --out secret.txt

# Investor, at onboarding: the commitment to hand the operator
node scripts/zk/prove-whitelist.js --commitment --identity <onchainID> --secret-file secret.txt

# Operator (ops, the listOperator): entries.json is
# [{ "identity": "<onchainID>", "commitment": "<0x..>" }, ...], one per identity
WHITELIST_OPS_KEY=<ops key> node scripts/zk/build-whitelist-root.js \
  --in entries.json --out root.json --publish --rpc <url> --privacy-manager <addr>

# Investor, with the published root.json: prove, bind the wallet, show the status
WHITELIST_WALLET_KEY=<wallet key> node scripts/zk/prove-whitelist.js \
  --root root.json --identity <onchainID> --wallet <wallet> --secret-file secret.txt \
  --out proof.json --submit --rpc <url> --privacy-manager <addr>
```

Leaf order is the order of `entries.json`, so the same file always gives
the same root. Without `--submit` the prover prints the calldata
`{ proof, signals }` for `submitWhitelistProof` and refuses a commitment
that is not in `root.json`. With `--submit` it also refuses a root that is
not the current published one: when nothing is published yet it prints the
publish command for ops; when ops has published a newer root it asks for
the current `root.json` and a new proof (an old root is never
republished, which would lapse every binding under the current one).
The builder enforces the operator's side of that rule: `--publish` reads
every `WhitelistRootPublished` of the root from block 0 (or
`--from-block <n>`) and refuses a root that was ever published before
unless `--force`, because an old root, rebuilt for instance from an old
`entries.json` backup, re-admits investors removed since. When the
`--out` file exists, it first prints how many commitments the new build
adds and removes against it. The prover warns on stderr when
`--secret-file` is readable by group or others, and when `--new-secret`
writes to stdout instead of `--out`.
Demo option 42 -> 1 builds roots and proofs with the same functions but
publishes the root directly (`publishWhitelistRoot`), without the old-root
history check, which is the CLI builder's.

### The ZK allow list on the live token (Task 3.6)

Option 1 deploys the privacy pair, `ZKVerifierIntegrated` with
`testingMode` false and `PrivacyManager` on it; option 21 points
ComplianceRules at it for VSC (`privacyManager(VSC)`) and leaves the
whitelist mode at OracleOnly, so nothing changes for transfers yet. The
handover ceremony reads the PrivacyManager from that wiring. Option 41
attaches the pair (it deploys the same real pair only when option 1 has
not run), initialises the proof generator and prints the wiring; option
41b shows the verifier, the circuits and the generator. The demo has no
mock mode: every proof is real, and mocks exist only in `test/`.

Option 42 -> 1 publishes a root, binds the chosen wallet, then runs five
steps on VSC: (a) it switches VSC to whitelist mode Either (the deployer
owns ComplianceRules until the handover; afterwards it prints the
ComplianceRules vote needed); no whitelist oracle is bound, so Either is
an allow list of PrivacyManager bindings and every holder without a live
binding is refused (mint recipient and transfers, not burns); (b) the
bound wallet sends VSC to another listed, verified wallet, which proves
and binds first; (c) a verified wallet without a binding is refused
(shown with `canTransfer` and a static call); (d) ops or the owner
publishes a root without the sender's commitment: the version bump lapses
the binding, the transfer is refused and the sender cannot re-prove; (e)
the sender re-onboards with a new secret, both wallets re-prove and
re-bind under the new root, and the transfer goes through again. The
smoke (`scripts/demo-smoke-privacy.js`) runs the same steps on wallets 6
to 8 before the handover and leaves VSC in Either.

Option 42 -> 2 (blacklist proof, Task 3.7) proves that the wallet's holder
owns a commitment in the current whitelist root whose identity is not in
the sanctions tree, a sparse Merkle tree built from the wallets the
BlacklistOracle lists, each resolved to its OnchainID (a wallet without one
stands in with its own address, as for the whitelist). It needs a live whitelist binding from option 42 -> 1 and
verifies through `ZKVerifierIntegrated.verifyBlacklistNonMembership`; it then
shows that a listed identity cannot prove. Nothing on chain gates on it
(D2): VSC's blacklist gate reads the BlacklistOracle directly and at once,
and PrivacyManager refuses the circuit. The proof's `blacklistRoot` is not
published on chain, so whoever checks the proof rebuilds that root from the
oracle's list (wallets resolved like the whitelist: OnchainID, else the
wallet address) and compares it.

### Issuer-signed attestations (Task 3.7b, D31 a)

The jurisdiction, accreditation and compliance-aggregation proofs show
that a trusted issuer signed the investor's attributes and that they meet
PrivacyManager's policy, without revealing them. The issuer holds an EdDSA
Baby Jubjub key; PrivacyManager trusts its public key (Ax, Ay) per circuit
(`setTrustedAttestor`) and holds the policy: the allowed jurisdiction mask
(below), `minimumAccreditation`, and the compliance minimum with four
weights summing to 100 (`setCompliancePolicy`). A proof records
{policyHash, attestor, nullifier, expiresAt} for the wallet that submits
it, one wallet per attestation per policy; a policy change, an untrusted
issuer key or expiry lapses it, and a policy change (a ComplianceRules
rule change for VSC included) re-admits the same attestation for a new
proof, from any wallet. Like a whitelist root version, every policy change
(a policy token or code registration, either policy setter) and every
trust change of a key starts a new epoch: restoring a policy or
re-trusting a key never revives an old record, holders resubmit.

An attestation is per chain and per PrivacyManager (Task 3.8 review M1):
the issuer signs the chain id and the PrivacyManager address with the
attributes, PrivacyManager refuses a proof naming another chain or
another PrivacyManager, and the prover refuses before proving. An issuer
key trusted on two deployments therefore cannot carry an attestation from
one to the other, where the same bit may mean another country; after a
redeploy, issuers sign again for the new PrivacyManager.

An attestation also expires on a date the issuer sets (Task 3.10, D32 a):
`attest.js --sign` requires `--valid-days <n>` or `--valid-until <ISO 8601
UTC date>` (`2027-01-01` or `2027-01-01T00:00:00Z`; other forms are
refused) and refuses a date not in the future; the issuer signs that
`validUntil` with the attributes and the proof publishes it. PrivacyManager
refuses the proof from `validUntil` on (`AttestationExpired`), and a
record's `expiresAt` is `min(submission + proofValidityPeriod,
validUntil)`, so a record never outlives its attestation and the same
calldata cannot be resubmitted after it: a lapsed accreditation or a
dropped score needs a new attestation, which renews the record. The
prover refuses an expired attestation before proving, naming the date.

The jurisdiction set for private proofs is ComplianceRules' rule for VSC
(Task 3.8): the one transfers enforce, with no second list to keep in
step. PrivacyManager names the token with `setPolicyToken(VSC)` and reads
its ComplianceRules from `VSC.compliance()` on every use, so a Token vote
moving VSC to a new ComplianceRules moves the private path with it; it
keeps only the code-to-bit table issuers attest: each ISO 3166-1
numeric code gets the next of 64 bits with `registerJurisdictionCode`, and
a bit never moves. The allowed mask is the OR of the bits of the
registered codes that `ComplianceRules.validateJurisdiction(VSC, code)`
admits (the default blocked list, then VSC's own rule). Blocking a country
in ComplianceRules (a ComplianceRules vote after the handover) is enough
to stop its holders on the private path; every `setJurisdictionRule` or
`clearJurisdictionRule` for VSC bumps `jurisdictionRuleVersion(VSC)`,
which is part of the policy, so it lapses every jurisdiction record
whatever the holder's country, and restoring the rule revives none. A
code without a bit cannot be attested until it is registered. Option 21
points PrivacyManager at VSC's rule and registers its allow list in order
(840 is bit 1), printing the bits; the ceremony refuses a PrivacyManager
whose policy token is not VSC. A code added to VSC's allow list later
(the jurisdiction-list menu, or a ComplianceRules vote) gets no bit by
itself: rerun option 21 or 41 before the handover, or pass a
PrivacyParameters vote for `registerJurisdictionCode` after it, before
investors from that country can attest. Today a Token round trip back to
an earlier ComplianceRules whose rule did not change (R1 -> R2 -> R1)
revives the records made under it. Task 4.1 does not change that:
ComplianceRules never sees a `Token.setCompliance`, so the fix belongs to
PrivacyManager (a test pins the current behaviour). Task 4.1, the
ComplianceRules split, is fresh-deploy only (D34 a): governance binds its
ComplianceRules at construction, so an existing deployment is redeployed
rather than migrated, and a fresh ComplianceRules starts OracleOnly with
no oracle, an open whitelist, until it is configured.

```bash
# Issuer, once: the private key is printed once; keep it offline
node scripts/zk/attest.js --new-key
# Issuer: the public key for the setTrustedAttestor vote, then sign
ATTESTOR_KEY=<key> node scripts/zk/attest.js --public-key
ATTESTOR_KEY=<key> node scripts/zk/attest.js --sign --circuit jurisdiction \
  --identity <onchainID> --country <ISO numeric> --rpc <url> \
  --privacy-manager <addr> --valid-days 365 --out att.json
#   or --valid-until 2027-01-01 (ISO 8601 UTC); the expiry is required
#   offline: --chain-id <id> --privacy-manager <addr> --mask <its bit>
#   ... --circuit accreditation --amount <amount>
#   ... --circuit compliance --scores <kyc,aml,jurisdiction,accreditation>
# Investor: policy and issuer trust read from PrivacyManager
WHITELIST_WALLET_KEY=<wallet key> node scripts/zk/prove-attestation.js \
  --attestation att.json --wallet <wallet> --rpc <url> \
  --privacy-manager <addr> --out proof.json --submit
```

The issuer key comes from `ATTESTOR_KEY` only, never argv, and is printed
only by `--new-key`. The attestation file carries the salt and the
signature: it is the investor's secret, written with mode 0600, and the
prover never prints either. The prover refuses an untrusted issuer key, an
expired attestation, a stale policy and attributes that miss the policy
before proving, verifies
the proof locally, and with `--submit` exits non-zero unless the record
reads valid. Before the handover the owner calls the setters; after it a
PrivacyParameters vote (type 11) does: trust the issuer's key for each
circuit it vouches for, untrust the demo key, and set
`setMinimumAccreditation` / `setCompliancePolicy`, and give new codes a
bit (`registerJurisdictionCode`); which codes are allowed is VSC's
ComplianceRules rule.

In the demo, option 1 (or 41 when it deploys the pair) makes a demo issuer
key for the session, never printed, trusts it for the three circuits and
sets minimum accreditation 100000 and compliance minimum 70 with weights
25/25/25/25, printing the public key and the policies; option 21 wires the
jurisdiction source, and 42 -> 3 asks for an ISO numeric code. Options
42 -> 3, 4 and 5 sign for the chosen wallet with a one-year validity,
prove and bind through the same library and print the attestation's
expiry, the record and the validator's answer; 44, 45 and 46 read
PrivacyManager's records and validators and show each record's expiry
next to its attestation's. The handover completion lists the
trusted attestors per circuit and warns when one has none, the jurisdiction
source and policy token, and the number of jurisdiction bits; the demo key
stays trusted after the ceremony until a vote untrusts it.

## Investor custody (Task 4.3, D13 b)

The "2-of-2 multisig" of option 23 is the on-chain `MultiSigWallet`.
Options 21 and 51 (whichever runs second) deploy `InvestorRequestManager`
for VSC with the bank = ops (wallet 10), make it an InvestorTypeRegistry
compliance officer and a ComplianceRules registrar on VSC for the
compiled `MultiSigWallet` code hash, set the lock requirements within the
Normal one-transfer cap (2,000 / 4,000 / 8,000 VSC), and hand its
ownership to ops, so the deployer keeps no custody power.

Who signs what in option 23: the user requests (2); the bank creates the
wallet (4), which the manager trusts on VSC in the same transaction; the
user approves the wallet, locks (the tokens move into it, the user's
balance falls) and confirms (5); the bank approves (6); a downgrade (8) is
a 2-of-2 unlock, proposed and signed by the user, signed by the bank, of
everything the wallet holds, then Normal again. There is no unfreeze path.
Option 62 uses the wallet as the investor's escrow fee wallet.

The registrar model: only the ComplianceRules owner (governance after the
handover) may trust an arbitrary contract or remove trust. A registrar is
a contract the owner named per token with one code hash; it may trust
only accounts with that code. Ops and rule administrators have no trust
power. `InvestorRequestManager` and `EscrowWalletFactory` are the two
registrars; the handover ceremony lists both (see 83e). Revoking a
registrar (`setTrustedRegistrar(token, registrar, 0)`) stops new trust
only: the wallets it already trusted stay trusted until the owner removes
each with `removeTrustedContract`.

Options 23 and 62 to 69 ask sub-prompts, so `demo-drive.sh` cannot drive
them (it answers the main menu only); `scripts/demo-smoke-custody.js`
runs the custody flow on the live node in the smoke.

## Oracle nodes and consensus (Task 4.4, D11 a)

OracleManager is the gate and ConsensusOracle its engine. A query opens in
OracleManager (`submitQuery`, by the owner or an active node), nodes
answer there (`submitResponse`, the one vote entry), and the engine
resolves a side once it holds `consensusThreshold` percent of the weight
of every node registered when the query opened, active or paused: 66% by
default, two of the three equal nodes option 31 registers (wallets 1, 2
and 3, reputation 500). A paused node stays in the denominator but cannot
answer, so pausing never lowers the bar: with two nodes paused the third
cannot resolve alone. A node registered after the query opened cannot
answer it, and weight or threshold changes apply to later queries only. A query expires after `queryExpiryTime` (1 hour)
without a verdict; raise a new one. One node then applies the verdict
with `provideAttestation` on the Whitelist or Blacklist oracle.

Who does what: the operator (ops, wallet 10) pauses and unpauses nodes
and sets or clears the emergency designation; unpause refuses a node at
the reputation floor (100), where `penalizeOracle` parks it, and ops
cannot unpause a node the owner (governance) paused. The owner
(the deployer, governance after the handover) registers and removes
nodes, sets the threshold, weights, expiry and the operator, and may
`emergencyOverride` a query. `BlacklistOracle.emergencyBlacklist` needs
OracleManager's designation and an active node, so pausing or removing
a node ends its emergency power at once.

Options: 31 deploys the manager, both oracles and the engine and binds
it; 32 designates node 2 (AML) and checks the 66% threshold (through
the manager, a proposal after the handover); 33a and 34a run a
whitelist and a HIGH blacklist round on a throwaway address (raise, two
YES answers, the verdict applied); 35a is the lifecycle: ops becomes the
operator, pauses node 3 (its answer is refused, nodes 1 and 2 still
resolve 200 of 300), pauses node 2 too (node 1 alone stays at 100 of 300,
unresolved), unpauses both (also after a failed step), designates node 2,
which lists
a throwaway address CRITICAL for 7 days, clears the designation (a
second listing is refused), restores it, and the owner registers and
removes a fourth node (skipped once governance owns the manager); 35a
refuses to start when ops could not undo its pauses (node 2 or 3 paused
by the owner or at the reputation floor); 37
asks sub-prompts for the same steps by hand; 40 runs a compliance round,
a 30-day whitelist entry and an emergency listing on throwaway
addresses, and says which owner-only steps it skips after the handover.
Option 76, type 2
(OracleParameters), proposes pause, unpause, removeOracle,
setEmergencyOracle, setConsensusThreshold or setOperator for governance
to vote (77, 78), from the first wallet among 0-8 that may propose. `demo-drive.sh --strict 1 21 31 32 33a 34a 35a 39 40`
runs with no error; 33, 34, 35 and 37 ask sub-prompts and are not
drivable. `DEMO_RPC_URL=http://127.0.0.1:<port>` points the drive at a
node on another port (network `devnode`).

`scripts/demo-smoke-oracles.js`, a leg of `scripts/demo-smoke.js`,
asserts from chain: the engine is bound both ways and its code is the
compiled ConsensusOracle, the threshold is 66%, the 33a and 34a rounds
resolve two of three (`ConsensusReached`, 200 of 300) and their verdicts
apply, 35a's paused node is refused as not active while two of three
still resolve 200 of 300, with two paused the third cannot resolve alone,
unpause restores both, the designation gates `emergencyBlacklist`, and an
expired query refuses answers and has no verdict.

The handover ceremony hands nothing over for the engine (it has no
owner). Before Step 1, without a transaction, the preflight refuses an
OracleManager with no engine, an engine with no code, whose runtime code
is not the compiled ConsensusOracle or that serves another manager, and
an operator other than ops once the deployer no longer owns the manager,
a threshold other than 66% and any registered node off the default
weight (review L-4: a deployer-era weight or threshold must not pass).
Step 2 makes ops the operator. 83e adds five lines: the engine is the
compiled ConsensusOracle and serves the manager, the threshold is 66%
(with the query expiry), every node carries the default weight, the
operator is ops, and the deployer is not an OracleManager node.
Re-binding the engine (owner only) strands queries open in the old one
(their answers revert `UnknownQuery`); only the ceremony pins the engine's
code hash, `setConsensusEngine` checks code and binding only.

## Waiting instead of jumping

The four demo paths that used to call `evm_increaseTime` (governance option
79, ownership-by-vote 83b, escrow 73a and 73b) now go through
`demo/utils/ChainTime.advancePast`. It reads the real deadline from the
chain, jumps if the node allows it, and otherwise polls until the deadline
has passed. The 13-of-14-day escrow demonstration is dev-node only and says
so on a network that cannot jump.

## Identity keys through KeyManager (Task 4.2)

Option 1 deploys `KeyManager` with the core contracts. It has no owner and
no allowlist: an identity opts in with `authorizeManager(keyManager)` from
its owner, and every rotation or recovery then needs a MANAGEMENT key of
that identity (docs/SYSTEM_WORKFLOW_GUIDE.md, "Identity key lifecycle").
The wallets the options use: wallet 1 (fee wallet, compliance officer)
owns the demo identity; wallets 7 and 8 (investors Bob and Carol) are the
recovery agents, chosen because they hold no issuer, ops or guardian role;
5 -> 2 falls back to wallet 6 (investor Alice) when the owner is 7 or 8.
Every print names each wallet's role.

- **12** (no prompts): wallet 1's identity (found in the registry or the
  factory, or created through the factory) authorizes KeyManager, adds a
  fresh MANAGEMENT key with `batchAddKeys`, rotates it to another fresh
  key through the rotation timelock (24 hours unless 12b set another),
  then wallets 7 and 8, as 2-of-2 recovery agents, recover the identity
  onto a third fresh key through the 48-hour timelock, the keys are
  listed, and the two keys the run created (held by nobody) are revoked
  with `batchRemoveKeys`. Wallet 1 keeps its own key. Run it again for a
  fresh round.
- **12a** (no prompts): withdraws KeyManager's authorization on that
  identity (`deauthorizeManager`) and shows KeyManager refusing a
  rotation; run again to restore it.
- **12b**: sets that identity's rotation timelock in hours (1 to 168).
- **5a** (no prompts, Task 4.5): on wallet 1's identity adds an ACTION
  key for a throwaway wallet, shows a stranger's signature refused, removes
  the key with the throwaway wallet's signature through
  `removeKeyWithProof` and reads `keyHasPurpose` and `getKey` back.
- **5**: picks an identity; 2 recovers it onto a new key (a wallet index,
  or a passphrase, which is only a label nobody can sign with), 3
  replaces one of its MANAGEMENT keys by a timelocked rotation, both
  through KeyManager; 1 removes a key at once, sent by the owner (a
  MANAGEMENT key): an address key through `removeKeyWithProof` with the
  key's own wallet signing the chain's `getRemoveKeyMessage` digest (the
  key's wallet must be a demo signer), a passphrase key through
  `removeKey`; it prints the method it called and reads the key back
  (`keyHasPurpose`, `getKey` revokedAt). In 5 -> 2 the
  owner authorizes KeyManager and names the agents: that is the holder's
  step, taken while it still holds its key (at onboarding); a holder who
  already lost every key cannot take it. In 5 -> 3, replacing the owner's
  own key leaves `owner()` rights on OnchainID only: KeyManager accepts
  MANAGEMENT keys, so 12, 12b and 5 -> 2/3 refuse that owner until it
  holds a MANAGEMENT key again.

The rotation timelock binds only rotations sent through KeyManager: a
MANAGEMENT key adds and removes keys at once (ERC-734), with
`batchAddKeys`/`batchRemoveKeys` or `OnchainID.addKey`/`removeKey`, and
nothing stops it. That stands by design (Task 4.5, R-45-1):
`executeKeyRotation` and `executeKeyRecovery` call `addKey` themselves,
so a timelock in `addKey` would block them or tie the identity to one
manager. The timelock is visibility for the holder. A MANAGEMENT key can
also cancel or re-seat KeyManager recovery, so recovery is no defence
against a rogue one: the owner is. `owner()` always passes
`onlyManagementKey`, so it can `removeKey` the rogue key, and it alone
controls `authorizeManager`, `deauthorizeManager` and
`transferOwnership`. Recovery restores a lost key; it does not evict a
key that is still active.

Withdrawing the authorization pauses KeyManager for the identity; it does
not cancel. Agents can then neither open nor approve candidates, and
nothing executes; `cancelKeyRotation` and `cancelKeyRecovery` (both work
while withdrawn) stop an item. A rotation or recovery runs only within 7
days after its execution time (`EXECUTION_WINDOW`); after that it is dead
and must be re-initiated, so a paused item cannot revive months later.
Before 12, 12a, 12b or 5 -> 2/3 re-authorize, the flow lists the
identity's paused items still inside their window; 12b and 5 ask before
re-authorizing, 12 and 12a print and continue.

On a dev node each timelock is jumped with `evm_increaseTime`. Where the
clock cannot be moved, the option prints when the step becomes executable
(chain time); run the same option again after that time, in the same demo
session, and it resumes from the chain (a pending rotation or recovery is
never re-initiated while it can still run). The keys live in memory: a
restarted demo starts over with fresh keys.
`scripts/demo-smoke.js` (via `scripts/demo-smoke-keys.js`) runs option 12
and checks on chain that KeyManager answers neither `owner()` nor
`authorizedManagers()`, is authorized on wallet 1's identity, that the
rotated-out key is revoked, the rotation and the recovery completed and
waited 24 and 48 hours (event block times), recovery ran with agents 7
and 8, option 12 revoked the keys it created, and wallet 1 kept its key;
then it runs option 5a and checks that the key removed with its proof is
gone (keyHasPurpose false, revokedAt set), KeyRemoved was emitted, a
stranger's signature is refused on a live key, and the removed key is not
removed again (13 checks).
`DEMO_SMOKE_OUT` records `keyManager`.

The handover ceremony hands nothing over for KeyManager (it has no
owner). handover.json may name `"keyManager"` and `"keyManagerIdentity"`
(the demo OnchainID). Before Step 1, without a transaction, the preflight
refuses a `keyManager` with no code or whose runtime code is not the
compiled KeyManager, a `keyManagerIdentity` with no code, one that has not
authorized the named KeyManager, one where the deployer is owner,
authorized manager or a MANAGEMENT key, and a `keyManagerIdentity` named
without `keyManager`. 83e adds two lines: the code matches the compiled
KeyManager (no owner, no allowlist, so the deployer holds no KeyManager
power), and the identity authorizes KeyManager while the deployer is not
its owner, manager or MANAGEMENT key. The smoke's ceremony passes 75
checks (Task 4.4 adds the five oracle lines below).

`scripts/production/DeployProduction.ts` deploys KeyManager and authorizes
it on the ops identity named by `OPS_IDENTITY` when the deploying wallet
owns that identity. When another wallet (the ops key) owns it, or
`OPS_IDENTITY` is unset, nothing is authorized and the deploy prints the
exact call the identity owner must send:
`OnchainID(<ops identity>).authorizeManager(<keyManager>)`.

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
second transfer (after a warm-up) for three deployments: the permissive
`MockIdentityRegistry` with compliance bound to it as the baseline, one
required topic (KYC), and two (KYC+AML). Since Task 2F.2 the remaining cost
is one `ClaimIssuer.hasValidClaim` call per party per topic
(`IdentityRegistry -> ClaimIssuer`, no OnchainID read). The two-topic delta
(+71,234) is still above the 40,000 gas tolerance; the next lever is plan v2
decision D17 (verified-until cache).

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

**After Task 2F.2 (measured 2026-10-01):** the registry asks the issuer
instead of walking the identity's claims, and the issuer reads one
latest-claim pointer per (identity, topic).

| Scenario | transfer gasUsed | delta vs A | isVerified est. |
|---|---|---|---|
| A: MockIdentityRegistry (baseline) | 93,956 | 0 | 23,938 |
| B: IdentityRegistry, 1 topic (KYC) | 134,126 | +40,170 | 48,942 |
| C: IdentityRegistry, 2 topics (KYC+AML) | 165,190 | +71,234 | 68,724 |

Before this change, at 1d61eed: B 246,346 (+152,390), C 389,550 (+295,594);
with the first 2F.2 issuer scan (efd0313): B 143,568 (+49,612), C 184,068
(+90,112).

Deploying all eleven contracts costs under 0.01 ETH at 1.3 gwei.
