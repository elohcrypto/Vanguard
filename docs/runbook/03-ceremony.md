# Runbook part 3: voters and the ceremony

Part of the [operator runbook](../OPERATOR_RUNBOOK.md) (conventions, the
local rehearsal box, the `prod` function and the order of work are
there). The deploy: [part 2](02-deploy.md).

## 3. Voter registration (D25)

The ceremony's proposer and voters are verified wallets that control
their OnchainID, hold the VGT fees for every acceptance vote, with an
identity at least `minVoterAge` (7 days / `GOV_TIME_SCALE`; 7 days on
Sepolia) old at the first proposal. Each is a key of its own in the
signer (never the deployer, a role or a node). Delete every identity
whose claims expired (`deleteIdentity`): it still counts toward quorum
(D7). A deleted identity's deposit still locked in a proposal is
claimed with `claimRefundFor(proposalId, identity)` from a verified
wallet that controls that identity (R-517-8).

`scripts/production/onboardVoters.ts` onboards the deploy's proposer and
voters through the signer (the OnchainID, the KYC and AML claims the
issuers' owner signs, the registry entry, the verification cache) and
tops each up to `VOTER_VGT` (default 1000) VGT minted by the deployer.
Every step is read back first: a re-run sends only what is missing. It
moves no clock: it prints when each may vote. Production track (after
2.3, no reset):

```bash
prod scripts/production/onboardVoters.ts > $RB/voters.log 2>&1; echo "exit $?"; grep -E "^   ✅ wallet|^⏳" $RB/voters.log
WAIT=$(grep -oE "[0-9]+ s to wait" $RB/voters.log | grep -oE "^[0-9]+")   # local
curl -s -X POST -H 'Content-Type: application/json' --data "{\"jsonrpc\":\"2.0\",\"method\":\"evm_increaseTime\",\"params\":[$((WAIT + 1))],\"id\":1}" $DEMO_RPC_URL; echo   # local: past the voter age
curl -s -X POST -H 'Content-Type: application/json' --data '{"jsonrpc":"2.0","method":"evm_mine","params":[],"id":1}' $DEMO_RPC_URL; echo   # local
```

prints `exit 0`, one line per voter
(`   ✅ wallet 4 0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65: verified (identity 0x…), 1000.0 VGT; votes from <date>`, wallets 4, 5 and 6) and
`⏳ voters registered; the ceremony's full phase passes its voter check from <date> (chain time now <date>, 604796 s to wait)`.
Locally the two `curl` lines print `{"jsonrpc":"2.0","id":1,"result":"N"}`
and `{"jsonrpc":"2.0","id":1,"result":"0"}`. A re-run adds
`(already onboarded)` to each line and sends nothing.
Refused: a voter that is the deployer, a role or a node, a chain other
than the record's, an incomplete record, and a run after the ceremony.
On Sepolia wait the printed time (7 days) before section 5; the
onboarding signs each claim through `vanguard_signClaim` (section 1a).

**The deployer's VGT, before the ceremony.** The deploy mints the
deployer 1,000,000 VGT; it pays proposal and voting deposits. Take it
out of use while the deployer can still send: after the window opens it
sends only votes, after the ceremony nothing, and VGT has no forced
transfer. A transfer to a treasury is refused (`Sender not verified`:
the production deployer has no identity, and must not get one), so the
deployer, still a VGT agent, burns it; after the ceremony ops (a VGT
agent) mints the treasury what it needs. Production track (after the
voters are onboarded, before section 5):

```bash
env -u MNEMONIC npx hardhat console --network remote <<'EOF'
const fs = await import("fs"); const rec = JSON.parse(fs.readFileSync(process.env.PROD_RECORD, "utf8")); const vgt = await ethers.getContractAt("GovernanceToken", rec.contracts.governanceToken, await ethers.getSigner(rec.deployer)); await (await vgt["burn(address,uint256)"](rec.deployer, await vgt.balanceOf(rec.deployer))).wait(); console.log("deployer VGT:", ethers.formatEther(await vgt.balanceOf(rec.deployer)));
EOF
```

prints `deployer VGT: 0.0`. The ceremony and the audit then print no
`deployer still holds … VGT` warning; left in place, the warning names
the only remaining path (ops: `burn(deployer, amount)` or
`setAddressFrozen(deployer, true)`).

The demo track onboards with options 23, 24 (`24:1:<name>`) or claims 6
and 7 and funds with 75a (a mint by the deployer before the ceremony,
ops after) or 75. The ceremony checks the voter age first. Local: L0.

```bash
l0   # local
grep "minVoterAge" $RB/handover.log
```

A young identity stops it with `❌ Handover failed: Handover: voter 0x… has an identity younger than minVoterAge (Ns); governance refuses it ("Identity too new to vote"): …`;
L0 prints `   ✅ governance minVoterAge 420s is at least 7 days / TIME_SCALE (420s)`.

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
(`   🗳️  12 proposal(s) open at once: #1, …` on the fixture, then one
`   ✅ Token: owned by governance (proposal #1)` line per contract),
`🔍 Handover: verify`, and ends `✅ Handover complete: the deployer holds no power.` (or
`⚠️  Handover complete with warnings: see above.`). A failure ends
`❌ Handover failed: <reason>`, exit 1 (the preflight refuses before the
first transaction); a multisig role pauses it, exit 3 (section 2.4).
`HANDOVER_PHASE` selects the phase: unset or `full`, `preflight` (the
checks up to the first transaction, nothing sent; the deploy runs it),
`accept` (resume, section 6) and `audit` (section 10). Demo options 83c,
83d, 83e run it too (`scripts/ci/strict-drive.sh`).

The rules for the window and after (the deployer key sends only votes
and VGT `approve(governance)` in the window and nothing after it; no
governance nomination on an InvestorRequestManager or list oracle;
factory-made identities only; re-sign claims after a revocation
(`Signer does not have claim signer key`); exempt the treasury and fee
wallets first) and their reasons: [TESTNET_CEREMONY](../TESTNET_CEREMONY.md#runbook-rules-for-the-ceremony-and-after-plan-2f).
Once governance owns VSC, `scripts/handover.ts`, `onboardVoters.ts`,
`claimSigners.ts` and `postCeremonyVotes.ts` refuse a transaction from
the deployer's key (`DeployProduction.ts` installs no such guard). The
signer itself still signs for wallet 0 for any local client holding its
token, a console snippet included: never run a console snippet as wallet
0 after the ceremony. The guarantee is the audit's
`✅ Audit passed: the deployer holds no power.` (section 10). Check and
clear a nomination on the
InvestorRequestManager from ops; `IRM` is the address the completion
names in `   ✅ registrar / officer contract 0x… code matches the compiled InvestorRequestManager`.
The `# local` lines plant one to clear:

```bash
export IRM=0x851356ae760d987E095750cCeb3bC6014560891C   # local; else <IRM_ADDRESS>
npx hardhat console --network $NET <<'EOF'   # local
const fs = await import("fs"); const cfg = JSON.parse(fs.readFileSync(process.env.HANDOVER_CONFIG, "utf8")); const s = await ethers.getSigners(); await (await (await ethers.getContractAt("InvestorRequestManager", process.env.IRM)).connect(s[cfg.ops]).transferOwnership(cfg.governance)).wait();
EOF
npx hardhat console --network $NET <<'EOF'
const fs = await import("fs"); const cfg = JSON.parse(fs.readFileSync(process.env.HANDOVER_CONFIG, "utf8")); const s = await ethers.getSigners(); const irm = await ethers.getContractAt("InvestorRequestManager", process.env.IRM); console.log("owner:", await irm.owner(), "pendingOwner:", await irm.pendingOwner()); if ((await irm.pendingOwner()) !== ethers.ZeroAddress) await (await irm.connect(s[cfg.ops]).transferOwnership(ethers.ZeroAddress)).wait(); console.log("pendingOwner:", await irm.pendingOwner());
EOF
```

prints `owner: 0x70997970C51812dc3A010C7d01b50e0d17dc79C8 pendingOwner: 0x9A676e781A523b5d0C0e43731313A708CB607508`
(ops; governance pending), then `pendingOwner: 0x0000000000000000000000000000000000000000`.
With a Safe ops the clearing `transferOwnership(0x0000000000000000000000000000000000000000)`
is the Safe's own transaction.

## 5a. On a public chain

The same CLI on the deploy's `handover.json`, through the signer:

- The full phase sends the deployer's steps, writes the snapshot and its
  digest, then pauses (exit 3) for the ops and issuer-admin Safe batches
  (2.4, 2.5) before any vote. Record the digest (section 6), execute both
  batches, then run the accept phase.
- Parallel acceptance (Q14): every acceptance proposal is opened at once
  (`   🗳️  11 proposal(s) open at once: #1, …, #11` on a production
  deploy), voted, and settled in order; the whole set needs one voting
  period and execution delay, about 10 days. Publicly the CLI waits (it
  polls the chain), so run it where it can keep running for that long
  (e.g. a tmux session); it stops at the first failed vote.
- A killed run is resumed by the same command (`HANDOVER_PHASE=accept`
  with the digest): it first waits for its own senders' pending
  transactions
  (`   ⏳ <config> (accept): waiting for pending transactions to mine first: 0x… (nonce N..N) (up to 900 s)`),
  then adopts its open proposals (`   ↪️  IdentityRegistry: proposal #3 already open; adopted`)
  and skips the settled ones (`   ✅ Token: already owned by governance`).
  On an RPC error the same request is repeated at the same pinned nonce,
  never as a second transaction (`   ↻ …`; a send whose reply was lost
  is `adopted (not resent)`).
- After completion the deployer sends nothing (the four ceremony and
  post-ceremony CLIs refuse its key; section 5). Run the day-2 audit,
  and the scan cross-check below.

Production track (after section 3; locally the roles are signer wallets,
so nothing pauses):

```bash
prod scripts/handover.ts > $RB/prod-full.log 2>&1; echo "exit $?"; tail -1 $RB/prod-full.log
grep -E "open at once|settled .* of chain time" $RB/prod-full.log
HANDOVER_PHASE=audit prod scripts/handover.ts > $RB/prod-audit.log 2>&1; echo "exit $?"; tail -1 $RB/prod-audit.log
```

prints `exit 0`, `⚠️  Handover complete with warnings: see above.` (the
seven warnings of 2.3: the deployer's VGT was burned),
`   🗳️  11 proposal(s) open at once: #1, #2, #3, #4, #5, #6, #7, #8, #9, #10, #11`,
`   ⏱️  11 proposal(s) settled N s of chain time after #1 was created`
(about 864000 s: the 10 days, jumped on the dev node), `exit 0` and
`⚠️  Audit passed with warnings: see above.`

**Scan cross-check (`scanCount`).** The ceremony reads every holder of a
power from event scans; a provider that silently caps or drops logs
makes a scan look clean. `scripts/production/scanCount.ts` runs the
read-only phase (the audit once governance owns the plan, else the
preflight) once per RPC and `logChunk`, counts each scan's raw hits and
exits 1 when any count differs or a phase fails. The audit fails while a
proposal on a plan contract is open, so run it between votes: right
after the ceremony completes, on both RPCs with two chunk sizes (the URLs from `SCAN_RPC_URLS_FILE`, this user's
0600 file, comma or newline separated; never typed inline):

```bash
(umask 077; echo "$DEMO_RPC_URL,http://localhost:$NODE_PORT" > $RB/scan-urls)   # local; publicly the file holds the provider URL and the own node's URL
SCAN_RPC_URLS_FILE=$RB/scan-urls SCAN_CHUNKS=5000,1000 prod scripts/production/scanCount.ts > $RB/scan.log 2>&1; echo "exit $?"; tail -1 $RB/scan.log
```

A file group or others can read is refused
(`SCAN_RPC_URLS_FILE must be this user's own file, mode 0600`). It prints `exit 0` and `✅ all N scans count the same on every RPC and chunk size`;
the log has `🔎 scan counts at block N (heads N, N)` and one row per scan
(`      2 | 2 | 2 | 2  RoleGranted @ 0x… (1 topic filter(s))`). A differing
row (marked `❌`) or a phase that failed on one RPC exits 1: find which
provider or chunk drops logs before trusting any phase on it.

## 6. The snapshot (B-6)

The full phase writes `$HANDOVER_CONFIG.snapshot.json`, its sha256 beside
it (`….snapshot.json.sha256`) and prints the digest. `HANDOVER_PHASE=accept`
requires that digest in `HANDOVER_SNAPSHOT_SHA256` and refuses a file whose
hash differs from it or the sidecar. Whoever can rewrite `$RB` can rewrite
all three, so `$RB` must not hold the only copy. Local: section 5's L0
chain as it is (its full phase, then the IRM plant-and-clear; no new
`l0`).

1. Right after the full phase, record the digest it printed
   (`   snapshot sha256: <64 hex> (in …snapshot.json.sha256; record this line outside the run directory)`)
   outside `$RB` (the ceremony ticket, a signed message, a second person);
   locally `export TICKET_SHA256=$(awk '/snapshot sha256:/ {print $3}' $RB/handover.log)`.
2. Before every accept run, take the digest from that record, not `$RB`
   (the box below). Publicly:
   `HANDOVER_SNAPSHOT_SHA256=<DIGEST> HANDOVER_PHASE=accept prod scripts/handover.ts`.

```bash
sha256sum -c $HANDOVER_CONFIG.snapshot.json.sha256
HANDOVER_SNAPSHOT_SHA256=$TICKET_SHA256 HANDOVER_PHASE=accept npx hardhat run scripts/handover.ts --network $NET > $RB/accept.log 2>&1; tail -1 $RB/accept.log
```

It prints `/tmp/vanguard-runbook/handover.json.snapshot.json: OK`; the
log has `⏭️  HANDOVER_PHASE=accept: deployer steps skipped`,
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
   An unwritable directory stops it before step 1 (`❌ Handover failed: EACCES: permission denied, open '…snapshot.json.tmp'`).
   After a pause for Safe batches (2.4) a full re-run is refused
   (`… a full re-run would send them again …`): resume with the accept
   phase.
