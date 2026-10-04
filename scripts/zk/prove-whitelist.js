#!/usr/bin/env node
/**
 * Whitelist prover (plan v2 Task 3.5; D29/D30). The investor's side of
 * scripts/zk/build-whitelist-root.js: library for the demo and the tests,
 * and a CLI.
 *
 *   # once: a fresh secret (31 random bytes) in a new 0600 file; keep it
 *   # offline (without --out it goes to stdout, with a warning on stderr)
 *   node scripts/zk/prove-whitelist.js --new-secret --out secret.txt
 *   # onboarding: the commitment to hand the operator
 *   node scripts/zk/prove-whitelist.js --commitment --identity <id> --secret-file secret.txt
 *   # proving: calldata for PrivacyManager.submitWhitelistProof
 *   node scripts/zk/prove-whitelist.js --root root.json --identity <id> \
 *        --wallet <0x..> --secret-file <path> [--out proof.json]
 *   # optional: submit it (key: env WHITELIST_WALLET_KEY)
 *        ... --submit --rpc <url> --privacy-manager <addr>
 *
 * The secret comes from --secret-file or env WHITELIST_SECRET, never from
 * argv (other processes can read argv), and is never printed; one below
 * 2^128 is refused. A --secret-file readable by group or others draws a
 * warning on stderr (review 3.9 B-L5). The identity of an onboarded investor is its OnchainID
 * address as a field element. Output: { proof: string[24], signals:
 * [nullifier, root, wallet] } on stdout (and --out); progress goes to
 * stderr. The proof is verified locally with the circuit's verification key
 * before it is printed, and a commitment that is not in the root file is
 * refused before proving. --submit checks its arguments and that the key is
 * the --wallet's before proving, needs the proof's root to be the current
 * published one, and exits non-zero unless the binding reads valid.
 * Plain node + ethers; no hardhat runtime.
 */

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");
const {
  hex32,
  toField,
  toSecret,
  computeCommitment,
  loadRootFile,
  privacyManagerAt,
  revertReason,
  publisherOf,
} = require("./build-whitelist-root");

const VKEY = path.join(
  __dirname,
  "../../build/circuits/whitelist_membership/whitelist_membership_vkey.json",
);

/** The wallet a proof binds: a checksummed, non-zero address. */
function walletOf(wallet) {
  let w;
  try {
    w = ethers.getAddress(wallet);
  } catch {
    throw new Error("wallet: not an address");
  }
  if (w === ethers.ZeroAddress) throw new Error("wallet: the zero address");
  return w;
}

/** A fresh secret: 31 random bytes (below the field order), 0x hex. */
function newSecret() {
  return "0x" + crypto.randomBytes(31).toString("hex");
}

/**
 * Prove whitelist membership for `wallet` under the root file.
 * @param {Object} p
 * @param {Object} p.rootFile - output of buildWhitelistRoot (re-checked here)
 * @param {*} p.identity - field element (OnchainID address for investors)
 * @param {*} p.secret - the investor's secret, >= 2^128; never logged
 * @param {string} p.wallet - the wallet that will submit (walletBinding)
 * @param {Object} [p.generator] - a RealProofGenerator (the demo shares one)
 * @returns {Promise<{proof: string[], signals: string[]}>} calldata for
 *          PrivacyManager.submitWhitelistProof; signals [nullifier, root, wallet]
 */
async function proveWhitelist({
  rootFile,
  identity,
  secret,
  wallet,
  generator,
}) {
  const { root, leaves } = await loadRootFile(rootFile);
  const id = toField(identity, "identity");
  const s = toSecret(secret);
  const w = walletOf(wallet);
  const c = await computeCommitment(id, s);
  if (!leaves.includes(c)) {
    throw new Error(
      "commitment Poseidon(identity, secret) is not in the root file: wrong identity or secret, or not onboarded under this root",
    );
  }

  let gen = generator;
  if (!gen) {
    const { RealProofGenerator } = require("../generate-real-proofs");
    gen = new RealProofGenerator();
  }
  const r = await gen.generateWhitelistProof({
    identity: id,
    secret: s,
    walletBinding: w,
    commitments: leaves,
  });
  const proof = r.proof.map((x) => BigInt(x).toString());
  const signals = r.publicSignals.map((x) => BigInt(x).toString());
  if (proof.length !== 24 || signals.length !== 3) {
    throw new Error("prover returned a malformed proof");
  }
  if (BigInt(signals[1]) !== root || BigInt(signals[2]) !== BigInt(w)) {
    throw new Error(
      "proof signals do not name the root file's root and the wallet",
    );
  }
  const snarkjs = require("snarkjs");
  const vkey = JSON.parse(fs.readFileSync(VKEY, "utf8"));
  if (!r.rawProof || !(await snarkjs.plonk.verify(vkey, signals, r.rawProof))) {
    throw new Error(
      "the proof does not verify against the whitelist verification key",
    );
  }
  return { proof, signals };
}

