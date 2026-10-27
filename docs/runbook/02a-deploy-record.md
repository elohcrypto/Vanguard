# Runbook part 2a: the deploy record

Part of the [operator runbook](../OPERATOR_RUNBOOK.md): section 2.3a,
moved out of [part 2](02-deploy.md) (section 2.3, the deploy) unchanged
when that part neared the 500-line rule (U2 round 9).

### 2.3a Stopped? Re-run the line

- Stopped? Re-run the line (`   ⏭️  #N …: skipped (recorded, code hash ok)`,
  the rest sent; complete: `(74 from the record, 0 sent now; …)`). It reads
  past blocks (archive RPC); a contradicting record, config or flow is
  refused. After a kill `<record>.lock is held by pid N`: if no deploy
  runs, `rm <record>.lock`. A transient RPC error is retried
  (`   ↻ eth_getCode: … retry 1/6 in 500 ms`) and a send whose reply was
  lost is adopted from the chain, never sent twice
  (`   ↪️  nonce N of 0x…: mined as 0x…; adopted (not resent)`). A send
  that failed, or whose settle (its receipt or nonce read) failed on an
  RPC error, stays the record's next entry until it is settled: the
  same transaction sent again settles that entry at its nonce, never a
  second entry, and the deployer's sends go out one at a time. An
  entry is never dropped from the record and never sent at another
  nonce: no answer of one node proves a transaction was never mined. A
  replaced, evicted or reorged transaction, one the signer refused, or
  one the node does not know is adopted if mined unchanged at its nonce,
  else sent again at its recorded nonce with its recorded payload, once
  per run
  (`   ⏳ <label>: entry #N unknown to this node; re-checking by sending it again at its nonce N`,
  then `   📤 #N <label>: sent again at its nonce N: 0x…`); the signer
  sends again what it signed at that nonce, or a fee bump of it. A nonce
  mines once, so the entry deploys once. Past 5000 blocks or a taken
  nonce is refused: find that nonce's transaction on an explorer and fix
  the record by hand. An entry sent again keeps the hash of its own
  earlier send (`sentHash`) and is read by that hash before any block
  scan, so a stray at the re-send (below) does not need one. Another transaction still pending at the entry's
  nonce is refused too
  (`… is pending …: wait for it to mine, then re-run`): wait, then
  re-run. An entry becomes the transaction under its hash only when that
  transaction is the entry in every field; one a signer sent at another
  nonce is refused, kept, nothing more sent
  (`… mined at nonce N from 0x…, not as the entry recorded (nonce M from 0x…, its target, value and calldata): the signer did not send it as recorded; kept in the record, nothing more is sent`).
  Another sender's transaction under the entry's hash (a buggy or
  malicious signer's answer) is never the entry's nor a stray: refused
  by name, the hash cleared, nothing listed
  (`… from 0x…, another sender's transaction, not the entry's and not the deployer's stray: nothing recorded; …`);
  fix the signer, and the next healthy resume finds or sends the entry
  at its own nonce. A creation whose receipt the node shows but whose
  code it does not yet (a lagging node) pins nothing
  (`record entry #N (<label>): 0x… has a receipt but no code on this node: a lagging RPC; kept, re-run against a synced RPC`):
  re-run against a synced RPC; the code is read again. A receipt that
  names another contract than the CREATE address of the entry's sender
  and nonce (a lying node) pins nothing either
  (`record entry #N (<label>): the receipt names 0x… as the contract created, not 0x…, the CREATE address of 0x… at nonce N: an inconsistent RPC; kept, re-run against a synced RPC`):
  re-run against a synced RPC.
  A re-send the signer sent at another nonce than the entry's (a signer
  that drops the nonce field, behind an RPC that hid the mined entry) is
  a stray: the record keeps it under `strays` (with `block`, the head
  before that re-send), never as the entry, clears the entry's hash and
  refuses once
  (`… a transaction the signer sent at nonce N outside the record, recorded as a stray, never the entry; …`).
  Fix or replace the signer, then re-run against a synced RPC: the
  resume adopts the entry's own transaction at its nonce, counts the
  stray in the deployer's nonce, and prints it once on every resume
  (`   ⚠️  nonce N: 0x…, the signer's re-send of entry #M (<label>) at another nonce: outside the record, never adopted; it cost 0x… X ETH and created 0x…, which the record does not own`).
  Its contract is a duplicate nothing points at; its cost is the
  deployer's. A stray the chain shows from another sender or nonce is
  refused by name. A stray is a transaction the record does not
  otherwise account for: a re-send the signer answers with another
  entry's transaction, or one of the deployer's from before
  `startNonce`, is refused by name and never listed
  (`… the signer answered its re-send with 0x…, record entry #K's transaction, not a new one: …`,
  or `…, an older transaction (nonce N, before the record's startNonce M), not a new one: …`),
  and the next healthy resume adopts the entry at its nonce; a `strays`
  list holding one is refused as inconsistent
  (`… the record's strays list is inconsistent …; remove it from strays, then re-run`).
  Any recorded stray still pending on the node (the deployer's or
  another sender's) stops every resume before an entry is settled, so
  nothing is sent while it is pending, an intent recorded behind it
  included
  (`stray 0x… (nonce N, the re-send of entry #M) is pending on this node: wait for it to mine or drop, then re-run`):
  wait for it to mine, or for the node to drop it, then re-run. A stray
  that stays pending: replace it at its nonce from the deployer (a
  cancel to self), keep that cancel's hash, then resume. The replacement
  is found by a block scan from the stray's `block` (an older row: the
  record's `fromBlock`), recorded under the
  stray (`replacedBy`), counted as a mined stray and printed on every
  resume, never an entry
  (`   ⚠️  nonce N: stray 0x… replaced by 0x…, outside the record, never adopted; it cost 0x… X ETH`).
  More than 5000 blocks after the stray the scan is refused and asks for
  the hash
  (`… more than 5000 blocks after the intent (block N); pass the hash of the transaction that filled it as DEPLOY_FILL_HASH=<hash>, then resume; unset DEPLOY_FILL_HASH after the resume completes`):
  re-run with `DEPLOY_FILL_HASH=0x…` (the cancel's hash) set. It is read
  by that hash and must be mined, from the stray's sender at its nonce,
  and no record entry or stray, else it is refused by name
  (`DEPLOY_FILL_HASH 0x… is <what it is>: refusing; unset DEPLOY_FILL_HASH after the resume completes`).
  Unset it once the resume completes: a stale value a later resume
  cannot place refuses with that line.
  One the node no longer shows is trusted as gone only while its sender
  has nothing pending the node hides
  (`… is not shown by this node but the deployer has N pending transactions it does not show: a lagging or inconsistent RPC; wait or re-run against a synced RPC`);
  the record's own sent entries the node shows pending in that range
  are no hidden transactions: the resume waits for them as for any sent
  entry. Then it prints `…: dropped, not counted`, and the next entry
  takes its nonce. Two strays at one nonce (the same re-send answered
  twice) count that nonce once: the one the node does not show prints
  `…: dropped, its nonce taken by stray 0x…`. A dropped stray below an entry's nonce leaves a gap no re-send
  fills
  (`… is dropped and its nonce is unfilled below record entry #K's nonce M: fill nonce N from the deployer (a cancel to self), then resume; …`):
  fill it the same way (a cancel to self at nonce N); the fill is
  counted as the stray's replacement and the entry is sent again at its
  nonce. An unsent intent that took a mined stray's
  nonce from a lagging count can never mine: the resume drops it
  (`   ↩️  <label>: its nonce N is stray 0x…'s (an intent read from a lagging RPC, never sent); dropped from the record`)
  and the flow plans it again at the next free nonce. A sent entry at
  a stray's nonce still refuses by name, never planned again
  (`… is unknown to the node and 0x…'s nonce N went to 0x…, another transaction: refusing`).
  Every entry is checked first: one whose recorded
  payload does not hash to its `dataHash`, or whose nonce, value, sender
  or target is not one, is refused before anything is read or sent
  (`… its recorded data (its keccak256 is not its dataHash): an edited record; kept, nothing sent`).
  A node that shows a used nonce but not its
  transaction, or still does not know the entry once it was sent again,
  is refused with the entry kept
  (`… a lagging or inconsistent RPC; kept in the record, resume against a synced RPC`):
  resume against a synced RPC. So is a receipt of another transaction
  for its hash. Off a dev chain only the calls the deploy makes reach
  the RPC, by exact name: `eth_accounts`, `eth_blockNumber`, `eth_call`,
  `eth_chainId`, `eth_estimateGas`, `eth_getBlockByNumber`, `eth_getCode`,
  `eth_getTransactionByHash`, `eth_getTransactionReceipt`,
  `eth_sendTransaction`, `net_version`, `web3_clientVersion` and the
  issuers' claim signatures (`vanguard_signClaim`, `personal_sign`); any
  other method or letter case is refused
  (`<method> refused on chain N: no dev-node call off a dev chain (only the calls the deploy makes reach the node)`).
  Every resume counts the deployer's nonce from `startNonce`, an empty
  record included, and names each nonce no entry and no stray holds
  (`the deployer's nonce is N but the record accounts for M: a transaction outside the record; refusing to resume (nonce K is no entry's and no stray's: find that transaction and record it by hand)`).
  Only such a nonce is to be found and recorded by hand. A free nonce
  a listed stray holds is that stray lagging on this node (its receipt
  not shown yet): never record it again, resume against a synced RPC
  (`… refusing to resume (stray 0x… is listed but not shown mined on this node: a lagging RPC; resume against a synced RPC)`).
  A re-send writes its intent (the entry and the head block) before it
  goes out, so a re-send the signer answered at another nonce while the
  run was killed is found at such a nonce and recorded as the entry's
  stray
  (`   ⚠️  nonce K: 0x…, the signer's re-send of entry #M (<label>) at another nonce, found on chain from its recorded intent (the run that sent it stopped before recording it): recorded as a stray`).
  A stray already listed is never found again: while the node shows it
  `not mined on this node, not counted`, or in a block but not by its
  hash (`stray 0x… … is not shown by this node by its hash, but its block holds it …: a lagging RPC; kept, re-run against a synced RPC`),
  re-run against a synced RPC; never record it by hand. A later re-send
  keeps the first intent's block, and the intent is kept for the life
  of the record (never cleared: a pending count from a lagging node
  cannot prove that no re-send is still out); a send the node refused
  outright leaves no intent of its own. A stray row recorded from an
  intent (this search or `DEPLOY_FILL_HASH`) carries the intent's
  `block`, where its search starts, not the block it mined in. More than
  5000 blocks after the intent the search is refused
  (`nonce K: 0x… used nonce K more than 5000 blocks after the intent (block N); pass its hash as DEPLOY_FILL_HASH=<hash>, then resume; unset DEPLOY_FILL_HASH after the resume completes`):
  find the deployer's transaction at nonce K on an explorer and re-run
  with its hash set. It is recorded as that entry's stray only if it is
  the deployer's at that free nonce, mined after the intent, with the
  entry's payload; anything else is refused by name. Unset the
  variable once the resume completes: left set, a hash a later resume
  cannot place (the stray it recorded is now listed) refuses every
  resume until it is unset. One hash at a time: with two nonces to
  fill, resume once per hash, the lower nonce first. A transaction stuck in the
  mempool: `signer.js bump` (section 1a).
