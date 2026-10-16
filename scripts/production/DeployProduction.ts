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
 *
 * Task 5.13: with ops external (a multisig; deployConfig.ts) the deploy
 * sends the custody nomination, then exports ops's acceptOwnership as a
 * Safe batch (deployments/<chainId>.ops-transactions.json), halts the
 * record (nothing more is sent) and exits 3. A re-run replays the record
 * and checks the effect on chain (owner ops, no pending owner): it
 * continues, pauses again while the call is not executed, or refuses
 * another effect. Only the deployer's transactions are recorded, so the
 * record's nonce rule holds across the pause.
 */
import * as fs from "fs";
import { ethers, network } from "hardhat";
import {
  DeployInputs,
  refuseLocalKeys,
  refuseTimeScale,
  resolveInputs,
} from "./deployConfig";
import { Recorder } from "./deployRecord";
import {
  DeployRecord,
  loadRecord,
  lockRecord,
  recordPath,
  saveRecord,
} from "./deployRecordFile";
import {
  handoverConfig,
  preflightHandover,
  probeLogChunk,
  writeHandoverConfig,
} from "./deployHandover";
import { configureKeyManager } from "./opsKeyManager";

const DemoState = require("../../demo/core/DemoState");
const {
  acceptStatus,
  externalRole,
  requireEffects,
  vetRole,
} = require("../../demo/utils/RoleCalls");
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
async function deployStack(
  inputs: DeployInputs,
  salt: string,
  roles: unknown,
): Promise<any> {
  const state = new DemoState();
  state.production = {
    roles,
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
  const raw = JSON.parse(fs.readFileSync(cfgFile, "utf8"));
  // Task 5.13: a role address with code is external; a default (a wallet
  // index) with code is refused (review LOW-2).
  const coded = new Set<string>();
  const candidates = ["ops", "issuerAdmin", "guardian"].map((k) => raw[k]);
  for (const a of [...candidates, ...accounts]) {
    if (ethers.isAddress(a) && (await ethers.provider.getCode(a)) !== "0x")
      coded.add(String(a).toLowerCase());
  }
  const inputs = resolveInputs(raw, chainId, accounts, coded);
  console.log(
    `🚀 Production deploy on ${network.name} (chain ${chainId}) from ${inputs.deployer}`,
  );
  console.log(
    `   ops ${inputs.ops}, guardian ${inputs.guardian}, issuer admin ${inputs.issuerAdmin}`,
  );
  console.log(
    `   nodes (D50) ${inputs.oracleNodes.join(", ")}; operator (D47) ops`,
  );
  await vetExternalRoles(inputs);
  console.log(
    `   lock amounts (D45) ${inputs.lockAmounts ? inputs.lockAmounts.map((x) => ethers.formatEther(x)).join(" / ") + " VSC" : "default: cap/4, cap/2, cap"}`,
  );

  const file = recordPath(chainId);
  const release = lockRecord(file);
  try {
    await deployOn(file, inputs, accounts, chainId);
  } finally {
    release();
  }
}

/** The deploy on the locked record `file`, then handover.json. */
async function deployOn(
  file: string,
  inputs: DeployInputs,
  accounts: string[],
  chainId: number,
): Promise<void> {
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
  const roles = rolePause(inputs, file, recorder);
  recorder.refuseFrom(
    Object.fromEntries(inputs.external.map((k) => [k, (inputs as any)[k]])),
  );
  let state: any;
  try {
    state = await deployStack(inputs, rec.salt, roles);
    await configureKeyManager(
      state.getContract("keyManager"),
      { address: inputs.deployer },
      process.env.OPS_IDENTITY,
      {},
    );
    await recorder.finish();
  } catch (e) {
    if (!roles.stop) throw e;
    await recorder.confirmLast(); // the nomination's receipt, then stop
    throw roles.stop;
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

/**
 * Task 5.13 (review LOW-5): one line per external role; refused when the
 * deployer owns the ops or issuer-admin multisig (RoleCalls.vetRole).
 */
export async function vetExternalRoles(
  inputs: DeployInputs,
  log: (m: string) => void = console.log,
): Promise<void> {
  for (const k of inputs.external) {
    const a = (inputs as any)[k];
    await vetRole(externalRole(a, k), inputs.deployer, log);
  }
}

/**
 * Task 5.13: the external ops's custody acceptance (CustodyFlow.js), as
 * a role step: done, exported (pause, exit 3) or refused, never sent.
 */
export function rolePause(
  inputs: DeployInputs,
  file: string,
  recorder: Recorder,
) {
  const base = file.replace(/\.json$/, "");
  const roles = {
    stop: null as Error | null,
    isExternal: (a: string) =>
      inputs.external.some(
        (k) => (inputs as any)[k].toLowerCase() === a.toLowerCase(),
      ),
    acceptCustody: async (m: any) => {
      const step = {
        id: "deploy.custody.accept",
        role: externalRole(inputs.ops, "ops"),
        roleLabel: "ops",
        contract: m,
        name: "InvestorRequestManager",
        fn: "acceptOwnership",
        args: [],
        purpose:
          "ops takes the custody manager the deployer nominated it for, before the manager gains any power (Task 4.3 L1, Q7)",
        status: () => acceptStatus(m, inputs.deployer, inputs.ops, "ops"),
      };
      const fresh = !fs.existsSync(`${base}.ops-transactions.json`);
      try {
        await requireEffects([step], base, "Vanguard deploy", { fresh });
      } catch (e) {
        roles.stop = e as Error;
        recorder.halt(e as Error); // nothing is sent after the pause
        throw e;
      }
    },
  };
  return roles;
}

if (require.main === module) {
  main().catch((e) => {
    if (e.name === "RoleCallsPending") {
      // Task 5.13: paused, not done (exit 3).
      console.log(e.lines.join("\n"));
      console.log(
        "   execute it in the multisig, then run the deploy again: it checks the effect on chain and continues",
      );
      process.exitCode = 3;
      return;
    }
    console.error(`❌ Deploy failed: ${e.message}`);
    process.exitCode = 1;
  });
}
