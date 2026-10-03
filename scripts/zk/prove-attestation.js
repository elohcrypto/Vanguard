#!/usr/bin/env node
/**
 * Attestation prover (plan v2 Task 3.7b, D31 a). The investor's side of
 * scripts/zk/attest.js: library for the demo and the tests, and a CLI.
 *
 *   # policy and issuer trust read from PrivacyManager (recommended)
 *   node scripts/zk/prove-attestation.js --attestation att.json --wallet <0x..> \
 *        --rpc <url> --privacy-manager <addr> [--out proof.json] [--submit]
 *   # or offline, the policy given explicitly (no trust check possible)
 *        ... --mask <allowedMask> | --minimum <minimumAccreditation>
 *        | --policy <minimum,wK,wA,wJ,wAcc>
 *
 * The attestation file holds the salt and the issuer's signature; neither
 * is ever printed. Before proving it refuses: a signature that does not
 * verify, an issuer key (Ax, Ay) PrivacyManager does not trust for the
 * circuit, an attestation signed for another chain or PrivacyManager than
 * the target (Task 3.8 M1), a policy given explicitly that differs from the
 * current one, and
 * attributes that do not meet the policy. The proof is verified locally with
 * the circuit's verification key before it is printed. --submit (key: env
 * WHITELIST_WALLET_KEY, which must be the --wallet's) sends
 * submitAttestationProof and exits non-zero unless the record reads valid.
 * Output: { circuit, circuitId, proof: string[24], signals } on stdout (and
 * --out); progress on stderr. Plain node + ethers; no hardhat runtime.
 */

const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");
const { toField, revertReason } = require("./build-whitelist-root");
const {
  CIRCUITS,
  circuitOf,
  attestorId,
  loadAttestation,
} = require("./attest");

/** The PrivacyManager surface this CLI uses, custom errors included. */
const PM_ABI = [
  "function trustedAttestor(bytes32 circuitId, bytes32 attestor) view returns (bool)",
  "function currentPolicy(bytes32 circuitId) view returns (uint256[])",
  "function submitAttestationProof(bytes32 circuitId, uint256[24] proof, uint256[] signals)",
  "function attestationRecords(address user, bytes32 circuitId) view returns (bytes32 policyHash, bytes32 attestor, uint256 nullifier, uint256 expiresAt, uint256 policyEpoch, uint256 attestorEpoch)",
  "function getUserProofInfo(address user, bytes32 circuitId) view returns (uint256 expiresAt, bool isValid, bool isExpired)",
  "error NotAttestationCircuit(bytes32 circuitId)",
  "error NonGatingBlacklistProof()",
  "error InvalidSignalCount(uint256 expected, uint256 got)",
  "error UntrustedAttestor(bytes32 circuitId, bytes32 attestor)",
  "error PolicyNotSet(bytes32 circuitId)",
  "error StalePolicy(bytes32 circuitId)",
  "error WalletBindingMismatch()",
  "error WrongChainId(uint256 signal)",
  "error WrongVerifierContext(uint256 signal)",
  "error AttestationNullifierBound(address wallet)",
  "error InvalidAttestationProof()",
];

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

/** Policy signal count per circuit: [mask], [minimum], [minimum, 4 weights]. */
const POLICY_LENGTH = { jurisdiction: 1, accreditation: 1, compliance: 5 };

function parsePolicy(circuit, policy) {
  const list = Array.isArray(policy) ? policy : String(policy).split(",");
  if (list.length !== POLICY_LENGTH[circuit]) {
    throw new Error(
      `policy: ${circuit} takes ${POLICY_LENGTH[circuit]} value(s)`,
    );
  }
  return list.map((v) => toField(v, "policy"));
}

/**
 * Read the circuit's current policy and whether the attestation's issuer is
 * trusted, from PrivacyManager.
 * @returns {Promise<{policy: bigint[], trusted: boolean}>}
 */
async function readChainPolicy({ circuit, Ax, Ay, privacyManager, runner }) {
  const pm = new ethers.Contract(privacyManager, PM_ABI, runner);
  const id = circuitOf(circuit).id;
  const [policy, trusted] = await Promise.all([
    pm.currentPolicy(id),
    pm.trustedAttestor(id, attestorId(Ax, Ay)),
  ]);
  return { policy: policy.map(BigInt), trusted };
}

/** Throws unless the attributes meet the policy (clear error before proving). */
function checkPolicy(att, policy) {
  const a = att.attributes;
  if (att.circuit === "jurisdiction") {
    if (policy[0] === 0n) throw new Error("policy: no jurisdiction is active");
    if ((a[0] & policy[0]) === 0n) {
      throw new Error("the attested jurisdiction is not in the allowed mask");
    }
  } else if (att.circuit === "accreditation") {
    if (policy[0] === 0n)
      throw new Error("policy: no minimum accreditation set");
    if (a[0] < policy[0]) {
      throw new Error("the attested amount is below the minimum accreditation");
    }
  } else {
    const [minimum, ...w] = policy;
    if (w.reduce((x, y) => x + y, 0n) !== 100n) {
      throw new Error("policy: compliance weights not set (they sum to 100)");
    }
    const sum = a.reduce((x, s, i) => x + s * w[i], 0n);
    if (sum < minimum * 100n) {
      throw new Error("the attested scores are below the compliance minimum");
    }
  }
}

