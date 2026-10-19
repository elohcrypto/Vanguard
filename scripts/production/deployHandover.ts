/**
 * Plan v2 Task 5.7: the handover.json a production deploy writes for the
 * ceremony (scripts/handover.ts), and the preflight run on it.
 *
 * Roles are wallet indices of the external signer's accounts (the CLI
 * reads them that way), each pinned to its address in "accounts" (deep
 * review M-2, walletPins.ts); an external role (Task 5.13, a multisig) is its
 * address, which the CLI reads as external; fromBlock is the block before the deploy's first
 * transaction (the record keeps it from the first run); logChunk is the
 * largest eth_getLogs range the provider serves, unless the config sets
 * it. The contracts governance cannot derive before the ceremony binds
 * them are named (R-413-2): the OnchainIDFactory, the privacy pair and the
 * escrow factory by address, and both list oracles (Task 5.14: the
 * whitelist oracle is unbound until a vote binds it, D47, and still goes
 * to ops). The acknowledgements are what the deploy
 * itself created: the D50 nodes, the attestor key it trusted (R-413-9)
 * and the escrow factory's fee wallet (D54). An existing file with other
 * content is never overwritten.
 */
import * as fs from "fs";
import { ethers } from "hardhat";
import { runHandover } from "../handover";
import type { DeployInputs } from "./deployConfig";
import { pinsFor } from "./walletPins";

const CHUNKS = [10000, 5000, 2000, 1000, 500, 100];
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** The largest range in CHUNKS the provider answers eth_getLogs over. */
export async function probeLogChunk(address: string): Promise<number> {
  const head = await ethers.provider.getBlockNumber();
  const refusals: string[] = [];
  for (const n of CHUNKS) {
    const range = {
      address,
      fromBlock: ethers.toQuantity(Math.max(0, head - n + 1)),
      toBlock: ethers.toQuantity(head),
    };
    try {
      await ethers.provider.send("eth_getLogs", [range]);
      return n;
    } catch (e) {
      refusals.push(`${n}: ${(e as Error).message.split("\n")[0]}`);
    }
  }
  throw new Error(
    `the provider refuses eth_getLogs over every range down to 100 blocks (${refusals.join("; ")}); set "logChunk" in the deploy config`,
  );
}

/** handover.json for the deployed `contracts` (state key -> address). */
export function handoverConfig(
  inputs: DeployInputs,
  contracts: Record<string, string>,
  accounts: string[],
  fromBlock: number,
  logChunk: number,
): Record<string, unknown> {
  const ix = (a: string) => {
    const i = accounts.findIndex((x) => same(x, a));
    if (i < 0) throw new Error(`${a} is not an account of the signer`);
    return i;
  };
  if (ix(inputs.deployer) !== 0) {
    throw new Error("the deployer must be the signer's first account");
  }
  const role = (k: "ops" | "guardian" | "issuerAdmin") =>
    inputs.external.includes(k) ? inputs[k] : ix(inputs[k]);
  const indices = {
    ops: role("ops"),
    guardian: role("guardian"),
    issuerAdmin: role("issuerAdmin"),
    proposer: ix(inputs.proposer),
    voters: inputs.voters.map(ix),
  };
  return {
    governance: contracts.vanguardGovernance,
    ...indices,
    // Deep review M-2: every index above pinned to its address.
    accounts: pinsFor(indices, accounts),
    fromBlock,
    logChunk,
    onchainIDFactory: contracts.onchainIDFactory,
    privacyManager: contracts.privacyManager,
    zkVerifier: contracts.zkVerifierIntegrated,
    escrowWalletFactory: contracts.escrowFactory,
    oracles: [contracts.whitelistOracle, contracts.blacklistOracle].filter(
      Boolean,
    ),
    oracleNodes: inputs.oracleNodes,
    attestors: [inputs.attestor.Ax],
    extraTrusted: [],
    // The escrow factory's owner fee wallet, acknowledged (D54).
    feeWallets: [inputs.escrowFeeWallet],
  };
}

/**
 * Write `cfg` to `file` (temp file, rename), unless a file with other
 * content is already there: that is the operator's, and is refused.
 */
export function writeHandoverConfig(
  file: string,
  cfg: Record<string, unknown>,
): void {
  const text = JSON.stringify(cfg, null, 2) + "\n";
  if (fs.existsSync(file)) {
    if (fs.readFileSync(file, "utf8") === text) return;
    throw new Error(
      `${file} exists with other content; the deploy does not overwrite it: move it away or set HANDOVER_CONFIG`,
    );
  }
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, text, { flag: "wx" });
  fs.renameSync(tmp, file);
}

/** The ceremony's preflight on the written file (HANDOVER_PHASE=preflight). */
export async function preflightHandover(file: string): Promise<void> {
  console.log(
    `\n🔍 Preflight (scripts/handover.ts, HANDOVER_PHASE=preflight) on ${file}`,
  );
  await runHandover(
    JSON.parse(fs.readFileSync(file, "utf8")),
    "preflight",
    file,
  );
}
