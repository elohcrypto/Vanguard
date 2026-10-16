/**
 * Plan v2 Task 5.7 (D48 a): the production deploy's inputs and its key
 * refusal. No private key ever lives in the deploying process: it signs
 * through an external JSON-RPC signer (Frame style, hardhat network
 * `remote`, accounts "remote"; scripts/production/DeployProduction.ts).
 *
 * The config file (DEPLOY_CONFIG, JSON) names addresses:
 *   {
 *     "ops": "0x..", "guardian": "0x..", "issuerAdmin": "0x..",
 *     "oracleNodes": ["0x..", "0x..", "0x.."],  // D50: three node keys
 *     "oracleOperator": "0x..",                 // D47: must be ops today
 *     "lockAmounts": ["2000", "4000", "8000"],  // D45: VSC, Retail /
 *                                               // Accredited / Institutional
 *     "proposer": "0x..", "voters": ["0x..", "0x.."],
 *     "escrowFeeWallet": "0x..",                // the escrow factory's owner
 *                                               // fee wallet (a verified human)
 *     "attestor": { "Ax": "..", "Ay": ".." },   // the issuer's EdDSA key
 *     "logChunk": 5000,                         // optional eth_getLogs range
 *     "confirmations": 3,                       // optional, per transaction
 *     "externalRoles": ["ops", "issuerAdmin"]   // optional (Task 5.13)
 *   }
 * Task 5.13: ops, issuerAdmin or guardian at an address holding code (a
 * multisig), or listed in "externalRoles", is external: it need not be a
 * signer account; its calls are exported as a Safe batch and the deploy
 * and the ceremony pause for them (demo/utils/RoleCalls.js).
 * The ops identity for KeyManager (Task 4.2) stays OPS_IDENTITY.
 * On the local dev chain (31337) and Sepolia an absent role defaults
 * to the signer's account at its docs/TESTNET_SETUP.md index (nodes 1-3,
 * proposer 4, voters 5 and 6, escrow fee wallet 8 (its own party, never
 * a role or a node), issuer admin 9, ops 10, guardian 11), the
 * operator to ops and the lock amounts to the engineering default (cap/4,
 * cap/2, cap; Q2). Mainnet (chain 1) and any other chain take explicit
 * values only. The attestor public key is always explicit: a demo key
 * would be a private key made in this process.
 */
import { createHash } from "crypto";
import { getAddress, isAddress, parseEther } from "ethers";

/** The local dev chain: Hardhat (31337); nothing here runs another. */
export const LOCAL_CHAINS = new Set([31337]);
/** Chains where an absent value takes its default (Q2-Q4). */
const DEFAULTS_ALLOWED = new Set([31337, 11155111]);
/** Network names that may hold a local key (on a local chain only). */
const LOCAL_NAMES = new Set(["hardhat", "localhost", "devnode"]);
const KEY_ENV = ["PRIVATE_KEY", "MNEMONIC"];

/**
 * Refuse a key in this process (R-56c-6, carried to 5.7): PRIVATE_KEY /
 * MNEMONIC on any network but hardhat/localhost/devnode, and on those
 * too unless the connected chain is a local dev chain; and a network
 * holding local accounts (a mnemonic, raw keys, Hardhat's defaults)
 * whenever the connected chain is not local. Without `chainId` only the
 * name rule runs (before any RPC call).
 */
export function refuseLocalKeys(p: {
  network: string;
  chainId?: number;
  accounts: unknown;
  env: Record<string, string | undefined>;
}): void {
  const set = KEY_ENV.filter((k) => p.env[k]);
  const chain = p.chainId === undefined ? "" : ` (chain ${p.chainId})`;
  const local = p.chainId === undefined || LOCAL_CHAINS.has(p.chainId);
  if (set.length && !(LOCAL_NAMES.has(p.network) && local)) {
    throw new Error(
      `refusing to deploy: ${set.join(" and ")} set for network "${p.network}"${chain}; keys live only in the external signer (SIGNER_RPC_URL, --network remote): unset ${set.length > 1 ? "them" : "it"}`,
    );
  }
  if (!local && p.accounts !== "remote") {
    throw new Error(
      `refusing to deploy: network "${p.network}" holds local accounts and chain ${p.chainId} is not a local dev chain (31337); deploy through the external signer: SIGNER_RPC_URL=<signer endpoint> --network remote`,
    );
  }
}

/**
 * GOV_TIME_SCALE shortens every governance window (demo option 74 reads
 * it): refused unless "1" off a local dev chain.
 */
