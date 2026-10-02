#!/usr/bin/env node
/**
 * Whitelist prover (plan v2 Task 3.5; D29/D30). The investor's side of
 * scripts/zk/build-whitelist-root.js: library for the demo and the tests,
 * and a CLI.
 *
 *   # onboarding: the commitment to hand the operator
 *   WHITELIST_SECRET=... node scripts/zk/prove-whitelist.js --commitment --identity <id>
 *   # proving: calldata for PrivacyManager.submitWhitelistProof
 *   node scripts/zk/prove-whitelist.js --root root.json --identity <id> \
 *        --wallet <0x..> --secret-file <path> [--out proof.json]
 *   # optional: submit it (key: env WHITELIST_WALLET_KEY)
 *        ... --submit --rpc <url> --privacy-manager <addr>
 *
 * The secret comes from --secret-file or env WHITELIST_SECRET, never from
 * argv (other processes can read argv), and is never printed. The identity
 * of an onboarded investor is its OnchainID address as a field element.
 * Output: { proof: string[24], signals: [nullifier, root, wallet] } on stdout
 * (and --out); progress goes to stderr. The proof is verified locally with
 * the circuit's verification key before it is printed, and a commitment that
 * is not in the root file is refused before proving. Submitting needs the
 * root already published (ops; the publish command is printed otherwise).
 * Plain node + ethers; no hardhat runtime.
 */

const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");
const {
  hex32,
  toField,
  computeCommitment,
  loadRootFile,
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

/**
 * Prove whitelist membership for `wallet` under the root file.
 * @param {Object} p
 * @param {Object} p.rootFile - output of buildWhitelistRoot (re-checked here)
 * @param {*} p.identity - field element (OnchainID address for investors)
 * @param {*} p.secret - the investor's secret; never logged
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
  const s = toField(secret, "secret");
  if (s === 0n) throw new Error("secret: 0 is not a secret");
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

const PM_ABI = [
  "function whitelistRoot() view returns (bytes32)",
  "function whitelistVersion() view returns (uint256)",
  "function listOperator() view returns (address)",
  "function submitWhitelistProof(uint256[24] proof, uint256[3] signals)",
  "function whitelistBindings(address) view returns (uint256 version, uint256 nullifier, uint256 expiresAt)",
  "function hasValidWhitelistProof(address) view returns (bool)",
];

/**
 * Submit calldata from proveWhitelist with the bound wallet's key. Refuses
 * (and returns the publish command for ops) when the proof's root is not
 * the current published root.
 * @returns {Promise<{txHash, nullifier, version, expiresAt, hasValidWhitelistProof}>}
 */
async function submitWhitelistProof({
  calldata,
  rpc,
  privacyManager,
  walletKey,
}) {
  const signer = new ethers.Wallet(walletKey, new ethers.JsonRpcProvider(rpc));
  if (BigInt(signer.address) !== BigInt(calldata.signals[2])) {
    throw new Error(
      `WHITELIST_WALLET_KEY is for ${signer.address}, the proof binds ${ethers.getAddress(ethers.toBeHex(BigInt(calldata.signals[2]), 20))}`,
    );
  }
  const pm = new ethers.Contract(privacyManager, PM_ABI, signer);
  const root = hex32(BigInt(calldata.signals[1]));
  if ((await pm.whitelistRoot()) !== root) {
    const data = new ethers.Interface([
      "function publishWhitelistRoot(bytes32)",
    ]).encodeFunctionData("publishWhitelistRoot", [root]);
    throw new Error(
      `root ${root} is not the current published root; ops (listOperator ${await pm.listOperator()}) publishes it first:\n` +
        `  WHITELIST_OPS_KEY=... node scripts/zk/build-whitelist-root.js --in <entries.json> --publish --rpc ${rpc} --privacy-manager ${privacyManager}\n` +
        `  or send to ${privacyManager} the calldata ${data}`,
    );
  }
  const rx = await (
    await pm.submitWhitelistProof(calldata.proof, calldata.signals)
  ).wait();
  const b = await pm.whitelistBindings(signer.address);
  return {
    txHash: rx.hash,
    nullifier: b.nullifier.toString(),
    version: b.version.toString(),
    expiresAt: new Date(Number(b.expiresAt) * 1000).toISOString(),
    hasValidWhitelistProof: await pm.hasValidWhitelistProof(signer.address),
  };
}

/** The secret from --secret-file or WHITELIST_SECRET; argv is refused. */
function readSecret(args, env) {
  if (args["secret-file"]) {
    return fs.readFileSync(args["secret-file"], "utf8").trim();
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
    if (!a.startsWith("--")) throw new Error(`unexpected argument ${a}`);
    const key = a.slice(2);
    if (["submit", "commitment", "help"].includes(key)) args[key] = true;
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

const USAGE = `Usage: node scripts/zk/prove-whitelist.js --commitment --identity <id>
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
  if (args.identity === undefined)
    throw new Error(`--identity is required\n${USAGE}`);
  secretBox.value = readSecret(args, process.env);

  if (args.commitment) {
    return out(hex32(await computeCommitment(args.identity, secretBox.value)));
  }
  if (!args.root || !args.wallet)
    throw new Error(`--root and --wallet are required\n${USAGE}`);
  const calldata = await proveWhitelist({
    rootFile: JSON.parse(fs.readFileSync(args.root, "utf8")),
    identity: args.identity,
    secret: secretBox.value,
    wallet: args.wallet,
  });
  const json = JSON.stringify(calldata, null, 2);
  if (args.out) fs.writeFileSync(args.out, json + "\n");
  if (args.submit) {
    if (
      !args.rpc ||
      !args["privacy-manager"] ||
      !process.env.WHITELIST_WALLET_KEY
    ) {
      throw new Error(
        "--submit needs --rpc, --privacy-manager and env WHITELIST_WALLET_KEY",
      );
    }
    const b = await submitWhitelistProof({
      calldata,
      rpc: args.rpc,
      privacyManager: args["privacy-manager"],
      walletKey: process.env.WHITELIST_WALLET_KEY,
    });
    console.error(`submitted (tx ${b.txHash})`);
    console.error(
      `  nullifier ${b.nullifier}, root version ${b.version}, expires ${b.expiresAt}`,
    );
    console.error(`  hasValidWhitelistProof: ${b.hasValidWhitelistProof}`);
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

module.exports = { proveWhitelist, submitWhitelistProof, readSecret };
