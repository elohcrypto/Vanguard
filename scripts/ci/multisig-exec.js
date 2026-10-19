/**
 * The CI stand-in for a multisig's owners (plan v2 Task 5.13, Q11 = B):
 * a process of its own, signing through scripts/ci/remote-signer.js. The
 * multisig is contracts/test/mocks/TestMultisig.sol, not the production
 * recommendation (use a Safe).
 *
 *   MULTISIG_OWNERS=10,12 npx hardhat run scripts/ci/multisig-exec.js --network remote
 *     deploys a 2-of-2 TestMultisig owned by those wallets; prints
 *     "multisig <address>"
 *   BATCH=<file> MULTISIG_OWNERS=10,12 npx hardhat run ... --network remote
 *     reads the Safe Transaction Builder batch as Safe's import does
 *     (demo/utils/RoleCalls.js batchProblems: types, string values,
 *     checksum) on its chain, then both owners approve its calls and the
 *     first executes them on the multisig the file names
 *     (meta.createdFromSafeAddress); prints "executed <n> calls"
 */
const fs = require("fs");
const { scrubKnown } = require("../production/redact");
const { ethers } = require("hardhat");
const { batchProblems } = require("../../demo/utils/RoleCalls");

async function main() {
  const signers = await ethers.getSigners();
  const owners = String(process.env.MULTISIG_OWNERS || "")
    .split(",")
    .map((i) => signers[Number(i)]);
  if (owners.length !== 2 || owners.some((o) => !o))
    throw new Error("set MULTISIG_OWNERS to two wallet indices");
  if (!process.env.BATCH) {
    const f = await ethers.getContractFactory("TestMultisig", owners[0]);
    const ms = await f.deploy(
      owners.map((o) => o.address),
      2,
    );
    await ms.waitForDeployment();
    console.log(`multisig ${await ms.getAddress()}`);
    return;
  }
  const batch = JSON.parse(fs.readFileSync(process.env.BATCH, "utf8"));
  const problems = batchProblems(batch);
  if (problems.length) throw new Error(`batch refused: ${problems.join("; ")}`);
  const chainId = String((await ethers.provider.getNetwork()).chainId);
  if (batch.chainId !== chainId)
    throw new Error(`batch for chain ${batch.chainId}, not ${chainId}`);
  const ms = await ethers.getContractAt(
    "TestMultisig",
    batch.meta.createdFromSafeAddress,
  );
  const calls = batch.transactions.map((t) => ({
    to: t.to,
    value: t.value,
    data: t.data,
  }));
  const hash = await ms.hashOf(calls);
  for (const o of owners) await (await ms.connect(o).approve(hash)).wait();
  await (await ms.connect(owners[0]).execute(calls)).wait();
  console.log(`executed ${calls.length} calls on ${await ms.getAddress()}`);
}

main().catch((e) => {
  console.error(`❌ ${scrubKnown(e.message)}`);
  process.exitCode = 1;
});