/**
 * Submit calldata from proveWhitelist as `signer`, which must be the bound
 * wallet. A proof whose root is not the current published one is refused:
 * nothing published yet -> the publish command for ops; another root
 * current -> re-prove on the current root file. It never advises
 * republishing a replaced root (that would lapse every binding under the
 * current one and let investors removed since bind again).
 * @param {Object} p
 * @param {{proof: string[], signals: string[]}} p.calldata
 * @param {string} p.privacyManager - address
 * @param {Object} p.signer - ethers signer of the wallet (the CLI builds it)
 * @param {string} [p.rpc] - for the printed publish command only
 * @returns {Promise<{txHash, nullifier, version, expiresAt}>}; throws
 *          unless hasValidWhitelistProof reads true afterwards
 */
async function submitWhitelistProof({ calldata, privacyManager, signer, rpc }) {
  const who = await signer.getAddress();
  const bound = ethers.getAddress(
    ethers.toBeHex(BigInt(calldata.signals[2]), 20),
  );
  if (who !== bound) {
    throw new Error(`the key is for ${who}, the proof binds ${bound}`);
  }
  const pm = privacyManagerAt(privacyManager, signer);
  const root = hex32(BigInt(calldata.signals[1]));
  const current = await pm.whitelistRoot();
  if (current === ethers.ZeroHash) {
    throw new Error(
      `no whitelist root is published yet; ${await publisherOf(pm)} publishes ${root}:\n` +
        `  WHITELIST_OPS_KEY=... node scripts/zk/build-whitelist-root.js --in <entries.json> --publish --rpc ${rpc || "<url>"} --privacy-manager ${privacyManager}`,
    );
  }
  if (current !== root) {
    throw new Error(
      `your root file is not the current one: the published root is ${current} (version ${await pm.whitelistVersion()}); get the current root.json from ops and prove again (an old root is never republished)`,
    );
  }
  let rx;
  try {
    rx = await (
      await pm.submitWhitelistProof(calldata.proof, calldata.signals)
    ).wait();
  } catch (e) {
    throw new Error(`submitWhitelistProof reverted: ${revertReason(e)}`);
  }
  const b = await pm.whitelistBindings(who);
  if (!(await pm.hasValidWhitelistProof(who))) {
    throw new Error(
      `submitted (tx ${rx.hash}) but hasValidWhitelistProof(${who}) reads false`,
    );
  }
  return {
    txHash: rx.hash,
    nullifier: b.nullifier.toString(),
    version: b.version.toString(),
    expiresAt: new Date(Number(b.expiresAt) * 1000).toISOString(),
  };
}

/**
 * Write a fresh secret to a new file, mode 0600, refusing an existing one
 * (review 3.9 B-L5: a shell redirect leaves the mode to the umask).
 */
function writeSecretFile(file, secret) {
  try {
    fs.writeFileSync(file, secret + "\n", { mode: 0o600, flag: "wx" });
  } catch (e) {
    if (e.code === "EEXIST") {
      throw new Error(`${file} exists: refusing to overwrite a secret file`);
    }
    throw e;
  }
}

/**
 * The secret from --secret-file or WHITELIST_SECRET; argv is refused. A
 * secret file readable by group or others is read, with a warning on
 * stderr (`warn`).
 */
