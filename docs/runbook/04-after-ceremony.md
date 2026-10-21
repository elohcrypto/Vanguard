# Runbook part 4: after the ceremony

Part of the [operator runbook](../OPERATOR_RUNBOOK.md) (conventions, the
local rehearsal box, the `prod` function and the order of work are
there). The ceremony: [part 3](03-ceremony.md).

## 4. Oracle nodes (D50, Q4, Q15, Q20)

Production runs three node keys of their own (section 1: never a role,
voter or claim-signer key; the ceremony and the audit refuse such a node
by name, `OracleManager node(s) 0x… (ops) hold a role key: a node is a key of its own (D25 b), …`).
The deploy's three nodes were registered by the deployer; the ceremony
and the audit name each:
`   ⚠️  OracleManager node 0x… (KYC_ORACLE) was registered by the deployer at block N: it votes with a key the deployer chose; rotate deployer-era nodes by an OracleParameters vote (D50)`.
They stay through the ceremony (R-56-2) and are rotated just after it,
together with the re-approval of the attestor key the deployer trusted
(`   ⚠️  PrivacyManager issuer key (Ax …) for jurisdiction was trusted by the deployer: re-approve it by a PrivacyParameters vote or untrust it`, three circuits).
After a verifier swap (`   ❌ jurisdiction records made up to block N (the last jurisdiction verifier swap) still count: …`)
a re-approval leaves the records made under it valid: untrust then
re-trust that key (two votes), or change that circuit's policy.

`scripts/production/postCeremonyVotes.ts` does both in TWO rounds,
because `executeProposal` is anyone's and `removeOracle` checks no node
minimum: a passed removal could be executed by a stranger before the
registrations.

- Round 1: `registerOracle` for each production node (`NEW_NODES`) and
  `setTrustedAttestor` for each deployer-trusted attestor key, proposed
  together, voted, settled (one voting period and delay, about 10 days).
- Round 2, only once every production node is registered (read from the
  chain): `removeOracle` for each deployer-era node, proposed only when
  every order and subset of the removals leaves at least MIN_NODES (2) nodes with
  none alone at the consensus bar (about 9 days).
- `NEW_NODES` is `<address>:<NAME>,…` (checksummed). Refused before any
  proposal: an unfinished ceremony, a snapshot from another chain, an
  entry that is zero, repeated, the deployer, governance, a role, a voter,
  the proposer or a claim signer
  (`❌ Post-ceremony votes failed: 0x… is the deployer, governance, a role, a voter or a claim signer: a node is a key of its own (D25 b)`),
  and a final set below MIN_NODES (2) nodes or with one node at the bar. A re-run
  resumes from the chain (round 1 while anything of it is missing,
  adopting its open proposals) and first waits for its own senders'
  pending transactions.

**The standing hazard.** A removal that has passed is executable by
anyone 2 days after its vote. The guards are this run's votes against a
foreign removal while it is still voting (only one that passes on the
votes cast or has a FOR vote, and that would make the node set invalid
with this run's removals) and the precheck right before each of this
run's removals executes. A cancel vote (a SystemParameters vote, 7 + 2
days) clears only a passed removal that nobody executes first: it is no
guard once a removal has passed. A run prints such a removal as
`   ⚠️  STANDING HAZARD: proposal #N (a removal) would leave an invalid node set if anyone executed it now; a cancelProposal vote follows, which clears it only if nobody executes it first (executeProposal is anyone's)`;
round 2 holds while a foreign removal that would break the set passes
(`round 2 held: …`). Watch open `removeOracle` proposals daily during the
rounds and vote down any you did not make.

