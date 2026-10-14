import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { handoverFixture } from "./governanceFixture";

const {
  proposeCall,
  castAcceptanceVotes,
  settleProposal,
} = require("../../demo/utils/HandoverVotes");

type Fixture = Awaited<ReturnType<typeof handoverFixture>>;

/**
 * Plan v2 Task 5.6b: the handover.json scripts/handover.ts reads for a
 * handoverFixture (signer order from the fixture), and a fresh config
 * path in its own tempdir (the full phase writes the snapshot beside it).
 */
export async function cliConfig(f: Fixture) {
  const a = async (k: string) => f.c[k].getAddress();
  const cfg: Record<string, any> = {
    governance: f.govAddr,
    escrowWalletFactory: await a("escrowWalletFactory"),
    onchainIDFactory: await a("onchainIDFactory"),
    privacyManager: await a("privacyManager"),
    zkVerifier: await a("zkVerifier"),
    oracles: [await f.args.oracles[0].getAddress()],
    issuers: [await f.args.issuers[0].getAddress()],
    fromBlock: f.args.fromBlock,
    logChunk: 100,
    feeWallets: [f.feeWallet.address],
    ops: 1,
    guardian: 2,
    issuerAdmin: 7,
    proposer: 4,
    voters: [5, 6],
  };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "h56b-"));
  return { cfg, cfgPath: path.join(dir, "handover.json"), dir };
}

/**
 * One vote after the ceremony: the fixture's proposer proposes, both
 * voters vote, `executor` (default the proposer) executes.
 */
export async function byVote(
  f: Fixture,
  type: number,
  target: any,
  callData: string,
  executor: any = f.proposer,
) {
  const g = f.c.governance;
  const id = await proposeCall(
    g,
    f.proposer,
    type,
    target,
    callData,
    `5.6b test #${type}`,
    "5.6b test",
  );
  await castAcceptanceVotes(g, id, f.voters);
  await settleProposal(g.connect(executor), id);
  return id;
}

/** console.log captured into `out` while `fn` runs. */
export async function captured<T>(out: string[], fn: () => Promise<T>) {
  const quiet = console.log;
  console.log = (m: string) => out.push(String(m));
  try {
    return await fn();
  } finally {
    console.log = quiet;
  }
}
