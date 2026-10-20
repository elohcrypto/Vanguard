# Operator runbook

The ordered procedure to deploy Vanguard, hand it from the deployer to
governance and run it, on Sepolia (Task 5.8) and in its local
rehearsal. Each step names the command or demo option and the line it
prints when it worked. The rules and their reasons:
[TESTNET_SETUP](TESTNET_SETUP.md), [TESTNET_CEREMONY](TESTNET_CEREMONY.md)
(its [runbook rules](TESTNET_CEREMONY.md#runbook-rules-for-the-ceremony-and-after-plan-2f)),
[TESTNET_DEMO_OPTIONS](TESTNET_DEMO_OPTIONS.md), the
[ZK command lines](TESTNET_ZK_CLI.md) and the deep dives
([transfer](DEEP_DIVE_TRANSFER.md), [identity](DEEP_DIVE_IDENTITY.md),
[ZK](DEEP_DIVE_ZK.md)).

Status: rewritten for the Sepolia path in Task 5.16 (the Task 5.15
tooling and the Task 5.17 fixes), split into parts; driven verbatim on a
local node by a non-author before 5.8 (records in
[rehearsals](rehearsals/)); final after 5.8.

## The parts

| Part                                                    | Sections                                                                                               |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| [Keys and the signer](runbook/01-keys-and-signer.md)    | 1 roles and keys; 1a the production signer; 1b the `accounts` pins                                     |
| [Deploy](runbook/02-deploy.md)                          | 2 deploy: 2.1 the RPCs, 2.2 the budget, 2.3 the deploy, 2.4 multisig ops and issuer admin, 2.5 a Safe batch |
| [Voters and the ceremony](runbook/03-ceremony.md)       | 3 voter registration; 5 the ceremony; 5a on a public chain; 6 the snapshot                             |
| [After the ceremony](runbook/04-after-ceremony.md)      | 4 oracle nodes (the post-ceremony votes); 4a claim signers                                             |
| [Operations](runbook/05-operations.md)                  | 7 the KeyManager ops identity; 8 rule administrators; 9 list oracles; 10 the day-2 audit; 11 drills; 12 incidents |

Section numbers are those of the Task 5.6 draft (code comments and other
documents cite them). Section 4 runs after sections 5 and 6: it needs
governance to own OracleManager.

## The Sepolia order of work

1. Keys: the role table and the three Safes (ops, guardian, issuer
   admin; section 1), the production signer's keystores (1a), the
   attestor key made offline (2.3), and the ops identity, an OnchainID
   the ops Safe owns, exported as `OPS_IDENTITY` (section 7).
2. Before the deploy: `rpc-check` on both RPCs (2.1), the budget and the
   funding (2.2; it includes Task 5.8's stray probe, which is not a
   runbook step yet).
3. The deploy through the signer, `OPS_IDENTITY` set for every run of it
   (2.3); it pauses for the ops Safe's batches (custody, the ops
   identity: 2.4, 2.5, section 7).
4. Voters: `onboardVoters`, then the 7-day voter age; meanwhile the
   deployer burns its VGT (section 3).
5. The ceremony's full phase (pauses for the ops and issuer-admin Safe
   batches), the digest recorded (section 6), the accept phase (all
   acceptances voted in parallel), `scanCount`, the day-2 audit (5, 5a).
6. Right after: the post-ceremony votes in two rounds (section 4) and
   the claim signers, the issuer-admin Safe's batch (4a); then the
   audit.

Calendar (R-515-12): about 5 weeks of wall time: 7 days voter age, about
10 days for the acceptance votes (one voting period and execution delay
for all of them), about 19 days for the two post-ceremony rounds.

## Conventions and the local rehearsal

Shell variables, set once per session: `NET` (`devnode` locally),
`HANDOVER_CONFIG` (the local fixture's `handover.json`), `RB` (the run's
record directory: logs, snapshot, digests; keep it), and for the
production track `PROD_RECORD` and `PROD_CONFIG` (the deploy record and
the `handover.json` the deploy writes; on Sepolia
`deployments/11155111.json` and `deployments/11155111.handover.json`).
`<ANGLE>` is a value the operator fills in. Output is quoted as printed;
`0x…` and `N` stand for an address and a number that differ between
runs. Skip `# local` lines publicly and `# public` lines (with their
here-document) locally.

