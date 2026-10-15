# Demo options on a live node: privacy, custody, oracles, identity keys

The testnet guide is three files: [setup](TESTNET_SETUP.md) (roles, time scale, governance rules, rehearsal, Sepolia, gas), [demo options](TESTNET_DEMO_OPTIONS.md) (privacy, custody, oracles, identity keys) and [ceremony](TESTNET_CEREMONY.md) (the handover and the operators' command lines).

## Privacy options

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
ComplianceRules vote needed). When no whitelist oracle is bound (option
38a has not run), Either acts as ZkOnly: an allow list of PrivacyManager
bindings, and every holder without a live binding is refused (mint
recipient and transfers, not burns). When 38a has bound one, oracle-listed
wallets also pass, and a ZK binding alone serves only investor types whose
required tier is 1 (D46 a); (b) the
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

### Attestations in the demo (Task 3.7b)

In the demo, option 1 (or 41 when it deploys the pair) makes a demo issuer
key for the session, never printed, trusts it for the three circuits and
sets minimum accreditation 100000 and compliance minimum 70 with weights
25/25/25/25, printing the public key and the policies; option 21 wires the
jurisdiction source, and 42 -> 3 asks for an ISO numeric code. Options
42 -> 3, 4 and 5 sign for the chosen wallet with a one-year validity,
prove and bind through the same library and print the attestation's
expiry, the record and the validator's answer; 44 and 45 read
PrivacyManager's records and validators and show each record's expiry
next to its attestation's; 46 prints `validateAllPrivateCompliance`
(whitelist, jurisdiction, accreditation, compliance) for every wallet that
holds any record. The handover completion lists the
trusted attestors per circuit and warns when one has none, the jurisdiction
source and policy token, and the number of jurisdiction bits; the demo key
stays trusted after the ceremony until a vote untrusts it.

### Privacy options read from chain (Task 4.7)

42 -> 6 runs the flows of 42 -> 1 (proof and binding, without the
transfer steps), 2, 3, 4 and 5 with their defaults for one wallet and
prints `validateAllPrivateCompliance(wallet)` and VSC's whitelist mode
(only the whitelist binding gates VSC transfers, and only in ZkOnly or
Either; 42 -> 6 does not switch the mode); the blacklist step needs the
oracle system (31). 47 reads the proof cache expiry, the binding
validity and the preference flags, sets the first two while the deployer
owns the verifier or PrivacyManager (after the handover a
VerifierParameters or PrivacyParameters vote: option 76, type 12 or
11, proposes it), lists every nullifier
against `nullifierWallet` / `attestationNullifierWallet`, and lets a
wallet set its own preference flags. 48 prints the verifier's counters
(`getVerificationStats`) and wiring, 49 eight checks each true, false or
not run, 50 wires VSC's ComplianceRules to the PrivacyManager as 41 does
and reports the whitelist mode and each verified wallet's binding.
`scripts/demo-smoke-privacy-options.js` compares all eight of option
49's checks with independent chain reads before and after 42 -> 6, and
checks the 42 -> 6 banner and 42 -> 1's secure mode against the chain.
Secure mode (42 -> 1, mode 3) proves for wallet 1 and prints its
IdentityRegistry identity and `isVerified` as read. `demo-drive.sh --strict 1 21 31 41 47:1 42:6: 46 47:4 48 49 50`
runs them without a terminal.

## Investor custody (Task 4.3, D13 b)

The "2-of-2 multisig" of option 23 is the on-chain `MultiSigWallet`.
Options 21 and 51 (whichever runs second) deploy `InvestorRequestManager`
for VSC with the bank = ops (wallet 10), make it an InvestorTypeRegistry
compliance officer and a ComplianceRules registrar on VSC for the
compiled `MultiSigWallet` code hash, set the lock requirements within the
Normal one-transfer cap (2,000 / 4,000 / 8,000 VSC; the manager and
`MultiSigWallet.lockTokens` refuse a lock above that cap,
`LockAboveNormalCap`, Task 5.1), and nominate ops as owner, which ops
accepts (`acceptOwnership`, Ownable2Step), so the deployer keeps no
custody power.

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

Options 23 and 62 to 69 ask sub-prompts; `demo-drive.sh` answers them
when the argument carries the answers (`23:<sub-option>:...`, see
"Driving the demo without a terminal" in TESTNET_SETUP.md), and
`scripts/demo-smoke-custody.js` runs the custody flow on the live node
in the smoke.

## Investor-type cooldown and tier (Task 4.10, D37 = a)

