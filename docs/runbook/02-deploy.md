# Runbook part 2: deploy

Part of the [operator runbook](../OPERATOR_RUNBOOK.md) (conventions, the
local rehearsal box, the `prod` function and the order of work are
there). Keys and the signer: [part 1](01-keys-and-signer.md).

## 2. Deploy

`scripts/production/DeployProduction.ts` deploys demo option 1a's stack
and option 61's escrow factory through the signer (section 1a; no
unsigned-transaction files), records every transaction in the deploy
record before the next, writes the ceremony's `handover.json` and runs
its preflight. The record (`deployments/<chainId>.json`) holds the
deployer and its mined nonce when the record was made (`startNonce`; a
deployer with a pending transaction is refused until it mines), the
config digest, `fromBlock`, the salt, and one entry per transaction
(intent with its payload until it mines, hash, receipt). The signer has one upstream that serves both its reads and
its sends and must be archive (2.1): a send-only private RPC (e.g.
Flashbots Protect) cannot be that upstream.

### 2.1 The RPCs (Q18)

One commercial provider and the owner's own Sepolia node, synced before
the deploy: every ceremony phase reads historical state from `fromBlock`
on (about 5 weeks of blocks by the end) and refuses an RPC that cannot
serve it. Each must be an archive node, or a node that keeps all state
from a block before the deploy on. `rpc-check` probes state at head
minus 200,000 blocks unless `--old-block <N>` is given, so the
commercial RPC is probed archive-deep. Check both, URLs from a 0600 file
(comma or newline separated), never argv; for a node that keeps state
only from some block on, check it with `--old-block <its first kept block>`
before the deploy and with `--old-block <fromBlock in handover.json>`
after it:

```bash
RPC_CHECK_URLS=$DEMO_RPC_URL node scripts/production/rpcCheck.js --chain 31337   # local; publicly RPC_CHECK_URLS_FILE=<0600 FILE> … --chain 11155111
```

prints per URL `   ✅ chain id 31337 (want 31337)`,
`   ✅ archive: state at block N served (head N)`,
`   ✅ getLogs: up to N blocks per call accepted (logChunk <= N)`, an
address-less scan's hit count, a rate line (40 calls at once) and the
live gas prices (`   ℹ️  gas: gasPrice N gwei, priority fee N gwei, base fee N gwei`),
then `✅ rpc-check passed` (exit 0). A URL failing the chain or archive
check, or accepting no `eth_getLogs` range, exits 1. A URL on the command
line is refused
(`rpc-check: an RPC URL on the command line is refused (shell history, ps): set RPC_CHECK_URLS or RPC_CHECK_URLS_FILE (0600)`).
The deploy probes the largest range its own RPC accepts (10,000 blocks
at most) into `handover.json`'s `"logChunk"`; when the two RPCs differ,
set `"logChunk"` in the deploy config to the smaller.

### 2.2 The budget (Q19)

Every account is funded before the deploy from a measured table: the gas
each step used on a local drive, priced, plus 50% headroom. Measured at
470ee02 by `scripts/ci/deploy-drive.sh` (its step 9) at 20 gwei:

```
Cost table at 20 gwei (fund = +50%, Q19):
  gas by step:
    deploy                                 74608826 gas  1.4922 ETH
    stray probe throwaway deploy           74580412 gas  1.4916 ETH
    voter onboarding                       16305900 gas  0.3261 ETH
    ceremony (parallel acceptance)         19028819 gas  0.3806 ETH
    post-ceremony votes                    15633292 gas  0.3127 ETH
  per account to fund:
    deployer                              167434458 gas  3.3487 ETH  fund 5.0230 ETH
    proposer                               17978235 gas  0.3596 ETH  fund 0.5393 ETH
    voter 5                                 7558840 gas  0.1512 ETH  fund 0.2268 ETH
    voter 6                                 6874840 gas  0.1375 ETH  fund 0.2062 ETH
    issuerAdmin                              225230 gas  0.0045 ETH  fund 0.0068 ETH
    ops                                       85646 gas  0.0017 ETH  fund 0.0026 ETH
    total                                 200157249 gas  4.0031 ETH  fund 6.0047 ETH
```

