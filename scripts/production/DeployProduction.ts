/**
 * Production deploy (plan v2 Task 5.7, D48 a): the whole system from an
 * external signer, recorded as it goes, then the ceremony's handover.json
 * and its preflight.
 *
 *   SIGNER_RPC_URL=http://127.0.0.1:1248 DEPLOY_CONFIG=deploy.json \
 *     npx hardhat run scripts/production/DeployProduction.ts --network remote
 *
 * No private key lives in this process: the `remote` network (accounts
 * "remote") sends every transaction to the signer endpoint (Frame style:
 * it holds the keys, signs and forwards), and PRIVATE_KEY / MNEMONIC or a
 * network with local accounts are refused off a local dev chain
 * (deployConfig.ts). The deploy is demo option 1a's flows, unchanged
 * (demo/core/ContractDeployer.js deployEverything: identity layer and
 * privacy pair, VSC with ComplianceRules, the oracle system, the investor
 * type registry with custody, governance), then option 61's escrow
 * factory; the config's roles reach them
 * as the wallets of docs/TESTNET_SETUP.md (DemoState.production carries
 * the attestor key and the D45 lock amounts). Every transaction goes to
 * deployments/<chainId>.json before the next one; a re-run replays the
 * record and sends only what is missing (deployRecord.ts). Then:
 * KeyManager on the ops identity (opsKeyManager.ts), handover.json
 * (HANDOVER_CONFIG, default deployments/<chainId>.handover.json) and the
 * ceremony's preflight on it (deployHandover.ts).
 *
 * Unsigned-transaction files for an air-gapped or KMS signer: not built
 * (Task 5.7 builds the remote JSON-RPC signer first).
 */
import * as fs from "fs";
import { ethers, network } from "hardhat";
import {
  DeployInputs,
  refuseLocalKeys,
  refuseTimeScale,
  resolveInputs,
} from "./deployConfig";
import {
  DeployRecord,
  loadRecord,
  Recorder,
  recordPath,
  saveRecord,
} from "./deployRecord";
import {
  handoverConfig,
  preflightHandover,
  probeLogChunk,
  writeHandoverConfig,
} from "./deployHandover";
import { configureKeyManager } from "./opsKeyManager";

const DemoState = require("../../demo/core/DemoState");
const ContractDeployer = require("../../demo/core/ContractDeployer");
const InvestorTypeModule = require("../../demo/modules/InvestorTypeModule");
const GovernanceModule = require("../../demo/modules/GovernanceModule");
const EscrowModule = require("../../demo/modules/EscrowModule");
const { EnhancedLogger } = require("../../demo/logging");

/** What a complete deploy holds (DemoState keys). */
const EXPECTED = [
  "onchainIDFactory",
  "kycIssuer",
  "amlIssuer",
  "keyManager",
  "identityRegistry",
  "zkVerifierIntegrated",
  "privacyManager",
  "complianceRules",
  "digitalToken",
  "oracleManager",
  "whitelistOracle",
  "blacklistOracle",
  "consensusOracle",
  "investorTypeRegistry",
  "investorRequestManager",
  "governanceToken",
  "vanguardGovernance",
  "escrowFactory",
];

/** Demo option 1a for `inputs`, roles at their TESTNET_SETUP wallets. */
async function deployStack(inputs: DeployInputs, salt: string): Promise<any> {
  const state = new DemoState();
  state.production = {
    attestor: inputs.attestor,
    lockRequirements: inputs.lockAmounts,
    escrowFeeWallet: await ethers.getSigner(inputs.escrowFeeWallet),
    identitySalt: (wallet: string) =>
      ethers.solidityPackedKeccak256(["bytes32", "address"], [salt, wallet]),
  };
  const at = (a: string) => ethers.getSigner(a);
  state.signers = new Array(12);
  state.signers[0] = await at(inputs.deployer);
  for (const [i, a] of inputs.oracleNodes.entries()) {
    state.signers[i + 1] = await at(a);
  }
  state.signers[9] = await at(inputs.issuerAdmin);
  state.signers[10] = await at(inputs.ops);
  state.signers[11] = await at(inputs.guardian);
  const logger = new EnhancedLogger();
  const ask = async (q: string) => {
    throw new Error(`the production deploy asks nothing (prompted: ${q})`);
  };
  const deployer = new ContractDeployer(state, logger);
  const ok = await deployer.deployEverything({
    investorType: new InvestorTypeModule(state, logger, ask),
    governance: new GovernanceModule(state, logger, ask),
  });
  // Option 61 after 74, as the escrowdlm drive: the escrow factory, a
  // ComplianceRules registrar on VSC; the ceremony hands it over by vote.
  if (ok) await new EscrowModule(state, logger, ask).deployEscrowSystem();
  const missing = EXPECTED.filter((k) => !state.getContract(k));
  if (!ok || missing.length) {
    throw new Error(
      `the deploy stopped${missing.length ? `; missing: ${missing.join(", ")}` : ""} (see above)`,
    );
  }
  return state;
}

