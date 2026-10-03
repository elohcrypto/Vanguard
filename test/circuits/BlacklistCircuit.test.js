const { expect } = require("chai");
const path = require("path");
const fs = require("fs");
const snarkjs = require("snarkjs");
const { MerkleTreeBuilder } = require("../../utils/merkle-tree-builder");
const {
  SMT_LEVELS,
  buildBlacklistSmt,
  isListed,
  nonInclusionWitness,
} = require("../../utils/smt-builder");

/**
 * @title Blacklist Circuit Test
 * @dev Circuit-level checks of blacklist_membership (Task 3.7): build
 *      artifacts, the sanctions SMT builder, and a witness for each branch of
 *      circomlib's non-inclusion proof. Soundness (what cannot be proven) is
 *      in test/privacy/BlacklistSoundness.test.js.
 */
describe("Blacklist Membership Circuit", function () {
  this.timeout(120000);

  const CIRCUIT_NAME = "blacklist_membership";
  const BUILD_DIR = path.join(__dirname, "../../build/circuits", CIRCUIT_NAME);
  const WASM_PATH = path.join(
    BUILD_DIR,
    `${CIRCUIT_NAME}_js`,
    `${CIRCUIT_NAME}.wasm`,
  );
  const ZKEY_PATH = path.join(BUILD_DIR, `${CIRCUIT_NAME}.zkey`);
  const VKEY_PATH = path.join(BUILD_DIR, `${CIRCUIT_NAME}_vkey.json`);

  describe("Circuit Build Verification", function () {
    it("should have the witness calculator, proving and verification keys", function () {
      expect(fs.existsSync(WASM_PATH)).to.be.true;
      expect(fs.existsSync(ZKEY_PATH)).to.be.true;
      expect(fs.existsSync(VKEY_PATH)).to.be.true;
    });

    it("should have a PLONK verification key with four public signals", function () {
      const vkey = JSON.parse(fs.readFileSync(VKEY_PATH, "utf8"));
      expect(vkey.protocol).to.equal("plonk");
      expect(vkey.curve).to.equal("bn128");
      // [nullifier, whitelistRoot, blacklistRoot, walletBinding]
      expect(vkey.nPublic).to.equal(4);
    });
  });

  describe("Sanctions tree builder", function () {
    it("refuses zero, duplicates and out-of-field identities", async function () {
      await expect(buildBlacklistSmt([0n])).to.be.rejectedWith(/must be in 1/);
      await expect(buildBlacklistSmt([5n, 5n])).to.be.rejectedWith(
        /duplicate identity/,
      );
      await expect(buildBlacklistSmt([1n << 254n])).to.be.rejectedWith(
        /must be in 1/,
      );
    });

    it("refuses identities that collide below the circuit depth", async function () {
      // Same low SMT_LEVELS bits: the leaves would sit deeper than the
      // circuit can check.
      const a = 7n;
      const b = 7n + (1n << BigInt(SMT_LEVELS));
      await expect(buildBlacklistSmt([a, b])).to.be.rejectedWith(
        /deeper than the circuit/,
      );
    });

    it("a leaf at depth 20 is refused, depth 19 proves (SMTLevIns)", async function () {
      // circomlib's SMTLevIns needs the last of the 20 siblings to be 0, so
      // the deepest provable leaf is at depth 19 (review 3.7a L1).
      const d20 = [7n, 7n + (1n << 19n)]; // share 19 low bits: depth 20
      await expect(buildBlacklistSmt(d20)).to.be.rejectedWith(
        `deeper than the circuit's maximum ${SMT_LEVELS - 1} for ${SMT_LEVELS} levels`,
      );
      const d19 = [7n, 7n + (1n << 18n)]; // share 18 low bits: depth 19
      const smt = await buildBlacklistSmt(d19);
      const depth = (await smt.tree.find(d19[1])).siblings.length;
      expect(depth).to.equal(SMT_LEVELS - 1);
      // An unlisted key on that branch gets a witness the circuit accepts.
      const outsider = 7n + (1n << 30n); // same 19 low bits as 7
      const w = await nonInclusionWitness(smt.tree, outsider);
      expect(w.isOld0).to.equal(0);
      const wl = new MerkleTreeBuilder();
      await wl.initialize();
      wl.buildTree([wl.commitment(outsider, 77n)]);
      const { pathElements, pathIndices } = wl.getProof(0);
      await snarkjs.wtns.calculate(
        {
          identity: outsider.toString(),
          secret: "77",
          pathElements: pathElements.map(String),
          pathIndices,
          siblings: w.siblings.map(String),
          oldKey: w.oldKey.toString(),
          oldValue: w.oldValue.toString(),
          isOld0: w.isOld0,
          whitelistRoot: wl.getRoot().toString(),
          blacklistRoot: smt.root.toString(),
          walletBinding: "1",
        },
        WASM_PATH,
        { type: "mem" },
      );
    });

    it("an empty list has root 0 and lists nobody", async function () {
      const smt = await buildBlacklistSmt([]);
      expect(smt.root).to.equal(0n);
      expect(await isListed(smt.tree, 1n)).to.equal(false);
      const w = await nonInclusionWitness(smt.tree, 1n);
      expect(w.isOld0).to.equal(1);
      expect(w.siblings).to.have.lengthOf(SMT_LEVELS);
    });

    it("the same list gives the same root in any order", async function () {
      const a = await buildBlacklistSmt([2n, 6n, 9n]);
      const b = await buildBlacklistSmt([9n, 2n, 6n]);
      expect(a.root).to.equal(b.root);
      expect(await isListed(a.tree, 6n)).to.equal(true);
    });
  });

  describe("Circuit Functionality", function () {
    // Whitelist members; identities chosen for the SMT branches below.
    const members = [
      { identity: 1n, secret: 11n },
      { identity: 10n, secret: 22n },
      { identity: 3n, secret: 33n },
    ];
    // Keys 2 (..010) and 6 (..110) share bit 0 = 0, so the root's right
    // child (odd keys) is empty: key 1 lands on an empty slot (isOld0 = 1);
    // key 10 (..1010) lands on key 2's leaf (isOld0 = 0, oldKey 2).
    const sanctioned = [2n, 6n];
    let wl;

    before(async function () {
      wl = new MerkleTreeBuilder();
      await wl.initialize();
      wl.buildTree(members.map((m) => wl.commitment(m.identity, m.secret)));
    });

    async function input(member, blacklist) {
      const smt = await buildBlacklistSmt(blacklist);
      const w = await nonInclusionWitness(smt.tree, member.identity);
      const idx = wl.findLeafIndex(
        wl.commitment(member.identity, member.secret),
      );
      const { pathElements, pathIndices } = wl.getProof(idx);
      return {
        w,
        smt,
        input: {
          identity: member.identity.toString(),
          secret: member.secret.toString(),
          pathElements: pathElements.map(String),
          pathIndices,
          siblings: w.siblings.map(String),
          oldKey: w.oldKey.toString(),
          oldValue: w.oldValue.toString(),
          isOld0: w.isOld0,
          whitelistRoot: wl.getRoot().toString(),
          blacklistRoot: smt.root.toString(),
          walletBinding: "1234",
        },
      };
    }

    async function publicSignals(inp) {
      const wtns = { type: "mem" };
      await snarkjs.wtns.calculate(inp, WASM_PATH, wtns);
      const w = await snarkjs.wtns.exportJson(wtns);
      // Wire 0 is the constant 1; then outputs, then public inputs.
      return w.slice(1, 5).map(String);
    }

    it("proves non-membership in an empty sanctions list", async function () {
      const { input: inp, w } = await input(members[0], []);
      expect(w.isOld0).to.equal(1);
      const sig = await publicSignals(inp);
      expect(sig.slice(1)).to.deep.equal([
        wl.getRoot().toString(),
        "0",
        "1234",
      ]);
    });

    it("proves non-membership where the key's slot is empty (isOld0 = 1)", async function () {
      const { input: inp, w, smt } = await input(members[0], sanctioned);
      expect(w.isOld0).to.equal(1);
      expect(smt.root).to.not.equal(0n);
      const sig = await publicSignals(inp);
      expect(sig[2]).to.equal(smt.root.toString());
    });

    it("proves non-membership where another key's leaf sits on the path (isOld0 = 0)", async function () {
      const { input: inp, w } = await input(members[1], sanctioned);
      expect(w.isOld0).to.equal(0);
      expect(w.oldKey).to.equal(2n);
      await publicSignals(inp);
    });

    it("the nullifier is Poseidon(secret, blacklistRoot)", async function () {
      const { input: inp, smt } = await input(members[2], sanctioned);
      const sig = await publicSignals(inp);
      expect(sig[0]).to.equal(wl.hash(members[2].secret, smt.root).toString());
    });
  });
});
