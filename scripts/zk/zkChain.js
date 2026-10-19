/**
 * Task 5.17 slice B (deep review L-4): how the zk CLIs (attest.js,
 * build-whitelist-root.js, prove-whitelist.js, prove-attestation.js) reach
 * a chain and hold a key, the way the production CLIs do.
 *
 *  - The RPC URL comes from env ZK_RPC_URL, or ZK_RPC_URL_FILE (this
 *    user's own file, 0600), never the command line: argv lands in shell
 *    history and ps, and a provider key lives in the URL
 *    (scripts/production/redact.js urlsFrom). `--rpc` is refused with
 *    that reason.
 *  - A raw key from env (WHITELIST_OPS_KEY, WHITELIST_WALLET_KEY,
 *    ATTESTOR_KEY) that is one of the published Hardhat test keys is
 *    refused on any chain but 31337: anyone holds it.
 *  - Each key may come from <NAME>_FILE instead (this user's own file,
 *    mode 0600), as the URL may (R-515-10, the lead's ruling on slice B
 *    review L-2: an inline NAME=<key> prefix lands in shell history).
 */
"use strict";

const { HDNodeWallet } = require("ethers");
const { urlsFrom } = require("../production/redact");

const DEV_CHAIN = 31337;
const PHRASE = "test test test test test test test test test test test junk";
let published = null;

/** The 20 published Hardhat private keys, lower case, no 0x. */
function publishedKeys() {
  published ??= new Set(
    Array.from({ length: 20 }, (_, i) =>
      HDNodeWallet.fromPhrase(PHRASE, undefined, `m/44'/60'/0'/0/${i}`)
        .privateKey.slice(2)
        .toLowerCase(),
    ),
  );
  return published;
}

/** parseArgs: `--rpc` is refused (the URL is env's). */
function refuseRpcArg(arg) {
  if (/^--rpc(=|$)/.test(arg)) {
    throw new Error(
      "--rpc <url> is refused (argv lands in shell history and ps, and a provider key lives in the URL): set ZK_RPC_URL, or ZK_RPC_URL_FILE (0600)",
    );
  }
}

/** The RPC URL from ZK_RPC_URL / ZK_RPC_URL_FILE, or undefined. */
function rpcFromEnv(argv = []) {
  const urls = urlsFrom("ZK_RPC_URL", argv);
  if (urls.length > 1) throw new Error("ZK_RPC_URL must name one RPC URL");
  return urls[0];
}

/** Refuse `key` (env `name`) on `chainId` when it is a published one. */
function guardKey(key, chainId, name) {
  const k = String(key).trim().replace(/^0x/i, "").toLowerCase();
  if (Number(chainId) !== DEV_CHAIN && publishedKeys().has(k)) {
    throw new Error(
      `${name} is a published Hardhat test key: refused on chain ${chainId} (anyone holds it)`,
    );
  }
}

/**
 * Key `name` from <name>_FILE (this user's own plain file, mode 0600,
 * trimmed) or the variable itself; undefined when neither is set.
 */
function keyFromEnv(name, env = process.env) {
  const file = env[`${name}_FILE`];
  if (!file) return env[name] ? env[name].trim() : undefined;
  const fs = require("fs");
  const st = fs.lstatSync(file);
  if (!st.isFile() || st.uid !== process.getuid() || st.mode & 0o077)
    throw new Error(`${name}_FILE must be this user's own file, mode 0600`);
  return fs.readFileSync(file, "utf8").trim();
}

/** An ethers Wallet for env key `name` (or its file) on `provider`, guarded. */
async function guardedWallet(name, provider) {
  const { Wallet } = require("ethers");
  const key = keyFromEnv(name);
  const chainId = (await provider.getNetwork()).chainId;
  guardKey(key, chainId, name);
  return new Wallet(key, provider);
}

module.exports = {
  refuseRpcArg,
  rpcFromEnv,
  guardKey,
  guardedWallet,
  keyFromEnv,
};