async function main(): Promise<void> {
  const accountsCfg = (network.config as any).accounts;
  refuseLocalKeys({
    network: network.name,
    accounts: accountsCfg,
    env: process.env,
  });
  const chainId = Number(
    await network.provider.request({ method: "eth_chainId" }),
  );
  refuseLocalKeys({
    network: network.name,
    chainId,
    accounts: accountsCfg,
    env: process.env,
  });
  refuseTimeScale(chainId, process.env);
  const cfgFile = process.env.DEPLOY_CONFIG;
  if (!cfgFile) throw new Error("set DEPLOY_CONFIG to the deploy config JSON");
  const accounts = (await network.provider.request({
    method: "eth_accounts",
  })) as string[];
  const inputs = resolveInputs(
    JSON.parse(fs.readFileSync(cfgFile, "utf8")),
    chainId,
    accounts,
  );
  console.log(
    `🚀 Production deploy on ${network.name} (chain ${chainId}) from ${inputs.deployer}`,
  );
  console.log(
    `   ops ${inputs.ops}, guardian ${inputs.guardian}, issuer admin ${inputs.issuerAdmin}`,
  );
  console.log(
    `   nodes (D50) ${inputs.oracleNodes.join(", ")}; operator (D47) ops`,
  );
  console.log(
    `   lock amounts (D45) ${inputs.lockAmounts ? inputs.lockAmounts.map((x) => ethers.formatEther(x)).join(" / ") + " VSC" : "default: cap/4, cap/2, cap"}`,
  );

  const file = recordPath(chainId);
  let rec = loadRecord(file);
  if (rec && rec.configDigest !== inputs.digest) {
    throw new Error(
      `${file} was made with another config (digest ${rec.configDigest}); refusing to resume with this one`,
    );
  }
  if (rec && rec.deployer.toLowerCase() !== inputs.deployer.toLowerCase()) {
    throw new Error(
      `${file} was made by deployer ${rec.deployer}, not ${inputs.deployer}`,
    );
  }
  if (!rec) {
    const created: DeployRecord = {
      version: 1,
      chainId,
      configDigest: inputs.digest,
      deployer: inputs.deployer,
      fromBlock: await ethers.provider.getBlockNumber(),
      salt: ethers.hexlify(ethers.randomBytes(32)),
      txs: [],
      contracts: {},
      complete: false,
    };
    saveRecord(file, created);
    rec = created;
    console.log(
      `📒 New record ${file} (scans start at block ${rec.fromBlock})`,
    );
  } else {
    console.log(
      `📒 Resuming from ${file}: ${rec.txs.length} recorded transactions`,
    );
  }
  const recorder = new Recorder(file, rec, inputs.confirmations);
  await recorder.install();
  let state: any;
  try {
    state = await deployStack(inputs, rec.salt);
    await configureKeyManager(
      state.getContract("keyManager"),
      { address: inputs.deployer },
      process.env.OPS_IDENTITY,
      {},
    );
    await recorder.finish();
  } finally {
    recorder.remove();
  }
  for (const k of EXPECTED)
    rec.contracts[k] = await state.getContract(k).getAddress();
  rec.complete = true;
  saveRecord(file, rec);
  const gas = rec.txs.reduce((t, e) => t + BigInt(e.gasUsed ?? 0), 0n);
  console.log(
    `\n✅ Deployed: ${rec.txs.length} transactions in ${file} (${recorder.reused} from the record, ${recorder.sent} sent now; ${gas.toLocaleString("en-US")} gas)`,
  );

  const out =
    process.env.HANDOVER_CONFIG || file.replace(/\.json$/, ".handover.json");
  const logChunk =
    inputs.logChunk ?? (await probeLogChunk(rec.contracts.vanguardGovernance));
  writeHandoverConfig(
    out,
    handoverConfig(inputs, rec.contracts, accounts, rec.fromBlock, logChunk),
  );
  console.log(`📝 handover.json: ${out} (logChunk ${logChunk})`);
  await preflightHandover(out);
}

if (require.main === module) {
  main().catch((e) => {
    console.error(`❌ Deploy failed: ${e.message}`);
    process.exitCode = 1;
  });
}