About 200 M gas, 4.0 ETH at 20 gwei: fund about 6 ETH. The deployer row
counts the deploy twice: Task 5.8's stray probe (plant a deployer agent
on a second, throwaway deploy and see its preflight refuse) is budgeted
here but is not a runbook step yet. It must run before the real
ceremony and never with the deployer key after it, with `OPS_IDENTITY`
unset (a throwaway deploy would pin its own KeyManager on the ops
identity, and a pin is final) and with a separate record and
`handover.json`; with Safe roles the throwaway also pauses for its own
custody batch. Without it the deployer needs about 2.24 ETH less (1.49
ETH plus headroom at 20 gwei). With Safes the issuer-admin and ops rows are paid by the Safe
owners who execute the batches; `scripts/ci/multisig-drive.sh` prints
their table. Re-measure on the reviewed commit (about 6 minutes; the
drive starts its own node and signer on two free ports, not the box's)
and price at the live `gasPrice` `rpc-check` printed (decimals are
accepted, e.g. `--gwei 1.875`):

```bash
DEPLOY_NODE_PORT=<FREE_PORT> DEPLOY_SIGNER_PORT=<FREE_PORT> COST_GWEI=20 scripts/ci/deploy-drive.sh > $RB/cost-drive.log 2>&1; sed -n '/^Cost table/,/total/p' $RB/cost-drive.log
node scripts/production/costTable.js table --gwei <GWEI> <GAS_JSON>   # GAS_JSON: the gas-deploy.json its last lines name
```

The drive ends `deploy drive PASS in Ns (logs /tmp/deploy-drive.…)`; its
figures move by a few dozen gas between runs (a re-run at 470ee02: total
200157237 gas, the same ETH).
`costTable.js measure` reads its RPC from `COST_RPC_URL` or
`COST_RPC_URL_FILE` (0600).

### 2.3 The deploy

The config (`DEPLOY_CONFIG`, keys in `scripts/production/deployConfig.ts`)
names every role by address:

```json
{
  "ops": "<OPS_SAFE>", "guardian": "<GUARDIAN_SAFE>", "issuerAdmin": "<ISSUER_ADMIN_SAFE>",
  "oracleNodes": ["<NODE_A>", "<NODE_B>", "<NODE_C>"],
  "proposer": "<PROPOSER>", "voters": ["<VOTER_1>", "<VOTER_2>"],
  "escrowFeeWallet": "<FEE_WALLET>",
  "attestor": { "Ax": "<AX>", "Ay": "<AY>" }
}
```

- The proposer and voters are keys in the signer (the ceremony names
  them by wallet index). The three nodes are the deployer's choice and
  are rotated out by vote after the ceremony (section 4): three distinct
  keys of their own. The escrow fee wallet is its own key (D54), not a
  role or a node.
- `<AX>`, `<AY>`: the attestor's EdDSA public key (Q20: the owner holds
  the private key offline, apart from the claim signers). On an offline
  machine, `attest.js --new-key` prints the key once as JSON
  (`{ "privateKey": "0x…", "Ax": "…", "Ay": "…" }`); the key file holds
  only the `0x…` key:

```bash
(umask 077; node scripts/zk/attest.js --new-key > <OFFLINE_DIR>/attestor.json && node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).privateKey)' <OFFLINE_DIR>/attestor.json > <OFFLINE_DIR>/attestor.key)
ATTESTOR_KEY_FILE=<OFFLINE_DIR>/attestor.key node scripts/zk/attest.js --public-key
```

The first line also prints, on stderr,
`The private key is printed once: store it offline; it is never shown again.`;
the second prints `{ "Ax": "…", "Ay": "…" }` for the config
([ZK command lines](../TESTNET_ZK_CLI.md)).

- `OPS_IDENTITY`: the ops OnchainID (section 7), created and exported
  before the first deploy run and kept set for every re-run: it is part
  of the config digest the record keeps, and a resume with another value
  is refused (`… was made with another config (digest …); refusing to resume with this one`).
- Optional: `"oracleOperator"` (must be ops, D47), `"lockAmounts"` (D45;
  Sepolia defaults to cap/4, cap/2, cap; mainnet requires it),
  `"logChunk"`, `"confirmations"`, `"externalRoles"`. On Sepolia and
  31337 an absent role defaults to the signer's account at its
  [TESTNET_SETUP](../TESTNET_SETUP.md) index; name them all on Sepolia.
