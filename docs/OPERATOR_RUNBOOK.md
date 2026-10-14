# Operator runbook (draft)

The ordered procedure to deploy Vanguard, hand it from the deployer to
governance and run it. Each step names the command or demo option and the
line it prints when it worked. The rules in full: [TESTNET_SETUP](TESTNET_SETUP.md),
[TESTNET_CEREMONY](TESTNET_CEREMONY.md), [TESTNET_DEMO_OPTIONS](TESTNET_DEMO_OPTIONS.md)
and the deep dives ([transfer](DEEP_DIVE_TRANSFER.md),
[identity](DEEP_DIVE_IDENTITY.md), [ZK](DEEP_DIVE_ZK.md)).

Status: draft (Task 5.6; the day-2 audit and the snapshot digest since
Task 5.6b). Section 2 is final only after Task 5.7 (the production deploy
with an external signer); the whole runbook is final after the Sepolia
rehearsal (Task 5.8).

## Conventions and the local rehearsal

Commands use shell variables set once per session: `NET` (the hardhat
network: `devnode` locally, `sepolia` in 5.8), `HANDOVER_CONFIG` (the
ceremony's `handover.json`) and `RB` (the run's record directory: logs,
snapshot, hashes; keep it). `<ANGLE>` marks a value the operator fills in (an address, a node key).
Expected output is quoted as printed; `0x…` stands for an address and `N`
for a number that differ between runs.

> **Local rehearsal box.** Drives the whole runbook on a fresh local node.
> The keys are Hardhat's public test accounts (the phrase below is
> published in Hardhat's documentation): never use them, or this phrase,
> on a public network.
>
> ```bash
> cd <repo checkout>                 # a clean checkout of the reviewed commit
> npm ci && npm run setup:zk         # once; setup:zk before compile
> npx hardhat clean && npx hardhat compile
> export MNEMONIC="test test test test test test test test test test test junk"
> export DEMO_RPC_URL=http://127.0.0.1:8547 NET=devnode
> export RB=/tmp/vanguard-runbook HANDOVER_CONFIG=/tmp/vanguard-runbook/handover.json
> mkdir -p $RB
> npx hardhat node --port 8547 > $RB/node.log 2>&1 &   # leave it running
> sleep 10                                              # until it listens
> ```
>
> Shell functions for the local starts (no reset or fixture exists on a
> public network):
>
> ```bash
> reset() { curl -s -X POST -H 'Content-Type: application/json' --data '{"jsonrpc":"2.0","method":"hardhat_reset","params":[],"id":1}' $DEMO_RPC_URL; echo; }
> l0deploy() { reset; rm -f $HANDOVER_CONFIG $HANDOVER_CONFIG.snapshot.*; HANDOVER_FIXTURE_OUT=$HANDOVER_CONFIG npx hardhat run test/production/deployHandoverFixture.ts --network $NET | tail -1; }
> l0() { l0deploy; npx hardhat run scripts/handover.ts --network $NET > $RB/handover.log 2>&1; tail -1 $RB/handover.log; }
> ```
>
> `reset` prints `{"jsonrpc":"2.0","id":1,"result":true}`; `l0deploy`
> adds the fixture (below):
> `handover fixture deployed; config written to /tmp/vanguard-runbook/handover.json`;
> `l0` adds the ceremony: `✅ Handover complete: the deployer holds no power.`
> Skip lines marked `# local` on a public network.
>
> **Two tracks.** The ceremony CLI (`scripts/handover.ts`) is the
> production path; locally it runs on the handover fixture
> (`test/production/deployHandoverFixture.ts`, a full stack; its
> `handover.json` names ops 1, guardian 2, proposer 4, voters 5 and 6,
> issuer admin 7). The demo (`npm run demo:drive`) shows the other steps
> with section 1's role table (ops 10, guardian 11, issuer admin 9); it
> keeps its state in memory, so each drive starts from a reset.

## 1. Roles and keys

