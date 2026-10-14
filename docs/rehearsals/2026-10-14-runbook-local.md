# Runbook rehearsal: local node (2026-10-14)

An independent operator (not the runbook's author) followed
[OPERATOR_RUNBOOK](../OPERATOR_RUNBOOK.md) top to bottom with its local
rehearsal box values, running every command as written. No repository
file was changed to make a step pass.

> Superseded procedure: this record ran the runbook at 87271ee. Its
> section 6 kept the operator digest in `$RB`; the runbook now records it
> outside the run directory (review M-2, R-56c-2). Follow the current
> [OPERATOR_RUNBOOK](../OPERATOR_RUNBOOK.md), not the commands below.

- Date: 2026-10-14
- Commit: `7db047c` (branch `feat/zk-kyc-ownership-cleanup`, the runbook
  at 446 lines)
- Node: Hardhat local node, port 8547, `NET=devnode`; Node v22.23.1,
  npm 10.9.8
- Record directory: `RB=/tmp/vanguard-runbook`,
  `HANDOVER_CONFIG=/tmp/vanguard-runbook/handover.json`
- Raw transcript (not committed): `/tmp/56-drive/` (one file per step,
  named by section; the final record directory copied to
  `/tmp/56-drive/rb-final/`)

Multi-line console blocks are cited by section, not repeated; each was
pasted verbatim. Output lines are abridged (`…`) where long.

## Conventions and the local rehearsal box

| Command                                                              | Expected                                                                           | Actual                                                                                                | Result |
| -------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | ------ |
| `cd <repo checkout>` (filled: the worktree at `7db047c`, clean)      | (none)                                                                             | clean tree                                                                                            | PASS   |
| `npm ci && npm run setup:zk`                                         | (none quoted)                                                                      | exit 0; `🎉 ZK circuit setup completed!`, `5 circuits compiled with real artifacts`; tree stays clean | PASS   |
| `npx hardhat clean && npx hardhat compile`                           | (none quoted)                                                                      | exit 0                                                                                                | PASS   |
| the three `export` lines and `mkdir -p $RB`                          | (none)                                                                             | set                                                                                                   | PASS   |
| `npx hardhat node --port 8547 > $RB/node.log 2>&1 &` then `sleep 10` | listens                                                                            | `Started HTTP and WebSocket JSON-RPC server at http://127.0.0.1:8547/`                                | PASS   |
| shell functions `reset`, `l0deploy`, `l0` defined as written         | `reset`: `{"jsonrpc":"2.0","id":1,"result":true}`                                  | `{"jsonrpc":"2.0","id":1,"result":true}` (every call below)                                           | PASS   |
| `l0deploy`                                                           | `handover fixture deployed; config written to /tmp/vanguard-runbook/handover.json` | same                                                                                                  | PASS   |
| `l0`                                                                 | `✅ Handover complete: the deployer holds no power.`                               | same (every call below)                                                                               | PASS   |

Note: `/tmp/vanguard-runbook` already existed with an earlier run's
files (logs, a `snap.bak`). The operator moved it aside (to
`/tmp/56-drive/prev-vanguard-runbook-22h32`) before `mkdir -p $RB`. The
box does not say to start from an empty `$RB`; see observation O1.

## 1. Roles and keys

| Command                                                        | Expected                                                                                          | Actual                                                                                            | Result |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | ------ |
| `npx hardhat run scripts/print-role-wallets.js --network $NET` | ` 10  ops                                0xBcd4042DE499D14e55001CcbB24a551F3b954096  10000.0 ETH` | ` 10  ops                                0xBcd4042DE499D14e55001CcbB24a551F3b954096  10000.0 ETH` | PASS   |

Also printed: `  9  issuer admin … 0xa0Ee7A14…9720` and
` 11  guardian … 0x71bE63f3…5788`. The table follows a contract-size
table (observation O2).

## 2. Deploy

| Command                                                                                                                                             | Expected                                                                  | Actual                                                                    | Result |
| --------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------- | ------ |
| `npx hardhat run scripts/production/DeployProduction.ts --network hardhat > $RB/deploy-identity.log 2>&1; grep "Complete!" $RB/deploy-identity.log` | `✅ System Configuration Complete!`, `🎉 Production Deployment Complete!` | `✅ System Configuration Complete!`, `🎉 Production Deployment Complete!` | PASS   |

The second bullet (full stack deploy writing `handover.json`) has no
command until Task 5.7.

## 3. Voter registration

| Command                               | Expected                                                                   | Actual                                                                     | Result |
| ------------------------------------- | -------------------------------------------------------------------------- | -------------------------------------------------------------------------- | ------ |
| `l0`                                  | `✅ Handover complete: the deployer holds no power.`                       | same                                                                       | PASS   |
| `grep "minVoterAge" $RB/handover.log` | `   ✅ governance minVoterAge 420s is at least 7 days / TIME_SCALE (420s)` | `   ✅ governance minVoterAge 420s is at least 7 days / TIME_SCALE (420s)` | PASS   |

The young-identity refusal has no local command; not driven.

## 4. Oracle nodes

Step 1:

| Command                                                                                                                       | Expected                                                                                                  | Actual                                                                                                                                               | Result |
| ----------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| `l0`, then the section 4 step 1 console block (register nodes)                                                                | one `   ⏩ proposal #N: voting period + execution delay: jumped Ns (dev node)` per node                   | `   ⏩ proposal #13: … jumped 596s (dev node)`, `#14`, `#15`                                                                                         | PASS   |
| (same block)                                                                                                                  | `registered nodes: 0xa0Ee…9720 0xBcd4…4096 0x71bE…5788`                                                   | `registered nodes: 0xa0Ee7A142d267C1f36714E4a8F75612F20a79720 0xBcd4042DE499D14e55001CcbB24a551F3b954096 0x71bE63f3384f5fb98995898A86B02Fb2426c5788` | PASS   |
| the `node -e '…c.oracleNodes = …'` line with the three addresses                                                              | `oracleNodes: 3`                                                                                          | `oracleNodes: 3`                                                                                                                                     | PASS   |
| `HANDOVER_PHASE=audit npx hardhat run scripts/handover.ts --network $NET > $RB/audit-d50.log 2>&1; tail -1 $RB/audit-d50.log` | `✅ Audit passed: the deployer holds no power.`                                                           | `✅ Audit passed: the deployer holds no power.`                                                                                                      | PASS   |
| `grep "OracleManager node" $RB/audit-d50.log`                                                                                 | `   ✅ every registered OracleManager node is acknowledged in oracleNodes (3 registered, 3 acknowledged)` | same, plus `the deployer is not an OracleManager node` (twice) and `no OracleManager node alone reaches the 66% bar; weight shares: … 100 (33.3%) …` | PASS   |

Step 2:

| Command                                                                                                        | Expected                                                                                        | Actual                                                                                                        | Result         |
| -------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | -------------- |
| `reset`                                                                                                        | `{"jsonrpc":"2.0","id":1,"result":true}`                                                        | same                                                                                                          | PASS           |
| `npm run demo:drive -- --strict --timeout 1800 --log $RB/d50.log 1 21 51 31 74 … 79:y 78:11:y 39 0` (verbatim) | `   Call: OracleManager.removeOracle(0x90F79bf6EB2c4f870365E785982E1f101E93b906, D50 rotation)` | same                                                                                                          | PASS           |
| (log)                                                                                                          | `   Proposer: 0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65`                                       | same                                                                                                          | PASS           |
| (log)                                                                                                          | three `✅ VOTE CAST SUCCESSFULLY!`                                                              | three                                                                                                         | PASS           |
| (log)                                                                                                          | `   Executing from 0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65 (the proposer)`                   | same                                                                                                          | PASS           |
| (log)                                                                                                          | `✅ PROPOSAL EXECUTED — callData ran, locked VGT burned`                                        | same                                                                                                          | PASS           |
| (log)                                                                                                          | option 39's `   Total Oracles: 2`                                                               | `   Total Oracles: 2` (an earlier `   👥 Total Oracles: 3` too)                                               | PASS           |
| (log)                                                                                                          | it ends `✓ demo ran to completion`                                                              | on the drive's stdout summary (`answers sent : 67/67`, `demo exit : 0`, `❌ lines : 0`), not in `$RB/d50.log` | DEVIATION (D1) |
| (log, 35a)                                                                                                     | `   ⏸️  ops paused node 3 0x90F79bf6EB2c4f870365E785982E1f101E93b906`                           | same, then `   ⏸️  ops paused node 2 0x3C44…93BC` (observation O3)                                            | PASS           |
| (log, ceremony)                                                                                                | `   ⚠️  OracleManager node 0x… (KYC_ORACLE) was registered by the deployer at block N: …`       | three such lines: KYC_ORACLE (block 53), AML_ORACLE (54), COMPLIANCE_ORACLE (55)                              | PASS           |

## 5. The ceremony

| Command                                                                                                                              | Expected                                                                                                     | Actual                                                                                                                   | Result |
| ------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------ | ------ |
| `l0deploy`                                                                                                                           | `handover fixture deployed; config written to /tmp/vanguard-runbook/handover.json`                           | same                                                                                                                     | PASS   |
| `npx hardhat run scripts/handover.ts --network $NET > $RB/handover.log 2>&1; tail -1 $RB/handover.log`                               | `✅ Handover complete: the deployer holds no power.`                                                         | same                                                                                                                     | PASS   |
| (log)                                                                                                                                | `🔑 Handover: deployer powers` (steps 1, 2, 5, 3)                                                            | present; `📝 Step 1`, `Step 2`, `Step 5`, `Step 3` in that order                                                         | PASS   |
| (log)                                                                                                                                | `   snapshot written: /tmp/vanguard-runbook/handover.json.snapshot.json`                                     | same                                                                                                                     | PASS   |
| (log)                                                                                                                                | `🏛️  Handover: governance accepts by vote`, `   ✅ Token: owned by governance (proposal #1)`                 | same (one line per contract, `GovernanceToken` at #2, …)                                                                 | PASS   |
| (log)                                                                                                                                | `🔍 Handover: verify`                                                                                        | same                                                                                                                     | PASS   |
| (log)                                                                                                                                | `   ✅ registrar / officer contract 0x… code matches the compiled InvestorRequestManager`                    | `… 0x851356ae760d987E095750cCeb3bC6014560891C code matches the compiled InvestorRequestManager` (equals the box's `IRM`) | PASS   |
| `export IRM=0x851356ae760d987E095750cCeb3bC6014560891C`, the `# local` console block (plant), then the check-and-clear console block | `owner: 0x70997970C51812dc3A010C7d01b50e0d17dc79C8 pendingOwner: 0x9A676e781A523b5d0C0e43731313A708CB607508` | same                                                                                                                     | PASS   |
| (same)                                                                                                                               | `pendingOwner: 0x0000000000000000000000000000000000000000`                                                   | same                                                                                                                     | PASS   |

## 6. The snapshot

| Command                                                                                                                                                                      | Expected                                                                                         | Actual                                                                                                                                   | Result |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| (section 5's log)                                                                                                                                                            | `   snapshot sha256: <64 hex> (in …snapshot.json.sha256; keep this line with the run's records)` | `   snapshot sha256: 4826f3cc…8691 (in /tmp/vanguard-runbook/handover.json.snapshot.json.sha256; keep this line with the run's records)` | PASS   |
| `awk '/snapshot sha256:/ {print $3}' $RB/handover.log > $RB/snapshot.sha256; cat $RB/snapshot.sha256`                                                                        | the digest                                                                                       | `4826f3ccd04464ca1f1ef877b62f0b71b0a83843b2a3e0b3aa936c35cf748691`                                                                       | PASS   |
| `sha256sum -c $HANDOVER_CONFIG.snapshot.json.sha256`                                                                                                                         | `/tmp/vanguard-runbook/handover.json.snapshot.json: OK`                                          | same                                                                                                                                     | PASS   |
| `HANDOVER_SNAPSHOT_SHA256=$(cat $RB/snapshot.sha256) HANDOVER_PHASE=accept npx hardhat run scripts/handover.ts --network $NET > $RB/accept.log 2>&1; tail -1 $RB/accept.log` | ends as in section 5                                                                             | `✅ Handover complete: the deployer holds no power.`                                                                                     | PASS   |
| (log)                                                                                                                                                                        | `⏭️  HANDOVER_PHASE=accept: deployer steps skipped`                                              | same                                                                                                                                     | PASS   |
| (log)                                                                                                                                                                        | `   snapshot sha256: <64 hex> (matches the full phase's)`                                        | `   snapshot sha256: 4826f3cc…8691 (matches the full phase's)`                                                                           | PASS   |
| (log)                                                                                                                                                                        | `   snapshot: /tmp/vanguard-runbook/handover.json.snapshot.json (block N)`                       | `… (block 62)`                                                                                                                           | PASS   |

The refusals in steps 2 and 3 have no command; the operator drove them
by the obvious edit (the pair saved first and restored after, then
`sha256sum -c` printed `OK` again):

| Check (implied)                               | Expected                                                                                                                 | Actual                                                                                                                                                                            | Result |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| accept without `HANDOVER_SNAPSHOT_SHA256`     | `❌ Handover failed: snapshot digest missing: set HANDOVER_SNAPSHOT_SHA256 to the digest …; …`                           | `❌ Handover failed: snapshot digest missing: … ("snapshot sha256: <hex>", kept in the run's records); the sidecar alone cannot prove the file was not rewritten with it`         | PASS   |
| accept after editing one byte of the snapshot | `❌ Handover failed: snapshot hash mismatch: …snapshot.json hashes to <hex>, but …snapshot.json.sha256 records <hex>: …` | `… hashes to 588dff56…66d7c, but …snapshot.json.sha256 records 4826f3cc…8691: the file was edited after the full phase wrote it; a completion against it is a re-run, not a pass` | PASS   |
| same, sidecar rewritten to match              | `… but HANDOVER_SNAPSHOT_SHA256 is <hex>: …`                                                                             | `… but HANDOVER_SNAPSHOT_SHA256 is 4826f3cc…8691: the file and its sidecar are not the pair the full phase printed`                                                               | PASS   |

Step 4 (full re-run replacing a pair; unwritable directory) has no
command and was not driven.

## 7. The KeyManager ops identity

| Command                                                     | Expected                                                                                                      | Actual                                                                                                                                               | Result |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| `grep -E "OPS_IDENTITY\|must send" $RB/deploy-identity.log` | `   ⚠️  OPS_IDENTITY not set: KeyManager is authorized on no identity yet.`                                   | same                                                                                                                                                 | PASS   |
| (same)                                                      | `   The ops key must send: OnchainID(<ops identity>).authorizeManager(0x…) from the identity owner <ops key>` | `   The ops key must send: OnchainID(<ops identity>).authorizeManager(0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512) from the identity owner <ops key>` | PASS   |

The `OPS_IDENTITY` set branch is "not driven locally" per the runbook.

## 8. Rule administrators per token

| Command                                      | Expected                                                              | Actual                                                                         | Result |
| -------------------------------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------ | ------ |
| `grep "rule administrator" $RB/handover.log` | `   ✅ ComplianceRules rule administrator on VSC: governance 0x…`     | `… on VSC: governance 0x9A676e781A523b5d0C0e43731313A708CB607508` (and on VGT) | PASS   |
| (same)                                       | `   ✅ deployer removed as ComplianceRules rule administrator on VSC` | same (and on VGT)                                                              | PASS   |
| (same)                                       | `   ✅ no ComplianceRules rule administrator but governance and ops`  | same                                                                           | PASS   |

## 9. List oracles; sanction clearing

| Command                                                                                                            | Expected                                                                        | Actual                                         | Result |
| ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------- | ---------------------------------------------- | ------ |
| `reset`                                                                                                            | `{"jsonrpc":"2.0","id":1,"result":true}`                                        | same                                           | PASS   |
| `npm run demo:drive -- --strict --timeout 1800 --log $RB/d47.log 1 21 51 31 74 … 83c:y 83d 83e 38a:y 0` (verbatim) | `   ✅ no holder would be frozen by the bind`                                   | same; drive `✓ demo ran to completion`, exit 0 | PASS   |
| (log)                                                                                                              | `   ✅ proposal #11 executed`                                                   | same                                           | PASS   |
| (log)                                                                                                              | `   ✅ rules.whitelistOracle(VSC) = 0x36C02dA8a0983159322a80FFE9F24b1acfF8B570` | same; no `⛔ Bind refused` line                | PASS   |
| `l0`, then the section 9 console block (consensus clearings)                                                       | `consensus clearings: 0 []`                                                     | `consensus clearings: 0 []`                    | PASS   |

## 10. Upgrades and the day-2 audit

On section 9's L0 chain:

| Command                                                                                                               | Expected                                                                                                                                                          | Actual                                                                                                                                      | Result |
| --------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| `HANDOVER_PHASE=audit npx hardhat run scripts/handover.ts --network $NET > $RB/audit.log 2>&1; tail -1 $RB/audit.log` | `✅ Audit passed: the deployer holds no power.`                                                                                                                   | same                                                                                                                                        | PASS   |
| `grep "Handover audit" $RB/audit.log`                                                                                 | `🔍 Handover audit: every completion line against the state governance derives now (no snapshot, no voting window)`                                               | same                                                                                                                                        | PASS   |
| implied: `l0deploy`, then the audit command                                                                           | `❌ Handover failed: HANDOVER_PHASE=audit: the ceremony has not completed: governance does not own Token, …; run the full phase (or HANDOVER_PHASE=accept) first` | same (`… does not own Token, GovernanceToken, IdentityRegistry, … VanguardGovernance; run the full phase (or HANDOVER_PHASE=accept) first`) | PASS   |

## 11. Recovery drills

| Command                                                                        | Expected                                                                               | Actual       | Result |
| ------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------- | ------------ | ------ |
| `reset`                                                                        | `{"jsonrpc":"2.0","id":1,"result":true}`                                               | same         | PASS   |
| `npm run demo:drive -- --strict --timeout 1800 --log $RB/d12.log 1 21 51 12 0` | `   ✅ executeKeyRecovery (receipt): 2 MANAGEMENT keys evicted`                        | same         | PASS   |
| (log)                                                                          | `   ✅ owner() = wallet 6 (investor Alice) 0x976EA74026E726554dB657fA54763abd0C3a0aa9` | same         | PASS   |
| (log)                                                                          | `✅ Key rotated; recovery evicted the rogue key and moved the owner`                   | same         | PASS   |
| (drive)                                                                        | `✓ demo ran to completion`                                                             | same, exit 0 | PASS   |

The lost-key bullet (burn and re-mint) has no script (5.8).

## 12. Incident: pause and the voted unpause

| Command                                                       | Expected                                                                     | Actual | Result |
| ------------------------------------------------------------- | ---------------------------------------------------------------------------- | ------ | ------ |
| `l0`, then the section 12 console block (pause, vote unpause) | `VSC paused: true`                                                           | same   | PASS   |
| (same)                                                        | `   ⏩ unpause VSC: voting period + execution delay: jumped 656s (dev node)` | same   | PASS   |
| (same)                                                        | `VSC paused: false`                                                          | same   | PASS   |

The VGT and node bullets have no command.

## Deviations

- **D1** (section 4 step 2, wording). Command: the
  `npm run demo:drive -- … --log $RB/d50.log …` line. Expected: "The log
  (`$RB/d50.log`) shows … it ends `✓ demo ran to completion`". Actual:
  every quoted line is in `$RB/d50.log` except `✓ demo ran to completion`,
  which the drive prints on its stdout summary (after `answers sent :
67/67`, `demo exit : 0`, `❌ lines : 0`); the log itself ends
  `🔚 Exiting...` and the recorder's footer. Read: the runbook's wording
  is wrong (the subject of "it ends" is the log), not the code; section 11
  words the same line correctly ("the drive ends").

## Observations (not deviations)

- **O1** (box). `mkdir -p $RB` accepts a directory left by an earlier run,
  so old logs and snapshot pairs can sit beside the new run's. Suggest
  the box say to start from an empty (or new) `$RB`.
- **O2** (every `hardhat run` and `hardhat console` call). A
  contract-size table of about 140 lines prints before the command's own
  output; the quoted lines are still there, but an operator piping the
  output into `head` (as this operator first did in section 1, and re-ran
  without the pipe) sees only the table.
- **O3** (section 4 step 2). Option 35a pauses two nodes (node 3, then
  node 2 after a consensus vote); the runbook quotes the first line only.

## Summary

- Sections run: the box and sections 1 to 12, every command as written,
  on one Hardhat node at port 8547 (reset between tracks as the runbook
  says).
- Passed: the box, 1, 2, 3, 4 (step 1), 5, 6, 7, 8, 9, 10, 11, 12.
  With a deviation: 4 (step 2, D1, wording only; every quoted chain
  result appeared).
- Deviations: 1 (D1). Observations: 3.
- Not runnable locally, or no command given: section 2's full-stack
  deploy (Task 5.7); section 3's young-identity refusal; section 6 step 4
  (re-run replacing a pair, unwritable directory); section 7's
  `OPS_IDENTITY` branch (runbook: not driven locally); section 11's
  lost-key burn and re-mint (no script, 5.8); section 12's VGT and node
  bullets; publicly-only waits (`settleProposal`, the 24 h / 48 h / 7 day
  timelocks) are jumped on the dev node.
- Section 6's refusals in steps 2 and 3 have no command in the runbook;
  they were driven by hand and matched.