- Refused before any transaction: `PRIVATE_KEY` or `MNEMONIC` set off a
  dev chain (also from `.env`), a network with local accounts,
  `GOV_TIME_SCALE` other than 1 off a dev chain, a role that is neither
  a signer account nor external, a deployer, ops, guardian and issuer
  admin that are not four different keys, a fee wallet that is the
  deployer, a role or a node, and a node that is the deployer, ops, the
  guardian, the issuer admin, the proposer or a voter
  (`deploy config: oracleNodes[2] 0x… is voters[0]: a node is a key of its own (D25 b); …`).
  A proposer or voter that clashes with another role is refused
  later, by the onboarding (section 3) and the ceremony's checks.

Local (production track; publicly `signer.js` on 1248, section 1a;
locally `OPS_IDENTITY` stays unset here, 2.4's box sets one):

```bash
SIGNER_COUNT=17 SIGNER_UPSTREAM=$DEMO_RPC_URL node scripts/ci/remote-signer.js $SIGNER_PORT > $RB/signer.log 2>&1 & SIGNER_PID=$!   # local; publicly signer.js
export SIGNER_RPC_URL=http://127.0.0.1:$SIGNER_PORT   # publicly http://127.0.0.1:1248
node -e 'require("./scripts/zk/attest").attestorPublicKey("0x" + "11".repeat(32)).then((k) => console.log(JSON.stringify({ attestor: { Ax: String(k.Ax), Ay: String(k.Ay) } })))' > $RB/deploy.json   # local; publicly the config above
DEPLOY_CONFIG=$RB/deploy.json prod scripts/production/DeployProduction.ts > $RB/deploy.log 2>&1; grep -E "^✅ (Deployed|Preflight)" $RB/deploy.log
```

prints `✅ Deployed: 74 transactions in /tmp/vanguard-runbook/deploy-record.json (0 from the record, 74 sent now; N gas)`
(N about 74.6 M; it moves by a few dozen gas between runs) and
`✅ Preflight passed: every check before the ceremony's first transaction holds (voters are checked by the full phase)`.

- Before that line the deploy reads its wiring back from chain
  (`🔗 Wiring read back from chain (49 links):`,
  then one `   ✅ <link>` each: the KeyManager pin on the identity
  factory, agents, rule administrators (the deployer's on VGT until the
  handover too), the KYC and AML issuers trusted on the identity
  registry (until the handover), the identity registry's
  ComplianceRules, VSC's identity registry in ComplianceRules, VSC's
  PrivacyManager and blacklist oracle, the consensus engine and the
  three nodes (until the handover), VGT's registry and trust, VSC's
  authorization on the investor type registry, the registrars, the
  custody officer and lock amounts, the registry's nomination, the
  escrow fee wallet verified and exempt from investor limits). The
  constructor arguments a getter shows are links too: the issuers' and
  ComplianceRules' owner (until the handover), the custody manager's
  bank (ops) and VSC, governance's bound registry, ComplianceRules,
  OracleManager and VSC, and the escrow factory's fee wallet. So is
  every address argument that names another contract
  (`<Contract> <field> as deployed`): the list oracles' OracleManager,
  the custody manager's identity registry (read right after its deploy,
  wherever it is deployed), the escrow factory's VSC, identity registry
  and ComplianceRules, governance's VGT and identity registry, and
  VSC's and VGT's identity registry and compliance. Six of them read
  only until the handover, since their owners may move them: VSC's and
  VGT's `identityRegistry` and `compliance`, and the escrow factory's
  `identityRegistry` and `complianceRules`.
  Each new contract is read before anything holds it: no code at its
  address, or code that is not its compiled artifact's (immutables
  aside), stops that deploy naming it
  (`<contract> at 0x… has code that is not <artifact>'s: its deploy transaction created another contract`,
  or `… has no code: its deploy transaction mined without creating it`);
  the demo's deploy options, 84 included, take the same check, so demo
  state never holds a contract without its artifact's code (the tier
  proof's throwaway probe stack, option 58, too).
  Each deploy step reads its own links back before it reports, so a
  link that does not read true stops that step: its error, the links
  it left missing (`   the deploy stopped; missing wiring: <links>`) and
  `❌ Deploy failed: the deploy stopped; missing: <contracts> (see above)`.
  The escrow step reads its own links too, before the factory enters
  state (`❌ Deploy failed: missing wiring: <links>`), and the whole
  table is read once more at the end
  (`❌ Deploy failed: the deploy stopped; missing wiring: <links>`):
  a stack is never reported deployed half-wired. Re-run the line once the cause is
  fixed: the record replays the sent part and the wiring resumes.
