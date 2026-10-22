import { ethers } from "hardhat";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { Recorder } from "../../scripts/production/deployRecord";
import {
  DeployRecord,
  saveRecord,
} from "../../scripts/production/deployRecordFile";

/**
 * Plan v2 Task 5.7: a small deploy flow and the record around it, shared
 * by the deploy record tests (DeployRecord, DeployRecordResume,
 * DeployFrontRun). `files()` registers the hooks: a fresh record path per
 * test in a temporary directory.
 */
export const AGENT = "0x000000000000000000000000000000000000a11c";
const quiet = () => {};

export function files(): { readonly file: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "deploy-record-"));
  let n = 0;
  const box = { file: "" };
  beforeEach(function () {
    box.file = path.join(dir, `${++n}.json`);
  });
  after(function () {
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return box;
}

/** A new record at `file` for the in-process chain's first signer. */
export async function fresh(file: string): Promise<DeployRecord> {
  const [d] = await ethers.getSigners();
  const rec: DeployRecord = {
    version: 1,
    chainId: 31337,
    configDigest: "test",
    deployer: d.address,
    startNonce: await ethers.provider.getTransactionCount(d.address),
    fromBlock: await ethers.provider.getBlockNumber(),
    salt: ethers.ZeroHash,
    txs: [],
    contracts: {},
    complete: false,
  };
  saveRecord(file, rec);
  return rec;
}

/** Two deploys and two calls, one behind a read; stops after `stop` sends. */
export async function flow(stop = Infinity, agent = AGENT) {
  let sends = 0;
  const tick = () => {
    if (++sends >= stop) throw new Error("killed");
  };
  const ir = await (
    await ethers.getContractFactory("IdentityRegistry")
  ).deploy();
  await ir.waitForDeployment();
  tick();
  if (!(await ir.isAgent(agent))) {
    await (await ir.addAgent(agent)).wait();
    tick();
  }
  const km = await (await ethers.getContractFactory("KeyManager")).deploy();
  await km.waitForDeployment();
  tick();
  await (await ir.addAgent(await km.getAddress())).wait();
  tick();
  return { ir: await ir.getAddress(), km: await km.getAddress() };
}

/** `f` under a Recorder on `file`; the hook is always removed. */
export async function run(
  file: string,
  rec: DeployRecord,
  f: () => Promise<any>,
) {
  const r = new Recorder(file, rec, 1, quiet);
  await r.install();
  try {
    const out = await f();
    await r.finish();
    return { r, out };
  } finally {
    r.remove();
  }
}

/** Install a Recorder on `file` and remove it: the record settled. */
export async function settle(file: string, rec: DeployRecord): Promise<void> {
  const r = new Recorder(file, rec, 1, quiet);
  await r.install();
  r.remove();
}

export const nonce = async (i = 0) =>
  ethers.provider.getTransactionCount((await ethers.getSigners())[i]);
