// Shared fixture of the three attestation soundness tests (plan v2 Task
// 3.7b, D31 a): a real-mode wrapper, a PrivacyManager on it, an issuer key
// trusted for the circuit, witness and aliasing helpers, and the
// reproduce-the-committed-verifier check (test D).
const { expect } = require("chai");
const { ethers } = require("hardhat");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const snarkjs = require("snarkjs");
const { RealProofGenerator } = require("../../scripts/generate-real-proofs");
const { ProofFormatter } = require("../../utils/proof-formatter");
const {
  CIRCUITS,
  newAttestorKey,
  attestorPublicKey,
  attestorId,
  signAttestation,
} = require("../../scripts/zk/attest");
const { proveAttestation } = require("../../scripts/zk/prove-attestation");
const { loadAliasingSnarkjs } = require("./plonkAliasProver");

const Q =
  21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const ROOT = path.join(__dirname, "../..");

/** Where an EdDSA signature check fails in the witness calculator. */
const IN_SIGNATURE =
  /Assert Failed\. Error in template (ForceEqualIfEnabled|EdDSAPoseidonVerifier|BabyCheck)/;

/**
 * Task 3.8: a ComplianceRules (empty default rule: every code allowed)
 * behind a policy token (MockPolicyToken.compliance()) as `pm`'s
 * jurisdiction source, and `codes` registered in order (the n-th gets bit
 * 1 << n). Default US, DE, GB, CA: mask 15. `token` is the address,
 * `policyToken` the contract (setCompliance models a Token vote).
 */
async function wireJurisdictionSource(pm, codes = [840, 276, 826, 124]) {
  const [owner] = await ethers.getSigners();
  const rules = await (
    await ethers.getContractFactory("ComplianceRules")
  ).deploy(owner.address, [], []);
  const policyToken = await (
    await ethers.getContractFactory("MockPolicyToken")
  ).deploy(await rules.getAddress());
  const token = await policyToken.getAddress();
  await pm.setPolicyToken(token);
  for (const c of codes) await pm.registerJurisdictionCode(c);
  return { rules, token, policyToken };
}

/**
 * Deploy the wrapper and PrivacyManager, trust a fresh issuer key for
 * `circuit` and return the context. Policies are the caller's, except the
 * jurisdiction source (wireJurisdictionSource, mask 15).
 */
async function deployAttestationFixture(circuit) {
  const wallets = await ethers.getSigners();
  const zk = await (
    await ethers.getContractFactory("ZKVerifierIntegrated")
  ).deploy(false);
  const pm = await (
    await ethers.getContractFactory("PrivacyManager")
  ).deploy(await zk.getAddress());
  const key = newAttestorKey();
  const { Ax, Ay } = await attestorPublicKey(key);
  const id = CIRCUITS[circuit].id;
  await pm.setTrustedAttestor(id, Ax, Ay, true);
  const source =
    circuit === "jurisdiction" ? await wireJurisdictionSource(pm) : {};
  const gen = new RealProofGenerator();
  await gen.initialize();
  return {
    ...source,
    wallets,
    zk,
    pm,
    key,
    Ax,
    Ay,
    id,
    attestor: attestorId(Ax, Ay),
    gen,
    paths: gen.getCircuitPaths(CIRCUITS[circuit].build),
    // Task 3.8 M1: signed for this chain and this PrivacyManager.
    sign: (attrs, k = key, target = pm.target) =>
      signAttestation({
        key: k,
        circuit,
        chainId: 31337,
        privacyManager: target,
        identity: 0xa11ce,
        ...attrs,
      }),
    prove: (attestation, wallet) =>
      proveAttestation({
        attestation,
        wallet: wallet.address,
        privacyManager: pm.target,
        runner: wallet,
        generator: gen,
      }),
  };
}

/** The circuit input an honest prover builds; callers override fields. */
function circuitInput(att, policy, wallet, overrides = {}) {
  const base = {
    identity: att.identity,
    salt: att.salt,
    R8x: att.R8x,
    R8y: att.R8y,
    S: att.S,
    Ax: att.Ax,
    Ay: att.Ay,
    chainId: String(att.chainId),
    verifierContext: BigInt(att.privacyManager).toString(),
    walletBinding: BigInt(wallet).toString(),
  };
  const p = policy.map(String);
  if (att.circuit === "jurisdiction") {
    Object.assign(base, { userMask: att.attributes[0], allowedMask: p[0] });
  } else if (att.circuit === "accreditation") {
    Object.assign(base, {
      amount: att.attributes[0],
      minimumAccreditation: p[0],
    });
  } else {
    Object.assign(base, {
      scores: att.attributes,
      minimum: p[0],
      weights: p.slice(1),
    });
  }
  return { ...base, ...overrides };
}

