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

/** An ethers Wallet for env key `name` on `provider`, guarded. */
async function guardedWallet(name, provider) {
  const { Wallet } = require("ethers");
  const key = process.env[name];
  const chainId = (await provider.getNetwork()).chainId;
  guardKey(key, chainId, name);
  return new Wallet(key, provider);
}

module.exports = { refuseRpcArg, rpcFromEnv, guardKey, guardedWallet };