Options 21 and 51 point VSC at the InvestorTypeRegistry and, while the
deployer owns the registry, have it authorize VSC (`authorizeToken`);
otherwise they name the owner, since a registry that has not authorized
VSC makes VSC refuse every mint and transfer ("Token not authorized by
investor registry"). Option 58 asks nothing: on VSC a verified,
non-exempt wallet sends 1 VSC, a second send is refused ("Transfer
cooldown", `canTransfer` false), a dev node jumps past the type's
cooldown and the send passes (a real network prints when to run 58
again); no deploy path binds a whitelist oracle to VSC (option 38a does so
on request), so 58 always shows the tier on a probe token (its own ComplianceRules in OracleOnly,
WhitelistOracle and registry, on the demo's IdentityRegistry): an
Accredited wallet listed at tier 2 is refused ("Compliance check
failed", `whitelistTierAllows` false) and passes when re-listed at
tier 3. Option 59 runs 52, 56, 57 and 58 and reports 58's two verdicts,
plus counted lines for the others: the types 52 read, and per wallet
(with its actual type) whether 56 and 57 held; a step that threw says
"failed";
16 and 17 (20c, 20d) print the cooldowns with each demo wallet's clock and
the tiers with VSC's mode, oracle and each wallet's entry. Option 42 -> 1
waits out the sender's cooldown before its re-proof transfer (e). Without
`evm_increaseTime` (a public testnet) 58 and 42 -> 1 never wait: they
print "cooldown: N minutes left, re-run after <time>" and skip only the
step that needs the cooldown over. A wallet that
sends twice by hand within its cooldown sees "Transfer cooldown".
`scripts/demo-smoke-investor.js` runs 58 and asserts both rules from
chain.

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
without a verdict; raise a new one. No query opens with fewer than two
registered nodes (`TooFewNodes`) or when one node's weight alone reaches
the bar (`SingleNodeQuorum`, Task 5.1). One node then applies the verdict
with `provideAttestation` on the Whitelist or Blacklist oracle, which
applies it only when at least `minimumConsensusOracles` distinct nodes
(default 2, never below 2) voted its way (`TooFewVoters`).

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
the manager, a proposal after the handover); 33a and 34a run a tier-4
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
setEmergencyOracle, setConsensusThreshold, setOperator or (action 7,
Task 5.12) registerOracle for governance
to vote (77, 78), from the first wallet among 0-8 that may propose.
Action 7 takes the next free demo wallet (allocated, never reserved, so
later onboarding moves to the next one) or a typed address (a node with
no demo key), and refuses a registered address before any VGT is spent.
The node prompts and the rounds (33a, 34a, 35a, 37) use the nodes
registered on chain, so after a rotation by vote (D50: register the new
nodes, then remove wallets 1-3) the new nodes answer; a node with no demo
key is listed as one that cannot answer, and 35a needs exactly three.
Option 83f is the day-2 audit after such votes (section 10 of
[OPERATOR_RUNBOOK](OPERATOR_RUNBOOK.md#10-upgrades-and-the-day-2-audit)). `demo-drive.sh --strict 1 21 31 32 33a 34a 35a 39 40`
runs with no error; 33, 34, 35 and 37 ask sub-prompts, which a drive
answers only when the argument carries them (`37:<sub-option>:...`).
A whitelist query names a tier T (Task 4.12; 37 -> 1 asks 1-4, 5 is the
OracleManager owner's, governance after the handover): approval lists at
T or raises a lower entry (a dated entry's expiry capped at 365 days, a
permanent one stays permanent), never lowers; only the list oracle's
owner or list manager (33, 40, DynamicListManager) writes a tier directly
and lowers one. After the handover that owner is ops, which can list at
tier 5 or blacklist CRITICAL without a vote (D44 a; the list-oracle
ownership posture is an audit item).
`DEMO_RPC_URL=http://127.0.0.1:<port>` points the drive at a node on
another port (network `devnode`).

`scripts/demo-smoke-oracles.js`, a leg of `scripts/demo-smoke.js`,
asserts from chain: the engine is bound both ways and its code is the
compiled ConsensusOracle, the threshold is 66%, the 33a and 34a rounds
resolve two of three (`ConsensusReached`, 200 of 300) and their verdicts
apply (33a's at tier 4 in query and entry), 35a's paused node is refused
as not active while two of three still resolve 200 of 300, with two
paused the third cannot resolve alone, unpause restores both, the
designation gates `emergencyBlacklist`, and an expired query refuses
answers and has no verdict.

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

## Identity keys through KeyManager (Task 4.2)

Option 1 deploys `KeyManager` with the core contracts. It has no owner and
no allowlist: an identity opts in to rotations and batches with
`authorizeManager(keyManager)` from its owner, after which each needs a
MANAGEMENT key of that identity; recovery needs no authorization: it runs
through the identity's pinned recovery manager and its seated agents
(below) (docs/DEEP_DIVE_IDENTITY.md, "Identity key lifecycle").
The wallets the options use: wallet 1 (fee wallet, compliance officer)
owns the demo identity; wallets 7 and 8 (investors Bob and Carol) are the
recovery agents, chosen because they hold no issuer, ops or guardian role;
5 -> 2 falls back to wallet 6 (investor Alice) when the owner is 7 or 8.
Every print names each wallet's role.

- **12** (no prompts): wallet 1's identity (found in the registry or the
  factory, or created through the factory) authorizes KeyManager, adds a
  fresh MANAGEMENT key with `batchAddKeys`, rotates it to another fresh
  key through the rotation timelock (24 hours unless 12b set another),
  lists the keys and revokes the rotated-in key (held by nobody) with
  `batchRemoveKeys`; wallet 1 keeps its own key. Then the recovery drill
  (Task 4.11) on a drill identity wallet 1 deploys and owns (not in the
  registry; wallet 1 pins KeyManager as its recovery manager, which the
  factory does for the identities it creates, and a re-seat of agents
  already seated waits 48 hours): a rogue MANAGEMENT key is planted (a fresh wallet nobody
  uses, standing for a stolen key), wallet 1 seats wallets 7 and 8 as
  2-of-2 agents, wallet 7 opens a candidate for wallet 6's key (its own
  approval, D39) and wallet 8 approves it (the receipt prints both
  opening times); the rogue key's cancel and
  re-seat, the owner's cancel, re-seat and `deauthorizeManager` are each
  shown refused (⛔, the chain's reason) and so is an execution before
  48 hours; 48 hours after the approval the candidate executes and the
  receipt lists the evicted keys (the rogue key and wallet 1's), read
  back with `keyHasPurpose` and `getKeysByPurpose`; 7 days after the
  approval `executeOwnerTransfer` proposes wallet 6 (`pendingOwner()`),
  wallet 1's `acceptOwnership` is refused, wallet 6 accepts, `owner()`
  is read back and wallet 1's `transferOwnership` is refused. Run it
  again for a fresh round (a new drill identity).
- **12a** (no prompts): withdraws KeyManager's authorization on that
  identity (`deauthorizeManager`) and shows KeyManager refusing a
  rotation; run again to restore it.
- **12b**: sets that identity's rotation timelock in hours (1 to 168).
- **5a** (no prompts, Task 4.5): on wallet 1's identity adds an ACTION
  key for a throwaway wallet, shows a stranger's signature refused, removes
  the key with the throwaway wallet's signature through
  `removeKeyWithProof` and reads `keyHasPurpose` and `getKey` back.
- **5**: picks an identity; 2 runs the recovery drill on it (Task 4.11:
  a planted rogue key, wallets 7 and 8 as agents, the eviction at 48
  hours and the owner transfer at 7 days to the wallet given, which
  must be a demo signer since it accepts the ownership itself), 3
  replaces one of its MANAGEMENT keys by a timelocked rotation, both
  through KeyManager; 1 removes a key at once, sent by the owner (a
  MANAGEMENT key): an address key through `removeKeyWithProof` with the
  key's own wallet signing the chain's `getRemoveKeyMessage` digest (the
  key's wallet must be a demo signer), a passphrase key through
  `removeKey`; it prints the method it called and reads the key back
  (`keyHasPurpose`, `getKey` revokedAt). In 5 -> 2 the
  owner pins KeyManager as the recovery manager (factory identities already
  pin it) and seats the agents: that is the owner's step, taken at onboarding; a holder who already lost every key cannot
  take it. In 5 -> 3, replacing the owner's own key leaves `owner()`
  rights on OnchainID only: KeyManager accepts MANAGEMENT keys for
  rotations, so 12, 12b and 5 -> 3 refuse that owner until it holds a
  MANAGEMENT key again.

The rotation timelock binds only rotations sent through KeyManager: a
MANAGEMENT key adds and removes keys at once (ERC-734), with
`batchAddKeys`/`batchRemoveKeys` or `OnchainID.addKey`/`removeKey`, and
nothing stops it. That stands by design (Task 4.5, R-45-1):
`executeKeyRotation` and `executeKeyRecovery` call `addKey` themselves,
so a timelock in `addKey` would block them or tie the identity to one
manager. The timelock is visibility for the holder.

Recovery is the defence against a rogue MANAGEMENT key and a stolen
owner key (Task 4.11, D38 = c). It runs only through the identity's ONE
pinned recovery manager (`recoveryManager()`): the factory pins its
KeyManager when it creates the identity (its owner can only choose a
contract with the compiled KeyManager's code hash,
`recoveryManagerCodeHash`, fixed at construction, or none); an
identity deployed directly is pinned (`pinRecoveryManager`) by its
creator in the creating block or by its owner, and with none pinned
it has no recovery. The pin never changes and outlives ownership
transfers. On an unpinned identity the owner key can pin any
manager, so a new owner checks `recoveryManager()` first. Recovery does not
depend on `authorizedManagers`, so withdrawing KeyManager pauses its
rotations and batches, never recovery. Who can do what, and when:
the owner seats the agents and threshold (`setupKeyRecovery`); the
first seating is immediate, a re-seat of seated agents is pending for
48 hours, the seated agents can veto it at their threshold
(`vetoKeyRecoverySetup`), anyone applies it afterwards
(`applyKeyRecoverySetup`), an approved recovery blocks it and an executed
one drops it; neither the owner nor a current MANAGEMENT key can be
seated as an agent (D53), nor the identity itself or KeyManager; the
threshold is at least 2 (`ThresholdBelowTwo`, D59) and at most 10 agents.
Before seating agents the owner must remove every MANAGEMENT key it does
not know (A2F-4): `setupKeyRecovery` does not check them, and such a key
can make the chosen agents MANAGEMENT keys and block the seating. An agent
opens a candidate (`initiateKeyRecovery`), which counts as its approval
(every seat needs at least two, so another agent must approve); none
opens while another is approved. Until the approvals
reach the threshold only its initiator may cancel it: not the owner (a
stolen owner key raced every candidate: D39, R-414-1), not a MANAGEMENT
key. From the approval only the agents cancel it, at the same threshold,
and the identity refuses its owner's `authorizeManager`,
`deauthorizeManager` and `transferOwnership` (`ownershipFrozen`, asked of
the recovery manager only and read strictly: only the word 1 is yes), any
new MANAGEMENT key (`ManagementAdditionsFrozen`) and every
`acceptOwnership` but the recovery's own nominee's (`FrozenByRecovery`).
48 hours after the approval (`RECOVERY_TIMELOCK`), within 7 days, anyone
executes it: the recovered key is added and every other MANAGEMENT key,
the owner's included, is removed (ACTION, CLAIM and ENCRYPTION keys
stay), 100 per call (`MAX_EVICTIONS_PER_CALL`, above the 64 keys a
purpose `addKey` allows, `MAX_KEYS_PER_PURPOSE`; KeyManager batches take
at most 50 keys, `MAX_BATCH_SIZE`; `continueKeyEviction` is reachable
only on an identity deployed before the cap). 7 days after the approval
(`OWNER_TRANSFER_TIMELOCK`) and before 14 days, someone (the recovered
wallet, or anyone for it) must call `executeOwnerTransfer` and the
recovered wallet must accept (`acceptOwnership`); a recovery to a key that
is not a wallet address's hash (a passphrase key) evicts the other
MANAGEMENT keys but never moves ownership (A2F-7); if nobody does in that
window the lock lifts, the old owner keeps the identity and an agent's
next `initiateKeyRecovery` re-opens recovery (`KeyRecoveryReopened`, a
new epoch; D52). Between the execution and the transfer the old owner
keeps its other owner powers: it can remove claims and ACTION or CLAIM
keys and remove the recovered key (the transfer restores it), but it
cannot add a MANAGEMENT key, a manager or a new owner. On the recovered
wallet's acceptance every other MANAGEMENT key is removed and every
authorized manager but the recovery manager is de-authorized (one
`ManagerDeauthorized` each); the thief's ACTION and CLAIM keys survive,
so the recovered owner reviews `getKeysByPurpose(2)` and
`getKeysByPurpose(3)` and removes what it does not know (D40). A re-seat
applies only while its proposer still owns the identity; after an
ordinary transfer it is stale (`StaleReseat`) and anyone drops it
(`dropStaleRecoverySetup`). Agents at the threshold can therefore take
the identity: choose agents you would trust with it. The owner sees the
approval on chain and has the 48 hours to move assets through the
issuer's `Token.recoveryAddress`, which stays the asset-side bound; its
new wallet must control the identity (own it or hold a MANAGEMENT or
ACTION key on it, D41), as `IdentityRegistry.registerIdentity` and
`moveIdentity` require of every wallet they bind (D41 is a consistency
rule, not a defence against a rogue registry agent, A2F-6); a holder without seated
agents whose owner key is lost is burned and re-issued by the agent
instead.

Withdrawing the authorization pauses KeyManager's rotations and batches
for the identity (it is refused while a recovery is approved); it does
not cancel and does not pause recovery, which runs through the pinned
recovery manager. `cancelKeyRotation` and `cancelKeyRecovery` (both work
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
rotated-out key is revoked, the rotation completed and waited 24 hours
(event block times); on the drill identity that the recovery executed 48
hours after the approval (`KeyRecoveryApproved` to `KeyRecoveryCompleted`
block times) with agents 7 and 8, the rogue key was evicted
(`KeyRecoveryKeyEvicted`, `keyHasPurpose` false), wallet 6's key is the
only MANAGEMENT key, the owner transfer waited 7 days after the approval,
`owner()` is wallet 6, the rogue key's cancel and the old owner's accept
were refused; that option 12 revoked the rotated-in key and wallet 1 kept
its key; that wallet 1's identity pins KeyManager as its recovery manager
and authorizes only it, and that the drill identity pins KeyManager and
kept no other manager after wallet 6 accepted; then it runs option 5a and checks that the key removed with its
proof is gone (keyHasPurpose false, revokedAt set), KeyRemoved was
emitted, a stranger's signature is refused on a live key, and the removed
key is not removed again (19 checks: "Key lifecycle: 19 chain checks
pass").
`DEMO_SMOKE_OUT` records `keyManager`.

The handover ceremony hands nothing over for KeyManager (it has no
owner). It derives the KeyManager from the factory's `recoveryManager()`
(a `"keyManager"` key is an assertion, refused when it differs);
handover.json may name `"keyManagerIdentity"` (the demo OnchainID).
Before Step 1, without a transaction, the preflight refuses a
`keyManager` with no code or whose runtime code is not the compiled
KeyManager, a `keyManagerIdentity` with no code, one that has not
authorized the named KeyManager, one where the deployer is owner,
authorized manager, a MANAGEMENT key or a recovery agent (agents at the
threshold can take an identity, Task 4.11), one that does not pin the
named KeyManager as its recovery manager or authorizes any other manager
(`getManagers()` must be exactly [KeyManager]), a `keyManagerIdentity`
named without `keyManager`, and an `onchainIDFactory` (checked with or
without `keyManager`) whose `recoveryManagerCodeHash` is neither zero nor
the compiled KeyManager's or whose `recoveryManager()` is not the named
KeyManager. Option 83c names option 1's KeyManager and, once option 12
ran, its identity. 83e adds the KeyManager
and factory lines, plus the identity line once option 12 ran: the code
matches the compiled KeyManager (no owner, no allowlist, so the
deployer holds no KeyManager power; only an identity's pinned recovery
manager can move its ownership, after the agents' eviction at 48 hours
and transfer at 7 days), and the identity pins KeyManager as its
recovery manager and authorizes only it while the deployer is not its owner, manager,
MANAGEMENT key or recovery agent, and the factory pins KeyManager on
every identity it creates. Option 1 sets the factory's `recoveryManager`
to its KeyManager; the factory accepts only a contract with the compiled
KeyManager's code hash (`recoveryManagerCodeHash`, fixed at
construction), so after the handover governance can switch pinning off or
to another KeyManager deployment, never to a contract of its own. The
smoke prints the number of ceremony checks that pass (`Handover ceremony:
N checks pass`).

`scripts/production/DeployProduction.ts` deploys KeyManager and authorizes
it on the ops identity named by `OPS_IDENTITY` when the deploying wallet
owns that identity. When another wallet (the ops key) owns it, or
`OPS_IDENTITY` is unset, nothing is authorized and the deploy prints the
exact call the identity owner must send:
`OnchainID(<ops identity>).authorizeManager(<keyManager>)`. It also pins
KeyManager as the ops identity's recovery manager (or prints
`OnchainID(<ops identity>).pinRecoveryManager(<keyManager>)` for its
owner), refuses an identity already pinned to another manager (a pin is
final), and sets the factory's `recoveryManager` to KeyManager.