const witness = (paths, input) =>
  snarkjs.wtns.calculate(input, paths.wasm, { type: "mem" });

async function cachedEvents(zk, tx) {
  const receipt = await tx.wait();
  return receipt.logs
    .map((l) => zk.interface.parseLog(l))
    .filter((e) => e && e.name === "ProofCached");
}

/**
 * A real proof of `input` whose transcript hashed signal `i` as s + q: the
 * raw verifier accepts it against the aliased signals.
 * @returns {Promise<{proof: string[], signals: string[]}>}
 */
async function aliasedProof(paths, input, i, nPublic) {
  const wtns = { type: "mem" };
  await snarkjs.wtns.calculate(input, paths.wasm, wtns);
  const aliasing = loadAliasingSnarkjs();
  aliasing.__setAliasK(1, i, nPublic);
  let m;
  try {
    m = await aliasing.plonk.prove(paths.zkey, wtns);
  } finally {
    aliasing.__setAliasK(0);
  }
  const c = await ProofFormatter.formatPlonkForSolidity(
    m.proof,
    m.publicSignals,
  );
  const signals = [...c.publicSignals];
  signals[i] = (BigInt(signals[i]) + Q).toString();
  return { proof: c.proof, signals };
}

/**
 * Test D: recompile the committed circuit, run the setup:zk commands and
 * compare the exported verifier with the committed one byte for byte.
 * Skips honestly without circom 2.x.
 */
function reproducesCommittedVerifier(ctx, build, contractName) {
  const candidates = [
    process.env.CIRCOM_BIN,
    path.join(os.homedir(), ".cargo/bin/circom"),
    "/usr/local/bin/circom",
  ].filter(Boolean);
  const circom = candidates.find((c) => {
    try {
      return /\b2\.\d+\.\d+/.test(execFileSync(c, ["--version"]).toString());
    } catch {
      return false;
    }
  });
  if (!circom) {
    // CI builds circom 2.x before the tests: a pending test there would
    // hide a lost circom (review 3.9 C-7), so it fails instead.
    if (process.env.CI) {
      throw new Error(
        "circom 2.x not found (CIRCOM_BIN, ~/.cargo/bin, /usr/local/bin): required when CI is set",
      );
    }
    ctx.skip();
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "att-setup-"));
  try {
    execFileSync(circom, [
      path.join(ROOT, "circuits", `${build}.circom`),
      "--r1cs",
      "-o",
      tmp,
      "-l",
      path.join(ROOT, "node_modules"),
    ]);
    const zkey = path.join(tmp, "c.zkey");
    const out = path.join(tmp, "v.sol");
    // The same commands setup:zk runs (scripts/setup-zk-circuits.js).
    const snarkjsBin = path.join(ROOT, "node_modules/.bin/snarkjs");
    execFileSync(snarkjsBin, [
      "plonk",
      "setup",
      path.join(tmp, `${build}.r1cs`),
      path.join(ROOT, "build/circuits/powersOfTau28_hez_final_15.ptau"),
      zkey,
    ]);
    execFileSync(snarkjsBin, ["zkey", "export", "solidityverifier", zkey, out]);
    const src = fs
      .readFileSync(out, "utf8")
      .replace(/contract (Groth16|Plonk)Verifier/g, `contract ${contractName}`);
    const committed = fs.readFileSync(
      path.join(ROOT, "contracts/privacy/verifiers", `${build}Verifier.sol`),
      "utf8",
    );
    const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");
    expect(sha(src)).to.equal(sha(committed));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/** Test C: every signal tampered (+1, binding swapped) is refused, uncached. */
async function expectTamperedRefused(zk, route, r) {
  const n = r.signals.length;
  for (let i = 0; i < n; i++) {
    const bad = [...r.signals];
    bad[i] =
      i === n - 1 ? 0xbeefn.toString() : (BigInt(bad[i]) + 1n).toString();
    expect(await zk[route].staticCall(r.proof, bad), `signal ${i}`).to.equal(
      false,
    );
    const tx = await zk[route](r.proof, bad);
    expect(await cachedEvents(zk, tx), `signal ${i} cached`).to.have.lengthOf(
      0,
    );
  }
  for (const k of [0, 11, 23]) {
    const bad = [...r.proof];
    bad[k] = (BigInt(bad[k]) + 1n).toString();
    expect(await zk[route].staticCall(bad, r.signals), `word ${k}`).to.equal(
      false,
    );
  }
}

module.exports = {
  Q,
  IN_SIGNATURE,
  wireJurisdictionSource,
  deployAttestationFixture,
  circuitInput,
  witness,
  cachedEvents,
  aliasedProof,
  reproducesCommittedVerifier,
  expectTamperedRefused,
};
