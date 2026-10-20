# Runbook part 5: operations

Part of the [operator runbook](../OPERATOR_RUNBOOK.md) (conventions, the
local rehearsal box and the order of work are there).

## 7. The KeyManager ops identity

KeyManager has no owner: the ops identity's owner sends
`authorizeManager(KeyManager)` and pins KeyManager as recovery manager
(`pinRecoveryManager`, final; [identity](../DEEP_DIVE_IDENTITY.md)). The
deploy (its steps in `scripts/production/opsKeyManager.ts`) handles the
ops OnchainID named by `OPS_IDENTITY`, which only ops may own (or the
deployer before it transfers it; another owner is refused by name).
The deploy creates no identity, and `OPS_IDENTITY` is part of the deploy
config's digest: create it and export it before the first deploy run,
and keep it set for every re-run (a resume with another value is
refused). On Sepolia, deploy an `OnchainID` whose owner is the ops Safe
through the signer, from `<CREATOR_ADDRESS>`, a funded key the signer holds, not the
deployer (its creator gets no lasting power: only in the creating block
may it pin a recovery manager or add a creation key):

```bash
env -u MNEMONIC OPS_SAFE=<OPS_SAFE> CREATOR=<CREATOR_ADDRESS> npx hardhat console --network remote > ops-identity.log 2>&1 <<'EOF'
const id = await (await ethers.getContractFactory("OnchainID", await ethers.getSigner(process.env.CREATOR))).deploy(process.env.OPS_SAFE); await id.waitForDeployment(); console.log("OPS_IDENTITY", await id.getAddress(), "owner", await id.owner());
EOF
export OPS_IDENTITY=$(awk '/^OPS_IDENTITY/ {print $2}' ops-identity.log); grep "^OPS_IDENTITY" ops-identity.log
```

It prints `OPS_IDENTITY 0x… owner <OPS_SAFE>` (2.4's box runs it
locally). Check the address has code and `owner()` is the ops Safe
before the deploy. The deploy then handles it by its owner:


- owned by an external ops (the ops Safe, the Sepolia case): both calls
  are a Safe batch (`deployments/11155111.ops-identity.ops-transactions.json`,
  `⏸️  awaiting 2 ops transactions: <file>`, exit 3; 2.4, 2.5); the next
  run checks `recoveryManager() == KeyManager` and
  `authorizedManagers(KeyManager)` on chain
  (`   ✅ 2 role transaction effect(s) hold on chain`) and goes on. An
  identity pinned to another manager is refused before anything is
  exported (a pin is final: use another ops identity). Driven by
  `scripts/ci/multisig-drive.sh` step 2;
- owned by the deploying wallet: the deploy sends both itself;
- owned by an ops key the signer does not drive: it prints the calls
  that key must send (text only);
- unset: it prints the call with a placeholder; nothing is authorized.

Local: after section 2.3's run (production track):

```bash
grep -E "OPS_IDENTITY|must send" $RB/deploy.log
```

With `OPS_IDENTITY` unset it prints `   ⚠️  OPS_IDENTITY not set: KeyManager is authorized on no identity yet.` and
`   The ops key must send: OnchainID(<ops identity>).authorizeManager(0x…) from the identity owner <ops key>`.
Then remove every MANAGEMENT key you do not know from the ops identity
and seat at least two recovery agents (`setupKeyRecovery`, threshold at
least 2). The completion has no row for the ops identity's owner yet (a
`handover.json` key is needed; carried to 5.8 or 5.9).

## 8. Rule administrators per token

