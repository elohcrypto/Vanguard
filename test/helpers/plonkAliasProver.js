// Test-only: loads an in-memory copy of snarkjs whose PLONK prover hashes
// publicSignals[i] + k*q (instead of the reduced value) into the beta
// transcript (i = 0 by default; __setAliasK(k, i, nPublic)). A proof built this way verifies against [n + k*q, ...] in a
// snarkjs PLONK verifier, which reduces signals mod q in the PI term but
// hashes the raw calldata words. Used to show the wrapper rejects such
// aliased (non-canonical) public signals. Nothing is written to disk.
const fs = require("fs");
const Module = require("module");
const path = require("path");

const ANCHOR =
  "const value = ffjavascript.Scalar.fromRprBE(sha3.keccak_256(buffer));";
// Beta transcript: 8 vk commitments (64 bytes each), then the public
// signals, then A, B, C: 11 polynomials and nPublic scalars (3 for the
// whitelist, 4 for the blacklist).
const PATCH = `
        if (__aliasK && nPolynomials === 11 && nScalars === __aliasN) {
            const q = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
            const at = 512 + 32 * __aliasI;
            let v = 0n;
            for (let j = 0; j < 32; j++) v = (v << 8n) | BigInt(buffer[at + j]);
            v += q * __aliasK;
            for (let j = 31; j >= 0; j--) { buffer[at + j] = Number(v & 255n); v >>= 8n; }
        }
`;

function loadAliasingSnarkjs() {
  const file = require.resolve("snarkjs");
  const src = fs.readFileSync(file, "utf8");
  if (src.split(ANCHOR).length !== 2) {
    throw new Error("snarkjs transcript anchor not found exactly once");
  }
  const patched =
    "let __aliasK = 0n; let __aliasI = 0; let __aliasN = 3;\n" +
    src.replace(ANCHOR, PATCH + "        " + ANCHOR) +
    "\nexports.__setAliasK = (k, i = 0, n = 3) => {" +
    " __aliasK = BigInt(k); __aliasI = i; __aliasN = n; };\n";
  const m = new Module(file, module);
  m.filename = file;
  m.paths = Module._nodeModulePaths(path.dirname(file));
  m._compile(patched, file);
  return m.exports;
}

module.exports = { loadAliasingSnarkjs };