Production track (after 5a, no reset; the new nodes are the test
phrase's wallets 12-14, free of every role; publicly `<NODE_1>`..`<NODE_3>`):

```bash
NEW_NODES=0xFABB0ac9d68B0B445fB7357272Ff202C5651694a:NODE_1,0x1CBd3b2770909D4e10f157cABC84C7264073C9Ec:NODE_2,0xdF3e18d64BC6A983f673Ab319CCaE4f1a57C7097:NODE_3 prod scripts/production/postCeremonyVotes.ts > $RB/post.log 2>&1; echo "exit $?"; grep -E "round [12]:|^✅|set handover" $RB/post.log
```

prints `exit 0`,
`   🗳️  round 1: 6 proposal(s), registrations and re-approvals`,
`   🗳️  round 2: 3 removal(s), every production node registered`,
`✅ post-ceremony votes executed; nodes now 0x…, 0x…, 0x…` and
`   set handover.json "oracleNodes" to ["0x…","0x…","0x…"], then run HANDOVER_PHASE=audit`.
The log has a `   ✅ register production node 0x… (NODE_1) (proposal #12)`,
`   ✅ re-approve issuer key Ax … for jurisdiction (Q20) (proposal #N)` and
`   ✅ remove deployer-era node 0x70997970C51812dc3A010C7d01b50e0d17dc79C8 (KYC_ORACLE) (proposal #N)`
line per proposal. Acknowledge the nodes it printed and audit:

```bash
node -e 'const fs = require("fs"); const p = process.env.PROD_CONFIG; const c = JSON.parse(fs.readFileSync(p, "utf8")); c.oracleNodes = JSON.parse(process.argv[1]); fs.writeFileSync(p, JSON.stringify(c, null, 2)); console.log("oracleNodes:", c.oracleNodes.length)' "$(grep -oE 'set handover.json "oracleNodes" to \[.*\]' $RB/post.log | sed -E 's/.* to //')"
HANDOVER_PHASE=audit prod scripts/handover.ts > $RB/audit-d50.log 2>&1; echo "exit $?"; grep -E "OracleManager node|registered by the deployer|trusted by the deployer" $RB/audit-d50.log
```

prints `oracleNodes: 3`, `exit 0`, the two deployer lines
`   ✅ the deployer is not an OracleManager node` and
`   ✅ the deployer 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266 is not an OracleManager node`, then
`   ✅ no OracleManager node is ops, the guardian, the issuer admin, the proposer, a voter, a claim signer, the manager operator, an InvestorTypeRegistry governor or officer, a registry/VGT/VSC agent or a ClaimIssuer key`,
`   ✅ every registered OracleManager node is acknowledged in oracleNodes (3 registered, 3 acknowledged)`,
`   ✅ no OracleManager node alone reaches the 66% bar; weight shares: 0x… 100 (33.3%), …`;
no deployer-era node or attestor line. A node left out of `oracleNodes`
fails the audit; one the deployer registered ends it with
`⚠️  Audit passed with warnings: see above.`. Audit again after every
rotation, `oracleNodes` updated. The accept phase compares with the
ceremony's snapshot, so after any vote it fails for good
(`   ❌ appeared after the preflight, not granted by the ceremony: 0x… in OracleManager nodes, …`).

**The demo track** does the whole rotation by hand, add before remove
(Task 5.12): option 76, type 2, action 7 (`registerOracle`, reputation
500) per new node, 77 per voter (it approves the voter's fee), 79, 78;
then action 3 (`removeOracle`) for wallets 1-3 (all proposed before any
runs: node indices 0-2), 77, 79, 78. Six, five, four, then three nodes:
two always remain, none alone reaches the bar. Action 7 takes the next
free demo wallet on Enter; of the rehearsal's twelve only wallet 8 is
free, so it says so and two nodes are typed (keys the demo lacks: they
cannot answer rounds; publicly `<NODE_2>`, `<NODE_3>`). After the
ceremony 76 proposes from the first eligible wallet but 0, 78 executes
from the proposer. Option 83f, before and after, is section 10's audit
(the same code) on the demo's in-memory state; it acknowledges option
31's nodes, the nodes 76 proposed after the handover and option 1's
attestor key. Local: reset.

```bash
reset   # local
npm run demo:drive -- --strict --timeout 2400 --log $RB/d50.log 1 21 51 31 74 24:1:Alice 24:1:Bob 24:1:Carol 24:1:Dave 75a:4:1000:y 75a:5:1000:y 75a:6:1000:y 75a:7:1000:y 22 32 83c:y 83d 83e 35a 83f 76:2:7:NODE_4:: 76:2:7:NODE_5::0x1111111111111111111111111111111111111111: 76:2:7:NODE_6::0x2222222222222222222222222222222222222222: 77:11:5:y: 77:11:6:y: 77:11:7:y: 77:12:5:y: 77:12:6:y: 77:12:7:y: 77:13:5:y: 77:13:6:y: 77:13:7:y: 79:y 78:11:y 78:12:y 78:13:y "76:2:3:0:D50 rotation" "76:2:3:1:D50 rotation" "76:2:3:2:D50 rotation" 77:14:5:y: 77:14:6:y: 77:14:7:y: 77:15:5:y: 77:15:6:y: 77:15:7:y: 77:16:5:y: 77:16:6:y: 77:16:7:y: 79:y 78:14:y 78:15:y 78:16:y 39 83f 0
awk '/HANDOVER STEP 4/{n++} n==2' $RB/d50.log | grep -E "registered by the deployer|acknowledged in oracleNodes|Audit passed"
```

The log (`$RB/d50.log`) shows `   Call: OracleManager.registerOracle(0x23618e81E3f5cdF7f54C3d65f7FBc0aBf5B21E8f, NODE_4, registered by an OracleParameters vote, 500)`
(wallet 8), twice `   ⚠️  no free demo wallet: type the node's address`,
`   Call: OracleManager.removeOracle(0x70997970C51812dc3A010C7d01b50e0d17dc79C8, D50 rotation)`
(and wallets 2, 3), `   Proposer: 0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65`
(wallet 4), 18 `✅ VOTE CAST SUCCESSFULLY!`, six times
`   Executing from 0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65 (the proposer)`
and `✅ PROPOSAL EXECUTED — callData ran, locked VGT burned`, and option
39's `   Total Oracles: 3`. The first 83f lists the three deployer-era
nodes (`   ⚠️  OracleManager node 0x70997970C51812dc3A010C7d01b50e0d17dc79C8 (KYC_ORACLE) was registered by the deployer at block 53: …`).
The `awk` prints only `   ✅ every registered OracleManager node is acknowledged in oracleNodes (3 registered, 6 acknowledged)`
and `⚠️  Audit passed with warnings: see above.`: no deployer-era node
line; a node a governance execution registered prints none (R-56c-1).
The warnings left: option 1's attestor key (three circuits), the
deployer's VSC exemption and the deployer's VGT. The drive's summary
(stdout) ends `✓ demo ran to completion` (about 6.5 minutes locally). CI
runs the rotation with free wallets and a 33a round answered by the new
nodes only (`scripts/ci/regression-drives.sh`, drive `rotate`).

Ops pauses a misbehaving node at once (35a above pauses two:
`   ⏸️  ops paused node 3 0x90F79bf6EB2c4f870365E785982E1f101E93b906`,
then `   ⏸️  ops paused node 2 0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC`).
A consensus clearing a governance sanction is accountable (D27, section 9).

## 4a. Claim signers (Q17)

A Safe issuer admin cannot sign claims (the issuers check EIP-191
signatures only), and the ceremony revoked the deployer's key, so no
claim can be issued until the issuer-admin Safe adds EOA claim-signer
keys: a KYC key on the KYC issuer and a separate AML key on the AML
issuer (purpose 3, CLAIM_SIGNER). `scripts/production/claimSigners.ts`
exports them as the issuer admin's Safe batch
(`<PROD_CONFIG>.claim-signers.issuer-admin-transactions.json`, exit 3;
2.5), and a re-run checks both effects on chain and probes a claim
signed by each key the signer holds. Refused: an issuer the ceremony has
not handed over, one key for both, a key that is the deployer's,
governance's, a role's, a node's or a voter's, and a key the issuer
revoked before (a revoked key is never re-added: choose another). Run
it after round 2 of section 4 has completed (a claim-signer key listed
in `handover.json` is then never a node). Keep the claim-signer
keystores in the signer, named to sort after the pinned ones, and
restart the signer after adding them: it reads its keystores only at
start (1a). Claims are then signed through `vanguard_signClaim`.

Production track (after section 4; locally the issuer admin is a signer
wallet, so the calls are sent; the keys are the test phrase's wallets 15
and 16):

```bash
CLAIM_SIGNERS=kyc:0xcd3B766CCDd6AE721141F452C550Ca635964ce71,aml:0x2546BcD3c84621e976D8185a91A922aE77ECEc30 prod scripts/production/claimSigners.ts > $RB/signers.log 2>&1; echo "exit $?"; grep -E "verifies on|claimSigners" $RB/signers.log
```

prints `exit 0` (publicly `exit 3` and
`⏸️  awaiting 2 issuerAdmin transactions: <file>` first), two
`   ✅ a claim signed by 0x… verifies on 0x… (verifyClaim)` lines and
`   add both to handover.json: "claimSigners": ["0x…","0x…"] (the day-2 audit accepts them there)`.
List them and audit (until listed, the audit fails: a live key that is
not the issuer admin's):

```bash
node -e 'const fs = require("fs"); const p = process.env.PROD_CONFIG; const c = JSON.parse(fs.readFileSync(p, "utf8")); c.claimSigners = JSON.parse(process.argv[1]); fs.writeFileSync(p, JSON.stringify(c, null, 2)); console.log("claimSigners:", c.claimSigners.length)' "$(grep -oE '"claimSigners": \[.*\]' $RB/signers.log | sed -E 's/.*: //')"
HANDOVER_PHASE=audit prod scripts/handover.ts > $RB/audit-final.log 2>&1; echo "exit $?"; tail -1 $RB/audit-final.log; grep -E "✅ claimSigners|^\s+⚠️" $RB/audit-final.log
```

prints `claimSigners: 2`, `exit 0`,
`✅ Audit passed: the deployer holds no power.`, two
`   ✅ claimSigners 0x…: a CLAIM_SIGNER key the issuer admin added after the ceremony on KYC Service (0x…)`
lines (`AML Service` for the second) and the one warning that stays,
`   ⚠️  0x23618e81E3f5cdF7f54C3d65f7FBc0aBf5B21E8f is investorLimitExempt (set before the handover): …`
(the escrow fee wallet).