/**
 * Prove an attestation for `wallet` under `policy`.
 * @param {Object} p
 * @param {Object} p.attestation - from attest.js (re-checked here); never logged
 * @param {string} p.wallet - the wallet that will submit (walletBinding)
 * @param {Array} [p.policy] - explicit policy signals; compared with the
 *        chain when privacyManager is given
 * @param {string} [p.privacyManager] - read policy and issuer trust from it
 * @param {Object} [p.runner] - ethers provider or signer for privacyManager
 * @param {Object} [p.generator] - a RealProofGenerator (the demo shares one)
 * @returns {Promise<{circuit, circuitId, proof: string[], signals: string[]}>}
 */
async function proveAttestation({
  attestation,
  wallet,
  policy,
  privacyManager,
  runner,
  generator,
}) {
  const att = await loadAttestation(attestation);
  const w = walletOf(wallet);
  let p = policy === undefined ? undefined : parsePolicy(att.circuit, policy);
  if (privacyManager) {
    // Task 3.8 M1: PrivacyManager refuses another deployment's attestation.
    if (ethers.getAddress(privacyManager) !== att.privacyManager) {
      throw new Error(
        `the attestation is for PrivacyManager ${att.privacyManager}, not ${ethers.getAddress(privacyManager)}`,
      );
    }
    const provider = runner && (runner.provider ?? runner);
    const live = (await provider.getNetwork()).chainId;
    if (live !== att.chainId) {
      throw new Error(
        `the attestation is for chain ${att.chainId}, not chain ${live}`,
      );
    }
    const chain = await readChainPolicy({
      circuit: att.circuit,
      Ax: att.Ax,
      Ay: att.Ay,
      privacyManager,
      runner,
    });
    if (!chain.trusted) {
      throw new Error(
        `the issuer key (Ax, Ay) is not trusted for ${att.circuit} on PrivacyManager ${privacyManager}`,
      );
    }
    if (p && p.join() !== chain.policy.join()) {
      throw new Error(
        `stale policy: PrivacyManager's current ${att.circuit} policy is [${chain.policy.join(", ")}]`,
      );
    }
    p = chain.policy;
  }
  if (!p) {
    throw new Error(
      "no policy: pass --rpc and --privacy-manager, or the policy",
    );
  }
  checkPolicy(att, p);

  let gen = generator;
  if (!gen) {
    const { RealProofGenerator } = require("../generate-real-proofs");
    gen = new RealProofGenerator();
  }
  const base = {
    identity: att.identity,
    salt: att.salt,
    R8x: att.R8x,
    R8y: att.R8y,
    S: att.S,
    Ax: att.Ax,
    Ay: att.Ay,
    chainId: att.chainId,
    verifierContext: att.verifierContext,
    walletBinding: w,
  };
  let r;
  if (att.circuit === "jurisdiction") {
    r = await gen.generateJurisdictionProof({
      ...base,
      mask: att.attributes[0],
      allowedMask: p[0],
    });
  } else if (att.circuit === "accreditation") {
    r = await gen.generateAccreditationProof({
      ...base,
      amount: att.attributes[0],
      minimumAccreditation: p[0],
    });
  } else {
    r = await gen.generateComplianceProof({
      ...base,
      scores: att.attributes,
      minimum: p[0],
      weights: p.slice(1),
    });
  }
  const proof = r.proof.map((x) => BigInt(x).toString());
  const signals = r.publicSignals.map((x) => BigInt(x).toString());
  const expected = [
    att.Ax,
    att.Ay,
    att.chainId,
    att.verifierContext,
    ...p,
    BigInt(w),
  ].map(String);
  if (proof.length !== 24 || signals.slice(1).join() !== expected.join()) {
    throw new Error("prover returned a malformed proof");
  }
  const snarkjs = require("snarkjs");
  const vkeyPath = path.join(
    __dirname,
    `../../build/circuits/${CIRCUITS[att.circuit].build}/${CIRCUITS[att.circuit].build}_vkey.json`,
  );
  const vkey = JSON.parse(fs.readFileSync(vkeyPath, "utf8"));
  if (!r.rawProof || !(await snarkjs.plonk.verify(vkey, signals, r.rawProof))) {
    throw new Error(
      `the proof does not verify against the ${att.circuit} verification key`,
    );
  }
  return {
    circuit: att.circuit,
    circuitId: CIRCUITS[att.circuit].id,
    proof,
    signals,
  };
}

/**
 * Submit calldata from proveAttestation as `signer`, the bound wallet.
 * @returns {Promise<{txHash, policyHash, nullifier, expiresAt}>}; throws
 *          unless getUserProofInfo reads the record valid afterwards
 */
