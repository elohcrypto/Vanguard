const { expect } = require("chai");
const { ethers, artifacts } = require("hardhat");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const snarkjs = require("snarkjs");
const { RealProofGenerator } = require(
  path.join(__dirname, "../../scripts/generate-real-proofs.js"),
);
const { MerkleTreeBuilder } = require(
  path.join(__dirname, "../../utils/merkle-tree-builder.js"),
);
const { buildBlacklistSmt, nonInclusionWitness } = require(
  path.join(__dirname, "../../utils/smt-builder.js"),
);
const { ProofFormatter } = require(
  path.join(__dirname, "../../utils/proof-formatter.js"),
);
const { loadAliasingSnarkjs } = require("../helpers/plonkAliasProver.js");

// Task 3.7 (plan v2): the blacklist circuit states "the wallet's holder owns a
// commitment in the current whitelist root whose identity is not in the
// sanctions tree". It is a non-gating demonstration (D2): the wrapper
// verifies it, PrivacyManager refuses it, nothing on chain gates on it.
// A-F mirror the whitelist guards in ZKSoundness.test.js.
const P =
  21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const CIRCUIT = "blacklist_membership";
// Where a witness fails: the sanctions check, the whitelist inclusion, or the
// circuit's own isOld0 binary constraint.
const IN_SMT =
  /Assert Failed\. Error in template SMTVerifier|ForceEqualIfEnabled/;
const IN_WHITELIST = /Assert Failed\. Error in template MerkleInclusion/;
const IN_MAIN = /Assert Failed\. Error in template BlacklistNonMembership/;

