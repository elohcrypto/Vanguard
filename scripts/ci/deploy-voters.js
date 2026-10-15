/**
 * Voter registration for the CI deploy drive (plan v2 Task 5.7; runbook
 * section 3, D25), on the deploy scripts/production/DeployProduction.ts
 * recorded: the handover.json's proposer and voters become verified
 * identities through the demo's one onboarding path (demo/utils/
 * Onboard.js), the deployer mints each 1,000 VGT (it is a VGT agent until
 * the ceremony), and a dev node's clock passes governance.minVoterAge.
 *
 *   DEPLOY_RECORD=<record> HANDOVER_CONFIG=<handover.json> \
 *     npx hardhat run scripts/ci/deploy-voters.js --network remote
 */
const fs = require("fs");
const { ethers, network } = require("hardhat");
const DemoState = require("../../demo/core/DemoState");
const { onboard } = require("../../demo/utils/Onboard");

const ARTIFACT = {
  onchainIDFactory: "OnchainIDFactory",
  identityRegistry: "IdentityRegistry",
  kycIssuer: "ClaimIssuer",
  amlIssuer: "ClaimIssuer",
  complianceRules: "ComplianceRules",
  digitalToken: "Token",
  governanceToken: "GovernanceToken",
  vanguardGovernance: "VanguardGovernance",
};

async function main() {
  const rec = JSON.parse(fs.readFileSync(process.env.DEPLOY_RECORD, "utf8"));
  const cfg = JSON.parse(fs.readFileSync(process.env.HANDOVER_CONFIG, "utf8"));
  if (!rec.complete) throw new Error("the deploy record is not complete");
  if (![31337, 1337].includes(rec.chainId)) {
    throw new Error(`a dev-node drive; chain ${rec.chainId} refused`);
  }
  const state = new DemoState();
  state.signers = await ethers.getSigners();
  for (const [k, name] of Object.entries(ARTIFACT)) {
    state.setContract(k, await ethers.getContractAt(name, rec.contracts[k]));
  }
  const vgt = state.getContract("governanceToken");
  for (const i of [cfg.proposer, ...cfg.voters]) {
    const w = state.signers[i].address;
    const r = await onboard(state, w, { label: `voter ${i}` });
    if (!r.verified) throw new Error(`wallet ${i} ${w} did not verify`);
    await (await vgt.mint(w, ethers.parseEther("1000"))).wait();
    console.log(`   ✅ wallet ${i} ${w}: verified, 1,000 VGT`);
  }
  const gov = state.getContract("vanguardGovernance");
  const age = Number(await gov.minVoterAge()) + 1;
  await network.provider.send("evm_increaseTime", [age]);
  await network.provider.send("evm_mine", []);
  console.log(`✅ voters registered; clock moved ${age}s past minVoterAge`);
}

main().catch((e) => {
  console.error(`❌ ${e.message}`);
  process.exitCode = 1;
});
