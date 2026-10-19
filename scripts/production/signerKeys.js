/**
 * scripts/production/signer.js's keys and chain guard, moved here
 * unchanged in Task 5.17 (slice C review L-5 grew signer.js past the
 * 500-line rule): the keystores (0600, one password from
 * SIGNER_PASSWORD_FILE or the terminal), the published Hardhat keys
 * refused off the test chain, and the upstream's chain (Sepolia, or 31337
 * with SIGNER_TEST=1).
 */
"use strict";

const fs = require("fs");
const path = require("path");
const readline = require("readline");
const { HDNodeWallet, Wallet } = require("ethers");

const SEPOLIA = 11155111;
const HARDHAT_PHRASE =
  "test test test test test test test test test test test junk";
const PUBLISHED = new Set(
  Array.from({ length: 20 }, (_, i) =>
    HDNodeWallet.fromPhrase(
      HARDHAT_PHRASE,
      undefined,
      `m/44'/60'/0'/0/${i}`,
    ).address.toLowerCase(),
  ),
);

/** Refuse a file group or others may read (the owner's key material). */
function privateFile(f) {
  const mode = fs.statSync(f).mode;
  if (mode & 0o077) {
    throw new Error(
      `${f} is readable by group or others (mode ${(mode & 0o777).toString(8)}): chmod 600 ${f}`,
    );
  }
}

/** The password: SIGNER_PASSWORD_FILE (0600), else asked without echo. */
async function password(question = "keystore password: ") {
  const f = process.env.SIGNER_PASSWORD_FILE;
  if (f) {
    privateFile(f);
    return fs.readFileSync(f, "utf8").replace(/\r?\n$/, "");
  }
  if (!process.stdin.isTTY) {
    throw new Error("set SIGNER_PASSWORD_FILE or run on a terminal");
  }
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  rl._writeToOutput = (s) => {
    if (s.startsWith(question)) rl.output.write(question);
  };
  const p = await new Promise((ok) => rl.question(question, ok));
  rl.close();
  process.stdout.write("\n");
  return p;
}

/** Every keystore in `dir`, decrypted, in file-name order. */
async function loadKeys(dir, pass) {
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort();
  if (!files.length) throw new Error(`${dir}: no keystore (*.json)`);
  const out = [];
  for (const f of files) {
    const file = path.join(dir, f);
    privateFile(file);
    const w = await Wallet.fromEncryptedJson(
      fs.readFileSync(file, "utf8"),
      pass,
    ).catch(() => {
      throw new Error(`${file}: wrong password or not a keystore`);
    });
    out.push({ name: f.replace(/\.json$/, ""), wallet: w });
  }
  return out;
}

/** The upstream's chain id: Sepolia, or 31337 with SIGNER_TEST=1. */
async function guardChain(provider) {
  const chain = Number((await provider.send("eth_chainId", [])).toString());
  const test = process.env.SIGNER_TEST === "1" && chain === 31337;
  if (chain !== SEPOLIA && !test) {
    throw new Error(
      `upstream is chain ${chain}: this signer serves Sepolia (${SEPOLIA}) only${chain === 31337 ? " (31337 with SIGNER_TEST=1)" : ""}`,
    );
  }
  return chain;
}

module.exports = {
  HARDHAT_PHRASE,
  PUBLISHED,
  SEPOLIA,
  guardChain,
  loadKeys,
  password,
  privateFile,
};