| Role         | Holds                                                                                               | Key on a public network                           |
| ------------ | --------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| Governance   | owner of every core contract after the ceremony; acts only by vote                                  | a contract (no key)                               |
| Ops          | agent roles, compliance officer, list oracles, OracleManager operator, `listOperator`, escrow admin | multisig; on Sepolia the owner's own signer (Q11) |
| Guardian     | `Token.pause()` on VSC, nothing else                                                                | multisig; on Sepolia the owner's own signer (Q11) |
| Issuer admin | owner and only key of every trusted claim issuer                                                    | multisig, held by a party that is not ops (D25 b) |
| Issuers      | claim signing for their topic                                                                       | the issuer admin's key                            |
| Nodes        | oracle consensus votes                                                                              | three independent node keys (Q4, D50)             |
| Deployer     | everything until the ceremony; in the voting window only votes; afterwards nothing                  | external signer (Task 5.7)                        |

- No single `PRIVATE_KEY` on a public network (R-2F6-6).
  `hardhat.config.ts` still falls back to it for `sepolia` (and uses it
  for `mainnet`) until Task 5.7: never set it for a ceremony.
- No key is both an IdentityRegistry agent and an issuer owner or signer
  (D25 b); ops, guardian and issuer admin are three holders, none the
  deployer or governance. The preflight refuses either.

