# Runbook part 1: keys and the signer

Part of the [operator runbook](../OPERATOR_RUNBOOK.md) (conventions, the
local rehearsal box and the order of work are there).

## 1. Roles and keys

| Role             | Holds                                                                                               | Key on a public network                                         |
| ---------------- | --------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| Governance       | owner of every core contract after the ceremony; acts only by vote                                  | a contract (no key)                                             |
| Ops              | agent roles, compliance officer, list oracles, OracleManager operator, `listOperator`, escrow admin | a Safe, Sepolia too (Q11 = B; section 2.4)                      |
| Guardian         | `Token.pause()` on VSC, nothing else                                                                | a Safe, Sepolia too (Q11 = B; never sends in the ceremony)      |
| Issuer admin     | owner and only management key of every trusted claim issuer                                         | a Safe whose owners are not the ops Safe's (D25 b, Q17)         |
| Claim signers    | KYC and AML claim signatures after the ceremony                                                     | two EOA keys in the signer, added by the issuer-admin Safe (4a) |
| Proposer, voters | the ceremony's and the post-ceremony votes                                                          | keys of their own in the signer (section 3)                     |
| Nodes            | oracle consensus votes                                                                              | three keys of their own, no other role (Q4, D50; section 4)     |
| Deployer         | everything until the ceremony; in the voting window only votes; afterwards nothing                  | the signer (section 1a)                                         |

- No key in the deploying process (R-2F6-6, D48 a): section 2's deploy
  refuses `PRIVATE_KEY` / `MNEMONIC` and local accounts off a dev chain;
  `hardhat.config.ts` refuses the published Hardhat phrase on any chain
  but 31337 (keyed on the chain id). Never set either publicly.
- No key is both an IdentityRegistry agent and an issuer owner or signer
  (D25 b); ops, guardian, issuer admin: three holders, none the deployer
  or governance. A node is a key of its own: never the deployer, ops, the
  guardian, the issuer admin, the proposer, a voter, a registry or token
  agent, a claim signer, the OracleManager operator, an
  InvestorTypeRegistry governor or officer, or a key on a claim issuer
  (the preflight, the completion and the audit refuse it; a node that is
  also an escrow fee wallet only warns).
- No tool checks that the issuer-admin Safe's owners differ from the ops
  Safe's (Q17): the deploy refuses only the deployer as a listed owner
  and the claim-signer CLI compares the Safe addresses. Compare the two
  owner lists by hand in the Safe app before the deploy.

Check the demo's wallets:

```bash
npx hardhat run scripts/print-role-wallets.js --network $NET
```

prints one row per role, locally
` 10  ops                                0xBcd4042DE499D14e55001CcbB24a551F3b954096  10000.0 ETH`.
On Sepolia the roles are not the demo's wallet indices: the deploy config
names them by address (section 2.3).

## 1a. The production signer

`scripts/production/signer.js` holds every key the CLIs send from and is
reached as `--network remote` (`SIGNER_RPC_URL`); no CLI holds a key. It
serves Sepolia (chain 11155111) only, listens on 127.0.0.1 (default port
1248) and answers only requests carrying its bearer token.
`scripts/ci/remote-signer.js` is the CI and local-rehearsal stand-in: it
derives its keys from `MNEMONIC`, refuses a chain other than 31337 unless
`SIGNER_ALLOW_CHAIN` names it, and must never run with a real key.

**Keystores.** One encrypted keystore per key, mode 0600, all under one
password, in one directory. The signer orders them by file name and that
order is the wallet index the ceremony uses (index 0 is the deployer;
the index is the position in the order, not the number in the name), so
name them with a sortable prefix:

```bash
node scripts/production/signer.js new <KEYSTORE_DIR> 00-deployer 10-proposer 11-voter 12-voter
```

