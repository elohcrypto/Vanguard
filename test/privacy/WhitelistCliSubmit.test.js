const { expect } = require("chai");
const { ethers } = require("hardhat");
const path = require("path");
const { execFile } = require("child_process");

// Task 3.5 review round: the publish and submit library functions the CLIs
// call (signer injected; the CLI builds a JsonRpcProvider + Wallet), the
// stale-root refusal (M1), the secret floor (M2) and identity variants.
const {
  hex32,
  computeCommitment,
  buildWhitelistRoot,
  publishRoot,
} = require("../../scripts/zk/build-whitelist-root");
const {
  proveWhitelist,
  submitWhitelistProof,
} = require("../../scripts/zk/prove-whitelist");

const ROOT = path.join(__dirname, "../..");
const PROVER = path.join(ROOT, "scripts/zk/prove-whitelist.js");
const run = (args, env = {}) =>
  new Promise((resolve) =>
    execFile(
      process.execPath,
      [PROVER, ...args],
      { cwd: ROOT, env: { ...process.env, ...env } },
      (err, stdout, stderr) =>
        resolve({ code: err ? err.code : 0, stdout, stderr }),
    ),
  );
const randomSecret = () => BigInt(ethers.hexlify(ethers.randomBytes(31)));

describe("Whitelist CLI publish and submit (Task 3.5 review)", function () {
  this.timeout(300000);

  let owner, ops, alice, bob, stranger;
  let rootFile, calldata, pm, pmAddr;
  const me = { identity: 0n, secret: 0n };

  before(async function () {
    [owner, ops, alice, bob, stranger] = await ethers.getSigners();
    me.identity = BigInt(ethers.Wallet.createRandom().address);
    me.secret = randomSecret();
    rootFile = await buildWhitelistRoot([
      {
        identity: "11",
        commitment: hex32(await computeCommitment(11n, randomSecret())),
      },
      {
        identity: me.identity,
        commitment: await computeCommitment(me.identity, me.secret),
      },
    ]);
    calldata = await proveWhitelist({ rootFile, ...me, wallet: alice.address });
  });

  beforeEach(async function () {
    const zk = await (
      await ethers.getContractFactory("ZKVerifierIntegrated")
    ).deploy(false);
    pm = await (
      await ethers.getContractFactory("PrivacyManager")
    ).deploy(await zk.getAddress());
    pmAddr = await pm.getAddress();
  });

  const submitAs = (signer, cd = calldata) =>
    submitWhitelistProof({
      calldata: cd,
      privacyManager: pmAddr,
      signer,
      rpc: "http://node",
    });

  describe("publishRoot", function () {
    it("ops publishes; the same root again is a no-op", async function () {
      await pm.setListOperator(ops.address);
      const p = await publishRoot({
        root: rootFile.root,
        privacyManager: pmAddr,
        signer: ops,
      });
      expect(p.version).to.equal("1");
      expect(p.txHash).to.match(/^0x/);
      expect(await pm.whitelistRoot()).to.equal(rootFile.root);
      const again = await publishRoot({
        root: rootFile.root,
        privacyManager: pmAddr,
        signer: ops,
      });
      expect(again).to.deep.equal({ version: "1", txHash: null });
    });

    it("a wrong key reads as NotListOperator and names who may publish", async function () {
      await pm.setListOperator(ops.address);
      await expect(
        publishRoot({
          root: rootFile.root,
          privacyManager: pmAddr,
          signer: stranger,
        }),
      ).to.be.rejectedWith(
        new RegExp(
          `NotListOperator.*the list operator ${ops.address} \\(or the owner\\)`,
        ),
      );
      // No operator set: the owner is named, never 0x000...
      await pm.setListOperator(ethers.ZeroAddress);
      await expect(
        publishRoot({
          root: rootFile.root,
          privacyManager: pmAddr,
          signer: stranger,
        }),
      ).to.be.rejectedWith(
        new RegExp(`the owner ${owner.address} \\(no list operator set\\)`),
      );
      expect(await pm.whitelistVersion()).to.equal(0n);
    });
  });

  describe("submitWhitelistProof", function () {
    it("binds the wallet and returns the binding", async function () {
      await pm.publishWhitelistRoot(rootFile.root);
      const b = await submitAs(alice);
      expect(b.nullifier).to.equal(calldata.signals[0]);
      expect(b.version).to.equal("1");
      expect(await pm.hasValidWhitelistProof(alice.address)).to.be.true;
    });

    it("refuses a key for another wallet before sending", async function () {
      await pm.publishWhitelistRoot(rootFile.root);
      await expect(submitAs(bob)).to.be.rejectedWith(
        new RegExp(
          `key is for ${bob.address}, the proof binds ${alice.address}`,
        ),
      );
    });

    it("a bad proof reverts with a named error and binds nothing", async function () {
      await pm.publishWhitelistRoot(rootFile.root);
      const bad = {
        proof: calldata.proof.map((w, i) =>
          i === 0 ? (BigInt(w) ^ 1n).toString() : w,
        ),
        signals: calldata.signals,
      };
      await expect(submitAs(alice, bad)).to.be.rejectedWith(
        /submitWhitelistProof reverted: .*InvalidWhitelistProof/,
      );
      expect(await pm.hasValidWhitelistProof(alice.address)).to.be.false;
    });

    it("nothing published: prints the ops publish command for this root, no calldata", async function () {
      await pm.setListOperator(ops.address);
      const e = await submitAs(alice).catch((x) => x);
      expect(e.message).to.match(/no whitelist root is published yet/);
      expect(e.message).to.include(`the list operator ${ops.address}`);
      expect(e.message).to.include(rootFile.root);
      expect(e.message).to.include(
        "build-whitelist-root.js --in <entries.json> --publish",
      );
      expect(e.message).to.not.match(/calldata|0x60a39172/);
    });

    it("a replaced root: re-prove on the current root, never republish the old one", async function () {
      await pm.publishWhitelistRoot(rootFile.root);
      const newer = hex32(12345n);
      await pm.publishWhitelistRoot(newer);
      const e = await submitAs(alice).catch((x) => x);
      expect(e.message).to.match(
        new RegExp(
          `published root is ${newer} \\(version 2\\); get the current root.json from ops`,
        ),
      );
      expect(e.message).to.not.match(
        /--publish|publishWhitelistRoot|0x60a39172/,
      );
      expect(e.message).to.not.include(rootFile.root);
      expect(await pm.whitelistRoot()).to.equal(newer);
    });
  });

  describe("builder identity variants and the secret floor", function () {
    it("one identity in decimal, 0x, leading zeros or another case is a duplicate", async function () {
      const addr = ethers.Wallet.createRandom().address;
      const variants = [
        BigInt(addr).toString(),
        addr.toLowerCase(),
        "0x" + "00" + addr.slice(2).toUpperCase(),
        "000" + BigInt(addr).toString(),
      ];
      const first = {
        identity: addr,
        commitment: hex32(await computeCommitment(addr, randomSecret())),
      };
      for (const v of variants) {
        const second = {
          identity: v,
          commitment: hex32(await computeCommitment(v, randomSecret())),
        };
        await expect(buildWhitelistRoot([first, second])).to.be.rejectedWith(
          /entry 1: identity .* already has a commitment \(entry 0\)/,
        );
      }
      await expect(
        buildWhitelistRoot([{ identity: "0", commitment: first.commitment }]),
      ).to.be.rejectedWith(/identity 0 is not an OnchainID/);
    });

    it("--new-secret prints a fresh 31-byte secret and nothing else; a weak one is refused", async function () {
      const a = await run(["--new-secret"]);
      const b = await run(["--new-secret"]);
      expect(a.code).to.equal(0);
      expect(a.stdout).to.match(/^0x[0-9a-f]{62}\n$/);
      expect(a.stderr).to.equal("");
      expect(a.stdout).to.not.equal(b.stdout);
      const weak = await run(["--commitment", "--identity", "1"], {
        WHITELIST_SECRET: "4321",
      });
      expect(weak.code).to.equal(1);
      expect(weak.stderr).to.match(/below 2\^128.*--new-secret/);
      expect(weak.stdout).to.equal("");
      const pos = await run(["987654321987654321"]);
      expect(pos.stderr).to.match(/unexpected positional argument/);
      expect(pos.stderr).to.not.include("987654321987654321");
    });
  });
});