Local: any. Check the wallets (the demo's indices, from `MNEMONIC`):

```bash
npx hardhat run scripts/print-role-wallets.js --network $NET
```

prints one row per role, locally
` 10  ops                                0xBcd4042DE499D14e55001CcbB24a551F3b954096  10000.0 ETH`
(on Sepolia the balances to fund; amounts pending 5.7).

## 2. Deploy (final after Task 5.7)

What exists today:

- `scripts/production/DeployProduction.ts` deploys only the identity
  layer (OnchainIDFactory, KeyManager, KYC and AML issuers,
  IdentityRegistry, ComplianceRules) from `signers[0]`; no
  `handover.json`. Local: in-process (over RPC it waits forever for 3
  confirmations):

  ```bash
  npx hardhat run scripts/production/DeployProduction.ts --network hardhat > $RB/deploy-identity.log 2>&1; grep "Complete!" $RB/deploy-identity.log
  ```

  prints `✅ System Configuration Complete!` and
  `🎉 Production Deployment Complete!`.

- The full stack (token, governance, oracles, privacy pair, factories) is
  deployed today only by the demo (option 1 or 1a, then 21, 51, 31, 74) or,
  locally, by the handover fixture (L0).
- Task 5.7 adds the full-stack deploy with an external signer, writing
  `handover.json`; until then do not improvise one on a public network.

`handover.json` has one root, `governance` (every other contract is
derived from it), the wallet indices and the acknowledgement lists; every
key in [TESTNET_CEREMONY](TESTNET_CEREMONY.md#handover-ceremony).

## 3. Voter registration (D25)

The ceremony's proposer and voters must be verified wallets that control
their OnchainID, hold the VGT fees for every acceptance vote, and whose
identity is at least `minVoterAge` (7 days / `GOV_TIME_SCALE`) old at the
first ceremony proposal: register and fund them 7 days ahead.

- Onboard with demo options 23 or 24 (`24:1:<name>` in a drive) or the
  issuers' claims (6 and 7); fund with 75a (mint; the deployer before the
  ceremony, ops after it) or 75.
- Delete every identity whose claims expired before any proposal is
  created (`deleteIdentity`, by an IdentityRegistry agent): it still
  counts toward quorum (D7).
- The CLI checks this before its first transaction. Local: L0.

  ```bash
  l0   # local
  grep "minVoterAge" $RB/handover.log
  ```

  A young identity stops it with
  `❌ Handover failed: Handover: voter 0x… has an identity younger than minVoterAge (Ns); governance refuses it ("Identity too new to vote"): …`;
  L0 prints
  `   ✅ governance minVoterAge 420s is at least 7 days / TIME_SCALE (420s)`.

## 4. Oracle nodes (D50, Q4)

Production runs three independent node keys. Nodes the deployer
registered (demo option 31 registers wallets 1, 2 and 3) vote with keys
the deployer chose; the ceremony names each:
`   ⚠️  OracleManager node 0x… (KYC_ORACLE) was registered by the deployer at block N: it votes with a key the deployer chose; rotate deployer-era nodes by an OracleParameters vote (D50)`.
Only OracleManager's owner registers or removes nodes, so rotate by vote
once governance owns it, before the deployment counts as live (R-56-2):
new nodes first, so that at least two stay registered and none alone
reaches the 66% bar (`TooFewNodes`, `SingleNodeQuorum`).

1. Register each production node by an OracleParameters vote. Local: L0
   (node keys: wallets 9, 10, 11; on a public network `<NODE_1>`..`<NODE_3>`).
   The proposer sends the executions, never the deployer.

   ```bash
   l0   # local
   npx hardhat console --network $NET <<'EOF'
   const fs = await import("fs");
   const cfg = JSON.parse(fs.readFileSync(process.env.HANDOVER_CONFIG, "utf8"));
   const s = await ethers.getSigners();
   const { proposeCall, castAcceptanceVotes, settleProposal } = await import("./demo/utils/HandoverVotes.js");
   const g = await ethers.getContractAt("VanguardGovernance", cfg.governance, s[cfg.proposer]);
   const om = await ethers.getContractAt("OracleManager", await g.boundTarget(2));
   const nodes = [s[9].address, s[10].address, s[11].address];
   for (const [i, n] of nodes.entries()) { const id = await proposeCall(g, s[cfg.proposer], 2, om, om.interface.encodeFunctionData("registerOracle", [n, `NODE_${i + 1}`, "production node", 500]), `Register node ${i + 1}`, "runbook 4"); await castAcceptanceVotes(g, id, cfg.voters.map((v) => s[v])); await settleProposal(g, id); }
   console.log("registered nodes:", (await om.getRegisteredOracles()).join(" "));
   EOF
   ```

   prints one `   ⏩ proposal #N: voting period + execution delay: jumped Ns (dev node)`
   per node, then
   `registered nodes: 0xa0Ee7A142d267C1f36714E4a8F75612F20a79720 0xBcd4042DE499D14e55001CcbB24a551F3b954096 0x71bE63f3384f5fb98995898A86B02Fb2426c5788`.
   Acknowledge them in `handover.json` (`oracleNodes`):

   ```bash
   node -e 'const fs = require("fs"); const p = process.env.HANDOVER_CONFIG; const c = JSON.parse(fs.readFileSync(p, "utf8")); c.oracleNodes = process.argv.slice(1); fs.writeFileSync(p, JSON.stringify(c, null, 2)); console.log("oracleNodes:", c.oracleNodes.length)' 0xa0Ee7A142d267C1f36714E4a8F75612F20a79720 0xBcd4042DE499D14e55001CcbB24a551F3b954096 0x71bE63f3384f5fb98995898A86B02Fb2426c5788
   ```

   prints `oracleNodes: 3` (publicly the three `<NODE_n>`). Then audit
   (section 10; again after every rotation, `oracleNodes` updated):

   ```bash
   HANDOVER_PHASE=audit npx hardhat run scripts/handover.ts --network $NET > $RB/audit-d50.log 2>&1; tail -1 $RB/audit-d50.log
   grep "OracleManager node" $RB/audit-d50.log
   ```

   ends `✅ Audit passed: the deployer holds no power.` and lists
   `   ✅ every registered OracleManager node is acknowledged in oracleNodes (3 registered, 3 acknowledged)`
   (a node left out fails it). The accept phase compares with the
   ceremony's snapshot: after any vote it fails for good
   (`   ❌ appeared after the preflight, not granted by the ceremony: 0x… in OracleManager nodes, …`).

2. Remove each deployer-era node by an OracleParameters vote: demo option
   76, type 2, action 3 (`removeOracle`), then 77 per voter (77 approves
   the voter's fee itself), 79 and 78. Local: reset.

   ```bash
   reset   # local
   npm run demo:drive -- --strict --timeout 1800 --log $RB/d50.log 1 21 51 31 74 24:1:Alice 24:1:Bob 24:1:Carol 24:1:Dave 75a:4:1000:y 75a:5:1000:y 75a:6:1000:y 75a:7:1000:y 22 32 83c:y 83d 83e 35a "76:2:3:2:D50 rotation" 77:11:4:y: 77:11:5:y: 77:11:6:y: 77:11:7:y: 79:y 78:11:y 39 0
   ```

   The log (`$RB/d50.log`) shows
   `   Call: OracleManager.removeOracle(0x90F79bf6EB2c4f870365E785982E1f101E93b906, D50 rotation)`,
   four `✅ VOTE CAST SUCCESSFULLY!`, option 78's
   `   Executing from 0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65 (a voter on it)`
   (never wallet 0 after the ceremony), `✅ PROPOSAL EXECUTED — callData ran, locked VGT burned` and
   option 39's `   Total Oracles: 2`; it ends `✓ demo ran to completion`.

Node operators: clearing a governance sanction by consensus is a visible,
accountable act (D27, section 9). Ops pauses a node at once (35a above:
`   ⏸️  ops paused node 3 0x90F79bf6EB2c4f870365E785982E1f101E93b906`).

## 5. The ceremony

Run from a clean checkout of the reviewed commit after
`npx hardhat clean && npx hardhat compile`: the code-hash pins compare
against `artifacts/`, so a coverage build refuses an honest deployment.
Local: `l0deploy` stands in for the deploy.

```bash
l0deploy   # local
npx hardhat run scripts/handover.ts --network $NET > $RB/handover.log 2>&1; tail -1 $RB/handover.log
```

It prints `🔑 Handover: deployer powers` (steps 1, 2, 5, 3),
`   snapshot written: /tmp/vanguard-runbook/handover.json.snapshot.json`
and its digest (section 6), `🏛️  Handover: governance accepts by vote` (one
`   ✅ Token: owned by governance (proposal #1)` line per contract),
`🔍 Handover: verify`, and ends
`✅ Handover complete: the deployer holds no power.` (or
`⚠️  Handover complete with warnings: see above.`). A failure ends
`❌ Handover failed: <reason>`, exit 1; the preflight refuses before the
first transaction. Demo options 83c, 83d, 83e run the same ceremony
(`scripts/ci/strict-drive.sh`), ending with the warnings line (option
31's nodes and option 1's attestor key are deployer-era).

Rules for the window and after:

- From the preflight to the last acceptance vote the deployer key sends
  only votes (a transaction to governance that emits a voting event) and
  VGT `approve(governance)` (R-417-8). Any other or reverted deployer
  transaction fails the completion for good. After the ceremony the
  deployer key sends nothing; proposals are executed by ops or a voter.
- A contract nominated to governance is accepted only by a vote of the
  type bound to it (`VanguardGovernance.boundTarget`); the ceremony does
  this for every plan contract, the EscrowWalletFactory included
  (EscrowFactoryParameters). No type targets an InvestorRequestManager or
  a list oracle: ops is their intended owner (D44). Never nominate
  governance on them: such a nomination can never be accepted (it fails
  safe; R-56-3 corrects the 5.1 carried-in rule). Check and clear it from
  ops; `IRM` is the address the completion names in
  `   ✅ registrar / officer contract 0x… code matches the compiled InvestorRequestManager`.
  The `# local` lines plant a nomination to clear:

  ```bash
  export IRM=0x851356ae760d987E095750cCeb3bC6014560891C   # local; else <IRM_ADDRESS>
  npx hardhat console --network $NET <<'EOF'   # local
  const fs = await import("fs"); const cfg = JSON.parse(fs.readFileSync(process.env.HANDOVER_CONFIG, "utf8")); const s = await ethers.getSigners(); await (await (await ethers.getContractAt("InvestorRequestManager", process.env.IRM)).connect(s[cfg.ops]).transferOwnership(cfg.governance)).wait();
  EOF
  npx hardhat console --network $NET <<'EOF'
  const fs = await import("fs");
  const cfg = JSON.parse(fs.readFileSync(process.env.HANDOVER_CONFIG, "utf8"));
  const s = await ethers.getSigners();
  const irm = await ethers.getContractAt("InvestorRequestManager", process.env.IRM);
  console.log("owner:", await irm.owner(), "pendingOwner:", await irm.pendingOwner());
  if ((await irm.pendingOwner()) !== ethers.ZeroAddress) await (await irm.connect(s[cfg.ops]).transferOwnership(ethers.ZeroAddress)).wait();
  console.log("pendingOwner:", await irm.pendingOwner());
  EOF
  ```

  prints `owner: 0x70997970C51812dc3A010C7d01b50e0d17dc79C8 pendingOwner: 0x9A676e781A523b5d0C0e43731313A708CB607508`
  (ops; governance pending), then
  `pendingOwner: 0x0000000000000000000000000000000000000000`.

- Onboard only identities the OnchainIDFactory made, whose
  `recoveryManager()` is the pinned KeyManager (I-2): an identity
  deployed outside the factory can carry a stranger's MANAGEMENT key and
  recovery manager.
- A claim signature made before a revocation on that (identity, topic)
  fails with `Signer does not have claim signer key`: re-sign at the new
  revocation epoch (Task 5.2).
- Exempt the treasury and the escrow fee wallets before the ceremony;
  after it only an InvestorTypeConfig vote can.

## 6. The snapshot (B-6)

The full phase writes `$HANDOVER_CONFIG.snapshot.json` (the preflight's
findings, chain id and block, the ceremony's transactions), its sha256
beside it (`….snapshot.json.sha256`, `sha256sum` format) and prints the
digest. `HANDOVER_PHASE=accept` refuses a file whose hash differs from
the sidecar or from `HANDOVER_SNAPSHOT_SHA256`; the sidecar can be
rewritten with the file, so pass the recorded digest. Local: L0.

1. Right after the full phase, keep the digest it printed
   (`   snapshot sha256: <64 hex> (in …snapshot.json.sha256; keep this line with the run's records)`):
   `awk '/snapshot sha256:/ {print $3}' $RB/handover.log > $RB/snapshot.sha256; cat $RB/snapshot.sha256`.
2. Before every accept run, check and pass it:

   ```bash
   sha256sum -c $HANDOVER_CONFIG.snapshot.json.sha256
   HANDOVER_SNAPSHOT_SHA256=$(cat $RB/snapshot.sha256) HANDOVER_PHASE=accept npx hardhat run scripts/handover.ts --network $NET > $RB/accept.log 2>&1; tail -1 $RB/accept.log
   ```

   prints `/tmp/vanguard-runbook/handover.json.snapshot.json: OK`; the log
   has `⏭️  HANDOVER_PHASE=accept: deployer steps skipped`,
   `   snapshot sha256: <64 hex> (matches the full phase's)` and
   `   snapshot: /tmp/vanguard-runbook/handover.json.snapshot.json (block N)`
   and ends as in section 5.

3. An edited snapshot stops it before anything is read (a re-run, not a
   pass: record it so and run the full phase again):
   `❌ Handover failed: snapshot hash mismatch: …snapshot.json hashes to <hex>, but …snapshot.json.sha256 records <hex>: the file was edited after the full phase wrote it; a completion against it is a re-run, not a pass`
   (sidecar rewritten too: `… but HANDOVER_SNAPSHOT_SHA256 is <hex>: …`).
4. A full re-run writes a new pair to a new path, then renames it (a
   read-only old file is replaced: `   (replaced a snapshot with sha256 <hex>)`);
   move the old pair into the record first. An unwritable directory stops
   it before step 1 (`❌ Handover failed: EACCES: permission denied, open '…snapshot.json.tmp'`).

## 7. The KeyManager ops identity

KeyManager has no owner. The ops identity opts in by
`authorizeManager(KeyManager)` and pins KeyManager as its recovery
manager, both sent by the identity's owner.
`scripts/production/DeployProduction.ts` (its KeyManager steps in
`scripts/production/opsKeyManager.ts`) sends both when the deploying
wallet owns the identity named by `OPS_IDENTITY`, and otherwise prints
the calls the ops key must send. Local: after section 2's run:

```bash
grep -E "OPS_IDENTITY|must send" $RB/deploy-identity.log
```

With `OPS_IDENTITY` unset it prints
`   ⚠️  OPS_IDENTITY not set: KeyManager is authorized on no identity yet.`
and
`   The ops key must send: OnchainID(<ops identity>).authorizeManager(0x…) from the identity owner <ops key>`.
With `OPS_IDENTITY=<ops OnchainID>` owned by the ops key it prints the
`authorizeManager` call and
`   The ops key must also send: OnchainID(<ops OnchainID>).pinRecoveryManager(0x…) from the identity owner 0x…`
(not driven locally); send both from the ops key. A pin is final: it
refuses an identity pinned to another manager. Then remove every
MANAGEMENT key you do not know and seat at least two recovery agents
(`setupKeyRecovery`, threshold at least 2).

## 8. Rule administrators per token

A rule administrator sets that token's jurisdiction rule (which lapses
every private jurisdiction record); the role is per token. Step 1 makes
governance the rule administrator on VSC and VGT
(`   ✅ ComplianceRules rule administrator on VSC: governance 0x…`), step 5
removes the deployer
(`   ✅ deployer removed as ComplianceRules rule administrator on VSC`).
Afterwards only governance and ops may hold it; a change is a
ComplianceRules vote on `setRuleAdministrator(token, account, bool)`.
Local: section 5's log; every completion prints
`   ✅ no ComplianceRules rule administrator but governance and ops`:

```bash
grep "rule administrator" $RB/handover.log
```

## 9. List oracles: fill, then bind (D47); sanction clearing (D27)

No deploy binds a WhitelistOracle to VSC. Binding one turns on the
investor-type tier rule for every holder, so list every holder at its
type's tier first, then bind (`ComplianceRules.setWhitelistOracle(VSC, oracle)`,
a ComplianceRules vote after the ceremony). On Sepolia ops operates the
VSC whitelist oracle (Q3). Demo option 38a does both and votes the bind
(`38a:y`). Local: reset.

```bash
reset   # local
npm run demo:drive -- --strict --timeout 1800 --log $RB/d47.log 1 21 51 31 74 24:1:Alice 24:1:Bob 24:1:Carol 24:1:Dave 75a:4:1000:y 75a:5:1000:y 75a:6:1000:y 75a:7:1000:y 22 32 83c:y 83d 83e 38a:y 0
```

The log shows `   ✅ no holder would be frozen by the bind`,
`   ✅ proposal #11 executed` and
`   ✅ rules.whitelistOracle(VSC) = 0x36C02dA8a0983159322a80FFE9F24b1acfF8B570`;
a holder the bind would freeze stops it at `   ⛔ Bind refused: <reason>`.

An oracle consensus may clear a governance (no-expiry) blacklist entry
when its verdict resolved after the governance write (D27 = a). Watch for
it daily and after every incident. Local: L0.

```bash
l0   # local
npx hardhat console --network $NET <<'EOF'
const fs = await import("fs");
const cfg = JSON.parse(fs.readFileSync(process.env.HANDOVER_CONFIG, "utf8"));
const g = await ethers.getContractAt("VanguardGovernance", cfg.governance);
const rules = await ethers.getContractAt("ComplianceRules", await g.boundTarget(1));
const bl = await ethers.getContractAt("BlacklistOracle", await rules.blacklistOracle(await g.boundTarget(3)));
const ev = (await bl.queryFilter(bl.filters.BlacklistUpdated(), cfg.fromBlock ?? 0)).filter((e) => e.args.reason === "Oracle consensus clearing");
console.log("consensus clearings:", ev.length, ev.map((e) => `${e.args.subject} @${e.blockNumber}`));
EOF
```

prints `consensus clearings: 0 []` on L0 (no blacklist oracle bound) and
one subject per clearing otherwise. The emergency-oracle key and the
oracle owner (ops) are held by parties able to re-list within hours.

## 10. Upgrades

- A new ComplianceRules or InvestorTypeRegistry is a fresh deploy, not a
  migration (D34 a): governance binds its ComplianceRules at
  construction. Redeploy the list oracles with it (their bindings and
  `listManager` point at the old set), bind them fill-then-bind (section
  9), and run the checks again.
- The day-2 audit, after an upgrade, a rotation or any vote that moves a
  power: every completion line against the state governance derives now
  and `handover.json`'s acknowledgements, with no snapshot or window;
  sends nothing. A change by vote that leaves the deployer no power
  passes; a deployer power, an unacknowledged holder (agent, role, owner,
  node, attestor, trusted contract), a pending owner but governance or
  ops, or an open proposal on a plan contract fails (audit between
  votes). An acknowledged node passes whoever sent its registration.
  Local: section 9's L0 chain.

  ```bash
  HANDOVER_PHASE=audit npx hardhat run scripts/handover.ts --network $NET > $RB/audit.log 2>&1; tail -1 $RB/audit.log
  grep "Handover audit" $RB/audit.log
  ```

  ends `✅ Audit passed: the deployer holds no power.` (`⚠️  Audit passed with warnings: see above.`;
  failing: `❌ Handover failed: audit failed (see ❌ above)`) and has
  `🔍 Handover audit: every completion line against the state governance derives now (no snapshot, no voting window)`.
  Before the ceremony: `❌ Handover failed: HANDOVER_PHASE=audit: the ceremony has not completed: governance does not own Token, …; run the full phase (or HANDOVER_PHASE=accept) first`.

- Never unbind an oracle as a remedy: unbinding switches its gate off
  (with no blacklist oracle nobody is sanctions-checked; OracleOnly with
  no whitelist oracle passes every party). Rebind a working oracle, or
  pause the token (section 12).

## 11. Recovery drills

- KeyManager recovery, on a drill identity, quarterly: demo option 12
  rotates a key, then recovers with two agents, evicting a planted key
  and moving the owner after 7 days. Local: reset.

  ```bash
  reset   # local
  npm run demo:drive -- --strict --timeout 1800 --log $RB/d12.log 1 21 51 12 0
  ```

  The log shows `   ✅ executeKeyRecovery (receipt): 2 MANAGEMENT keys evicted`,
  `   ✅ owner() = wallet 6 (investor Alice) 0x976EA74026E726554dB657fA54763abd0C3a0aa9`
  and `✅ Key rotated; recovery evicted the rogue key and moved the owner`;
  the drive ends `✓ demo ran to completion`. On a public network the
  option prints when each timelock (24 h rotation, 48 h recovery, 7 days
  owner transfer) becomes executable; run it again then, in the same
  demo session.

- A holder without seated agents whose owner key is lost cannot be
  recovered through KeyManager: ops, the token agent, burns the balance
  (`Token.burn(lostWallet, amount)`) and re-issues it to the holder's
  new, onboarded wallet (`Token.mint(newWallet, amount)`). No script or
  demo option does this yet (5.8).

## 12. Incident: pause and the voted unpause (D24, D56)

- The guardian pauses VSC (`Token.pause()`); only governance, the owner,
  unpauses it, by a TokenParameters vote. The guardian can pause again
  after a voted unpause, and a pause never expires (D56; an audit item).
  Local: L0.

  ```bash
  l0   # local
  npx hardhat console --network $NET <<'EOF'
  const fs = await import("fs");
  const cfg = JSON.parse(fs.readFileSync(process.env.HANDOVER_CONFIG, "utf8"));
  const s = await ethers.getSigners();
  const { proposeCall, castAcceptanceVotes, settleProposal } = await import("./demo/utils/HandoverVotes.js");
  const g = await ethers.getContractAt("VanguardGovernance", cfg.governance, s[cfg.proposer]);
  const vsc = await ethers.getContractAt("Token", await g.boundTarget(3));
  await (await vsc.connect(s[cfg.guardian]).pause()).wait();
  console.log("VSC paused:", await vsc.paused());
  const id = await proposeCall(g, s[cfg.proposer], 3, vsc, vsc.interface.encodeFunctionData("unpause"), "Unpause VSC", "runbook 12");
  await castAcceptanceVotes(g, id, cfg.voters.map((v) => s[v]));
  await settleProposal(g, id, "unpause VSC");
  console.log("VSC paused:", await vsc.paused());
  EOF
  ```

  prints `VSC paused: true`,
  `   ⏩ unpause VSC: voting period + execution delay: jumped 656s (dev node)`
  and `VSC paused: false`; on a public network `settleProposal` waits.
  Option 76 builds no TokenParameters proposal (types 0, 1, 2, 11, 12).

- VGT: a pause by vote is released by ops (VGT agent) with `unpause()`
  and no vote (D24 a). A pause meant to hold against ops must remove ops
  as a VGT agent in the same pre-voted batch.
- A misbehaving node: ops pauses it (`pauseOracle`, demo 35a), governance
  removes it (section 4). A failing oracle: rebind a working one or pause
  the token; never unbind (section 10).
