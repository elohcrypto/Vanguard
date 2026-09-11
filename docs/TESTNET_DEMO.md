# Running the demo with real role wallets (local rehearsal and Sepolia)

The interactive demo was written against Hardhat's twenty pre-funded
accounts and its `evm_increaseTime` RPC. A public network has neither. This
document is the path from a local rehearsal that behaves like a testnet to
the testnet itself.

## Roles are wallet indices

One BIP-39 mnemonic in `.env`; Hardhat derives twelve keys at
`m/44'/60'/0'/0/N`. Index N is the same role on every network, so demo code
that reads `signers[2]` means "the KYC issuer" whether the node is local or
Sepolia. Each role signs only its own transactions; the contracts' 26 access
modifiers are what enforce the separation.

| Index | Role | Signs |
|---|---|---|
| 0 | Platform owner, deployer | deploys, agent grants, governance ownership |
| 1 | Fee wallet, compliance officer | investor-type assignments |
| 2 | KYC issuer | KYC claims, identity registration |
| 3 | AML issuer | AML claims |
| 4, 5 | Risk and fraud oracles | attestations |
| 6, 7, 8 | Investors Alice, Bob, Carol | proposals, votes, transfers, escrow parties |
| 9 | Deliberately unverified | rejection demonstrations |
| 10, 11 | Spare | |

```bash
cp .env.example .env
npx hardhat run scripts/print-role-wallets.js --network hardhat   # generates a phrase if MNEMONIC is empty
```

Put the phrase in `.env` as `MNEMONIC`. It is gitignored. Never commit it.

## Governance time scale

`VanguardGovernance` takes a `timeScale` constructor argument that divides
every voting period and execution delay. `1` is the mainnet schedule
(7-day votes); the ceiling is `1440`, at which the shortest duration in the
table (1 day) is still 60 s. The percentages are never scaled. The demo reads
`GOV_TIME_SCALE` from the environment at deploy time.

| GOV_TIME_SCALE | InvestorTypeConfig vote | delay | Use |
|---|---|---|---|
| 1 | 7 days | 2 days | mainnet, tests |
| 336 | 30 min | ~9 min | Sepolia walkthrough |
| 1440 | 7 min | 1 min | local rehearsal (the ceiling) |

## Waiting instead of jumping

The four demo paths that used to call `evm_increaseTime` (governance option
79, ownership-by-vote 83b, escrow 73a and 73b) now go through
`demo/utils/ChainTime.advancePast`. It reads the real deadline from the
chain, jumps if the node allows it, and otherwise polls until the deadline
has passed. The 13-of-14-day escrow demonstration is dev-node only and says
so on a network that cannot jump.

## Local rehearsal (do this before Sepolia)

```bash
MNEMONIC="<your phrase>" npx hardhat node          # funds the 12 role wallets
GOV_TIME_SCALE=1440 npm run demo:interactive:proof   # in another terminal
```

Then walk: 1 (deploy), 74 (governance), 75 (distribute VGT to 6-8), 76
(Alice proposes), 77 (Bob and Carol vote), 79 (wait ~8 min), 78 (execute),
78a (claim on a rejected one). Every action is signed by its role's key.

Rehearsed on 2026-09-11 with the poll branch forced at a since-removed
scale of 10080: a 60-second vote plus 17-second delay waited 78 seconds of
real time and executed. The ceiling was then lowered to 1440 because at
10080 the one-day delay was 8 s, below a public chain's block time. The
unverified wallet at index 9 was rejected by `createProposal` from its own
key.

## Sepolia

1. `SEPOLIA_RPC_URL` in `.env` (Alchemy or Infura free tier).
2. Fund index 0 with ~0.3 ETH and indices 1 to 9 with ~0.02 each from a
   faucet. `print-role-wallets.js --network sepolia` shows balances.
3. `GOV_TIME_SCALE=336 npx hardhat run demo/index.js --network sepolia`.
4. Same menu walk. Option 79 waits about 40 minutes of real time.

Deploying all eleven contracts costs under 0.01 ETH at 1.3 gwei.
