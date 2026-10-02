const { expect } = require("chai");
const { ethers, artifacts } = require("hardhat");
const fs = require("fs");
const path = require("path");
const snarkjs = require("snarkjs");
const { RealProofGenerator } = require(
  path.join(__dirname, "../../scripts/generate-real-proofs.js"),
);
const { MerkleTreeBuilder } = require(
  path.join(__dirname, "../../utils/merkle-tree-builder.js"),
);
const { ProofFormatter } = require(
  path.join(__dirname, "../../utils/proof-formatter.js"),
);
const { loadAliasingSnarkjs } = require("../helpers/plonkAliasProver.js");

// Guard tests from .omc/plans/2026-09-23-zk-kyc-ownership-cleanup.md, Task 0.1,
// amended by R-3R-2 (owner decisions §N). Each names a soundness property the
// whitelist proof must have before the ZK layer may gate live transfers.
// Task 3.1 made the circuit hard (PLONK, binary path indices, root ===) so C
// and D pass; A and B need the published-root compare and the wallet binding
// in PrivacyManager (Task 3.3).
const WHITELIST_CIRCUIT = ethers.keccak256(
  ethers.toUtf8Bytes("WHITELIST_MEMBERSHIP"),
);
// BN254 scalar field.
const P =
  21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const mod = (x) => ((x % P) + P) % P;
function inv(a) {
  let [r0, r1, s0, s1] = [mod(a), P, 1n, 0n];
  while (r1 !== 0n) {
    const q = r0 / r1;
    [r0, r1] = [r1, r0 - q * r1];
    [s0, s1] = [s1, s0 - q * s1];
  }
  return mod(s0);
}