export function refuseTimeScale(
  chainId: number,
  env: Record<string, string | undefined>,
): void {
  const s = env.GOV_TIME_SCALE;
  if (s !== undefined && s !== "1" && !LOCAL_CHAINS.has(chainId)) {
    throw new Error(
      `refusing to deploy: GOV_TIME_SCALE=${s} on chain ${chainId}; governance runs on the mainnet schedule off a dev chain: unset it`,
    );
  }
}

export interface DeployInputs {
  chainId: number;
  deployer: string;
  ops: string;
  guardian: string;
  issuerAdmin: string;
  oracleNodes: string[];
  oracleOperator: string;
  /** D45 lock amounts in wei, or null for the engineering default. */
  lockAmounts: bigint[] | null;
  proposer: string;
  voters: string[];
  escrowFeeWallet: string;
  attestor: { Ax: string; Ay: string };
  logChunk?: number;
  confirmations: number;
  /** Task 5.13: the roles this signer does not send for (a multisig). */
  external: string[];
  /** sha256 of the values that shape the deploy (resume must match). */
  digest: string;
}

const KEYS = new Set([
  "ops",
  "guardian",
  "issuerAdmin",
  "oracleNodes",
  "oracleOperator",
  "lockAmounts",
  "proposer",
  "voters",
  "escrowFeeWallet",
  "attestor",
  "logChunk",
  "confirmations",
  "externalRoles",
]);
/** Task 5.13: the roles that may be external (never the voters). */
const EXTERNAL = ["ops", "issuerAdmin", "guardian"];
/** docs/TESTNET_SETUP.md role wallets: the defaults where allowed. */
const INDEX: Record<string, number | number[]> = {
  oracleNodes: [1, 2, 3],
  proposer: 4,
  voters: [5, 6],
  escrowFeeWallet: 8,
  issuerAdmin: 9,
  ops: 10,
  guardian: 11,
};
const FIELD = /^(0x[0-9a-fA-F]+|[0-9]+)$/;

/**
 * The deploy inputs for `raw` (the parsed config) on `chainId`, with
 * `accounts` the external signer's eth_accounts (deployer = the first).
 * Throws before any transaction on a missing, malformed or unsupported
 * value, and when a role the ceremony sends from is not a signer account
 * (scripts/handover.ts names roles by wallet index) and is not external:
 * `coded` holds the lowercased config addresses that hold code.
 */