> **Local rehearsal box.** A fresh local node with Hardhat's public test
> accounts (a published phrase): never use them on a public network.
>
> ```bash
> cd <repo checkout>                 # a clean checkout of the reviewed commit
> npm ci && npm run setup:zk         # once; setup:zk before compile
> npx hardhat clean && npx hardhat compile
> export MNEMONIC="test test test test test test test test test test test junk"
> export NODE_PORT=8547 SIGNER_PORT=8549   # two free ports
> export DEMO_RPC_URL=http://127.0.0.1:$NODE_PORT NET=devnode
> export RB=/tmp/vanguard-runbook HANDOVER_CONFIG=/tmp/vanguard-runbook/handover.json
> export PROD_RECORD=/tmp/vanguard-runbook/deploy-record.json PROD_CONFIG=/tmp/vanguard-runbook/deploy-handover.json
> unset OPS_IDENTITY   # set only where a box sets it (2.4); publicly section 7
> rm -rf $RB && mkdir -p $RB   # start from an empty $RB
> node_modules/.bin/hardhat node --port $NODE_PORT > $RB/node.log 2>&1 & NODE_PID=$!   # leave it running (not via npx: $! is then the node itself)
> sleep 10                                                   # until it listens
> ```
>
> Run the local track alone in this checkout: `npx hardhat clean`
> deletes `artifacts/` under anything else using the tree, and the
> code-hash pins compare against it. Keep `MNEMONIC` out of `.env`
> (Hardhat loads `.env` into every run, so `prod`'s `env -u MNEMONIC`
> cannot remove it and the deploy refuses); export it in the shell only.
>
> Shell functions (`reset` and the fixture never run publicly; `prod`
> runs every production CLI, locally and on Sepolia):
>
> ```bash
> reset() { curl -s -X POST -H 'Content-Type: application/json' --data '{"jsonrpc":"2.0","method":"hardhat_reset","params":[],"id":1}' $DEMO_RPC_URL; echo; }
> l0deploy() { reset; rm -f $HANDOVER_CONFIG $HANDOVER_CONFIG.snapshot.*; HANDOVER_FIXTURE_OUT=$HANDOVER_CONFIG npx hardhat run test/production/deployHandoverFixture.ts --network $NET | tail -1; }
> l0() { l0deploy; npx hardhat run scripts/handover.ts --network $NET > $RB/handover.log 2>&1; tail -1 $RB/handover.log; }
> prod() { env -u MNEMONIC DEPLOY_RECORD=$PROD_RECORD HANDOVER_CONFIG=$PROD_CONFIG npx hardhat run "$@" --network remote; }
> ```
>
> `reset` prints `{"jsonrpc":"2.0","id":1,"result":true}`; `l0deploy` adds
> `handover fixture deployed; config written to /tmp/vanguard-runbook/handover.json`;
> `l0` adds `✅ Handover complete: the deployer holds no power.` At the end
> stop the local signer (the one 2.4 restarted) and the node, and drop the
> keys (public networks refuse them):
>
> ```bash
> kill $SIGNER_PID; kill $NODE_PID   # local
> unset MNEMONIC PRIVATE_KEY
> ```
>
> **Three tracks.** The production track (`prod`: sections 2, 3, 5a, 4,
> 4a) runs the Sepolia commands against the local node through
> `scripts/ci/remote-signer.js` (CI tooling holding the published keys;
> Sepolia uses `scripts/production/signer.js`, section 1a). The ceremony
> CLI on the handover fixture (`test/production/deployHandoverFixture.ts`:
> ops 1, guardian 2, stranger 3, proposer 4, voters 5 and 6, issuer admin
> 7, escrow fee wallet 8) shows sections 5, 6 and 9-12 in seconds. The
> demo (`npm run demo:drive`) shows the rest with section 1's roles (ops
> 10, guardian 11, issuer admin 9); its state is in memory: each drive
> resets.

## The local rehearsal order

The production track runs on one chain with no reset in between; the
other boxes reset the node. Locally, in this order:

1. The box above; section 1's `print-role-wallets.js`; section 1a's
   production-signer box (it stops the signer it started by its pid).
2. The production track: 2.1's local `rpc-check`, 2.2's measurement
   (optional, about 6 minutes, on two other free ports), 2.3's deploy,
   section 3's `onboardVoters` box and its VGT burn, 5a's ceremony, audit and scan
   boxes, section 4's post-ceremony box and audit, 4a's claim-signer box
   and final audit.
3. 2.4's multisig box (it resets the node, restarts the local signer by
   its recorded pid and creates an ops identity the ops multisig owns).
4. The fixture and demo boxes: section 3's L0 check, section 4's demo
   drive, sections 5 and 6, then sections 7 to 12 in order.

## What checks this runbook

`node scripts/ci/docs-gate.js` (CI's gates job) checks structure and
existence only: closed code fences, the README tree, that links and
anchors resolve, that demo option numbers are menu cases, and that cited
script paths, `npm run` names and hardhat tasks exist. It does not check
that a command works, that a drive's arguments are right or that prose or
quoted output is true. That comes from the verbatim rehearsal: a person
who did not write the runbook runs every command as written on a fresh
node and records each quoted line against what was printed
([rehearsals](rehearsals/)). The CI drives (`scripts/ci/deploy-drive.sh`,
`scripts/ci/multisig-drive.sh`, `scripts/ci/strict-drive.sh`,
`scripts/ci/regression-drives.sh`) are the executable truth behind it.
