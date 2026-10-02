const { expect } = require("chai");
const { ethers } = require("hardhat");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFile } = require("child_process");

// Off-chain root builder and prover CLI (plan v2 Task 3.5; D29/D30). The
// demo and these tests call the same exported functions as the CLIs.
const {
  DEPTH,
  SNARK_SCALAR_FIELD: Q,
  hex32,
  computeCommitment,
  buildWhitelistRoot,
  loadRootFile,
} = require("../../scripts/zk/build-whitelist-root");
const { proveWhitelist } = require("../../scripts/zk/prove-whitelist");
const { MerkleTreeBuilder } = require("../../utils/merkle-tree-builder");

const ROOT = path.join(__dirname, "../..");
const BUILDER = path.join(ROOT, "scripts/zk/build-whitelist-root.js");
const PROVER = path.join(ROOT, "scripts/zk/prove-whitelist.js");

/** Run a CLI with node; resolves { code, stdout, stderr }. */
function run(script, args, env = {}) {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [script, ...args],
      { cwd: ROOT, env: { ...process.env, ...env }, timeout: 240000 },
      (err, stdout, stderr) =>
        resolve({ code: err ? err.code : 0, stdout, stderr }),
    );
  });
}

const randomSecret = () => BigInt(ethers.hexlify(ethers.randomBytes(31)));
/** Every printed form of a secret: decimal, bare hex, 0x hex. */
const secretForms = (s) => [s.toString(), s.toString(16), hex32(s)];