It asks `password for the new keystores: ` (12 or more characters; or
reads `SIGNER_PASSWORD_FILE`, a 0600 file) and prints `<name> <address>`
per key. A key added later must sort after the pinned ones (1b): a name
that sorts before an existing keystore prints
`warning: <name>.json sorts before <later>.json: every wallet index from it on shifts, and a handover.json pinned to the old order is refused (name new keystores so they sort after the pinned ones, or re-pin handover.json "accounts")`.
Claim-signer keys (4a) are such later keys (e.g. `50-claim-kyc`,
`51-claim-aml`). The signer reads its keystores only at start: restart
it after adding one. Back up the directory and the password apart.

**Start.** On a terminal of its own (the approval prompt reads
`/dev/tty`), the upstream RPC from a variable or a file, never argv. The
upstream serves both reads and sends and must be archive (2.1):

```bash
export SIGNER_UPSTREAM="$(cat <0600 FILE WITH THE ARCHIVE RPC URL>)"
SIGNER_KEYSTORE_DIR=<KEYSTORE_DIR> SIGNER_PASSWORD_FILE=<0600 FILE> node scripts/production/signer.js
```

It prints
`signer on 127.0.0.1:1248: N key(s), chain 11155111, every request asked; token in <file>; N signed nonce(s) remembered`
and one `   <index> <name> <address>` line per key. The token file is
`SIGNER_TOKEN_FILE`, else `<tmp>/vanguard-signer-<uid>/<port>.token`
(0600; the CLIs read the same path through `hardhat.config.ts`); it is
removed when the signer exits normally (a `kill -9` leaves it: `rm` it).
A refusal ends `signer: <reason>` with exit 3 (for the signer a failure,
not the CLIs' pause): on another chain
`signer: upstream is chain 31337: this signer serves Sepolia (11155111) only (31337 with SIGNER_TEST=1)`
(`SIGNER_TEST=1` is for the CI drives).

**The prompt.** It is on by default off chain 31337, and then the signer
needs a terminal: without one it refuses to start
(`the prompt (the default on chain 11155111; SIGNER_PROMPT=0 switches it off) needs a controlling terminal (/dev/tty) to ask on`).
Every transaction is shown (the call decoded for a compiled contract,
to, value, nonce, gas, fees, chain, the data's hash and the unsigned
transaction hash) and signed only when you type the token it shows,
`   type <token> to sign, anything else refuses: `, the last six hex
digits of the unsigned transaction hash. Compare what is shown with the
step you are running before typing. Every send waits at the signer's
terminal, and the CLIs give up on a request after 600 s (the `remote`
network's timeout in `hardhat.config.ts`): stay at the signer while a CLI
runs, and be there when a voting period or execution delay ends (each
execution comes 9 to 10 days after its vote). With the prompt on, opaque
`personal_sign` / `eth_sign` requests are refused; claims are signed
through `vanguard_signClaim`, which recomputes the claim digest (issuer,
identity, topic, scheme, data, uri, validTo, chain and the issuer's
revocation epoch) and shows each field (the onboarding and claim CLIs
use it). `SIGNER_PROMPT=0` switches the prompt off, needs no terminal and
says so at start:
`⚠️  SIGNER_PROMPT=0 on chain 11155111: EVERY REQUEST IS SIGNED WITHOUT ASKING. …`.

**One transaction per nonce.** The signed nonces are kept beside the
keystores in `<KEYSTORE_DIR>/signed-nonces` (0600; a restart on any
port, a reboot or a cleaned temp directory keeps it). A request at a
recorded nonce with the same chain, from, to, value and data is the same
transaction (re-sent, or re-signed when only gas or fees moved); a
different one is refused:
`nonce N of 0x… was already signed for another transaction (its value differs): refused; never to be mined? run: signer.js forget 0x… N`.
A transaction stuck in the mempool: the running signer sends the
recorded transaction again with higher fees (asked like any other):

```bash
node scripts/production/signer.js bump <ADDRESS> <NONCE>
```

prints `signer: nonce N of 0x… sent again with higher fees: 0x…`. An
entry for a transaction that will never be mined (verify on an explorer
that the nonce is unused or used by the transaction you expect): STOP
the signer first (a running signer keeps the record in memory and writes
the entry back with its next signature), then

```bash
SIGNER_KEYSTORE_DIR=<KEYSTORE_DIR> node scripts/production/signer.js forget <ADDRESS> <NONCE>
```

prints `signer: forgot 11155111:0x…:N in <KEYSTORE_DIR>/signed-nonces: the next request at that nonce is signed as new`;
start the signer again. `bump` takes the signer's port as a third
argument when it is not 1248 (and `SIGNER_TOKEN_FILE` when the signer was
started with one). `node scripts/production/signer.js help` prints the four
forms.

**The CLIs.** Point them at it: `export SIGNER_RPC_URL=http://127.0.0.1:1248`.

Locally the box's `remote-signer.js` stands in for sections 2 to 4a;
the production signer is exercised by the deploy drive's onboarding step
(`scripts/ci/deploy-drive.sh`, step 5, `SIGNER_TEST=1`) and, for its
start, key order and token file, by this box (before section 2.3 starts
the local signer on the same port):

```bash
(umask 077; printf '%s\n' "rehearsal-only password" > $RB/ks-password)   # local
SIGNER_PASSWORD_FILE=$RB/ks-password node scripts/production/signer.js new $RB/ks 10-deployer 20-proposer   # local
SIGNER_PASSWORD_FILE=$RB/ks-password node scripts/production/signer.js new $RB/ks 15-claim-kyc   # local: sorts before 20-proposer
SIGNER_TEST=1 SIGNER_KEYSTORE_DIR=$RB/ks SIGNER_PASSWORD_FILE=$RB/ks-password SIGNER_UPSTREAM=$DEMO_RPC_URL SIGNER_TOKEN_FILE=$RB/ks.token node scripts/production/signer.js $SIGNER_PORT > $RB/prod-signer.log 2>&1 & PSIGNER_PID=$!   # local
sleep 5; cat $RB/prod-signer.log; kill $PSIGNER_PID; sleep 1; ls $RB/ks.token   # local
```

prints `10-deployer 0x…`, `20-proposer 0x…`, the sort warning and
`15-claim-kyc 0x…`; then
`signer on 127.0.0.1:N: 3 key(s), chain 31337, NOT asking; token in /tmp/vanguard-runbook/ks.token; 0 signed nonce(s) remembered`
(N is `$SIGNER_PORT`) and `   0 10-deployer 0x…`, `   1 15-claim-kyc 0x…`,
`   2 20-proposer 0x…` (the proposer moved from index 1 to 2); after the
stop `ls` fails
(`ls: cannot access '/tmp/vanguard-runbook/ks.token': No such file or directory`):
the token went with the process.

## 1b. The `accounts` pins in handover.json

`handover.json` names the deployer, ops, guardian, issuer admin,
proposer and voters by wallet index into the signer's key order (a Safe
role by its address). The deploy writes `"accounts"`, each used index
pinned to its address (`{ "0": "0x…deployer", "4": "0x…proposer", … }`).
Every ceremony phase and every post-ceremony CLI checks the signer's
wallets against the pins before any send and refuses a shifted keystore
directory:
`<config>: wallet 4 (proposer) is 0x… but "accounts" pins 0x…: the signer's keystores changed (a file added, removed or renamed?); refusing before any send. …`.
Wallet 0 must also be the deploy record's deployer, and a signer on
another chain than the record's is refused. Pins are required off chain
31337 and whenever a deploy record is named.

To re-pin after an intended change of order: start the signer, read its
`   <index> <name> <address>` lines and write each used index's new
address into `"accounts"` by hand (only the indices the config uses).
Re-pinning to the wrong address makes every later phase sign as another
key: prefer naming new keystores so they sort last.