async function submitAttestationProof({ calldata, privacyManager, signer }) {
  const who = await signer.getAddress();
  const n = calldata.signals.length;
  const bound = ethers.getAddress(
    ethers.toBeHex(BigInt(calldata.signals[n - 1]), 20),
  );
  if (who !== bound) {
    throw new Error(`the key is for ${who}, the proof binds ${bound}`);
  }
  const pm = new ethers.Contract(privacyManager, PM_ABI, signer);
  let rx;
  try {
    rx = await (
      await pm.submitAttestationProof(
        calldata.circuitId,
        calldata.proof,
        calldata.signals,
      )
    ).wait();
  } catch (e) {
    throw new Error(
      `submitAttestationProof reverted: ${revertReason(e, PM_ABI)}`,
    );
  }
  const rec = await pm.attestationRecords(who, calldata.circuitId);
  const info = await pm.getUserProofInfo(who, calldata.circuitId);
  if (!info.isValid) {
    throw new Error(
      `submitted (tx ${rx.hash}) but the ${calldata.circuit} record of ${who} reads invalid`,
    );
  }
  return {
    txHash: rx.hash,
    policyHash: rec.policyHash,
    nullifier: rec.nullifier.toString(),
    expiresAt: new Date(Number(rec.expiresAt) * 1000).toISOString(),
  };
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) throw new Error("unexpected positional argument");
    const k = a.slice(2);
    if (["submit", "help"].includes(k)) args[k] = true;
    else if (
      [
        "attestation",
        "wallet",
        "rpc",
        "privacy-manager",
        "mask",
        "minimum",
        "policy",
        "out",
      ].includes(k)
    ) {
      if (i + 1 >= argv.length) throw new Error(`${a} needs a value`);
      args[k] = argv[++i];
    } else throw new Error(`unknown option ${a}`);
  }
  return args;
}

const USAGE = `Usage: node scripts/zk/prove-attestation.js --attestation <file> --wallet <addr>
            (--rpc <url> --privacy-manager <addr> | --mask <m> | --minimum <m> | --policy <min,wK,wA,wJ,wAcc>)
            [--out <proof.json>] [--submit]
Submit key: env WHITELIST_WALLET_KEY (the --wallet's).`;

async function main(box) {
  // Proof generation logs progress with console.log; stdout carries only
  // the result.
  console.log = (...a) => console.error(...a);
  const out = (s) => process.stdout.write(s + "\n");
  const args = parseArgs(process.argv.slice(2));
  if (args.help) return out(USAGE);
  if (!args.attestation || !args.wallet) {
    throw new Error(`--attestation and --wallet are required\n${USAGE}`);
  }
  box.attestation = JSON.parse(fs.readFileSync(args.attestation, "utf8"));
  const explicit = args.policy ?? args.mask ?? args.minimum;
  const chain = Boolean(args.rpc || args["privacy-manager"]);
  if (chain && (!args.rpc || !args["privacy-manager"])) {
    throw new Error("--rpc and --privacy-manager go together");
  }
  const provider = args.rpc ? new ethers.JsonRpcProvider(args.rpc) : undefined;
  // Everything --submit needs is checked before the proof is generated.
  let signer;
  if (args.submit) {
    const key = process.env.WHITELIST_WALLET_KEY;
    if (!chain || !key) {
      throw new Error(
        "--submit needs --rpc, --privacy-manager and env WHITELIST_WALLET_KEY",
      );
    }
    signer = new ethers.Wallet(key, provider);
    if (signer.address !== walletOf(args.wallet)) {
      throw new Error(
        `WHITELIST_WALLET_KEY is for ${signer.address}, --wallet is ${walletOf(args.wallet)}`,
      );
    }
  }
  const calldata = await proveAttestation({
    attestation: box.attestation,
    wallet: args.wallet,
    policy: explicit,
    privacyManager: args["privacy-manager"],
    runner: provider,
  });
  const json = JSON.stringify(calldata, null, 2);
  if (args.out) fs.writeFileSync(args.out, json + "\n");
  if (signer) {
    const r = await submitAttestationProof({
      calldata,
      privacyManager: args["privacy-manager"],
      signer,
    });
    console.error(`submitted (tx ${r.txHash})`);
    console.error(
      `  ${calldata.circuit} record: policyHash ${r.policyHash}, nullifier ${r.nullifier}, expires ${r.expiresAt}`,
    );
    console.error("  record valid: true");
  }
  out(json);
}

if (require.main === module) {
  const box = {};
  main(box).then(
    () => process.exit(0),
    (e) => {
      // No message names the salt or the signature; scrub them anyway.
      let msg = String(e && e.message);
      const a = box.attestation;
      if (a && typeof a === "object") {
        for (const k of ["salt", "R8x", "R8y", "S"]) {
          const forms = [];
          try {
            const v = BigInt(a[k]);
            forms.push(String(a[k]), v.toString(), v.toString(16));
          } catch {}
          for (const f of forms.filter((x) => x.length >= 4)) {
            msg = msg.split(f).join(`<${k}>`);
          }
        }
      }
      console.error(`prove-attestation: ${msg}`);
      process.exit(1);
    },
  );
}

module.exports = {
  PM_ABI,
  proveAttestation,
  submitAttestationProof,
  readChainPolicy,
  checkPolicy,
};
