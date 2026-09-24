const { expect } = require("chai");
const { ethers } = require("hardhat");
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

// Guard tests from .omc/plans/2026-09-23-zk-kyc-ownership-cleanup.md, Task 0.1.
// Each one names a soundness property the whitelist proof must have before the
// ZK layer may gate live transfers. They fail on the current circuits and are
// made to pass in Phase 3 (Tasks 3.1-3.3).
const WHITELIST_CIRCUIT = ethers.keccak256(
  ethers.toUtf8Bytes("WHITELIST_MEMBERSHIP"),
);

// PENDING until Phase 3: observed RED on 2026-09-23 (all three accepted, see the
// plan ledger). Change `describe.skip` to `describe` in Task 3.2.
describe.skip("ZK soundness guards (plan Task 0.1)", function () {
  this.timeout(300000);

  let verifier;
  let privacyManager;
  let gen;
  let alice;
  let bob;

  before(async function () {
    [, alice, bob] = await ethers.getSigners();

    gen = new RealProofGenerator();
    await gen.initialize();

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

  it("A: rejects a proof built against a Merkle root the list operator never published", async function () {
    // The attacker builds their own one-leaf tree and proves membership in it.
    const attacker = 777777n;
    const r = await gen.generateWhitelistProof({
      identity: attacker,
      whitelistIdentities: [attacker],
    });

    const accepted = await verifier.verifyWhitelistMembership.staticCall(
      r.proof.a,
      r.proof.b,
      r.proof.c,
      r.publicSignals,
    );

    expect(
      accepted,
      "a self-built tree must not satisfy the whitelist gate",
    ).to.equal(false);
  });

  it("B: a proof submitted by one wallet does not whitelist another wallet that replays it", async function () {
    const r = await gen.generateWhitelistProof({
      identity: 12345n,
      whitelistIdentities: [11111n, 12345n, 33333n],
    });
    const proof = { a: r.proof.a, b: r.proof.b, c: r.proof.c };

    await privacyManager
      .connect(alice)
      .submitPrivateProof(WHITELIST_CIRCUIT, proof, r.publicSignals);
    // Bob copies Alice's calldata straight off the chain.
    await privacyManager
      .connect(bob)
      .submitPrivateProof(WHITELIST_CIRCUIT, proof, r.publicSignals);

    const [, bobValid] = await privacyManager.getUserProofInfo(
      bob.address,
      WHITELIST_CIRCUIT,
    );
    expect(
      bobValid,
      "a replayed proof must not count for the replaying wallet",
    ).to.equal(false);
  });

  it("C: rejects a proof whose own circuit output says the identity is NOT in the tree", async function () {
    const members = [11111n, 22222n, 33333n];
    const tree = await MerkleTreeBuilder.createFromIdentities(members);
    const outsider = 99999n;
    const root = tree.getRoot();
    // Someone else's Merkle path, paired with an identity that is not a leaf.
    const { pathElements, pathIndices } = tree.getProof(0);

    const input = {
      identity: outsider.toString(),
      pathElements: pathElements.map((x) => x.toString()),
      pathIndices,
      merkleRoot: root.toString(),
      nullifierHash: gen.hash([outsider, root]).toString(),
    };
    const paths = gen.getCircuitPaths("whitelist_membership");
    const { proof, publicSignals } = await snarkjs.groth16.fullProve(
      input,
      paths.wasm,
      paths.zkey,
    );

    // The circuit itself reports "invalid" ...
    expect(publicSignals[0]).to.equal("0");

    // ... and the verifier must not turn that into "accepted".
    const f = ProofFormatter.formatForSolidity(proof, publicSignals);
    const accepted = await verifier.verifyWhitelistMembership.staticCall(
      f.a,
      f.b,
      f.c,
      publicSignals,
    );
    expect(
      accepted,
      "verifier must reject when the circuit output isValid is 0",
    ).to.equal(false);
  });
});
