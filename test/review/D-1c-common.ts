// Shared by the D-1c tests (round 3 of review D-1): the attack lane's
// Safe lookalike (Attack2Safe) as the guardian, read by the vet and by
// the preflight with no config vet (as demo option 83c runs it).
import { ethers } from "hardhat";
import { cliConfig } from "../helpers/handoverCli";
import * as h from "./D-1b-common";

const { vetRole, externalRole } = require("../../demo/utils/RoleCalls");

/** Read modes per getOwners, getThreshold, getModulesPaginated (Attack2Safe). */
export const OK = 0;
export const EMPTY_REVERT = 1;
export const CUSTOM_ERROR = 2;
export const NO_DATA = 4;

/** An Attack2Safe with `owners`, `threshold`, `modules` (list order) and read `modes`. */
export async function lookalike(
  owners: string[],
  threshold: number,
  modules: string[] = [],
  modes: [number, number, number] = [OK, OK, OK],
) {
  const x: any = await (
    await ethers.getContractFactory("Attack2Safe")
  ).deploy(owners, threshold);
  if (modules.length) await (await x.setModules(modules)).wait();
  if (modes.some((m) => m !== OK)) await (await x.setModes(...modes)).wait();
  return { x, at: (await x.getAddress()) as string };
}

/** A TestMultisig (the honest Safe stand-in), 1 of `owners`. */
export async function multisig(owners: string[]) {
  const MS = await ethers.getContractFactory("TestMultisig");
  return (await (await MS.deploy(owners, 1)).getAddress()) as string;
}

/** `n` fresh addresses (module stand-ins). */
export const strangers = (n: number) =>
  Array.from({ length: n }, () => ethers.Wallet.createRandom().address);

/** The vet's verdict ("accepted" or its refusal) and what it logged, `a` the guardian. */
export async function vet(a: string, d: string) {
  const logs: string[] = [];
  const words = await vetRole(externalRole(a, "guardian"), d, (m: string) =>
    logs.push(m),
  ).then(
    () => "accepted",
    (e: any) => e.message,
  );
  return { words, logs };
}

/** The vet's words and the preflight's run with `a` the guardian (no config vet). */
export async function vetAndPreflight(f: any, a: string) {
  const { words, logs } = await vet(a, f.deployer.address);
  const { cfg, cfgPath } = await cliConfig(f);
  const pre = await h.preflightAs(cfg, cfgPath, a);
  return { words, logs, pre };
}

/** [name, text the verdict must carry, the error]. */
export const faults: [string, string, () => any][] = [
  [
    "missing trie node (UNKNOWN_ERROR)",
    "execution reverted: missing trie node",
    () =>
      ethers.makeError("could not coalesce error", "UNKNOWN_ERROR", {
        error: {
          code: -32000,
          message: "execution reverted: missing trie node",
        },
      } as any),
  ],
  [
    "upstream reverted to cache (Error)",
    "upstream reverted to cache",
    () => new Error("503 from reverse proxy: upstream reverted to cache"),
  ],
  ["timeout", "ETIMEDOUT", () => new Error("request timeout (ETIMEDOUT)")],
  [
    "429",
    "Too Many Requests",
    () =>
      ethers.makeError("Too Many Requests", "SERVER_ERROR", {
        request: {} as any,
        response: { statusCode: 429 } as any,
      }),
  ],
];

/** `fn` with every eth_call of selector `sel` to `to` throwing `mk()`. */
export async function faulted(
  to: string,
  sel: string,
  mk: () => any,
  fn: () => any,
) {
  const prov: any = ethers.provider;
  const call = prov.call.bind(prov);
  let hits = 0;
  prov.call = async (tx: any) => {
    const at = String(tx.to).toLowerCase() === to.toLowerCase();
    if (at && String(tx.data).startsWith(sel)) {
      hits++;
      throw mk();
    }
    return call(tx);
  };
  try {
    const r = await Promise.resolve()
      .then(fn)
      .then(
        (v) => ({ v, err: "" }),
        (e: any) => ({ v: undefined, err: String(e.message) }),
      );
    return { ...r, hits };
  } finally {
    prov.call = call;
  }
}