function readSecret(args, env, warn = (m) => process.stderr.write(m + "\n")) {
  if (args["secret-file"]) {
    const file = args["secret-file"];
    const mode = fs.statSync(file).mode & 0o777;
    if (process.platform !== "win32" && mode & 0o077) {
      warn(
        `warning: secret file ${file} is readable by group or others (mode ${mode.toString(8).padStart(4, "0")}): chmod 600 it`,
      );
    }
    return fs.readFileSync(file, "utf8").trim();
  }
  if (env.WHITELIST_SECRET) return env.WHITELIST_SECRET.trim();
  throw new Error(
    "no secret: pass --secret-file <path> or env WHITELIST_SECRET",
  );
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--secret" || a.startsWith("--secret=")) {
      throw new Error(
        "never pass the secret on the command line (argv is visible to other processes): use --secret-file or env WHITELIST_SECRET",
      );
    }
    // Not echoed: a mistyped secret would land in the logs.
    if (!a.startsWith("--")) throw new Error("unexpected positional argument");
    const key = a.slice(2);
    if (["submit", "commitment", "new-secret", "help"].includes(key))
      args[key] = true;
    else if (
      [
        "root",
        "identity",
        "wallet",
        "secret-file",
        "out",
        "rpc",
        "privacy-manager",
      ].includes(key)
    ) {
      if (i + 1 >= argv.length) throw new Error(`${a} needs a value`);
      args[key] = argv[++i];
    } else throw new Error(`unknown option ${a}`);
  }
  return args;
}

const USAGE = `Usage: node scripts/zk/prove-whitelist.js --new-secret [--out <secret file>]
       node scripts/zk/prove-whitelist.js --commitment --identity <id>
       node scripts/zk/prove-whitelist.js --root <root.json> --identity <id> --wallet <addr>
            [--out <proof.json>] [--submit --rpc <url> --privacy-manager <addr>]
Secret: --secret-file <path> or env WHITELIST_SECRET. Submit key: env WHITELIST_WALLET_KEY.`;

async function main(secretBox) {
  // Proof generation logs progress with console.log; stdout carries only
  // the result.
  console.log = (...a) => console.error(...a);
  const out = (s) => process.stdout.write(s + "\n");
  const args = parseArgs(process.argv.slice(2));
  if (args.help) return out(USAGE);
  if (args["new-secret"]) {
    if (args.out) {
      writeSecretFile(args.out, newSecret());
      return out(args.out);
    }
    console.error(
      "warning: the secret goes to stdout; a shell redirect leaves the file mode to the umask (often 0644): prefer --new-secret --out <file> (mode 0600)",
    );
    return out(newSecret());
  }
  if (args.identity === undefined)
    throw new Error(`--identity is required\n${USAGE}`);
  secretBox.value = readSecret(args, process.env);

  if (args.commitment) {
    return out(hex32(await computeCommitment(args.identity, secretBox.value)));
  }
  if (!args.root || !args.wallet)
    throw new Error(`--root and --wallet are required\n${USAGE}`);
  // Everything --submit needs is checked before the proof is generated.
  let signer;
  if (args.submit) {
    const key = process.env.WHITELIST_WALLET_KEY;
    if (!args.rpc || !args["privacy-manager"] || !key) {
      throw new Error(
        "--submit needs --rpc, --privacy-manager and env WHITELIST_WALLET_KEY",
      );
    }
    signer = new ethers.Wallet(key, new ethers.JsonRpcProvider(args.rpc));
    if (signer.address !== walletOf(args.wallet)) {
      throw new Error(
        `WHITELIST_WALLET_KEY is for ${signer.address}, --wallet is ${walletOf(args.wallet)}`,
      );
    }
  }
  const calldata = await proveWhitelist({
    rootFile: JSON.parse(fs.readFileSync(args.root, "utf8")),
    identity: args.identity,
    secret: secretBox.value,
    wallet: args.wallet,
  });
  const json = JSON.stringify(calldata, null, 2);
  if (args.out) fs.writeFileSync(args.out, json + "\n");
  if (signer) {
    const b = await submitWhitelistProof({
      calldata,
      privacyManager: args["privacy-manager"],
      signer,
      rpc: args.rpc,
    });
    console.error(`submitted (tx ${b.txHash})`);
    console.error(
      `  nullifier ${b.nullifier}, root version ${b.version}, expires ${b.expiresAt}`,
    );
    console.error("  hasValidWhitelistProof: true");
  }
  out(json);
}

if (require.main === module) {
  const secretBox = {};
  main(secretBox).then(
    () => process.exit(0),
    (e) => {
      // Belt and braces: no message names the secret, but scrub it anyway.
      let msg = String(e && e.message);
      const s = secretBox.value;
      if (s) {
        const forms = [s];
        try {
          const v = BigInt(s);
          forms.push(v.toString(), v.toString(16));
        } catch {}
        for (const f of forms.filter((x) => x.length >= 4)) {
          msg = msg.split(f).join("<secret>");
        }
      }
      console.error(`prove-whitelist: ${msg}`);
      process.exit(1);
    },
  );
}

module.exports = {
  proveWhitelist,
  submitWhitelistProof,
  readSecret,
  newSecret,
  writeSecretFile,
};