export function resolveInputs(
  raw: Record<string, any>,
  chainId: number,
  accounts: string[],
  coded: Set<string> = new Set(),
): DeployInputs {
  const bad = (m: string) => new Error(`deploy config: ${m}`);
  for (const k of Object.keys(raw)) {
    if (!KEYS.has(k)) {
      throw bad(`unknown key "${k}" (allowed: ${[...KEYS].join(", ")})`);
    }
  }
  if (!accounts.length) {
    throw bad(
      "the external signer exposes no account (eth_accounts is empty); unlock the deployer there",
    );
  }
  const defaults = DEFAULTS_ALLOWED.has(chainId);
  const addr = (k: string, v: unknown): string => {
    if (typeof v !== "string" || !isAddress(v)) {
      throw bad(`"${k}" must be an address`);
    }
    return getAddress(v);
  };
  const role = (k: string): any => {
    if (raw[k] !== undefined) {
      return Array.isArray(INDEX[k])
        ? asList(k, raw[k]).map((v, i) => addr(`${k}[${i}]`, v))
        : addr(k, raw[k]);
    }
    if (!defaults) {
      throw bad(`"${k}" is required on chain ${chainId} (no defaults)`);
    }
    const pick = (i: number) => {
      if (!accounts[i]) {
        throw bad(
          `"${k}" defaults to the signer's account ${i}, which it does not expose; name it`,
        );
      }
      return getAddress(accounts[i]);
    };
    const ix = INDEX[k];
    return Array.isArray(ix) ? ix.map(pick) : pick(ix);
  };
  const asList = (k: string, v: unknown): unknown[] => {
    if (!Array.isArray(v) || v.length === 0) {
      throw bad(`"${k}" must list addresses`);
    }
    return v;
  };

  const deployer = getAddress(accounts[0]);
  const ops = role("ops");
  const guardian = role("guardian");
  const issuerAdmin = role("issuerAdmin");
  const oracleNodes: string[] = role("oracleNodes");
  const proposer = role("proposer");
  const voters: string[] = role("voters");
  const escrowFeeWallet: string = role("escrowFeeWallet");
  if (oracleNodes.length !== 3 || new Set(oracleNodes).size !== 3) {
    throw bad('"oracleNodes" must name three distinct node keys (D50, Q4)');
  }
  if (raw.oracleOperator === undefined && !defaults) {
    throw bad(`"oracleOperator" is required on chain ${chainId} (no defaults)`);
  }
  const oracleOperator =
    raw.oracleOperator === undefined
      ? ops
      : addr("oracleOperator", raw.oracleOperator);
  if (oracleOperator !== ops) {
    throw bad(
      `"oracleOperator" ${oracleOperator} is not ops ${ops}: the ceremony makes ops the list oracles' owner and the OracleManager operator (D47); a separate operator is not supported`,
    );
  }
  let lockAmounts: bigint[] | null = null;
  if (raw.lockAmounts !== undefined) {
    const v = raw.lockAmounts;
    if (
      !Array.isArray(v) ||
      v.length !== 3 ||
      !v.every((x) => typeof x === "string" && /^[0-9]+(\.[0-9]+)?$/.test(x))
    ) {
      throw bad(
        '"lockAmounts" must be three VSC amounts as strings (Retail, Accredited, Institutional)',
      );
    }
    lockAmounts = v.map((x: string) => parseEther(x));
    if (lockAmounts.some((x) => x === 0n)) {
      throw bad('"lockAmounts" must be above zero');
    }
  } else if (!defaults) {
    throw bad(`"lockAmounts" is required on chain ${chainId} (D45)`);
  }
  const a = raw.attestor;
  if (!a || !FIELD.test(String(a.Ax)) || !FIELD.test(String(a.Ay))) {
    throw bad(
      '"attestor" must give the issuer\'s EdDSA public key { "Ax": .., "Ay": .. } (scripts/zk/attest.js)',
    );
  }
  const attestor = { Ax: BigInt(a.Ax).toString(), Ay: BigInt(a.Ay).toString() };
  const people = { deployer, ops, guardian, issuerAdmin };
  if (new Set(Object.values(people)).size !== 4) {
    throw bad(
      "deployer, ops, guardian and issuerAdmin must be four different keys (D25 b)",
    );
  }
  if (
    [deployer, ops, guardian, issuerAdmin, ...oracleNodes].includes(
      escrowFeeWallet,
    )
  ) {
    throw bad(
      "the escrow fee wallet must be its own key: not the deployer, ops, guardian, issuer admin or a node",
    );
  }
  if (oracleNodes.includes(deployer)) {
    throw bad("a node key may not be the deployer (D50)");
  }
  const marked = raw.externalRoles ?? [];
  if (
    !Array.isArray(marked) ||
    marked.some((k: unknown) => !EXTERNAL.includes(String(k)))
  ) {
    throw bad(`"externalRoles" must list roles among ${EXTERNAL.join(", ")}`);
  }
  const roles: Record<string, string> = { ops, guardian, issuerAdmin };
  const external = EXTERNAL.filter(
    (k) => marked.includes(k) || coded.has(roles[k].toLowerCase()),
  );
  // scripts/handover.ts reads every other role below as a wallet index of
  // the signer it runs with; the ceremony sends as the deployer and ops.
  const held = new Set(accounts.map((x) => getAddress(x)));
  for (const [k, v] of Object.entries({
    ...roles,
    proposer,
    ...Object.fromEntries(voters.map((x, i) => [`voters[${i}]`, x])),
  })) {
    if (!held.has(v) && !external.includes(k)) {
      throw bad(
        `${k} ${v} is not an account of the external signer: the ceremony (scripts/handover.ts) names it by wallet index${EXTERNAL.includes(k) ? '; a multisig has code at its address, or list it in "externalRoles"' : ""}`,
      );
    }
  }
  const int = (k: string, min: number): number | undefined => {
    const v = raw[k];
    if (v === undefined) return undefined;
    if (!Number.isInteger(v) || v < min) {
      throw bad(`"${k}" must be an integer >= ${min}`);
    }
    return v;
  };
  const logChunk = int("logChunk", 100);
  const confirmations =
    int("confirmations", 1) ?? (LOCAL_CHAINS.has(chainId) ? 1 : 3);
  const shaped = {
    chainId,
    ...people,
    oracleNodes,
    escrowFeeWallet,
    lockAmounts: lockAmounts && lockAmounts.map(String),
    attestor,
    opsIdentity: process.env.OPS_IDENTITY ?? null,
    // Absent when empty: a signer-held deploy's digest is unchanged.
    ...(external.length ? { external } : {}),
  };
  return {
    chainId,
    deployer,
    ops,
    guardian,
    issuerAdmin,
    oracleNodes,
    oracleOperator,
    lockAmounts,
    proposer,
    voters,
    escrowFeeWallet,
    attestor,
    logChunk,
    confirmations,
    external,
    digest: createHash("sha256").update(JSON.stringify(shaped)).digest("hex"),
  };
}