- Publicly `PROD_RECORD` and `PROD_CONFIG` are
  `deployments/11155111.json` (keep it) and
  `deployments/11155111.handover.json`, the deploy's defaults.
- Stopped? Re-run the line: what a resume prints and what to do is
  section 2.3a, [part 2a](02a-deploy-record.md).
- The ceremony (section 5) takes the escrow factory by vote, hands both
  list oracles (`"oracles"`; the unbound whitelist oracle prints
  `   ⚠️  oracle 0x… is not bound on chain; handed over anyway`) to ops
  and closes with seven warnings: the attestor key the deployer trusted,
  one line per circuit (jurisdiction, accreditation, compliance), the
  three deployer-era nodes (section 4) and
  `   ⚠️  0x… is investorLimitExempt (set before the handover): …` (the
  escrow fee wallet; nothing mints the deployer VSC). An eighth when the
  deployer's VGT was not burned first (section 3):
  `   ⚠️  deployer still holds 1000000.0 VGT (N% of the supply): it pays proposal and voting deposits; the deployer should have burned it before the ceremony (it sends nothing after it); the remaining path is ops (a VGT agent): …`.
  A list oracle of the plan's OracleManager the deployer holds (found
  among its creations since `fromBlock`, the named and bound oracles, and
  a best-effort log scan) fails it; an `"oracles"` omitting one is
  refused. A stranger's nomination of the deployer adds one named warning
  by design
  (`   ⚠️  list oracle 0x… names the deployer as pending owner, nominated by 0x…, not the deployer: …`),
  as does a capped scan (`   ⚠️  scan for other list oracles naming the deployer was capped at block N…: not checked`).

### 2.4 Multisig ops, issuer admin and guardian (Task 5.13, Q11 = B)

A role at an address with code (a Safe) or in the config's
`"externalRoles"` is external: nothing is sent for it (a wallet index with
code, e.g. an EIP-7702 account, is refused: write it as an address).
The deploy, the ceremony's preflight, completion and the audit read
every external role as a Safe (the guardian Safe too: its owners could
pause VSC), down two levels of owner Safes, and refuse with the same
words: a 7702 account; the deployer as a listed owner
(`❌ guardian 0x… lists the deployer 0x… as an owner (through 0x…): the deployer holds its power`);
an owner below the role they cannot read (past two levels, in a cycle,
or with no readable `getOwners()`:
`❌ guardian 0x…: owner 0x… (through 0x…, 0x…) is unread (code past 2 levels): the deployer's ownership of it cannot be vetted`);
the deployer as an enabled module of the role or of an owner Safe, on
any page of its module list
(`❌ guardian 0x… has the deployer 0x… as an enabled module: a module executes without the owners`);
a module list they cannot read whole, past 100 entries
(`❌ guardian 0x… has its module list unread past 100: a module executes without the owners`)
or not readable beside a working `getOwners()`
(`❌ guardian 0x… reads as a Safe but its module list cannot be read: a module executes without the owners`);
a contract that reads as a Safe (`getOwners()` works, so its owners
are vetted as above) but whose threshold they cannot read
(`❌ guardian 0x… reads as a Safe but its threshold cannot be read: it cannot be vetted as a multisig`);
and a degenerate multisig, with no owner or a threshold of 0 or above
its owner count
(`❌ guardian 0x… is a degenerate multisig (0-of-0): it needs an owner and a threshold from 1 to its owner count`).
Warned in every phase (the preflight included), never a ✅, and the
run then ends with warnings: any other module
(`⚠️  ops 0x… has module(s) enabled (…): a module executes without the owners`)
and a role contract whose `getOwners()` cannot be read, so it reads as
no Safe
(`⚠️  ops 0x… has code but no readable getOwners()/getThreshold(): the deployer's ownership of it is unchecked (runbook section 2)`).
Only a call that has no such function (a revert with no data, or no
data back) reads as missing; a timeout, a rate limit, a revert with
data or any other error on these reads fails the run. The vet reads
what each contract reports, each call from the zero address so a
contract cannot answer the deployer differently; still compare each
role address with your own Safe before the deploy, and ensure the
deployer neither owns nor executes it any other way. Its calls go to a
Safe Transaction Builder batch (2.5) with
`⏸️  awaiting N <role> transaction(s): <file>`, exit 3: paused, not done.
The next run checks each effect on chain and goes on, pauses again
(`   ❌ not executed: [<step>] …`, only those re-written) or refuses another
effect by name (exit 1). The pauses on Sepolia:

