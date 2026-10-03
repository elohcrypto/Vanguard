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

const { describeProofs } = require("../helpers/zkProofs");
// Guard tests from .omc/plans/2026-09-23-zk-kyc-ownership-cleanup.md, Task 0.1,
// amended by R-3R-2 (owner decisions §N). Each names a soundness property the
// whitelist proof must have before the ZK layer may gate live transfers.
// Task 3.1 made the circuit hard (PLONK, binary path indices, root ===) so C
// and D pass; A and B run against PrivacyManager's root registry and wallet
// binder (Task 3.3).
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

describeProofs("ZK soundness guards (plan Task 0.1)", function () {
  this.timeout(300000);

  let verifier;
  let privacyManager;
  let gen;
  let paths;
  let alice;
  let bob;
  // The list the operator publishes in A and B.
  const listed = [
    { identity: 11111n, secret: 101n },
    { identity: 12345n, secret: 202n },
    { identity: 33333n, secret: 303n },
  ];

  before(async function () {
    [, alice, bob] = await ethers.getSigners();

    gen = new RealProofGenerator();
    await gen.initialize();
    paths = gen.getCircuitPaths("whitelist_membership");

    // Real verifiers, not testingMode: the point is what the cryptography accepts.
    verifier = await (
      await ethers.getContractFactory("ZKVerifierIntegrated")
    ).deploy(false);
    privacyManager = await (
      await ethers.getContractFactory("PrivacyManager")
    ).deploy(await verifier.getAddress());
    const tree = await MerkleTreeBuilder.createFromCommitments(
      listed.map((m) => gen.hash([m.identity, m.secret])),
    );
    await privacyManager.publishWhitelistRoot(
      ethers.toBeHex(tree.getRoot(), 32),
    );
  });

  it("A: rejects a proof built against a Merkle root the list operator never published", async function () {
    // The attacker builds their own one-leaf tree and proves membership in it.
    const attacker = { identity: 777777n, secret: 1n };
    const r = await gen.generateWhitelistProof({
      ...attacker,
      members: [attacker],
      walletBinding: alice.address,
    });
    expect(
      await verifier.verifyWhitelistMembership.staticCall(
        r.proof,
        r.publicSignals,
      ),
      "precondition: the proof itself is valid for the attacker's root",
    ).to.equal(true);

    await expect(
      privacyManager
        .connect(alice)
        .submitWhitelistProof(r.proof, r.publicSignals),
      "a self-built tree must not satisfy the whitelist gate",
    ).to.be.revertedWithCustomError(privacyManager, "RootNotCurrent");
    expect(await privacyManager.hasValidWhitelistProof(alice.address)).to.equal(
      false,
    );
  });

  it("B: a proof submitted by one wallet does not whitelist another wallet that replays it", async function () {
    const r = await gen.generateWhitelistProof({
      ...listed[1],
      members: listed,
      walletBinding: alice.address,
    });

    await privacyManager
      .connect(alice)
      .submitWhitelistProof(r.proof, r.publicSignals);
    expect(await privacyManager.hasValidWhitelistProof(alice.address)).to.equal(
      true,
    );
    // Bob copies Alice's calldata straight off the chain.
    await expect(
      privacyManager
        .connect(bob)
        .submitWhitelistProof(r.proof, r.publicSignals),
      "a replayed proof must not count for the replaying wallet",
    ).to.be.revertedWithCustomError(privacyManager, "WalletBindingMismatch");
    expect(await privacyManager.hasValidWhitelistProof(bob.address)).to.equal(
      false,
    );

    // Alice resubmitting is idempotent: same nullifier, same wallet.
    await expect(
      privacyManager
        .connect(alice)
        .submitWhitelistProof(r.proof, r.publicSignals),
    ).to.not.be.reverted;
    const version = await privacyManager.whitelistVersion();
    expect(
      await privacyManager.nullifierWallet(version, r.publicSignals[0]),
    ).to.equal(alice.address);
    expect(await privacyManager.hasValidWhitelistProof(alice.address)).to.equal(
      true,
    );
  });

  describe("C: a non-member cannot produce a witness", function () {
    const members = [
      { identity: 11111n, secret: 101n },
      { identity: 22222n, secret: 202n },
      { identity: 33333n, secret: 303n },
    ];
    const outsider = { identity: 99999n, secret: 909n };
    let tree;
    let root;

    before(async function () {
      tree = await MerkleTreeBuilder.createFromCommitments(
        members.map((m) => gen.hash([m.identity, m.secret])),
      );
      root = tree.getRoot();
    });

    it("an outsider with a member's Merkle path is rejected by fullProve", async function () {
      const { pathElements, pathIndices } = tree.getProof(0);
      const input = {
        identity: outsider.identity.toString(),
        secret: outsider.secret.toString(),
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
      let a = tree.commitment(members[0].identity, members[0].secret);
      for (let i = 0; i < top; i++) {
        a =
          pathIndices[i] === 0
            ? tree.hash(a, pathElements[i])
            : tree.hash(pathElements[i], a);
      }
      const b = pathElements[top];
      expect(tree.hash(a, b)).to.equal(root);

      // Outsider's node at the top level, using the same lower siblings.
      let L = tree.commitment(outsider.identity, outsider.secret);
      for (let i = 0; i < top; i++) {
        L =
          pathIndices[i] === 0
            ? tree.hash(L, pathElements[i])
            : tree.hash(pathElements[i], L);
      }
      const R = mod(a + b - L);
      const sel = mod((a - L) * inv(R - L));
      expect(sel > 1n, "the attack needs a fractional selector").to.equal(true);
      expect(mod(L + sel * (R - L))).to.equal(a);
      expect(mod(R - sel * (R - L))).to.equal(b);

      const input = {
        identity: outsider.identity.toString(),
        secret: outsider.secret.toString(),
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
    const secret = 0xabcdef0123456789n;
    const members = [
      { identity: 11111n, secret: 101n },
      { identity, secret },
      { identity: 33333n, secret: 303n },
    ];
    let tree;
    let r;
    let root;

    before(async function () {
      r = await gen.generateWhitelistProof({
        identity,
        secret,
        members,
        walletBinding: alice.address,
      });
      tree = await MerkleTreeBuilder.createFromCommitments(
        members.map((m) => gen.hash([m.identity, m.secret])),
      );
      root = tree.getRoot();
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
        gen.hash([secret, root]).toString(),
        root.toString(),
        BigInt(alice.address).toString(),
      ]);
    });

    it("the right identity with the wrong secret cannot produce a witness", async function () {
      const input = {
        identity: identity.toString(),
        secret: (secret + 1n).toString(),
        ...tree.getProof(1),
        merkleRoot: root.toString(),
        walletBinding: BigInt(alice.address).toString(),
      };
      input.pathElements = input.pathElements.map(String);
      await expect(
        snarkjs.plonk.fullProve(input, paths.wasm, paths.zkey),
      ).to.be.rejectedWith(/Assert Failed/);
    });

    it("one identity under two secrets gives two leaves and two nullifiers", async function () {
      // Nothing in the circuit ties a nullifier to an identity: an identity
      // holding two commitments under one root gets two nullifiers, i.e. two
      // wallets past D29's one-wallet rule. The operator's
      // one-commitment-per-identity rule at onboarding (Task 3.5) is what
      // closes this; this test pins the property that rule relies on.
      const secret2 = 0x1234n;
      const twice = [...members, { identity, secret: secret2 }];
      const t2 = await MerkleTreeBuilder.createFromCommitments(
        twice.map((m) => gen.hash([m.identity, m.secret])),
      );
      expect(t2.commitment(identity, secret)).to.not.equal(
        t2.commitment(identity, secret2),
      );
      const p1 = await gen.generateWhitelistProof({
        identity,
        secret,
        members: twice,
        walletBinding: alice.address,
      });
      const p2 = await gen.generateWhitelistProof({
        identity,
        secret: secret2,
        members: twice,
        walletBinding: bob.address,
      });
      expect(p1.publicSignals[1]).to.equal(p2.publicSignals[1]);
      expect(p1.publicSignals[0]).to.not.equal(p2.publicSignals[0]);
    });

    it("the nullifier cannot be recomputed from the identity alone", async function () {
      // The pre-D30 formula Poseidon(identity, root) needed no secret, so
      // anyone could link a public nullifier to an enumerated identity.
      expect(gen.hash([identity, root]).toString()).to.not.equal(
        r.publicSignals[0],
      );
      expect(gen.hash([secret, root]).toString()).to.equal(r.publicSignals[0]);
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
      console.log(
        `      wrapper verifyWhitelistMembership gasUsed: ${receipt.gasUsed}`,
      );

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
        secret: secret.toString(),
        ...tree.getProof(1),
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