describe("Whitelist root builder and prover CLI (Task 3.5)", function () {
  this.timeout(600000);

  let owner, alice, bob, carol;
  // Investors: identity = an OnchainID-style address, own random secret.
  let investors;
  let entries;
  let rootFile;

  async function deployPair() {
    const zk = await (
      await ethers.getContractFactory("ZKVerifierIntegrated")
    ).deploy(false);
    const pm = await (
      await ethers.getContractFactory("PrivacyManager")
    ).deploy(await zk.getAddress());
    return { zk, pm };
  }

  before(async function () {
    [owner, alice, bob, carol] = await ethers.getSigners();
    investors = [alice, bob, carol].map((w) => ({
      wallet: w,
      identity: BigInt(ethers.Wallet.createRandom().address),
      secret: randomSecret(),
    }));
    entries = [];
    for (const i of investors) {
      entries.push({
        identity: i.identity.toString(),
        commitment: hex32(await computeCommitment(i.identity, i.secret)),
      });
    }
    rootFile = await buildWhitelistRoot(entries);
  });

  describe("builder", function () {
    it("is deterministic, keeps input order and uses the tree builder's hashing", async function () {
      const again = await buildWhitelistRoot(entries);
      expect(again.root).to.equal(rootFile.root);
      expect(rootFile.depth).to.equal(DEPTH);
      expect(rootFile.count).to.equal(3);
      expect(rootFile.leaves).to.deep.equal(entries.map((e) => e.commitment));
      const tree = await MerkleTreeBuilder.createFromCommitments(
        entries.map((e) => BigInt(e.commitment)),
      );
      expect(rootFile.root).to.equal(hex32(tree.getRoot()));
      expect(rootFile.root).to.match(/^0x[0-9a-f]{64}$/);
      // Leaf order = input order: another order is another root.
      const reversed = await buildWhitelistRoot([...entries].reverse());
      expect(reversed.root).to.not.equal(rootFile.root);
    });

    it("refuses a second commitment for one identity (D29/D30)", async function () {
      const dup = [
        ...entries,
        {
          identity: entries[1].identity,
          commitment: hex32(
            await computeCommitment(investors[1].identity, randomSecret()),
          ),
        },
      ];
      await expect(buildWhitelistRoot(dup)).to.be.rejectedWith(
        /entry 3: identity .* already has a commitment \(entry 1\)/,
      );
    });

    it("refuses a repeated commitment", async function () {
      const dup = [
        ...entries,
        { identity: "424242", commitment: entries[0].commitment },
      ];
      await expect(buildWhitelistRoot(dup)).to.be.rejectedWith(
        /entry 3: commitment .* repeats entry 0/,
      );
    });

    it("refuses non-canonical, malformed and zero values", async function () {
      const bad = [
        [{ identity: "1", commitment: Q.toString() }, /not a canonical/],
        [{ identity: hex32(Q + 1n), commitment: "5" }, /not a canonical/],
        [{ identity: "-1", commitment: "5" }, /decimal or 0x-hex/],
        [{ identity: "1", commitment: "12abc" }, /decimal or 0x-hex/],
        [{ identity: "1" }, /entry 0 commitment/],
        [{ identity: "1", commitment: "0" }, /empty-leaf/],
      ];
      for (const [e, why] of bad) {
        await expect(buildWhitelistRoot([e])).to.be.rejectedWith(why);
      }
    });

    it("refuses an empty list and more leaves than depth 20 holds", async function () {
      await expect(buildWhitelistRoot([])).to.be.rejectedWith(/non-empty/);
      await expect(buildWhitelistRoot({})).to.be.rejectedWith(/non-empty/);
      await expect(
        buildWhitelistRoot(new Array(2 ** DEPTH + 1)),
      ).to.be.rejectedWith(/exceed the 1048576 leaves/);
    });

    it("a root file whose root is not its leaves' root is refused", async function () {
      await expect(
        loadRootFile({ ...rootFile, root: hex32(BigInt(rootFile.root) + 1n) }),
      ).to.be.rejectedWith(/not the root of its leaves/);
      await expect(
        loadRootFile({ ...rootFile, leaves: rootFile.leaves.slice(1) }),
      ).to.be.rejectedWith(/count 3 != 2/);
      await expect(loadRootFile({ ...rootFile, depth: 19 })).to.be.rejectedWith(
        /depth 19/,
      );
    });
  });

  describe("prover", function () {
    let zk, pm, aliceCalldata;

    before(async function () {
      ({ zk, pm } = await deployPair());
      await pm.publishWhitelistRoot(rootFile.root);
      aliceCalldata = await proveWhitelist({
        rootFile,
        identity: investors[0].identity,
        secret: investors[0].secret,
        wallet: alice.address,
      });
    });

    it("calldata verifies on ZKVerifierIntegrated and binds on PrivacyManager", async function () {
      const { proof, signals } = aliceCalldata;
      expect(proof).to.have.length(24);
      expect(BigInt(signals[1])).to.equal(BigInt(rootFile.root));
      expect(BigInt(signals[2])).to.equal(BigInt(alice.address));
      expect(await zk.verifyWhitelistMembership.staticCall(proof, signals)).to
        .be.true;

      await expect(pm.connect(alice).submitWhitelistProof(proof, signals))
        .to.emit(pm, "WhitelistProofBound")
        .withArgs(alice.address, BigInt(signals[0]), 1n, (x) => x > 0n);
      expect(await pm.hasValidWhitelistProof(alice.address)).to.be.true;
      // Bound to alice: bob cannot reuse it.
      await expect(
        pm.connect(bob).submitWhitelistProof(proof, signals),
      ).to.be.revertedWithCustomError(pm, "WalletBindingMismatch");
    });

    it("refuses a wrong secret or an unlisted commitment before proving", async function () {
      let called = false;
      const spy = {
        generateWhitelistProof: async () => {
          called = true;
          throw new Error("must not be reached");
        },
      };
      const cases = [
        { identity: investors[0].identity, secret: randomSecret() },
        { identity: 999n, secret: investors[0].secret },
        { identity: 7n, secret: 8n },
      ];
      for (const c of cases) {
        await expect(
          proveWhitelist({
            rootFile,
            ...c,
            wallet: alice.address,
            generator: spy,
          }),
        ).to.be.rejectedWith(/not in the root file/);
      }
      expect(called, "the prover ran on a non-member").to.be.false;
    });

    it("refuses a zero wallet, a zero secret and a tampered root file", async function () {
      const base = {
        rootFile,
        identity: investors[0].identity,
        secret: investors[0].secret,
        wallet: alice.address,
      };
      await expect(
        proveWhitelist({ ...base, wallet: ethers.ZeroAddress }),
      ).to.be.rejectedWith(/zero address/);
      await expect(
        proveWhitelist({ ...base, wallet: "0x1234" }),
      ).to.be.rejectedWith(/not an address/);
      await expect(proveWhitelist({ ...base, secret: 0n })).to.be.rejectedWith(
        /0 is not a secret/,
      );
      await expect(
        proveWhitelist({
          ...base,
          rootFile: { ...rootFile, root: hex32(1n) },
        }),
      ).to.be.rejectedWith(/not the root of its leaves/);
    });

    it("refuses a proof that does not verify against the vkey", async function () {
      // A generator that returns alice's signals with a real proof made for
      // bob's wallet: well-formed, but not a proof of these signals.
      const {
        RealProofGenerator,
      } = require("../../scripts/generate-real-proofs");
      const real = new RealProofGenerator();
      const forger = {
        generateWhitelistProof: async (p) => {
          const r = await real.generateWhitelistProof({
            ...p,
            walletBinding: bob.address,
          });
          return { ...r, publicSignals: aliceCalldata.signals };
        },
      };
      await expect(
        proveWhitelist({
          rootFile,
          identity: investors[0].identity,
          secret: investors[0].secret,
          wallet: alice.address,
          generator: forger,
        }),
      ).to.be.rejectedWith(
        /does not verify against the whitelist verification key/,
      );
    });
  });

  describe("CLI round trip", function () {
    let dir;
    before(() => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), "wl-cli-"));
    });
    after(() => fs.rmSync(dir, { recursive: true, force: true }));

    const noSecret = (r, secrets) => {
      for (const s of secrets) {
        for (const f of secretForms(s)) {
          expect(r.stdout, "stdout leaks the secret").to.not.include(f);
          expect(r.stderr, "stderr leaks the secret").to.not.include(f);
        }
      }
    };

    it("commitment -> root file -> calldata that binds, the secret never printed", async function () {
      const secrets = investors.map((i) => i.secret);
      const cliEntries = [];
      for (const i of investors) {
        const r = await run(
          PROVER,
          ["--commitment", "--identity", hex32(i.identity)],
          { WHITELIST_SECRET: i.secret.toString() },
        );
        expect(r.code, r.stderr).to.equal(0);
        noSecret(r, secrets);
        cliEntries.push({
          identity: i.identity.toString(),
          commitment: r.stdout.trim(),
        });
      }
      expect(cliEntries).to.deep.equal(entries);

      const entriesPath = path.join(dir, "entries.json");
      const rootPath = path.join(dir, "root.json");
      fs.writeFileSync(entriesPath, JSON.stringify(cliEntries));
      const b = await run(BUILDER, ["--in", entriesPath, "--out", rootPath]);
      expect(b.code, b.stderr).to.equal(0);
      const file = JSON.parse(fs.readFileSync(rootPath, "utf8"));
      expect(b.stdout.trim()).to.equal(rootFile.root);
      expect(file.root).to.equal(rootFile.root);
      expect(file.leaves).to.deep.equal(rootFile.leaves);

      const proofPath = path.join(dir, "proof.json");
      const p = await run(
        PROVER,
        [
          "--root",
          rootPath,
          "--identity",
          investors[1].identity.toString(),
          "--wallet",
          bob.address,
          "--out",
          proofPath,
        ],
        { WHITELIST_SECRET: investors[1].secret.toString() },
      );
      expect(p.code, p.stderr).to.equal(0);
      noSecret(p, secrets);
      const calldata = JSON.parse(p.stdout);
      expect(Object.keys(calldata)).to.deep.equal(["proof", "signals"]);
      expect(JSON.parse(fs.readFileSync(proofPath, "utf8"))).to.deep.equal(
        calldata,
      );

      const { pm } = await deployPair();
      await pm.publishWhitelistRoot(file.root);
      await pm
        .connect(bob)
        .submitWhitelistProof(calldata.proof, calldata.signals);
      expect(await pm.hasValidWhitelistProof(bob.address)).to.be.true;
    });

    it("reads the secret from --secret-file, refuses it on argv and names no secret on failure", async function () {
      const secretPath = path.join(dir, "secret");
      const wrong = randomSecret();
      fs.writeFileSync(secretPath, wrong.toString() + "\n");
      const rootPath = path.join(dir, "root-2.json");
      fs.writeFileSync(rootPath, JSON.stringify(rootFile));
      const r = await run(PROVER, [
        "--root",
        rootPath,
        "--identity",
        investors[2].identity.toString(),
        "--wallet",
        carol.address,
        "--secret-file",
        secretPath,
      ]);
      expect(r.code).to.equal(1);
      expect(r.stderr).to.match(/not in the root file/);
      noSecret(r, [wrong]);

      const argv = await run(PROVER, [
        "--commitment",
        "--identity",
        "1",
        "--secret",
        wrong.toString(),
      ]);
      expect(argv.code).to.equal(1);
      expect(argv.stderr).to.match(/never pass the secret on the command line/);
      expect(argv.stdout).to.equal("");

      const none = await run(PROVER, ["--commitment", "--identity", "1"], {
        WHITELIST_SECRET: "",
      });
      expect(none.code).to.equal(1);
      expect(none.stderr).to.match(/no secret/);
    });

    it("the builder CLI refuses a duplicate identity", async function () {
      const p = path.join(dir, "dup.json");
      fs.writeFileSync(
        p,
        JSON.stringify([
          entries[0],
          { ...entries[1], identity: entries[0].identity },
        ]),
      );
      const r = await run(BUILDER, ["--in", p]);
      expect(r.code).to.equal(1);
      expect(r.stderr).to.match(/one commitment per identity per root/);
      expect(r.stdout).to.equal("");
    });
  });
});