| CLI                   | Batch file                                                         | Calls                                                        |
| --------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------ |
| deploy                | `deployments/11155111.ops-transactions.json`                       | ops: custody `acceptOwnership`                               |
| deploy (OPS_IDENTITY) | `deployments/11155111.ops-identity.ops-transactions.json`          | ops: the ops identity's KeyManager calls (section 7)         |
| ceremony, full phase  | `<PROD_CONFIG>.ops-transactions.json`                              | ops: both list oracles' `acceptOwnership`                    |
| ceremony, full phase  | `<PROD_CONFIG>.issuer-admin-transactions.json`                     | issuer admin: both issuers' `acceptOwnership`, the deployer's key revoked |
| claimSigners          | `<PROD_CONFIG>.claim-signers.issuer-admin-transactions.json`        | issuer admin: the KYC and AML claim-signer keys (4a)         |

Locally `TestMultisig` (a test stand-in, not a Safe; owners: ops 10 and
12, issuer admin 9 and 13) is driven by `scripts/ci/multisig-exec.js`.
Run this box after the production track (it resets the node and
restarts the local signer); section 3's voter registration runs inside
it:

```bash
reset; kill $SIGNER_PID; sleep 1; SIGNER_COUNT=14 SIGNER_UPSTREAM=$DEMO_RPC_URL node scripts/ci/remote-signer.js $SIGNER_PORT > $RB/signer.log 2>&1 & SIGNER_PID=$!   # local
for a in 0xFABB0ac9d68B0B445fB7357272Ff202C5651694a 0x1CBd3b2770909D4e10f157cABC84C7264073C9Ec; do curl -s -X POST -H 'Content-Type: application/json' --data "{\"jsonrpc\":\"2.0\",\"method\":\"hardhat_setBalance\",\"params\":[\"$a\",\"0x56BC75E2D63100000\"],\"id\":1}" $DEMO_RPC_URL > /dev/null; done   # local: owners 12, 13
ms() { MULTISIG_OWNERS=$1 npx hardhat run scripts/ci/multisig-exec.js --network remote | sed -n 's/^multisig //p'; }   # local
exe() { BATCH=$1 MULTISIG_OWNERS=$2 npx hardhat run scripts/ci/multisig-exec.js --network remote; }   # local; publicly the Safe app
msrun() { env -u MNEMONIC DEPLOY_CONFIG=$RB/ms.json DEPLOY_RECORD=$RB/ms-record.json HANDOVER_CONFIG=$RB/ms-handover.json npx hardhat run "$@" --network remote; }   # local
export OPS=$(ms 10,12) ADMIN=$(ms 9,13)   # local; publicly the two Safes
env -u MNEMONIC OPS_SAFE=$OPS CREATOR=0xFABB0ac9d68B0B445fB7357272Ff202C5651694a npx hardhat console --network remote > $RB/ops-identity.log 2>&1 <<'EOF'   # section 7; locally owner 12 creates it
const id = await (await ethers.getContractFactory("OnchainID", await ethers.getSigner(process.env.CREATOR))).deploy(process.env.OPS_SAFE); await id.waitForDeployment(); console.log("OPS_IDENTITY", await id.getAddress(), "owner", await id.owner());
EOF
export OPS_IDENTITY=$(awk '/^OPS_IDENTITY/ {print $2}' $RB/ops-identity.log); grep "^OPS_IDENTITY" $RB/ops-identity.log
node -e 'require("./scripts/zk/attest").attestorPublicKey("0x" + "11".repeat(32)).then((k) => console.log(JSON.stringify({ attestor: { Ax: String(k.Ax), Ay: String(k.Ay) }, ops: process.env.OPS, issuerAdmin: process.env.ADMIN })))' > $RB/ms.json   # local
dep() { msrun scripts/production/DeployProduction.ts > $RB/ms-deploy.log 2>&1; echo "exit $?"; grep -E "^⏸️|not executed|effect\(s\) hold|^✅ Preflight" $RB/ms-deploy.log; }
dep; dep; exe $RB/ms-record.ops-transactions.json 10,12; dep; exe $RB/ms-record.ops-identity.ops-transactions.json 10,12; dep
msrun scripts/ci/deploy-voters.js > $RB/ms-voters.log 2>&1   # local: section 3
msrun scripts/handover.ts > $RB/ms-full.log 2>&1; echo "exit $?"; grep "^⏸️" $RB/ms-full.log
export MS_SHA256=$(awk '/snapshot sha256:/ {print $3}' $RB/ms-full.log)   # section 6
exe $RB/ms-handover.json.ops-transactions.json 10,12; exe $RB/ms-handover.json.issuer-admin-transactions.json 9,13
HANDOVER_SNAPSHOT_SHA256=$MS_SHA256 HANDOVER_PHASE=accept msrun scripts/handover.ts > $RB/ms-accept.log 2>&1; echo "exit $?"; grep "effect(s) hold" $RB/ms-accept.log; tail -1 $RB/ms-accept.log
unset OPS_IDENTITY   # local
```

