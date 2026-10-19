/**
 * Voter registration for the CI drives and the local rehearsal (plan v2
 * Task 5.7; runbook section 3, D25): the production CLI
 * (scripts/production/onboardVoters.ts, any chain, no clock jump), then a
 * dev node's clock moved past the youngest voter's minVoterAge. The jump
 * is the only dev-node part, so this refuses chains other than 31337; on
 * a public chain run the production CLI and wait the time it prints.
 *
 *   DEPLOY_RECORD=<record> HANDOVER_CONFIG=<handover.json> \
 *     npx hardhat run scripts/ci/deploy-voters.js --network remote
 */
const fs = require("fs");
const { scrubKnown } = require("../production/redact");
const { ethers, network } = require("hardhat");
const { onboardVoters } = require("../production/onboardVoters");
const { installRetry } = require("../../demo/utils/RpcRetry");

async function main() {
  installRetry(network.provider);
  const chain = Number((await ethers.provider.getNetwork()).chainId);
  if (chain !== 31337) {
    throw new Error(
      `a dev-node drive; chain ${chain} refused (use scripts/production/onboardVoters.ts)`,
    );
  }
  const read = (k) => JSON.parse(fs.readFileSync(process.env[k], "utf8"));
  const last = await onboardVoters(
    read("DEPLOY_RECORD"),
    read("HANDOVER_CONFIG"),
  );
  const now = (await ethers.provider.getBlock("latest")).timestamp;
  const age = Math.max(0, last - now) + 1;
  await network.provider.send("evm_increaseTime", [age]);
  await network.provider.send("evm_mine", []);
  console.log(
    `✅ dev node: clock moved ${age}s, past every voter's minVoterAge`,
  );
}

main().catch((e) => {
  console.error(`❌ ${scrubKnown(e.message)}`);
  process.exitCode = 1;
});
