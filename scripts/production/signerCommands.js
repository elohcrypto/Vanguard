/**
 * scripts/production/signer.js's commands besides serving (moved here in
 * Task 5.17 to keep signer.js under 500 lines):
 *  - `new <dir> <name>...`: fresh encrypted keystores, 0600, addresses
 *    printed. The signer orders keystores by file name and handover.json
 *    pins each wallet index to an address (walletPins.ts), so a name that
 *    sorts before an existing keystore shifts every index after it: warned
 *    (slice B review L-4).
 *  - `forget <address> <nonce>`: drops a stuck signed-nonce entry from
 *    the record beside SIGNER_KEYSTORE_DIR's keystores (signerState.js
 *    forget), logged (slice B review M-1, review D-4).
 *  - `bump <address> <nonce> [port]`: asks the running signer to send the
 *    transaction it recorded at that nonce again with higher fees
 *    (vanguard_bump), for one stuck in the mempool (slice C review L-5).
 */
"use strict";

const fs = require("fs");
const path = require("path");
const { Wallet, getAddress } = require("ethers");
const { forget, recordFile } = require("./signerState");

const HELP = `usage: node scripts/production/signer.js [port]   serve (SIGNER_UPSTREAM, SIGNER_KEYSTORE_DIR, SIGNER_PASSWORD_FILE)
       node scripts/production/signer.js new <dir> <name>...   new encrypted keystores (name them to sort after the existing ones)
       node scripts/production/signer.js forget <address> <nonce>   drop a stuck signed-nonce entry (SIGNER_KEYSTORE_DIR/signed-nonces)
       node scripts/production/signer.js bump <address> <nonce> [port]   the running signer re-sends its transaction at that nonce with higher fees`;

/** `new <dir> <name>...`; `password(question)` asks for the password. */
async function create(dir, names, password) {
  if (!dir || !names.length)
    throw new Error("usage: signer.js new <dir> <name>...");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const existing = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
  const pass = await password("password for the new keystores: ");
  if (pass.length < 12)
    throw new Error("use a password of 12 or more characters");
  for (const name of names) {
    const file = path.join(dir, `${name}.json`);
    if (fs.existsSync(file)) throw new Error(`${file} exists; not overwritten`);
    const after = existing.filter((f) => f > `${name}.json`);
    if (after.length) {
      console.error(
        `warning: ${name}.json sorts before ${after.join(", ")}: every wallet index from it on shifts, and a handover.json pinned to the old order is refused (name new keystores so they sort after the pinned ones, or re-pin handover.json "accounts")`,
      );
    }
    const w = Wallet.createRandom();
    fs.writeFileSync(file, await w.encrypt(pass), { mode: 0o600, flag: "wx" });
    console.log(`${name} ${w.address}`);
  }
}

/** `forget <address> <nonce>`, logged. */
async function forgetCmd(address, nonce) {
  if (!address || !/^\d+$/.test(String(nonce ?? ""))) throw new Error(HELP);
  const dir = process.env.SIGNER_KEYSTORE_DIR;
  if (!dir)
    throw new Error("set SIGNER_KEYSTORE_DIR to the keystores' directory");
  const file = recordFile(dir);
  const gone = forget(file, getAddress(address), nonce);
  console.log(
    gone.length
      ? `signer: forgot ${gone.join(", ")} in ${file}: the next request at that nonce is signed as new`
      : `signer: no entry for ${address} nonce ${nonce} in ${file}`,
  );
}

/** `bump <address> <nonce> [port]`: vanguard_bump on the running signer. */
async function bumpCmd(address, nonce, port = "1248") {
  if (!address || !/^\d+$/.test(String(nonce ?? ""))) throw new Error(HELP);
  const { readToken, tokenFileFor } = require("./rpcGuard");
  const r = await fetch(`http://127.0.0.1:${port}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${readToken(tokenFileFor(port))}`,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "vanguard_bump",
      params: [getAddress(address), Number(nonce)],
    }),
  });
  const out = await r.json();
  if (out.error) throw new Error(out.error.message);
  console.log(
    `signer: nonce ${nonce} of ${getAddress(address)} sent again with higher fees: ${out.result}`,
  );
}

module.exports = { HELP, create, forgetCmd, bumpCmd };
