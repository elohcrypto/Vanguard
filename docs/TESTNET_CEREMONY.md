# Handover ceremony and operator command lines

The testnet guide is three files: [setup](TESTNET_SETUP.md) (roles, time scale, governance rules, rehearsal, Sepolia, gas), [demo options](TESTNET_DEMO_OPTIONS.md) (privacy, custody, oracles, identity keys) and [ceremony](TESTNET_CEREMONY.md) (the handover and the operators' command lines).

## Handover ceremony

After the ceremony the deployer (wallet 0) holds no power: governance owns
Token, GovernanceToken (VGT), IdentityRegistry, ComplianceRules,
OracleManager, InvestorTypeRegistry (when deployed), the EscrowWalletFactory
and OnchainIDFactory (when deployed), PrivacyManager and ZKVerifierIntegrated
(option 1 deploys them), DynamicListManager (when option 84 deployed it)
and itself; ops (wallet 10) holds the OnchainIDFactory `feeRecipient` and,
if it was the deployer's, the escrow factory's fee wallet (D54), and the
agent roles, the compliance-officer role, the escrow factory's ADMIN_ROLE,
PrivacyManager's `listOperator` (it publishes the whitelist root), the
oracles the deployer owned and OracleManager's operator role (pause,
unpause and emergency designation of nodes, Task 4.4); the issuer admin (wallet 9) owns the
claim issuers the deployer held; the guardian (wallet 11) can pause the
token but not unpause it; it can pause again after a voted unpause, and a
pause has no expiry (D56; an audit item). Issuer ownership moves by
nominate and accept: the deployer's `transferOwnership` only nominates the
issuer admin. `scripts/handover.ts` signs as the issuer admin (each
issuer's `acceptOwnership` and the deployer-key revoke) and as ops (each
list oracle's `acceptOwnership`, Task 5.1) and refuses before step 1 when
the issuer admin is not a signer; how a multisig issuer admin or ops signs
these on Sepolia is Task 5.7 (pending). Since Task 4.13 option 1 deploys both issuers owned by the
deployer (wallet 0 signs every claim before the ceremony, wallet 9 after
it): every trusted issuer must end owned by issuerAdmin with issuerAdmin's
the only live key, so an issuer another wallet owns is refused, never
skipped (R-413-7).
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
being officer and governor).
Before its first transaction the ceremony runs a read-only preflight and
refuses to start rather than stop halfway: governance bound to every plan
contract except the two factories and the privacy pair, which step 3
binds; each plan contract owned by the deployer, or already by governance
where the deployer never calls it (Token, VGT, IdentityRegistry and
ComplianceRules must still be the deployer's); no issuer where the deployer
holds a key but not ownership; the issuer admin a signer wherever it must
accept or revoke on an issuer, and no issuer-admin key on it that is revoked
or of another purpose (it cannot be re-added as MANAGEMENT_KEY); each oracle
owned by the deployer or ops, and an ops-owned oracle whose `listManager` is
still the deployer fails, because only ops can clear it, and so does an
ops-owned oracle with a pending owner (Task 5.1: the list oracles are
Ownable2Step; step 2 nominates ops and ops accepts). Since 2F.5 it also
refuses: an `oracles` or `issuers` list that omits a contract bound on chain
(an extra one is handed over with a warning; leave a list out to use the
chain's set); a config address that differs from what governance derives
(R-413-1) or a `null` for a contract governance does derive (R-413-12); a `zkVerifier` that is not the
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
first, and a ComplianceRules that does not record VGT as its governance
token (`setGovernanceToken(VGT)`, set once; the contract then holds VGT to
OracleOnly itself, D33 b; 83e checks the same). It also refuses a VSC or
VGT whose `compliance()` is not the config's `complianceRules` (governance would own a ComplianceRules the
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
whatever option 25 minted to it, 100M with choice 3, verified and exempt,
as the treasury artifact: move it and remove the exemption by vote), escrow
fee wallets that are not exempt or were registered after the handover, and
the residual warnings: a current whitelist root not published by ops or
governance ("republish as ops so deployer-era bindings lapse"), an issuer
key the deployer trusted on PrivacyManager, an OracleManager node the
deployer registered (D50: rotate by an OracleParameters vote), an
`extraTrusted` acknowledgement, or a config key set to `null`. When any
residual warning fires, `scripts/handover.ts` and 83e close with "Handover
complete with warnings: see above" instead of "the deployer holds no
power". In the demo this always happens (option 31's nodes and option 1's
attestor key are deployer-era), and the smoke asserts exactly those seven
warnings. The InvestorTypeRegistry's own proposals
now belong to the governor set they were created under (every `setGovernor`
bumps `governorEpoch`, so the ceremony's removal of the deployer kills any
planted proposal), expire 7 days after their execution time, and pass the
same whitelist-tier check as `updateInvestorTypeConfig`. Preflight refuses to start on a
governance that is untrusted or still registered (a pre-D21 deployment).
The votes need a proposer plus quorum voters that are verified wallets
among 0 to 8 (wallet 9, the issuer admin, never votes), each holding the
proposal fee plus the voting fee: options 23/24 onboard them (6 and 7 issue
KYC/AML claims to any still unverified), and 75a (mint) or 75 (distribute
from the agent's balance) funds them; without them 83d refuses exactly as
83b does. Onboard first:
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
follow five rules. A query is raised only by the OracleManager owner or an
active oracle, and a blacklist query fixes its severity (so its duration)
when it is raised (`abi.encode(uint8)`, empty = MEDIUM); the severity a
node passes when it attests is ignored. Answering yes accepts the query's
severity, and a node can raise at most HIGH: only the OracleManager owner
raises a CRITICAL (365-day) query. Separately, ops as the list-oracle owner
writes entries directly, CRITICAL blacklist and tier-5 whitelist entries
included (D44 a); consensus severity only sets a verdict's duration; the
list-oracle ownership posture is an audit item. A resolved verdict is final (no
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
applies after it. A verdict applies only when at least
`minimumConsensusOracles` distinct nodes (default 2, never below 2) voted
its way (`TooFewVoters`, Task 5.1); an `emergencyOverride` that flips a
verdict counts only the nodes that voted the new side, so a flip with
fewer than two such voters cannot be applied. Options 33a, 34a, 35a, 37 and 40 raise OracleManager
queries; ConsensusOracle is the manager's engine and keeps no queries of
its own (Task 4.4, "Oracle nodes and consensus" in TESTNET_DEMO_OPTIONS.md).

Outside the demo, `HANDOVER_CONFIG=<path.json> npx hardhat run
scripts/handover.ts --network <net>` runs the same ceremony and exits
non-zero on any failure. Since Task 4.13 the JSON has one root: the `governance` address; every
other contract is derived from it (its bound targets and VGT, the tokens' registry and rules,
the rules' oracles, registrars and wired PrivacyManager, the registry's issuers, the manager's
engine and nodes, the factory's KeyManager). It also holds the wallet indices `ops`, `guardian`,
`issuerAdmin`, `proposer` and `voters`, `accounts` (those indices and 0 pinned to their addresses, required off the dev chain or with a deploy record, whose deployer wallet 0 must be; another key at a pinned index is refused before any send, Task 5.17 M-2), the optional `fromBlock` (a block before option 1's
first deploy; refused when any scanned contract already had code) and `logChunk`, the optional
`keyManagerIdentity` and `feeWallets`, and three acknowledgement lists, empty by default:
`oracleNodes` (every registered consensus node), `attestors` (the Ax of every trusted attestor
key) and `extraTrusted` (trusted contracts that are neither governance on VGT nor a wallet a
live registrar created). An address key of an older config is an assertion, refused when it
differs from the derivation (R-413-1); `escrowWalletFactory`, `onchainIDFactory`,
`privacyManager` and `zkVerifier` must still be stated (an address, or `null`) while governance
cannot derive them, before step 3 binds them (R-413-2); any other key is refused.
`HANDOVER_PHASE=accept` resumes a partial run; it requires `HANDOVER_SNAPSHOT_SHA256` (the digest
the full phase printed, recorded outside the run directory: the directory holding the snapshot and
its sidecar must not hold the only copy, R-56c-2) and refuses a snapshot whose sha256 differs from it or the sidecar (B-6). `HANDOVER_PHASE=audit` is the day-2
re-check: every completion line against the state governance derives now, no snapshot or window
([OPERATOR_RUNBOOK](OPERATOR_RUNBOOK.md) section 10). `HANDOVER_PHASE=preflight` (Task 5.7) runs the full phase's
checks up to its first transaction and sends nothing; the production deploy runs it on the handover.json it writes
([OPERATOR_RUNBOOK](OPERATOR_RUNBOOK.md) section 2). The preflight (and 83e, as failing lines) also
refuses, from the event scans: any agent but the deployer, ops, governance (VGT) and the tokens
(registry), a missing governance or token agent; any InvestorTypeRegistry officer wallet but
ops, a token other than VSC authorized, a registry or whitelist oracle on VGT (D56), a Token
enforcing a registry governance is not bound to; a key on any issuer held by ops, the guardian,
governance, a registry agent or an oracle node; a trusted contract outside governance on VGT, a
live registrar's wallets and `extraTrusted`; a registrar or officer contract whose code is not
the compiled InvestorRequestManager or EscrowWalletFactory, or whose immutable bank is not ops;
an unacknowledged node, the deployer as a node, an emergency designation on an unacknowledged
node (step 5 clears the rest), a paused or inactive list oracle, one below two consensus
oracles, one whose code is not the compiled WhitelistOracle or BlacklistOracle or whose
`maxVerdictAge` is outside 1 hour to 30 days, a node whose weight alone reaches the consensus
threshold (the engine would refuse every query, `SingleNodeQuorum`), a DynamicListManager
writing oracles no token reads; `minVoterAge` under 7 days / GOV_TIME_SCALE, a zero proposal or
vote cost, an open proposal targeting a plan contract, a factory `feeRecipient`
other than the deployer or ops (step 5 sets ops, D54), an escrow factory fee wallet that is
neither ops nor a `feeWallets` entry (step 5 moves the deployer's to ops), a trusted escrow the deployer arbitrates,
an escrow `INVESTOR_ROLE` without an active registration (step 5 deactivates the deployer's;
Task 4.17), an unacknowledged attestor key, a root published by a stranger, a pending re-seat,
rotation, recovery or owner nomination on the demo identity; and a code hash off the compiled artifact for every plan contract, list
oracle, registrar and issuer (immutables masked). A scan that cannot find a holder known to be
granted by event fails rather than passing as clean (R-413-6). Completion re-derives everything
and compares it with the preflight snapshot (the CLI writes it next to the config with the chain
id, the preflight block and a sha256 sidecar; the demo keeps it in state): nothing may appear the ceremony did not
grant, and every grant, mint, identity registration, freeze and rule-administrator event after
the preflight must come from a ceremony transaction, ops or a vote, even if revoked since (Task
4.17); every plan contract's pending owner is none, governance or ops (Task 5.6b). Re-running the full phase refreshes the preflight, so a chain prepared between an aborted
preflight and the re-run is judged by the re-run. Demo option 83c acknowledges what the demo
itself registered and trusted, lists every stray the preflight refuses and offers to remove them
as the deployer (answer `y`; the drive argument is `83c:y` when there are strays to remove,
plain `83c` otherwise).

### Runbook rules for the ceremony and after (plan 2F)

- Register every voter at least `minVoterAge` (7 days / GOV_TIME_SCALE:
  420 s at 1440, 30 min at 336) before the ceremony's first proposal
  (D25); a dev node jumps, Sepolia waits.
- Exempt the escrow fee wallets and the treasury before the ceremony, while
  the deployer owns the InvestorTypeRegistry; after it only an
  InvestorTypeConfig vote can (R-2F4-2). The completion check warns about a
  fee wallet that is not exempt.
- Settle every open proposal (vote it through or let it settle and refund)
  before any vote that moves a bound contract's ownership, and trust the
  new owner first (A-N3, R-2F1-1): a ComplianceRules owner that does not
  trust governance makes `createProposal` revert and strands open deposits.
- A wallet recovered with `recoveryAddress` must already control the
  OnchainID (own it or hold a MANAGEMENT or ACTION key, D41;
  `Token.recoveryAddress` refuses otherwise), so give the new wallet a key
  first, through KeyManager recovery when the old keys are lost. D41 keeps
  the asset side and the identity side consistent; it is no defence
  against a rogue recovery agent (A2F-6).
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
  Option 61's closing "security model" lists the design (an investor fee
  wallet may be the investor's trusted 2-of-2 MultiSigWallet, option 62). The two
  lines under it (owner fee wallet verified, VSC jurisdiction rule active)
  are chain reads.
- Revoking a whitelist binding is root rotation: publish a root without
  the commitment (ops, or a PrivacyParameters vote). Expiry alone does not
  revoke, since a holder may resubmit the same proof under the same root
  to refresh it. Under ComplianceRules whitelist mode ZkOnly (and Either
  without a whitelist oracle) a root rotation, or an expired binding,
  pauses every affected holder, escrow releases to them included, until
  they re-prove; burns stay open. In Either with a whitelist oracle bound,
  a proof binding alone serves only investor types whose required tier is
  1; every other type needs a listing at its tier (D46 a).
- The window (R-417-8, R-56-5): from the preflight to the last acceptance
  vote the deployer key sends only votes (a transaction to governance that
  emits a voting event) and VGT `approve(governance)`; any other or
  reverted deployer transaction fails the completion for good. After the
  ceremony it sends nothing: every demo picker leaves wallet 0 out and the
  demo refuses any wallet-0 transaction (`DeployerKeyAfterCeremony`).
  Demo 83c-83e end with the warnings line: option 31's nodes and option
  1's attestor key are deployer-era.
- A contract nominated to governance is accepted only by a vote of the
  type bound to it (`VanguardGovernance.boundTarget`); the ceremony does
  this for every plan contract, the EscrowWalletFactory included. No type
  targets an InvestorRequestManager or a list oracle: ops is their owner
  (D44). Never nominate governance on them: the nomination can never be
  accepted (it fails safe; R-56-3); clear it from ops.
- Onboard only identities the OnchainIDFactory made, whose
  `recoveryManager()` is the pinned KeyManager (I-2): one deployed
  outside it can carry a stranger's MANAGEMENT key and recovery manager.
  A claim signature made before a revocation on that (identity, topic)
  fails with `Signer does not have claim signer key`: re-sign (Task 5.2).
- A rule administrator's jurisdiction rule lapses every private
  jurisdiction record of that token. A new ComplianceRules or
  InvestorTypeRegistry is a fresh deploy, not a migration (D34 a):
  governance binds its ComplianceRules at construction, and the list
  oracles' bindings and `listManager` point at the old set. Unbinding an
  oracle switches its gate off: no blacklist oracle sanctions-checks no
  one; OracleOnly with no whitelist oracle passes every party.
- The day-2 audit (`HANDOVER_PHASE=audit`, Task 5.6b) runs every
  completion line against the state governance derives now and
  `handover.json`'s acknowledgements (`oracleNodes`, `attestors`,
  `extraTrusted`), with no snapshot or voting window, and sends nothing.
  A change by vote that leaves the deployer no power passes; a deployer
  power, an unacknowledged holder (agent, role, owner, node, attestor,
  trusted contract), a pending owner other than governance or ops, or an
  open proposal on a plan contract fails. A node a governance execution
  registered passes whoever sent it; one the deployer registered itself
  ends it with D50's warning (R-56c-1). It refuses before the ceremony
  completed (governance does not own every plan contract).

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
ZK_RPC_URL_FILE=<0600 file> WHITELIST_OPS_KEY=<ops key> node scripts/zk/build-whitelist-root.js \
  --in entries.json --out root.json --publish --privacy-manager <addr>

# Investor, with the published root.json: prove, bind the wallet, show the status
ZK_RPC_URL_FILE=<0600 file> WHITELIST_WALLET_KEY=<wallet key> node scripts/zk/prove-whitelist.js \
  --root root.json --identity <onchainID> --wallet <wallet> --secret-file secret.txt \
  --out proof.json --submit --privacy-manager <addr>  # the URL: a 0600 file, never argv
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
Demo option 42 -> 1 builds roots and proofs with the same functions. Its
first publish calls `publishWhitelistRoot` directly, with no old-root
history check; the rotations in steps (d) and (e) publish through the
CLI's `publishRoot`, which refuses a root that was published before.

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
UTC date>` (`2027-01-01`, or a UTC time ending in `Z` such as
`2027-01-01T00:00:00Z`; a time without `Z` or with an offset is refused) and refuses a date not in the future; the issuer signs that
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
ZK_RPC_URL_FILE=<0600 file> ATTESTOR_KEY=<key> node scripts/zk/attest.js --sign --circuit jurisdiction \
  --identity <onchainID> --country <ISO numeric> \
  --privacy-manager <addr> --valid-days 365 --out att.json
#   or --valid-until 2027-01-01 (ISO 8601 UTC); the expiry is required
#   offline: --chain-id <id> --privacy-manager <addr> --mask <its bit>
#   ... --circuit accreditation --amount <amount>
#   ... --circuit compliance --scores <kyc,aml,jurisdiction,accreditation>
# Investor: policy and issuer trust read from PrivacyManager
ZK_RPC_URL_FILE=<0600 file> WHITELIST_WALLET_KEY=<wallet key> node scripts/zk/prove-attestation.js \
  --attestation att.json --wallet <wallet> \
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
