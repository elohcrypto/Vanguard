# Runbook rehearsal: local node (2026-10-20)

An independent operator (not the runbook's author) followed
[OPERATOR_RUNBOOK](../OPERATOR_RUNBOOK.md) and its five parts in the
order its "local rehearsal order" gives, typing every command as written
(pasted into one interactive bash shell in a terminal session). No
repository file but this record was changed.

- Date: 2026-10-20
- Commit rehearsed: `90620ac` (branch `feat/zk-kyc-ownership-cleanup`).
  Two commits landed in the same worktree during the run (`34f85f3`,
  `b2cca93`, prettier on three files under `test/production/`); no file
  the runbook runs changed (`deployHandoverFixture.ts` untouched).
- Driver: an Opus agent that did not write the docs.
- Node v22.23.1, npm 10.9.8; Hardhat node on port 8548, `NET=devnode`.
- Ports (substituted, see D1): node 8548 (the box's 8547), signers 8550
  (the docs' 8549), 2.2's measurement 8552 and 8553 (`<FREE_PORT>`).
- Record directory: `RB=/tmp/vanguard-runbook-1020` (with
  `HANDOVER_CONFIG`, `PROD_RECORD`, `PROD_CONFIG` under it) instead of
  `/tmp/vanguard-runbook`, so quoted paths print with `-1020`; that is
  this substitution, not a deviation.
- `npm ci && npm run setup:zk` skipped: the tree was already set up
  (`node_modules/`, `build/circuits/` with the five circuits).

`=` means the quoted line appeared verbatim (addresses and `N` as the
runbook's conventions allow). Output abridged with `…`.

## The box and section 1

| Command                                                                    | Exit | Quoted output                                                                                       | Result |
| -------------------------------------------------------------------------- | ---- | --------------------------------------------------------------------------------------------------- | ------ |
| `npx hardhat clean && npx hardhat compile` (30 s)                          | 0    | (none quoted)                                                                                       | PASS   |
| the `export` lines, `rm -rf $RB && mkdir -p $RB`, node on 8548, `sleep 10` | 0    | node log: `Started HTTP and WebSocket JSON-RPC server at http://127.0.0.1:8548/`                    | PASS   |
| `reset`, `l0deploy`, `l0`, `prod` defined as written                       | 0    | (used below)                                                                                        | PASS   |
| `npx hardhat run scripts/print-role-wallets.js --network $NET`             | 0    | ` 10  ops                                0xBcd4042DE499D14e55001CcbB24a551F3b954096  10000.0 ETH` = | PASS   |

## 1a. The production signer box (signer on 8550)

| Command                                                                                  | Exit     | Quoted output                                                                                                                                                                                                                                                                                      | Result    |
| ---------------------------------------------------------------------------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- |
| `(umask 077; printf … > $RB/ks-password)`                                                | 0        | (none)                                                                                                                                                                                                                                                                                             | PASS      |
| `signer.js new $RB/ks 10-deployer 20-proposer`                                           | 0        | `10-deployer 0x…`, `20-proposer 0x…` =                                                                                                                                                                                                                                                             | PASS      |
| `signer.js new $RB/ks 15-claim-kyc`                                                      | 0        | the sort warning (`warning: 15-claim-kyc.json sorts before 20-proposer.json: …`) and `15-claim-kyc 0x…` =                                                                                                                                                                                          | PASS      |
| `SIGNER_TEST=1 … node scripts/production/signer.js 8550 > $RB/prod-signer.log 2>&1 &`    | 0        | (in the log, below)                                                                                                                                                                                                                                                                                | PASS      |
| `sleep 5; cat …; pkill -f "scripts/production/signer.js 8550"; sleep 1; ls $RB/ks.token` | 2 (`ls`) | `signer on 127.0.0.1:8550: 3 key(s), chain 31337, NOT asking; token in /tmp/vanguard-runbook-1020/ks.token; 0 signed nonce(s) remembered` =; `   0 10-deployer`, `   1 15-claim-kyc`, `   2 20-proposer` =; `ls: cannot access '/tmp/vanguard-runbook-1020/ks.token': No such file or directory` = | PASS (D2) |

## 2. Deploy (production track, one chain, no reset)

| Command                                                                                                                              | Exit | Quoted output                                                                                                                                                                                                                                                                                        | Result                                    |
| ------------------------------------------------------------------------------------------------------------------------------------ | ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| 2.1 `RPC_CHECK_URLS=$DEMO_RPC_URL node scripts/production/rpcCheck.js --chain 31337`                                                 | 0    | `   ✅ chain id 31337 (want 31337)`, `   ✅ archive: state at block 0 served (head 0)`, `   ✅ getLogs: up to 100000 blocks per call accepted (logChunk <= 100000)`, scan count, rate line, `   ℹ️  gas: gasPrice 1.875 gwei, priority fee 1.000 gwei, base fee 1.000 gwei`, `✅ rpc-check passed` = | PASS                                      |
| 2.2 `DEPLOY_NODE_PORT=8552 DEPLOY_SIGNER_PORT=8553 COST_GWEI=20 scripts/ci/deploy-drive.sh > $RB/cost-drive.log 2>&1; sed …` (356 s) | 0    | the cost table; `deploy drive PASS in 354s (logs /tmp/deploy-drive.fs3ENR)` =. Figures: deploy 74608814 (doc 74608826), onboarding 16305984 (doc 16305900), total 200157309 gas (doc 200157249), every ETH figure equal                                                                              | PASS (within the doc's "a few dozen gas") |
| 2.2 `node scripts/production/costTable.js table --gwei 1.875 /tmp/deploy-drive.fs3ENR/gas-deploy.json`                               | 0    | `Cost table at 1.875 gwei (fund = +50%, Q19):` … `total 200157309 gas  0.3753 ETH  fund 0.5629 ETH`                                                                                                                                                                                                  | PASS (D3)                                 |
| 2.3 remote signer on 8550, `export SIGNER_RPC_URL=http://127.0.0.1:8550`, the `node -e … > $RB/deploy.json` line, the deploy (18 s)  | 0    | `✅ Deployed: 74 transactions in /tmp/vanguard-runbook-1020/deploy-record.json (0 from the record, 74 sent now; 74,608,826 gas)` =; `✅ Preflight passed: …` =                                                                                                                                       | PASS                                      |
| 2.3 "Re-run the line" (the deploy line again, log to `$RB/deploy-rerun.log`)                                                         | 0    | `(74 from the record, 0 sent now; 74,608,826 gas)` =; `   ⏭️  #0 new OnchainIDFactory: skipped (recorded, code hash ok)` =                                                                                                                                                                           | PASS                                      |

## 3. Voters and the deployer's VGT

| Command                                                               | Exit | Quoted output                                                                                                                                                                                   | Result |
| --------------------------------------------------------------------- | ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| `prod scripts/production/onboardVoters.ts …; echo "exit $?"; grep …`  | 0    | `exit 0` =; `   ✅ wallet 4 0x15d34AAf…6A65: verified (identity 0x…), 1000.0 VGT; votes from <date>` = (wallets 4, 5, 6); `⏳ voters registered; … (chain time now <date>, 604796 s to wait)` = | PASS   |
| the `WAIT=…` line and the two `curl` lines                            | 0    | `{"jsonrpc":"2.0","id":1,"result":"604875"}` and `{"jsonrpc":"2.0","id":1,"result":"0"}` =                                                                                                      | PASS   |
| re-run of the onboarding line ("A re-run adds …")                     | 0    | each line ends `1000.0 VGT (already onboarded); votes from …` =; no `⏳` line on the re-run (O2)                                                                                                | PASS   |
| the `env -u MNEMONIC npx hardhat console --network remote` burn block | 0    | `deployer VGT: 0.0` =                                                                                                                                                                           | PASS   |

## 5a. The ceremony on the production track, audit, scan

| Command                                                                                         | Exit | Quoted output                                                                                                                                                                                                                                                            | Result    |
| ----------------------------------------------------------------------------------------------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------- |
| `prod scripts/handover.ts > $RB/prod-full.log 2>&1; echo "exit $?"; tail -1 …` (22 s)           | 0    | `exit 0`, `⚠️  Handover complete with warnings: see above.` =; seven closing warnings (exempt fee wallet, the attestor key in three circuits, three deployer-era nodes; no VGT warning) plus the earlier `   ⚠️  oracle 0x… is not bound on chain; handed over anyway` = | PASS (D4) |
| `grep -E "open at once\|settled .* of chain time" $RB/prod-full.log`                            | 0    | `   🗳️  11 proposal(s) open at once: #1, …, #11` =; `   ⏱️  11 proposal(s) settled 864071 s of chain time after #1 was created` = (about 864000)                                                                                                                         | PASS      |
| `HANDOVER_PHASE=audit prod scripts/handover.ts …`                                               | 0    | `exit 0`, `⚠️  Audit passed with warnings: see above.` =                                                                                                                                                                                                                 | PASS      |
| `(umask 077; echo "$DEMO_RPC_URL,http://localhost:8548" > $RB/scan-urls)`                       | 0    | (none)                                                                                                                                                                                                                                                                   | PASS (D1) |
| `SCAN_RPC_URLS_FILE=$RB/scan-urls SCAN_CHUNKS=5000,1000 prod scripts/production/scanCount.ts …` | 0    | `exit 0`, `✅ all 21 scans count the same on every RPC and chunk size` =; log `🔎 scan counts at block 220 (heads 220, 220)` =, `      2 \| 2 \| 2 \| 2  RoleGranted @ 0x… (1 topic filter(s))` =                                                                        | PASS      |

## 4 and 4a. Post-ceremony votes and claim signers (production track)

| Command                                                                                      | Exit | Quoted output                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Result        |
| -------------------------------------------------------------------------------------------- | ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- |
| `NEW_NODES=…:NODE_1,…:NODE_2,…:NODE_3 prod scripts/production/postCeremonyVotes.ts …` (12 s) | 0    | `exit 0`, `   🗳️  round 1: 6 proposal(s), registrations and re-approvals`, `   🗳️  round 2: 3 removal(s), every production node registered`, `✅ post-ceremony votes executed; nodes now 0x…, 0x…, 0x…`, `   set handover.json "oracleNodes" to [...], then run HANDOVER_PHASE=audit` =; log: `register production node 0xFABB…694a (NODE_1) (proposal #12)`, three `re-approve issuer key Ax …` (#15-17), `remove deployer-era node 0x70997970…79C8 (KYC_ORACLE) (proposal #18)` = | PASS          |
| the `node -e '… c.oracleNodes = …'` line, then the audit and its `grep`                      | 0    | `oracleNodes: 3`, `exit 0` =; `   ✅ the deployer is not an OracleManager node` =, second deployer line differs (D5); `   ✅ no OracleManager node is ops, the guardian, …` =; `(3 registered, 3 acknowledged)` =; `weight shares: 0x… 100 (33.3%), …` =; no deployer-era or attestor line =                                                                                                                                                                                        | MISMATCH (D5) |
| `CLAIM_SIGNERS=kyc:0xcd3B…ce71,aml:0x2546…EC30 prod scripts/production/claimSigners.ts …`    | 0    | `exit 0`, two `   ✅ a claim signed by 0x… verifies on 0x… (verifyClaim)`, `   add both to handover.json: "claimSigners": [...] (the day-2 audit accepts them there)` =                                                                                                                                                                                                                                                                                                             | PASS          |
| the `node -e '… c.claimSigners = …'` line, then the audit, `tail`, `grep`                    | 0    | `claimSigners: 2`, `exit 0`, `✅ Audit passed: the deployer holds no power.` =; two `   ✅ claimSigners 0x…: a CLAIM_SIGNER key the issuer admin added after the ceremony on KYC Service (0x…)` (`AML Service`) =; the one warning `   ⚠️  0x23618e81E3f5cdF7f54C3d65f7FBc0aBf5B21E8f is investorLimitExempt (set before the handover): …` =                                                                                                                                        | PASS          |

## 2.4. The multisig box (50 s)

Pasted as one block, with the port substituted and the `pkill` narrowed
(D1, D2): `reset; pkill -f "remote-signer.js 8550"; SIGNER_COUNT=14 …
remote-signer.js 8550 …`, then the remaining lines verbatim.

| Step                                  | Exit | Quoted output                                                                                                                                                                                                   | Result |
| ------------------------------------- | ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| `dep` (first)                         | 3    | `exit 3`, `⏸️  awaiting 1 ops transaction: /tmp/vanguard-runbook-1020/ms-record.ops-transactions.json` = (plus an unquoted `   execute it in the multisig, then run the deploy again: …` line)                  | PASS   |
| `dep` (second)                        | 3    | the same pause and `   ❌ not executed: [deploy.custody.accept] InvestorRequestManager 0x….acceptOwnership(): …` =                                                                                              | PASS   |
| `exe … 10,12; dep`                    | 0    | `executed 1 calls on 0x…`, `exit 0`, `   ✅ 1 role transaction effect(s) hold on chain`, the preflight line =                                                                                                   | PASS   |
| `msrun scripts/ci/deploy-voters.js …` | 0    | (none quoted)                                                                                                                                                                                                   | PASS   |
| `msrun scripts/handover.ts …`         | 3    | `exit 3`, `⏸️  awaiting 4 issuerAdmin transactions: …/ms-handover.json.issuer-admin-transactions.json`, `⏸️  awaiting 2 ops transactions: …/ms-handover.json.ops-transactions.json` =                           | PASS   |
| `export MS_SHA256=…`, the two `exe`   | 0    | `executed 2 calls on 0x…`, `executed 4 calls on 0x…` =                                                                                                                                                          | PASS   |
| the accept line                       | 0    | `exit 0`, `   ✅ 6 role transaction effect(s) hold on chain`, `⚠️  Handover complete with warnings: see above.` =; eight warnings incl. `   ⚠️  deployer still holds 1000000.0 VGT (99.73% of the supply): …` = | PASS   |

## Fixture and demo boxes

| Section | Command                                                                                                              | Exit | Quoted output                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Result    |
| ------- | -------------------------------------------------------------------------------------------------------------------- | ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- |
| 3       | `l0`, `grep "minVoterAge" $RB/handover.log`                                                                          | 0    | `{"jsonrpc":"2.0","id":1,"result":true}`, `handover fixture deployed; config written to /tmp/vanguard-runbook-1020/handover.json`, `✅ Handover complete: the deployer holds no power.`, `   ✅ governance minVoterAge 420s is at least 7 days / TIME_SCALE (420s)` =                                                                                                                                                                                                                                                                                                      | PASS      |
| 4       | `reset`, the `npm run demo:drive -- --strict --timeout 2400 --log $RB/d50.log 1 21 … 39 83f 0` line verbatim (390 s) | 0    | summary `answers sent : 191/191`, `demo exit : 0`, `❌ lines : 0`, `✓ demo ran to completion` =                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | PASS      |
| 4 (log) | `$RB/d50.log`                                                                                                        |      | `   Call: OracleManager.registerOracle(0x23618e81…1E8f, NODE_4, registered by an OracleParameters vote, 500)` =; `   ⚠️  no free demo wallet: type the node's address` ×2 =; three `removeOracle(…, D50 rotation)` (wallets 1-3) =; `   Proposer: 0x15d34AAf…6A65` =; 18 `✅ VOTE CAST SUCCESSFULLY!` =; 6 `   Executing from … (the proposer)` and 6 `✅ PROPOSAL EXECUTED — …` =; option 39 `   Total Oracles: 3` =; first 83f `… (KYC_ORACLE) was registered by the deployer at block 53: …` =; 35a `   ⏸️  ops paused node 3 0x90F7…b906`, then `node 2 0x3C44…93BC` = | PASS      |
| 4       | `awk '/HANDOVER STEP 4/{n++} n==2' $RB/d50.log \| grep -E …`                                                         | 0    | only `   ✅ every registered OracleManager node is acknowledged in oracleNodes (3 registered, 6 acknowledged)` and `⚠️  Audit passed with warnings: see above.` =; warnings left: the attestor key (three circuits), `deployer still holds 0.0 VSC (investorLimitExempt: true, …)`, `deployer still holds 999990.0 VGT …` =                                                                                                                                                                                                                                                | PASS      |
| 5       | `l0deploy`, the `handover.ts` line (8 s)                                                                             | 0    | `✅ Handover complete: the deployer holds no power.` =; log: `🔑 Handover: deployer powers`, `📝 Step 1`, `2`, `5`, `3` in that order, `   snapshot written: /tmp/vanguard-runbook-1020/handover.json.snapshot.json`, `   🗳️  12 proposal(s) open at once: #1, …`, `   ✅ Token: owned by governance (proposal #1)`, `🔍 Handover: verify`, `   ✅ registrar / officer contract 0x851356ae…891C code matches the compiled InvestorRequestManager` =                                                                                                                        | PASS      |
| 5       | `export IRM=0x851356ae…891C`, the `# local` plant console block, the check-and-clear block                           | 0    | `owner: 0x70997970C51812dc3A010C7d01b50e0d17dc79C8 pendingOwner: 0x9A676e781A523b5d0C0e43731313A708CB607508`, `pendingOwner: 0x0000000000000000000000000000000000000000` =                                                                                                                                                                                                                                                                                                                                                                                                 | PASS      |
| 6       | `export TICKET_SHA256=$(awk … $RB/handover.log)`                                                                     | 0    | log line `   snapshot sha256: ac410996…edefe (in …snapshot.json.sha256; record this line outside the run directory)` =                                                                                                                                                                                                                                                                                                                                                                                                                                                     | PASS (D6) |
| 6       | `sha256sum -c $HANDOVER_CONFIG.snapshot.json.sha256`                                                                 | 0    | `/tmp/vanguard-runbook-1020/handover.json.snapshot.json: OK` =                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | PASS      |
| 6       | `HANDOVER_SNAPSHOT_SHA256=$TICKET_SHA256 HANDOVER_PHASE=accept … accept.log; tail -1 …`                              | 0    | `✅ Handover complete: …` =; log `⏭️  HANDOVER_PHASE=accept: deployer steps skipped`, `   snapshot sha256: ac410996…edefe (matches the full phase's)`, `   snapshot: /tmp/vanguard-runbook-1020/handover.json.snapshot.json (block 62)` =                                                                                                                                                                                                                                                                                                                                  | PASS      |
| 6       | implied: the same line without `HANDOVER_SNAPSHOT_SHA256`                                                            | 1    | `❌ Handover failed: snapshot digest missing: set HANDOVER_SNAPSHOT_SHA256 to the digest the full phase printed for …snapshot.json ("snapshot sha256: <hex>", recorded outside the run directory); …` =                                                                                                                                                                                                                                                                                                                                                                    | PASS      |
| 7       | `grep -E "OPS_IDENTITY\|must send" $RB/deploy.log`                                                                   | 0    | `   ⚠️  OPS_IDENTITY not set: KeyManager is authorized on no identity yet.` =; `   The ops key must send: OnchainID(<ops identity>).authorizeManager(0xCf7Ed3Ac…0Fc9) from the identity owner <ops key>` =                                                                                                                                                                                                                                                                                                                                                                 | PASS      |
| 8       | `grep "rule administrator" $RB/handover.log`                                                                         | 0    | `… on VSC: governance 0x9A67…7508` (and VGT), `   ✅ deployer removed as ComplianceRules rule administrator on VSC` (and VGT), `   ✅ no ComplianceRules rule administrator but governance and ops` = (plus an unquoted `deployer is not a … rule administrator on VSC or VGT`)                                                                                                                                                                                                                                                                                            | PASS      |
| 9       | `reset`, the `--log $RB/d47.log … 38a:y 0` drive verbatim (89 s)                                                     | 0    | `✓ demo ran to completion`; log `   ✅ no holder would be frozen by the bind`, `   ✅ proposal #11 executed`, `   ✅ rules.whitelistOracle(VSC) = 0x36C02dA8a0983159322a80FFE9F24b1acfF8B570` =; no `⛔ Bind refused`                                                                                                                                                                                                                                                                                                                                                      | PASS      |
| 9       | `l0`, the consensus-clearings console block                                                                          | 0    | `consensus clearings: 0 []` =                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | PASS      |
| 10      | the audit line and `grep "Handover audit" $RB/audit.log` (section 9's L0 chain)                                      | 0    | `✅ Audit passed: the deployer holds no power.`, `🔍 Handover audit: every completion line against the state governance derives now (no snapshot, no voting window)` =                                                                                                                                                                                                                                                                                                                                                                                                     | PASS      |
| 10      | implied: `l0deploy`, then the audit line                                                                             | 0    | `❌ Handover failed: HANDOVER_PHASE=audit: the ceremony has not completed: governance does not own Token, GovernanceToken, …, VanguardGovernance; run the full phase (or HANDOVER_PHASE=accept) first` =                                                                                                                                                                                                                                                                                                                                                                   | PASS      |
| 11      | `reset`, `npm run demo:drive -- --strict --timeout 1800 --log $RB/d12.log 1 21 51 12 0` (14 s)                       | 0    | `   ✅ executeKeyRecovery (receipt): 2 MANAGEMENT keys evicted`, `   ✅ owner() = wallet 6 (investor Alice) 0x976EA74026E726554dB657fA54763abd0C3a0aa9`, `✅ Key rotated; recovery evicted the rogue key and moved the owner`; drive `✓ demo ran to completion` =                                                                                                                                                                                                                                                                                                          | PASS      |
| 12      | `l0`, the pause / voted-unpause console block (pasted unindented, D7)                                                | 0    | `VSC paused: true`, `   ⏩ unpause VSC: voting period + execution delay: jumped 656s (dev node)`, `VSC paused: false` =                                                                                                                                                                                                                                                                                                                                                                                                                                                    | PASS      |
| end     | `unset MNEMONIC PRIVATE_KEY`                                                                                         | 0    | (none)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | PASS      |

## Skipped (the doc's own wording) or no command given

- Sepolia only: 1a steps 1-5 on Sepolia (keystores, the prompt, `bump`,
  `forget`, `help`), 1b re-pinning, 2.1's `RPC_CHECK_URLS_FILE` form,
  2.3's public config and `attest.js --public-key`
  ([ZK command lines](../TESTNET_ZK_CLI.md)), 5a's waits and resume lines.
- "Steps 2 and 3 of the Safe app are not driven locally" (2.5).
- Driven by `scripts/ci/multisig-drive.sh`, "not by this box": the
  ops-identity pause and the claim-signer batch (2.4, section 7).
- No command given: 2.1's argv refusal; 2.3's lock, retry and adoption
  lines; 2.4's accept-before-execution exit 3 and full re-run refusal;
  3's young-identity refusal and the demo onboarding options; 5a's
  0600 refusal; 6 steps 3 and 4; 11's lost-key burn and re-mint ("no
  script yet"); 12's VGT and node bullets.

## Deviations

- **D1** (NOTE; box, 1a, 2.3, 2.4, 5a). Ports are hard-coded: the box's
  `DEMO_RPC_URL=http://127.0.0.1:8547` and `npx hardhat node --port
8547`; 8549 in 1a's signer and `pkill` lines, 2.3's signer and
  `SIGNER_RPC_URL`, 2.4's signer; `http://localhost:8547` in 5a's
  `scan-urls`. On a machine where those ports are taken the operator
  edits nine places by hand; I used 8548 and 8550 everywhere. Only 2.2
  uses `<FREE_PORT>`. Suggest a `NODE_PORT` / `SIGNER_PORT` pair set in
  the box.
- **D2** (NOTE, hazard; 1a, 2.4). The `pkill -f` patterns match by
  command-line substring. 2.4's `pkill -f remote-signer.js` stops every
  `remote-signer.js` on the machine, any port and any session (a CI drive
  or another rehearsal); I narrowed it to `"remote-signer.js 8550"`. 1a's
  `pkill -f "scripts/production/signer.js 8549"` also matched the
  driver's own wrapper shell, whose command line contained the string
  (it was killed; the operator shell's lines all ran and printed as
  quoted). Suggest `kill $!` right after starting each process.
- **D3** (NOTE; 2.2). "price at the gas `rpc-check` printed" while it
  prints three figures (gasPrice, priority fee, base fee). Interpreted
  `<GWEI>` as `gasPrice` (1.875); `costTable.js` accepted the decimal.
- **D4** (NOTE; 2.3). "the three deployer-trusted issuer keys": the
  ceremony prints one attestor key in three circuits
  (`   ⚠️  PrivacyManager issuer key (Ax …) for jurisdiction|accreditation|compliance was trusted by the deployer: …`);
  section 4 words it so ("three circuits"). A reader may look for three
  ClaimIssuer keys.
- **D5** (MISMATCH; section 4, the audit after the post-ceremony votes).
  The doc: "the two deployer lines (`   ✅ the deployer is not an OracleManager node`)".
  Printed: `   ✅ the deployer is not an OracleManager node` and
  `   ✅ the deployer 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266 is not an OracleManager node`.
  Same fact, second line not as quoted.
- **D6** (NOTE; section 6). "Local: L0." with no `l0` line in the
  section, while step 1 reads `$RB/handover.log`. Interpreted as section
  5's L0 chain (no new run); between that full phase and this accept,
  section 5's IRM plant-and-clear ran; the accept passed anyway.
- **D7** (NOTE; sections 10, 11, 12). The boxes sit inside list items and
  are indented two spaces in the markdown source. Copied from the source,
  section 12's heredoc terminator is `  EOF` and does not close
  `<<'EOF'` (the shell waits). Pasted as rendered (indent removed).

## Observations (not deviations)

- **O1**. Another session worked in the same worktree during the run
  (two test files edited, then committed); `npx hardhat clean` in the
  box deletes `artifacts/` under anyone else using the tree.
- **O2** (3). The onboarding re-run after the clock jump prints no `⏳`
  line; the doc does not claim one.
- **O3** (4, 4a). The audits after the post-ceremony votes print the
  `investorLimitExempt` `⚠️` line yet end `✅ Audit passed: …`, while
  section 10 says warnings end `⚠️  Audit passed with warnings`; 4a
  quotes exactly this pair, so the doc is consistent with the code, but
  section 10's rule reads otherwise.
- **O4** (2.2). The drive leaves `/tmp/deploy-drive.fs3ENR/` outside
  `$RB` (its gas JSON is the input of the next line).

## Summary

| Measure                                   | Count                                                            |
| ----------------------------------------- | ---------------------------------------------------------------- |
| Command rows run (blocks counted as rows) | 53 (4 implied: the deploy and onboarding re-runs, two refusals)  |
| Rows whose every quoted line matched      | 52                                                               |
| Deviations: BLOCKER                       | 0                                                                |
| Deviations: MISMATCH                      | 1 (D5)                                                           |
| Deviations: NOTE                          | 6 (D1, D2, D3, D4, D6, D7)                                       |
| Drives                                    | 2.2 measurement 356 s; d50 390 s; d47 89 s; d12 14 s; all exit 0 |

Verdict: an operator can follow the local track verbatim. Every chain
result and every quoted line appeared but one wording (D5). What an
operator on a shared machine must change is the hard-coded ports (D1),
and the broad `pkill` patterns (D2) should be fixed before someone runs
them beside a CI drive.

Processes: node 8548, signers 8550 (both 1a's and 2.3/2.4's), the 2.2
drive's own 8552/8553 (stopped by the drive); all stopped at the end,
nothing left listening on 8548-8554.