The console prints `OPS_IDENTITY 0x… owner 0x…` (the ops multisig).
The deploy prints `exit 3` and `⏸️  awaiting 1 ops transaction: /tmp/vanguard-runbook/ms-record.ops-transactions.json`
twice (the re-run sends nothing and adds `   ❌ not executed: [deploy.custody.accept] InvestorRequestManager 0x….acceptOwnership(): …`),
`executed 1 calls on 0x…`; then `exit 3`, `   ✅ 1 role transaction effect(s) hold on chain` and
`⏸️  awaiting 2 ops transactions: /tmp/vanguard-runbook/ms-record.ops-identity.ops-transactions.json`
(the ops identity's `pinRecoveryManager` and `authorizeManager`, section 7); `executed 2 calls on 0x…`, `exit 0`,
`   ✅ 1 role transaction effect(s) hold on chain`, `   ✅ 2 role transaction effect(s) hold on chain` and the preflight line.
The ceremony pauses after its snapshot, before any vote: `exit 3`,
`⏸️  awaiting 4 issuerAdmin transactions: /tmp/vanguard-runbook/ms-handover.json.issuer-admin-transactions.json`,
`⏸️  awaiting 2 ops transactions: /tmp/vanguard-runbook/ms-handover.json.ops-transactions.json`;
then `executed 2 calls on 0x…`, `executed 4 calls on 0x…`, `exit 0`, `   ✅ 6 role transaction effect(s) hold on chain`
and `⚠️  Handover complete with warnings: see above.` (the eight warnings above: this box does not burn the deployer's VGT).
Before execution the accept phase exits 3 naming each call and a full re-run is
refused (`… a full re-run would send them again …`, exit 1), sending nothing.
The claim-signer batch with a multisig issuer admin is driven by
`scripts/ci/multisig-drive.sh` (step 5), not by this box.

### 2.5 Executing a Safe batch

The batch file is Safe Transaction Builder's batch format (source:
`demo/utils/RoleCalls.js`). Its `meta.description` lists every call in
order (`N. [<step>] <Contract> <address>.<function>(<args>): <purpose>`)
and says which effects the CLI checks before it continues; approve
nothing else.

1. Check the file: its `chainId`, `meta.createdFromSafeAddress` (the
   role's Safe) and each call against the description and the step you
   are running.
2. In the Safe app for that Safe, open the Transaction Builder app,
   import (drag in) the JSON file, compare the listed transactions with
   step 1, create the batch, collect the owners' signatures and execute
   it. Another owner checks the same before signing.
3. Re-run the CLI that paused. It reads every call's effect from the
   chain: `   ✅ N role transaction effect(s) hold on chain` and goes on;
   a call not executed pauses again (exit 3); a different effect is
   refused (exit 1).

Steps 2 and 3 of the Safe app are not driven locally; the effect check in
step 3 is (the boxes above, `scripts/ci/multisig-drive.sh`).
