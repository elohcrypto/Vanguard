/**
 * Deploys the handover fixture (test/helpers/governanceFixture.ts) on the
 * network `hardhat run` is pointed at and writes a handover.json for
 * scripts/handover.ts that names only the allowed keys (plan v2 Task
 * 4.13): governance, the wallet indices (pinned to their addresses,
 * Task 5.17) and the empty acknowledgement
 * lists. The four contracts governance cannot derive before step 3 are
 * nominated and bound first, as a deployer rehearsing on a dev node
 * would, so the config need not name them. Driven by
 * test/production/HandoverCliNode.test.ts:
 *
 *   DEMO_RPC_URL=http://127.0.0.1:8547 HANDOVER_FIXTURE_OUT=/tmp/h.json \
 *     npx hardhat run test/production/deployHandoverFixture.ts --network devnode
 */
import * as fs from "fs";
import { ethers } from "hardhat";
import { handoverFixture } from "../helpers/governanceFixture";
import { pinsFor } from "../../scripts/production/walletPins";

async function main(): Promise<void> {
  const out = process.env.HANDOVER_FIXTURE_OUT;
  if (!out)
    throw new Error("set HANDOVER_FIXTURE_OUT to the JSON path to write");
  const f = await handoverFixture();
  const { c, govAddr } = f;
  for (const [key, setter] of [
    ["escrowWalletFactory", "setEscrowWalletFactory"],
    ["onchainIDFactory", "setOnchainIDFactory"],
    ["privacyManager", "setPrivacyManager"],
    ["zkVerifier", "setZKVerifier"],
  ] as const) {
    await (await c[key].transferOwnership(govAddr)).wait();
    await (await c.governance[setter](await c[key].getAddress())).wait();
  }
  const cfg = {
    governance: govAddr,
    ops: 1,
    guardian: 2,
    issuerAdmin: 7,
    proposer: 4,
    voters: [5, 6],
    logChunk: 100,
    // The escrow factory's fee wallet, acknowledged (Task 4.17, D54).
    feeWallets: [f.feeWallet.address],
    oracleNodes: [],
    attestors: [],
    extraTrusted: [],
  };
  // Deep review M-2: every index pinned to the node's account there.
  const accounts = (await ethers.getSigners()).map((s) => s.address);
  fs.writeFileSync(
    out,
    JSON.stringify({ ...cfg, accounts: pinsFor(cfg, accounts) }, null, 2),
  );
  console.log(`handover fixture deployed; config written to ${out}`);
}

main().catch((e) => {
  console.error(`❌ ${e.message}`);
  process.exitCode = 1;
});