The role (it sets the token's jurisdiction rule) is per token. Step 1
makes governance the rule administrator on VSC and VGT
(`   ✅ ComplianceRules rule administrator on VSC: governance 0x…`), step 5
removes the deployer (`   ✅ deployer removed as ComplianceRules rule administrator on VSC`).
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
tier first, then bind (a ComplianceRules vote on `ComplianceRules.setWhitelistOracle(VSC, oracle)`). On Sepolia ops
operates it (Q3; the ceremony hands it to ops, bound or not). Demo option
38a does both and votes the bind (`38a:y`), listing as the owner, never
wallet 0 after the ceremony; with a multisig ops it sends nothing
(`   ⛔ 0x… not listed: the oracle's owner 0x… is a contract (a multisig ops): listing is ops's batch or manual step; nothing sent`). Local: reset.

```bash
reset   # local
npm run demo:drive -- --strict --timeout 1800 --log $RB/d47.log 1 21 51 31 74 24:1:Alice 24:1:Bob 24:1:Carol 24:1:Dave 75a:4:1000:y 75a:5:1000:y 75a:6:1000:y 75a:7:1000:y 22 32 83c:y 83d 83e 38a:y 0
```

The log shows `   ✅ no holder would be frozen by the bind`, `   ✅ proposal #11 executed` and
`   ✅ rules.whitelistOracle(VSC) = 0x36C02dA8a0983159322a80FFE9F24b1acfF8B570`;
a holder the bind would freeze stops it at `   ⛔ Bind refused: <reason>`.

A consensus may clear a governance (no-expiry) blacklist entry when its
verdict resolved after the governance write (D27 = a). Watch daily and
after every incident; the emergency-oracle key and the oracle owner (ops)
must be able to re-list within hours. Local: L0.

```bash
l0   # local
npx hardhat console --network $NET <<'EOF'
const fs = await import("fs"); const cfg = JSON.parse(fs.readFileSync(process.env.HANDOVER_CONFIG, "utf8")); const g = await ethers.getContractAt("VanguardGovernance", cfg.governance); const rules = await ethers.getContractAt("ComplianceRules", await g.boundTarget(1)); const bl = await ethers.getContractAt("BlacklistOracle", await rules.blacklistOracle(await g.boundTarget(3))); const ev = (await bl.queryFilter(bl.filters.BlacklistUpdated(), cfg.fromBlock ?? 0)).filter((e) => e.args.reason === "Oracle consensus clearing"); console.log("consensus clearings:", ev.length, ev.map((e) => `${e.args.subject} @${e.blockNumber}`));
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

**The day-2 audit**, after an upgrade, a rotation or any vote that
moves a power, sends nothing: what it checks, passes and fails is in
[TESTNET_CEREMONY](../TESTNET_CEREMONY.md#runbook-rules-for-the-ceremony-and-after-plan-2f).
Audit between votes (an open proposal on a plan contract fails it).
Publicly: `HANDOVER_PHASE=audit prod scripts/handover.ts` (sections 4,
4a). Local: section 9's L0 chain. Demo option 83f runs the same audit
from the demo's in-memory state (section 4).

```bash
HANDOVER_PHASE=audit npx hardhat run scripts/handover.ts --network $NET > $RB/audit.log 2>&1; tail -1 $RB/audit.log
grep "Handover audit" $RB/audit.log
```

It ends `✅ Audit passed: the deployer holds no power.` and has
`🔍 Handover audit: every completion line against the state governance derives now (no snapshot, no voting window)`.
Its `⚠️` lines are of two kinds. Residual warnings, deployer-era facts,
change the last line to `⚠️  Audit passed with warnings: see above.`:
an attestor key the deployer trusted (one line per circuit), a node the
deployer registered, a current whitelist root published by anyone but
ops or governance, a node that is also an escrow fee wallet, an
`extraTrusted` acknowledgement, a config key set to `null`. Every other
warning is printed and leaves `✅ Audit passed: …` (section 4a's final
audit shows one): an address exempt from investor limits since before
the handover (`0x… is investorLimitExempt (set before the handover): …`),
the deployer's leftover VSC or exemption, the deployer's leftover VGT,
an escrow made before the handover that keeps the deployer as owner, an
escrow fee wallet that is not exempt (`escrow fee wallet 0x… (…) is not investorLimitExempt on the registry the Token enforces: …`)
or was registered after the handover,
`OracleManager has 0 registered nodes, below ConsensusOracle.MIN_NODES (2): …`,
a circuit with no trusted attestor (`PrivacyManager trusts no attestor for <circuit>: …`),
a list oracle a stranger nominated the deployer on, a list oracle not
created, named or bound that makes the deployer its listManager, a
capped list-oracle scan, and VSC holders not listed on the whitelist
oracle in Either mode.
The ceremony's completion line follows the same rule. Failing:
`❌ Handover failed: audit failed (see ❌ above)`. Before the ceremony:
`❌ Handover failed: HANDOVER_PHASE=audit: the ceremony has not completed: governance does not own Token, …; run the full phase (or HANDOVER_PHASE=accept) first`.
A list oracle the deployer owns fails it (`   ❌ the deployer still owns (or has pending by its own nomination) list oracle(s) 0x… serving OracleManager 0x…`);
a stranger's nomination of the deployer only warns. Repeat the scan
cross-check (section 5a, between votes) when you change RPC providers.

## 11. Recovery drills

KeyManager recovery on a drill identity, quarterly: demo option 12
rotates a key, then recovers with two agents, evicting a planted key and
moving the owner after 7 days. Local: reset.

```bash
reset   # local
npm run demo:drive -- --strict --timeout 1800 --log $RB/d12.log 1 21 51 12 0
```

The log shows `   ✅ executeKeyRecovery (receipt): 2 MANAGEMENT keys evicted`,
`   ✅ owner() = wallet 6 (investor Alice) 0x976EA74026E726554dB657fA54763abd0C3a0aa9`
and `✅ Key rotated; recovery evicted the rogue key and moved the owner`;
the drive ends `✓ demo ran to completion`. Publicly the option prints
when each timelock (24 h rotation, 48 h recovery, 7 days owner transfer)
is due; run it again then, in the same demo session.

A holder with no seated agents and a lost owner key: ops burns the
balance (`Token.burn(lostWallet, amount)`) and re-issues it to the new,
onboarded wallet (`Token.mint(newWallet, amount)`); no script yet.

## 12. Incident: pause and the voted unpause (D24, D56)

The guardian pauses VSC (`Token.pause()`); only governance unpauses it,
by a TokenParameters vote (option 76 builds none). A pause never expires
and the guardian can pause again (D56). Local: L0.

```bash
l0   # local
npx hardhat console --network $NET <<'EOF'
const fs = await import("fs"); const cfg = JSON.parse(fs.readFileSync(process.env.HANDOVER_CONFIG, "utf8")); const s = await ethers.getSigners(); const { proposeCall, castAcceptanceVotes, settleProposal } = await import("./demo/utils/HandoverVotes.js"); const g = await ethers.getContractAt("VanguardGovernance", cfg.governance, s[cfg.proposer]); const vsc = await ethers.getContractAt("Token", await g.boundTarget(3)); await (await vsc.connect(s[cfg.guardian]).pause()).wait(); console.log("VSC paused:", await vsc.paused()); const id = await proposeCall(g, s[cfg.proposer], 3, vsc, vsc.interface.encodeFunctionData("unpause"), "Unpause VSC", "runbook 12"); await castAcceptanceVotes(g, id, cfg.voters.map((v) => s[v])); await settleProposal(g, id, "unpause VSC"); console.log("VSC paused:", await vsc.paused());
EOF
```

It prints `VSC paused: true`, `   ⏩ unpause VSC: voting period + execution delay: jumped 656s (dev node)`
and `VSC paused: false`; publicly `settleProposal` waits and the
guardian's pause is a transaction of the guardian Safe.

- VGT: a pause by vote is released by ops (VGT agent) with `unpause()`,
  no vote (D24 a); to hold against ops, remove ops as a VGT agent in the
  same pre-voted batch.
- A misbehaving node: ops pauses it (`pauseOracle`, 35a), governance
  removes it (section 4, under its standing hazard). A failing oracle:
  rebind or pause; never unbind.
