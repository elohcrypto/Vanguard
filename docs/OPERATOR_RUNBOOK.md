# Operator runbook (draft)

The ordered procedure to deploy Vanguard, hand it from the deployer to
governance and run it. Each step names the command or demo option and the
line it prints when it worked. The rules and their reasons:
[TESTNET_SETUP](TESTNET_SETUP.md), [TESTNET_CEREMONY](TESTNET_CEREMONY.md)
(its [runbook rules](TESTNET_CEREMONY.md#runbook-rules-for-the-ceremony-and-after-plan-2f)),
[TESTNET_DEMO_OPTIONS](TESTNET_DEMO_OPTIONS.md) and the deep dives
([transfer](DEEP_DIVE_TRANSFER.md), [identity](DEEP_DIVE_IDENTITY.md),
[ZK](DEEP_DIVE_ZK.md)).

Status: draft (Task 5.6; audit and digest since 5.6b). Section 2 is final
after Task 5.7 (external signer), the rest after the Sepolia run (5.8).

## Conventions and the local rehearsal

Shell variables, set once per session: `NET` (`devnode` locally, `sepolia`
in 5.8), `HANDOVER_CONFIG` (the ceremony's `handover.json`) and `RB` (the
run's record directory: logs, snapshot, digests; keep it). `<ANGLE>` is a
value the operator fills in. Output is quoted as printed; `0x…` and `N`
stand for an address and a number that differ between runs.

> **Local rehearsal box.** A fresh local node with Hardhat's public test
> accounts (a published phrase): never use them on a public network.
>
> ```bash
> cd <repo checkout>                 # a clean checkout of the reviewed commit
> npm ci && npm run setup:zk         # once; setup:zk before compile
> npx hardhat clean && npx hardhat compile
> export MNEMONIC="test test test test test test test test test test test junk"
> export DEMO_RPC_URL=http://127.0.0.1:8547 NET=devnode
> export RB=/tmp/vanguard-runbook HANDOVER_CONFIG=/tmp/vanguard-runbook/handover.json
> rm -rf $RB && mkdir -p $RB   # start from an empty $RB
> npx hardhat node --port 8547 > $RB/node.log 2>&1 &   # leave it running
> sleep 10                                              # until it listens
> ```
>
> Shell functions for the local starts (no reset or fixture publicly):
>
> ```bash
> reset() { curl -s -X POST -H 'Content-Type: application/json' --data '{"jsonrpc":"2.0","method":"hardhat_reset","params":[],"id":1}' $DEMO_RPC_URL; echo; }
> l0deploy() { reset; rm -f $HANDOVER_CONFIG $HANDOVER_CONFIG.snapshot.*; HANDOVER_FIXTURE_OUT=$HANDOVER_CONFIG npx hardhat run test/production/deployHandoverFixture.ts --network $NET | tail -1; }
> l0() { l0deploy; npx hardhat run scripts/handover.ts --network $NET > $RB/handover.log 2>&1; tail -1 $RB/handover.log; }
> ```
>
> `reset` prints `{"jsonrpc":"2.0","id":1,"result":true}`; `l0deploy`
> adds `handover fixture deployed; config written to /tmp/vanguard-runbook/handover.json`;
> `l0` adds `✅ Handover complete: the deployer holds no power.`
> Skip lines marked `# local` on a public network. When the rehearsal ends:
> `unset MNEMONIC PRIVATE_KEY` (`sepolia` and `mainnet` refuse the phrase).
>
> **Two tracks.** The ceremony CLI (`scripts/handover.ts`) is the
> production path; locally it runs on the handover fixture
> (`test/production/deployHandoverFixture.ts`: ops 1, guardian 2, proposer
> 4, voters 5 and 6, issuer admin 7). The demo (`npm run demo:drive`) shows
> the other steps with section 1's roles (ops 10, guardian 11, issuer
> admin 9); its state is in memory, so each drive starts from a reset.

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

- No single `PRIVATE_KEY` on a public network (R-2F6-6); `hardhat.config.ts`
  falls back to it for `sepolia` (and `mainnet`) until 5.7: never set it.
- No key is both an IdentityRegistry agent and an issuer owner or signer
  (D25 b); ops, guardian, issuer admin: three holders, none the deployer
  or governance. The preflight refuses either. Check the wallets:

```bash
npx hardhat run scripts/print-role-wallets.js --network $NET
```

prints one row per role, locally
` 10  ops                                0xBcd4042DE499D14e55001CcbB24a551F3b954096  10000.0 ETH` (on Sepolia
the balances to fund; amounts pending 5.7).

## 2. Deploy (final after Task 5.7)

- `scripts/production/DeployProduction.ts` deploys the identity layer
  only (OnchainIDFactory, KeyManager, KYC and AML issuers,
  IdentityRegistry, ComplianceRules) from `signers[0]`, no `handover.json`.
  Local: in-process (over RPC it waits forever for 3 confirmations):

  ```bash
  npx hardhat run scripts/production/DeployProduction.ts --network hardhat > $RB/deploy-identity.log 2>&1; grep "Complete!" $RB/deploy-identity.log
  ```

  prints `✅ System Configuration Complete!` and `🎉 Production Deployment Complete!`.

- The full stack is deployed today only by the demo (option 1 or 1a,
  then 21, 51, 31, 74) or locally by the fixture (L0); Task 5.7 adds the
  deploy writing `handover.json` (do not improvise one publicly; its keys:
  [TESTNET_CEREMONY](TESTNET_CEREMONY.md#handover-ceremony)).

## 3. Voter registration (D25)

The ceremony's proposer and voters are verified wallets that control
their OnchainID, hold the VGT fees for every acceptance vote, with an
identity at least `minVoterAge` (7 days / `GOV_TIME_SCALE`) old at the
first proposal: register and fund them 7 days ahead (onboard: demo
options 23, 24 `24:1:<name>` or claims 6 and 7; fund: 75a, a mint by the
deployer before the ceremony and ops after, or 75). Delete every identity
whose claims expired (`deleteIdentity`): it still counts toward quorum
(D7). The CLI checks all this first. Local: L0.

```bash
l0   # local
grep "minVoterAge" $RB/handover.log
```

A young identity stops it with
`❌ Handover failed: Handover: voter 0x… has an identity younger than minVoterAge (Ns); governance refuses it ("Identity too new to vote"): …`;
L0 prints
`   ✅ governance minVoterAge 420s is at least 7 days / TIME_SCALE (420s)`.

## 4. Oracle nodes (D50, Q4)

Production runs three independent node keys. The ceremony and the audit
name each node the deployer registered (demo option 31: wallets 1, 2, 3):
`   ⚠️  OracleManager node 0x… (KYC_ORACLE) was registered by the deployer at block N: it votes with a key the deployer chose; rotate deployer-era nodes by an OracleParameters vote (D50)`.
Rotate by vote once governance owns OracleManager, before going live
(R-56-2): new nodes first, so at least two stay and none alone reaches
the 66% bar (`TooFewNodes`, `SingleNodeQuorum`).

1. Register each production node by an OracleParameters vote; the
   proposer executes, never the deployer. Local: L0 (node keys: wallets
   9, 10, 11; publicly `<NODE_1>`..`<NODE_3>`).

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

   prints `oracleNodes: 3`. Then audit (section 10; again after every
   rotation, `oracleNodes` updated):

   ```bash
   HANDOVER_PHASE=audit npx hardhat run scripts/handover.ts --network $NET > $RB/audit-d50.log 2>&1; tail -1 $RB/audit-d50.log
   grep "OracleManager node" $RB/audit-d50.log
   ```

   ends `✅ Audit passed: the deployer holds no power.` and lists
   `   ✅ every registered OracleManager node is acknowledged in oracleNodes (3 registered, 3 acknowledged)`
   (a node left out fails it; one the deployer registered itself ends it
   `⚠️  Audit passed with warnings: see above.`). The accept phase compares
   with the ceremony's snapshot, so after any vote it fails for good
   (`   ❌ appeared after the preflight, not granted by the ceremony: 0x… in OracleManager nodes, …`).

2. Then remove each deployer-era node by an OracleParameters vote. The
   demo track does the whole rotation, add before remove (Task 5.12):
   option 76, type 2, action 7 (`registerOracle`, reputation 500) per new
   node, 77 per voter (77 approves the voter's fee), 79, 78; then action
   3 (`removeOracle`) for wallets 1-3 (all three proposed before any runs,
   so they are node indices 0-2), 77, 79, 78. Six, five, four, then three
   nodes: two always remain and none alone reaches the bar. Action 7
   takes the next free demo wallet on Enter; with the rehearsal's twelve
   wallets only wallet 8 is free, so it says so and two nodes are typed
   (keys the demo does not hold: they cannot answer rounds; publicly
   `<NODE_2>`, `<NODE_3>`). After the ceremony 76 proposes from the first
   eligible wallet but 0 and 78 executes from the proposer. Option 83f,
   before and after, is section 10's audit (`HANDOVER_PHASE=audit`, the
   same code) run from the demo's in-memory state; it acknowledges what
   the demo made: option 31's nodes, the nodes 76 proposed and option 1's
   attestor key. Local: reset.

   ```bash
   reset   # local
   npm run demo:drive -- --strict --timeout 2400 --log $RB/d50.log 1 21 51 31 74 24:1:Alice 24:1:Bob 24:1:Carol 24:1:Dave 75a:4:1000:y 75a:5:1000:y 75a:6:1000:y 75a:7:1000:y 22 32 83c:y 83d 83e 35a 83f 76:2:7:NODE_4:: 76:2:7:NODE_5::0x1111111111111111111111111111111111111111: 76:2:7:NODE_6::0x2222222222222222222222222222222222222222: 77:11:5:y: 77:11:6:y: 77:11:7:y: 77:12:5:y: 77:12:6:y: 77:12:7:y: 77:13:5:y: 77:13:6:y: 77:13:7:y: 79:y 78:11:y 78:12:y 78:13:y "76:2:3:0:D50 rotation" "76:2:3:1:D50 rotation" "76:2:3:2:D50 rotation" 77:14:5:y: 77:14:6:y: 77:14:7:y: 77:15:5:y: 77:15:6:y: 77:15:7:y: 77:16:5:y: 77:16:6:y: 77:16:7:y: 79:y 78:14:y 78:15:y 78:16:y 39 83f 0
   awk '/HANDOVER STEP 4/{n++} n==2' $RB/d50.log | grep -E "registered by the deployer|acknowledged in oracleNodes|Audit passed"
   ```

   The log (`$RB/d50.log`) shows
   `   Call: OracleManager.registerOracle(0x23618e81E3f5cdF7f54C3d65f7FBc0aBf5B21E8f, NODE_4, registered by an OracleParameters vote, 500)`
   (wallet 8), twice `   ⚠️  no free demo wallet: type the node's address`,
   `   Call: OracleManager.removeOracle(0x70997970C51812dc3A010C7d01b50e0d17dc79C8, D50 rotation)`
   (and wallets 2 and 3),
   `   Proposer: 0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65` (wallet 4),
   18 `✅ VOTE CAST SUCCESSFULLY!`, six times
   `   Executing from 0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65 (the proposer)`
   and `✅ PROPOSAL EXECUTED — callData ran, locked VGT burned`, and
   option 39's `   Total Oracles: 3`. The first 83f lists the three
   deployer-era nodes (`   ⚠️  OracleManager node 0x70997970C51812dc3A010C7d01b50e0d17dc79C8 (KYC_ORACLE) was registered by the deployer at block 53: …`).
   The `awk` prints only
   `   ✅ every registered OracleManager node is acknowledged in oracleNodes (3 registered, 6 acknowledged)`
   and `⚠️  Audit passed with warnings: see above.`: no deployer-era node
   line, and a node a governance execution registered prints none
   (R-56c-1). The warnings left are option 1's attestor key and the
   deployer's VSC exemption. The drive's own summary (stdout, not the
   log) ends `✓ demo ran to completion`; it ran 6:28 locally. CI runs the
   same rotation with free wallets, a 33a round answered by the new nodes
   only (`scripts/ci/regression-drives.sh`, drive `rotate`).

Ops pauses a misbehaving node at once (35a above pauses two:
`   ⏸️  ops paused node 3 0x90F79bf6EB2c4f870365E785982E1f101E93b906`,
then `   ⏸️  ops paused node 2 0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC`).
A consensus clearing a governance sanction is accountable (D27, section 9).

## 5. The ceremony

From a clean checkout of the reviewed commit after `npx hardhat clean &&
npx hardhat compile` (the code-hash pins compare against `artifacts/`; a
coverage build refuses an honest deployment). Local: `l0deploy` deploys.

```bash
l0deploy   # local
npx hardhat run scripts/handover.ts --network $NET > $RB/handover.log 2>&1; tail -1 $RB/handover.log
```

It prints `🔑 Handover: deployer powers` (steps 1, 2, 5, 3),
`   snapshot written: /tmp/vanguard-runbook/handover.json.snapshot.json`
and its digest (section 6), `🏛️  Handover: governance accepts by vote`
(one `   ✅ Token: owned by governance (proposal #1)` line per contract),
`🔍 Handover: verify`, and ends
`✅ Handover complete: the deployer holds no power.` (or
`⚠️  Handover complete with warnings: see above.`). A failure ends
`❌ Handover failed: <reason>`, exit 1; the preflight refuses before the
first transaction. Demo options 83c, 83d, 83e run the same ceremony
(`scripts/ci/strict-drive.sh`), ending with the warnings line.

The rules for the window and after (the deployer key sends only votes
and VGT `approve(governance)` in the window and nothing after it; no
governance nomination on an InvestorRequestManager or list oracle;
factory-made identities only; re-sign claims after a revocation
(`Signer does not have claim signer key`); exempt the treasury and fee
wallets first) and their reasons:
[TESTNET_CEREMONY](TESTNET_CEREMONY.md#runbook-rules-for-the-ceremony-and-after-plan-2f).
Check and clear a nomination on the InvestorRequestManager from ops;
`IRM` is the address the completion names in
`   ✅ registrar / officer contract 0x… code matches the compiled InvestorRequestManager`.
The `# local` lines plant one to clear:

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

## 6. The snapshot (B-6)

The full phase writes `$HANDOVER_CONFIG.snapshot.json`, its sha256
beside it (`….snapshot.json.sha256`) and prints the digest.
`HANDOVER_PHASE=accept` requires that digest in `HANDOVER_SNAPSHOT_SHA256`
and refuses a file whose hash differs from it or the sidecar. Whoever can
rewrite `$RB` can rewrite the snapshot, the sidecar and any digest kept
there together, so `$RB` must not hold the only copy. Local: L0.

1. Right after the full phase, record the digest it printed
   (`   snapshot sha256: <64 hex> (in …snapshot.json.sha256; record this line outside the run directory)`)
   outside `$RB` (the ceremony ticket, a signed message, a second person);
   locally a shell variable stands in:
   `export TICKET_SHA256=$(awk '/snapshot sha256:/ {print $3}' $RB/handover.log)`.

2. Before every accept run, take the digest from that record, not `$RB`:

   ```bash
   sha256sum -c $HANDOVER_CONFIG.snapshot.json.sha256
   HANDOVER_SNAPSHOT_SHA256=$TICKET_SHA256 HANDOVER_PHASE=accept npx hardhat run scripts/handover.ts --network $NET > $RB/accept.log 2>&1; tail -1 $RB/accept.log
   ```

   prints `/tmp/vanguard-runbook/handover.json.snapshot.json: OK`; the log
   has `⏭️  HANDOVER_PHASE=accept: deployer steps skipped`,
   `   snapshot sha256: <64 hex> (matches the full phase's)` and
   `   snapshot: /tmp/vanguard-runbook/handover.json.snapshot.json (block N)`
   and ends as in section 5. Without the variable it refuses:
   `❌ Handover failed: snapshot digest missing: set HANDOVER_SNAPSHOT_SHA256 to the digest the full phase printed for …snapshot.json ("snapshot sha256: <hex>", recorded outside the run directory); …`.

3. An edited snapshot stops it before anything is read (a re-run, not a
   pass: record it so and run the full phase again):
   `❌ Handover failed: snapshot hash mismatch: …snapshot.json hashes to <hex>, but …snapshot.json.sha256 records <hex>: the file was edited after the full phase wrote it; a completion against it is a re-run, not a pass`
   (sidecar rewritten too: `… but HANDOVER_SNAPSHOT_SHA256 is <hex>: …`).
4. A full re-run writes a new pair (a read-only old file is replaced:
   `   (replaced a snapshot with sha256 <hex>)`; record the old pair first).
   An unwritable directory stops it before step 1
   (`❌ Handover failed: EACCES: permission denied, open '…snapshot.json.tmp'`).

## 7. The KeyManager ops identity

KeyManager has no owner: the ops identity's owner sends
`authorizeManager(KeyManager)` and pins KeyManager as recovery manager
([identity](DEEP_DIVE_IDENTITY.md)). `scripts/production/DeployProduction.ts`
(its steps in `scripts/production/opsKeyManager.ts`) sends both when the
deploying wallet owns `OPS_IDENTITY`, else prints the calls the ops key
must send. Local: after section 2's run:

```bash
grep -E "OPS_IDENTITY|must send" $RB/deploy-identity.log
```

With `OPS_IDENTITY` unset it prints
`   ⚠️  OPS_IDENTITY not set: KeyManager is authorized on no identity yet.` and
`   The ops key must send: OnchainID(<ops identity>).authorizeManager(0x…) from the identity owner <ops key>`.
With `OPS_IDENTITY=<ops OnchainID>` owned by the ops key it prints the
`authorizeManager` call and
`   The ops key must also send: OnchainID(<ops OnchainID>).pinRecoveryManager(0x…) from the identity owner 0x…`
(not driven locally); send both from the ops key (a pin is final). Then
remove every MANAGEMENT key you do not know and seat at least two
recovery agents (`setupKeyRecovery`, threshold at least 2).

## 8. Rule administrators per token

The role (it sets the token's jurisdiction rule) is per token. Step 1
makes governance the rule administrator on VSC and VGT
(`   ✅ ComplianceRules rule administrator on VSC: governance 0x…`), step 5
removes the deployer
(`   ✅ deployer removed as ComplianceRules rule administrator on VSC`).
Afterwards only governance and ops hold it; a change is a ComplianceRules
vote on `setRuleAdministrator(token, account, bool)`. Every completion
prints `   ✅ no ComplianceRules rule administrator but governance and ops`.
Local: section 5's log:

```bash
grep "rule administrator" $RB/handover.log
```

## 9. List oracles: fill, then bind (D47); sanction clearing (D27)

No deploy binds a WhitelistOracle to VSC; binding one turns on the
investor-type tier rule for every holder, so list every holder at its
tier first, then bind (a ComplianceRules vote on
`ComplianceRules.setWhitelistOracle(VSC, oracle)`). On Sepolia ops
operates it (Q3). Demo option 38a does both and votes the bind
(`38a:y`). Local: reset.

```bash
reset   # local
npm run demo:drive -- --strict --timeout 1800 --log $RB/d47.log 1 21 51 31 74 24:1:Alice 24:1:Bob 24:1:Carol 24:1:Dave 75a:4:1000:y 75a:5:1000:y 75a:6:1000:y 75a:7:1000:y 22 32 83c:y 83d 83e 38a:y 0
```

The log shows `   ✅ no holder would be frozen by the bind`,
`   ✅ proposal #11 executed` and
`   ✅ rules.whitelistOracle(VSC) = 0x36C02dA8a0983159322a80FFE9F24b1acfF8B570`;
a holder the bind would freeze stops it at `   ⛔ Bind refused: <reason>`.

A consensus may clear a governance (no-expiry) blacklist entry when its
verdict resolved after the governance write (D27 = a). Watch daily and
after every incident; the emergency-oracle key and the oracle owner (ops)
must be able to re-list within hours. Local: L0.

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
one subject per clearing otherwise.

## 10. Upgrades and the day-2 audit

- A new ComplianceRules or InvestorTypeRegistry is a fresh deploy (D34
  a): redeploy the list oracles with it, bind them fill-then-bind
  (section 9), and audit.
- Never unbind an oracle as a remedy (it switches its gate off): rebind a
  working one, or pause the token (section 12).
- The day-2 audit, after an upgrade, a rotation or any vote that moves a
  power, sends nothing: what it checks, passes and fails is in
  [TESTNET_CEREMONY](TESTNET_CEREMONY.md#runbook-rules-for-the-ceremony-and-after-plan-2f).
  Audit between votes (an open proposal on a plan contract fails it).
  Local: section 9's L0 chain. Demo option 83f runs the same audit from
  the demo's in-memory state (section 4).

  ```bash
  HANDOVER_PHASE=audit npx hardhat run scripts/handover.ts --network $NET > $RB/audit.log 2>&1; tail -1 $RB/audit.log
  grep "Handover audit" $RB/audit.log
  ```

  ends `✅ Audit passed: the deployer holds no power.` (`⚠️  Audit passed with warnings: see above.`;
  failing: `❌ Handover failed: audit failed (see ❌ above)`) and has
  `🔍 Handover audit: every completion line against the state governance derives now (no snapshot, no voting window)`.
  Before the ceremony: `❌ Handover failed: HANDOVER_PHASE=audit: the ceremony has not completed: governance does not own Token, …; run the full phase (or HANDOVER_PHASE=accept) first`.

## 11. Recovery drills

- KeyManager recovery on a drill identity, quarterly: demo option 12
  rotates a key, then recovers with two agents, evicting a planted key
  and moving the owner after 7 days. Local: reset.

  ```bash
  reset   # local
  npm run demo:drive -- --strict --timeout 1800 --log $RB/d12.log 1 21 51 12 0
  ```

  The log shows `   ✅ executeKeyRecovery (receipt): 2 MANAGEMENT keys evicted`,
  `   ✅ owner() = wallet 6 (investor Alice) 0x976EA74026E726554dB657fA54763abd0C3a0aa9`
  and `✅ Key rotated; recovery evicted the rogue key and moved the owner`;
  the drive ends `✓ demo ran to completion`. Publicly the option prints
  when each timelock (24 h rotation, 48 h recovery, 7 days owner
  transfer) is due; run it again then, in the same demo session.

- A holder with no seated agents and a lost owner key: ops burns the
  balance (`Token.burn(lostWallet, amount)`) and re-issues it to the new,
  onboarded wallet (`Token.mint(newWallet, amount)`); no script yet (5.8).

## 12. Incident: pause and the voted unpause (D24, D56)

- The guardian pauses VSC (`Token.pause()`); only governance unpauses it,
  by a TokenParameters vote (option 76 builds none). A pause never
  expires and the guardian can pause again (D56). Local: L0.

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

  prints `VSC paused: true`, `   ⏩ unpause VSC: voting period + execution delay: jumped 656s (dev node)`
  and `VSC paused: false`; publicly `settleProposal` waits.

- VGT: a pause by vote is released by ops (VGT agent) with `unpause()`,
  no vote (D24 a); to hold against ops, remove ops as a VGT agent in the
  same pre-voted batch.
- A misbehaving node: ops pauses it (`pauseOracle`, 35a), governance
  removes it (section 4). A failing oracle: rebind or pause; never unbind.