describe("ZK soundness guards (plan Task 0.1)", function () {
  this.timeout(300000);

  let verifier;
  let privacyManager;
  let gen;
  let paths;
  let alice;
  let bob;

  before(async function () {
    [, alice, bob] = await ethers.getSigners();

    gen = new RealProofGenerator();
    await gen.initialize();
    paths = gen.getCircuitPaths("whitelist_membership");

    // Real verifiers, not testingMode: the point is what the cryptography accepts.
    verifier = await (
      await ethers.getContractFactory("ZKVerifierIntegrated")
    ).deploy(false);
    const rules = await (
      await ethers.getContractFactory("MockComplianceRules")
    ).deploy();
    const oracleManager = await (
      await ethers.getContractFactory("MockOracleManager")
    ).deploy();
    privacyManager = await (
      await ethers.getContractFactory("PrivacyManager")
    ).deploy(
      await verifier.getAddress(),
      await rules.getAddress(),
      await oracleManager.getAddress(),
    );
  });

  // Green in 3.3: needs PrivacyManager to compare merkleRoot with the published root.
  it.skip("A: rejects a proof built against a Merkle root the list operator never published", async function () {
    // The attacker builds their own one-leaf tree and proves membership in it.
    const attacker = 777777n;
    const r = await gen.generateWhitelistProof({
      identity: attacker,
      whitelistIdentities: [attacker],
      walletBinding: alice.address,
    });

    const accepted = await verifier.verifyWhitelistMembership.staticCall(
      r.proof,
      r.publicSignals,
    );

    expect(
      accepted,
      "a self-built tree must not satisfy the whitelist gate",
    ).to.equal(false);
  });

  // Green in 3.3: needs walletBinding == msg.sender in PrivacyManager (new API).
  it.skip("B: a proof submitted by one wallet does not whitelist another wallet that replays it", async function () {
    const r = await gen.generateWhitelistProof({
      identity: 12345n,
      whitelistIdentities: [11111n, 12345n, 33333n],
      walletBinding: alice.address,
    });
    const unused = { a: [0, 0], b: [[0, 0], [0, 0]], c: [0, 0] };
    const inputs = [...r.proof, ...r.publicSignals];

    await privacyManager
      .connect(alice)
      .submitPrivateProof(WHITELIST_CIRCUIT, unused, inputs);
    // Bob copies Alice's calldata straight off the chain.
    await privacyManager
      .connect(bob)
      .submitPrivateProof(WHITELIST_CIRCUIT, unused, inputs);

    const [, bobValid] = await privacyManager.getUserProofInfo(
      bob.address,
      WHITELIST_CIRCUIT,
    );
    expect(
      bobValid,
      "a replayed proof must not count for the replaying wallet",
    ).to.equal(false);
  });

  describe("C: a non-member cannot produce a witness", function () {
    const members = [11111n, 22222n, 33333n];
    const outsider = 99999n;
    let tree;
    let root;

    before(async function () {
      tree = await MerkleTreeBuilder.createFromIdentities(members);
      root = tree.getRoot();
    });

    it("an outsider with a member's Merkle path is rejected by fullProve", async function () {
      const { pathElements, pathIndices } = tree.getProof(0);
      const input = {
        identity: outsider.toString(),
        pathElements: pathElements.map(String),
        pathIndices,
        merkleRoot: root.toString(),
        walletBinding: BigInt(alice.address).toString(),
      };
      await expect(
        snarkjs.plonk.fullProve(input, paths.wasm, paths.zkey),
      ).to.be.rejectedWith(/Assert Failed/);
    });

    it("a non-binary path index cannot steer an outsider to the real root", async function () {
      // Readiness review B2: circomlib Switcher is linear in `sel`, so with
      // R = a + b - L and sel = (a - L) / (R - L) its outputs are exactly the
      // real root's children (a, b). Only sel * (1 - sel) === 0 stops this.
      const levels = 20;
      const top = levels - 1;
      const { pathElements, pathIndices } = tree.getProof(0);
      // Real children of the root: a from leaf 0's path, b its sibling.
      let a = tree.hashSingle(members[0]);
      for (let i = 0; i < top; i++) {
        a = pathIndices[i] === 0
          ? tree.hash(a, pathElements[i])
          : tree.hash(pathElements[i], a);
      }
      const b = pathElements[top];
      expect(tree.hash(a, b)).to.equal(root);

      // Outsider's node at the top level, using the same lower siblings.
      let L = tree.hashSingle(outsider);
      for (let i = 0; i < top; i++) {
        L = pathIndices[i] === 0
          ? tree.hash(L, pathElements[i])
          : tree.hash(pathElements[i], L);
      }
      const R = mod(a + b - L);
      const sel = mod((a - L) * inv(R - L));
      expect(sel > 1n, "the attack needs a fractional selector").to.equal(true);
      expect(mod(L + sel * (R - L))).to.equal(a);
      expect(mod(R - sel * (R - L))).to.equal(b);

      const input = {
        identity: outsider.toString(),
        pathElements: [...pathElements.slice(0, top), R].map(String),
        pathIndices: [...pathIndices.slice(0, top), sel.toString()],
        merkleRoot: root.toString(),
        walletBinding: BigInt(alice.address).toString(),
      };
      await expect(
        snarkjs.plonk.fullProve(input, paths.wasm, paths.zkey),
      ).to.be.rejectedWith(/Assert Failed/);
    });
  });

  describe("D: the PLONK setup property", function () {
    const identity = 12345n;
    const members = [11111n, 12345n, 33333n];
    let r;
    let root;

    before(async function () {
      r = await gen.generateWhitelistProof({
        identity,
        whitelistIdentities: members,
        walletBinding: alice.address,
      });
      root = (await MerkleTreeBuilder.createFromIdentities(members)).getRoot();
    });

    it("the committed whitelist verifier is a PLONK verifier with nPublic 3", async function () {
      const artifact = await artifacts.readArtifact(
        "WhitelistMembershipVerifier",
      );
      const fn = artifact.abi.find((x) => x.name === "verifyProof");
      expect(fn.inputs.map((i) => i.type)).to.deep.equal([
        "uint256[24]",
        "uint256[3]",
      ]);
      const vkey = JSON.parse(fs.readFileSync(paths.vkey, "utf8"));
      expect(vkey.protocol).to.equal("plonk");
      expect(vkey.nPublic).to.equal(3);
    });

    it("public signals are [nullifier, merkleRoot, walletBinding]", async function () {
      expect(r.proof).to.have.lengthOf(24);
      expect(r.publicSignals).to.deep.equal([
        gen.hash([identity, root]).toString(),
        root.toString(),
        BigInt(alice.address).toString(),
      ]);
    });

    it("a real member proof verifies on-chain through the wrapper", async function () {
      expect(
        await verifier.verifyWhitelistMembership.staticCall(
          r.proof,
          r.publicSignals,
        ),
      ).to.equal(true);
      const tx = await verifier.verifyWhitelistMembership(
        r.proof,
        r.publicSignals,
      );
      const receipt = await tx.wait();
      console.log(`      wrapper verifyWhitelistMembership gasUsed: ${receipt.gasUsed}`);

      const plonk = await ethers.getContractAt(
        "WhitelistMembershipVerifier",
        await verifier.whitelistVerifier(),
      );
      const est = await plonk.verifyProof.estimateGas(r.proof, r.publicSignals);
      console.log(`      PlonkVerifier.verifyProof eth_estimateGas: ${est}`);
    });

    it("rejects the proof with any one proof word tampered", async function () {
      for (const k of [0, 9, 18, 23]) {
        const bad = [...r.proof];
        bad[k] = (BigInt(bad[k]) + 1n).toString();
        expect(
          await verifier.verifyWhitelistMembership.staticCall(
            bad,
            r.publicSignals,
          ),
          `tampered word ${k} must not verify`,
        ).to.equal(false);
      }
    });

    it("rejects the proof with an altered merkleRoot or walletBinding signal", async function () {
      const otherRoot = [...r.publicSignals];
      otherRoot[1] = (BigInt(otherRoot[1]) + 1n).toString();
      expect(
        await verifier.verifyWhitelistMembership.staticCall(r.proof, otherRoot),
      ).to.equal(false);

      const otherWallet = [...r.publicSignals];
      otherWallet[2] = BigInt(bob.address).toString();
      expect(
        await verifier.verifyWhitelistMembership.staticCall(
          r.proof,
          otherWallet,
        ),
      ).to.equal(false);
    });

    it("rejects a non-canonical nullifier (n + q) the raw verifier accepts", async function () {
      // A second proof for bob from the same identity, built with a prover
      // whose transcript hashes n + q: the PLONK verifier reduces signals
      // mod q in the PI term, so [n + q, root, bob] verifies there and would
      // look like a fresh nullifier to a nullifier -> wallet map.
      const aliasing = loadAliasingSnarkjs();
      const input = {
        identity: identity.toString(),
        ...(await MerkleTreeBuilder.createFromIdentities(members)).getProof(
          members.indexOf(identity),
        ),
        merkleRoot: root.toString(),
        walletBinding: BigInt(bob.address).toString(),
      };
      input.pathElements = input.pathElements.map(String);
      const wtns = { type: "mem" };
      await snarkjs.wtns.calculate(input, paths.wasm, wtns);
      aliasing.__setAliasK(1);
      const m = await aliasing.plonk.prove(paths.zkey, wtns);
      aliasing.__setAliasK(0);
      const c = await ProofFormatter.formatPlonkForSolidity(
        m.proof,
        m.publicSignals,
      );
      const aliased = [
        (BigInt(c.publicSignals[0]) + P).toString(),
        ...c.publicSignals.slice(1),
      ];
      expect(c.publicSignals[0]).to.equal(r.publicSignals[0]);

      const plonk = await ethers.getContractAt(
        "WhitelistMembershipVerifier",
        await verifier.whitelistVerifier(),
      );
      expect(
        await plonk.verifyProof(c.proof, aliased),
        "precondition: raw verifier accepts the alias",
      ).to.equal(true);

      expect(
        await verifier.verifyWhitelistMembership.staticCall(c.proof, aliased),
      ).to.equal(false);
      const receipt = await (
        await verifier.verifyWhitelistMembership(c.proof, aliased)
      ).wait();
      const cached = receipt.logs
        .map((l) => verifier.interface.parseLog(l))
        .filter((e) => e && e.name === "ProofCached");
      expect(cached).to.have.lengthOf(0);
    });
  });
});