describe("Blacklist non-membership soundness (Task 3.7)", function () {
  this.timeout(600000);

  // Whitelist commitments the operator publishes.
  const alice = { identity: 11111n, secret: 101n };
  const listedMember = { identity: 22222n, secret: 202n }; // also sanctioned
  const carol = { identity: 33333n, secret: 303n };
  const members = [alice, listedMember, carol];
  // Sanctions list: one whitelisted identity plus two others.
  const sanctioned = [22222n, 44444n, 55555n];

  let gen;
  let paths;
  let verifier;
  let wallets;
  let r; // alice's valid proof, bound to wallets[1]
  let wlTree;
  let smt;

  // Circuit input for `who`, built honestly; callers override fields.
  async function honestInput(who, wallet, overrides = {}) {
    const leaf = wlTree.commitment(who.identity, who.secret);
    let idx = wlTree.findLeafIndex(leaf);
    if (idx === -1) idx = 0; // outsider: borrow a member's path
    const { pathElements, pathIndices } = wlTree.getProof(idx);
    const res = await smt.tree.find(who.identity);
    const F = smt.tree.F;
    const siblings = res.siblings.map((s) => F.toObject(s));
    while (siblings.length < 20) siblings.push(0n);
    return {
      identity: who.identity.toString(),
      secret: who.secret.toString(),
      pathElements: pathElements.map(String),
      pathIndices,
      siblings: siblings.map(String),
      oldKey: res.found ? "0" : String(F.toObject(res.notFoundKey)),
      oldValue: res.found ? "0" : String(F.toObject(res.notFoundValue)),
      isOld0: res.isOld0 ? 1 : 0,
      whitelistRoot: wlTree.getRoot().toString(),
      blacklistRoot: smt.root.toString(),
      walletBinding: BigInt(wallet).toString(),
      ...overrides,
    };
  }

  const witness = (input) =>
    snarkjs.wtns.calculate(input, paths.wasm, { type: "mem" });

  async function cachedEvents(tx) {
    const receipt = await tx.wait();
    return receipt.logs
      .map((l) => verifier.interface.parseLog(l))
      .filter((e) => e && e.name === "ProofCached");
  }

  before(async function () {
    wallets = await ethers.getSigners();
    gen = new RealProofGenerator();
    await gen.initialize();
    paths = gen.getCircuitPaths(CIRCUIT);
    wlTree = await MerkleTreeBuilder.createFromCommitments(
      members.map((m) => gen.hash([m.identity, m.secret])),
    );
    smt = await buildBlacklistSmt(sanctioned);
    verifier = await (
      await ethers.getContractFactory("ZKVerifierIntegrated")
    ).deploy(false);
    r = await gen.generateBlacklistProof({
      ...alice,
      members,
      blacklistIdentities: sanctioned,
      walletBinding: wallets[1].address,
    });
  });

  describe("A: a sanctioned identity cannot produce a witness", function () {
    it("the prover refuses before proving", async function () {
      await expect(
        gen.generateBlacklistProof({
          ...listedMember,
          members,
          blacklistIdentities: sanctioned,
          walletBinding: wallets[2].address,
        }),
      ).to.be.rejectedWith(/is on the sanctions list/);
      await expect(
        nonInclusionWitness(smt.tree, listedMember.identity),
      ).to.be.rejectedWith(/is on the sanctions list/);
    });

    it("claiming its own leaf as the 'other' leaf fails (oldKey == key)", async function () {
      const res = await smt.tree.find(listedMember.identity);
      expect(res.found, "precondition: listed").to.equal(true);
      const input = await honestInput(listedMember, wallets[2].address, {
        oldKey: listedMember.identity.toString(),
        oldValue: "1",
        isOld0: 0,
      });
      await expect(witness(input)).to.be.rejectedWith(IN_SMT);
    });

    it("claiming an empty slot on its path fails (root mismatch)", async function () {
      const input = await honestInput(listedMember, wallets[2].address, {
        isOld0: 1,
      });
      await expect(witness(input)).to.be.rejectedWith(IN_SMT);
    });

    it("another listed leaf's path does not lead to its key", async function () {
      const other = await smt.tree.find(44444n);
      const F = smt.tree.F;
      const siblings = other.siblings.map((s) => String(F.toObject(s)));
      while (siblings.length < 20) siblings.push("0");
      const input = await honestInput(listedMember, wallets[2].address, {
        siblings,
        oldKey: "44444",
        oldValue: "1",
        isOld0: 0,
      });
      await expect(witness(input)).to.be.rejectedWith(IN_SMT);
    });

    it("a non-binary isOld0 is refused", async function () {
      const input = await honestInput(alice, wallets[1].address, {
        isOld0: 2,
      });
      await expect(witness(input)).to.be.rejectedWith(IN_MAIN);
    });
  });

  describe("B: an identity outside the whitelist root cannot produce a witness", function () {
    it("the prover refuses an unknown commitment", async function () {
      await expect(
        gen.generateBlacklistProof({
          identity: 99999n,
          secret: 909n,
          members,
          blacklistIdentities: sanctioned,
          walletBinding: wallets[3].address,
        }),
      ).to.be.rejectedWith(/Commitment not found in whitelist/);
    });

    it("an unsanctioned outsider with a member's path fails", async function () {
      const input = await honestInput(
        { identity: 99999n, secret: 909n },
        wallets[3].address,
      );
      await expect(witness(input)).to.be.rejectedWith(IN_WHITELIST);
    });

    it("a member's identity with the wrong secret fails", async function () {
      const input = await honestInput(alice, wallets[1].address, {
        secret: (alice.secret + 1n).toString(),
      });
      await expect(witness(input)).to.be.rejectedWith(IN_WHITELIST);
    });

    it("a member's secret under another identity fails", async function () {
      // Swapping the identity (to dodge the sanctions key) breaks the leaf.
      const input = await honestInput(listedMember, wallets[2].address);
      const forAlice = await honestInput(alice, wallets[2].address);
      input.identity = alice.identity.toString();
      Object.assign(input, {
        siblings: forAlice.siblings,
        oldKey: forAlice.oldKey,
        oldValue: forAlice.oldValue,
        isOld0: forAlice.isOld0,
      });
      await expect(witness(input)).to.be.rejectedWith(IN_WHITELIST);
    });
  });

  describe("C: the wrapper refuses tampered public signals and caches nothing", function () {
    const cases = [
      ["nullifier", 0, (x) => x + 1n],
      ["whitelistRoot", 1, (x) => x + 1n],
      ["blacklistRoot", 2, (x) => x + 1n],
      ["walletBinding", 3, () => 0xbeefn],
    ];
    for (const [name, i, f] of cases) {
      it(`wrong ${name}`, async function () {
        const bad = [...r.publicSignals];
        bad[i] = f(BigInt(bad[i])).toString();
        expect(
          await verifier.verifyBlacklistNonMembership.staticCall(r.proof, bad),
        ).to.equal(false);
        const tx = await verifier.verifyBlacklistNonMembership(r.proof, bad);
        expect(await cachedEvents(tx)).to.have.lengthOf(0);
      });
    }

    it("any tampered proof word", async function () {
      for (const k of [0, 11, 23]) {
        const bad = [...r.proof];
        bad[k] = (BigInt(bad[k]) + 1n).toString();
        expect(
          await verifier.verifyBlacklistNonMembership.staticCall(
            bad,
            r.publicSignals,
          ),
          `word ${k}`,
        ).to.equal(false);
      }
    });

    it("every signal aliased by + q, which the raw verifier accepts", async function () {
      const aliasing = loadAliasingSnarkjs();
      const input = await honestInput(alice, wallets[1].address);
      const wtns = { type: "mem" };
      await snarkjs.wtns.calculate(input, paths.wasm, wtns);
      const raw = await ethers.getContractAt(
        "BlacklistMembershipVerifier",
        await verifier.blacklistVerifier(),
      );
      const [totalBefore] = await verifier.getCircuitStats("blacklist");
      for (let i = 0; i < 4; i++) {
        aliasing.__setAliasK(1, i, 4);
        const m = await aliasing.plonk.prove(paths.zkey, wtns);
        aliasing.__setAliasK(0);
        const c = await ProofFormatter.formatPlonkForSolidity(
          m.proof,
          m.publicSignals,
        );
        expect(c.publicSignals).to.deep.equal(r.publicSignals);
        const aliased = [...c.publicSignals];
        aliased[i] = (BigInt(aliased[i]) + P).toString();
        expect(
          await raw.verifyProof(c.proof, aliased),
          `precondition: raw verifier accepts signal ${i} + q`,
        ).to.equal(true);
        expect(
          await verifier.verifyBlacklistNonMembership.staticCall(
            c.proof,
            aliased,
          ),
          `signal ${i} + q`,
        ).to.equal(false);
        const tx = await verifier.verifyBlacklistNonMembership(
          c.proof,
          aliased,
        );
        expect(await cachedEvents(tx)).to.have.lengthOf(0);
      }
      const [totalAfter] = await verifier.getCircuitStats("blacklist");
      expect(totalAfter, "out-of-field signals count as nothing").to.equal(
        totalBefore,
      );
    });
  });

  describe("D: the PLONK setup property", function () {
    it("signals are [Poseidon(secret, blacklistRoot), whitelistRoot, blacklistRoot, walletBinding]", async function () {
      expect(r.proof).to.have.lengthOf(24);
      expect(r.publicSignals).to.deep.equal([
        gen.hash([alice.secret, smt.root]).toString(),
        wlTree.getRoot().toString(),
        smt.root.toString(),
        BigInt(wallets[1].address).toString(),
      ]);
      // Unlinkable to the whitelist nullifier of the same commitment.
      expect(r.publicSignals[0]).to.not.equal(
        gen.hash([alice.secret, wlTree.getRoot()]).toString(),
      );
    });

    it("the committed verifier is PLONK with nPublic 4", async function () {
      const artifact = await artifacts.readArtifact(
        "BlacklistMembershipVerifier",
      );
      const fn = artifact.abi.find((x) => x.name === "verifyProof");
      expect(fn.inputs.map((i) => i.type)).to.deep.equal([
        "uint256[24]",
        "uint256[4]",
      ]);
      const vkey = JSON.parse(fs.readFileSync(paths.vkey, "utf8"));
      expect(vkey.protocol).to.equal("plonk");
      expect(vkey.nPublic).to.equal(4);
    });

    it("the committed verifier is reproduced from the committed circuit", async function () {
      const root = path.join(__dirname, "../..");
      const candidates = [
        process.env.CIRCOM_BIN,
        path.join(os.homedir(), ".cargo/bin/circom"),
        "/usr/local/bin/circom",
      ].filter(Boolean);
      const circom = candidates.find((c) => {
        try {
          return /\b2\.\d+\.\d+/.test(
            execFileSync(c, ["--version"]).toString(),
          );
        } catch {
          return false;
        }
      });
      if (!circom) this.skip(); // CI builds circom 2.x before the tests
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bl-setup-"));
      try {
        execFileSync(circom, [
          path.join(root, "circuits", `${CIRCUIT}.circom`),
          "--r1cs",
          "-o",
          tmp,
          "-l",
          path.join(root, "node_modules"),
        ]);
        const zkey = path.join(tmp, "c.zkey");
        const out = path.join(tmp, "v.sol");
        // The same commands setup:zk runs (scripts/setup-zk-circuits.js).
        const snarkjsBin = path.join(root, "node_modules/.bin/snarkjs");
        execFileSync(snarkjsBin, [
          "plonk",
          "setup",
          path.join(tmp, `${CIRCUIT}.r1cs`),
          path.join(root, "build/circuits/powersOfTau28_hez_final_15.ptau"),
          zkey,
        ]);
        execFileSync(snarkjsBin, [
          "zkey",
          "export",
          "solidityverifier",
          zkey,
          out,
        ]);
        const src = fs
          .readFileSync(out, "utf8")
          .replace(
            /contract (Groth16|Plonk)Verifier/g,
            "contract BlacklistMembershipVerifier",
          );
        const committed = fs.readFileSync(
          path.join(
            root,
            "contracts/privacy/verifiers",
            `${CIRCUIT}Verifier.sol`,
          ),
          "utf8",
        );
        const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");
        expect(sha(src)).to.equal(sha(committed));
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    });
  });

  describe("E: a valid proof verifies through the wrapper", function () {
    it("verifies, then answers from the cache", async function () {
      expect(
        await verifier.verifyBlacklistNonMembership.staticCall(
          r.proof,
          r.publicSignals,
        ),
      ).to.equal(true);
      const key = await verifier.blacklistProofCacheKey(
        r.proof,
        r.publicSignals,
      );
      const tx1 = await verifier.verifyBlacklistNonMembership(
        r.proof,
        r.publicSignals,
      );
      await expect(tx1).to.emit(verifier, "ProofCached");
      console.log(
        `      wrapper verifyBlacklistNonMembership gasUsed: ${(await tx1.wait()).gasUsed}`,
      );
      await expect(
        verifier.verifyBlacklistNonMembership(r.proof, r.publicSignals),
      )
        .to.emit(verifier, "ProofCacheHit")
        .withArgs(key, "blacklist");
    });

    it("the cache key depends on the verifier instance", async function () {
      const zk = await (
        await ethers.getContractFactory("ZKVerifierIntegrated")
      ).deploy(false);
      const before = await zk.blacklistProofCacheKey(r.proof, r.publicSignals);
      await zk.verifyBlacklistNonMembership(r.proof, r.publicSignals);
      const fresh = await (
        await ethers.getContractFactory("BlacklistMembershipVerifier")
      ).deploy();
      await zk.updateVerifier("blacklist", await fresh.getAddress());
      const after = await zk.blacklistProofCacheKey(r.proof, r.publicSignals);
      expect(after).to.not.equal(before);
      // Not a cache hit under the new verifier: verified again and cached.
      const tx = zk.verifyBlacklistNonMembership(r.proof, r.publicSignals);
      await expect(tx).to.emit(zk, "ProofCached").withArgs(after, "blacklist");
      await expect(tx).to.not.emit(zk, "ProofCacheHit");
    });

    it("the Groth16 router refuses the blacklist id", async function () {
      const BL = ethers.keccak256(ethers.toUtf8Bytes("BLACKLIST_MEMBERSHIP"));
      expect(await verifier.isCircuitRegistered(BL)).to.equal(true);
      const zero = {
        a: [0, 0],
        b: [
          [0, 0],
          [0, 0],
        ],
        c: [0, 0],
      };
      await expect(
        verifier.verifyCircuitProof(BL, zero, [1, 2, 3, 4]),
      ).to.be.revertedWith("use verifyBlacklistNonMembership");
    });
  });

  describe("F: PrivacyManager does not take the blacklist proof (D2)", function () {
    it("submitPrivateProof(BLACKLIST_ID) is refused and nothing is stored", async function () {
      const pm = await (
        await ethers.getContractFactory("PrivacyManager")
      ).deploy(await verifier.getAddress());
      const BL = ethers.keccak256(ethers.toUtf8Bytes("BLACKLIST_MEMBERSHIP"));
      const zero = {
        a: [0, 0],
        b: [
          [0, 0],
          [0, 0],
        ],
        c: [0, 0],
      };
      await expect(
        pm.connect(wallets[1]).submitPrivateProof(BL, zero, r.publicSignals),
      ).to.be.revertedWithCustomError(pm, "NonGatingBlacklistProof");
    });
  });
});
