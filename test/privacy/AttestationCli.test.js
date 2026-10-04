const { expect } = require("chai");
const { ethers } = require("hardhat");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFile } = require("child_process");

// Task 3.7b (D31 a): the issuer CLI (scripts/zk/attest.js) and the investor
// CLI (scripts/zk/prove-attestation.js). Secret hygiene: the issuer key, the
// salt and the signature never appear in any output; the key never comes
// from argv. The submit path runs through the library with an injected
// signer (the CLI builds a JsonRpcProvider + Wallet; CI's demo smoke step
// drives it against a node).
const {
  CIRCUITS,
  newAttestorKey,
  attestorPublicKey,
  signAttestation,
  loadAttestation,
} = require("../../scripts/zk/attest");
const {
  proveAttestation,
  submitAttestationProof,
} = require("../../scripts/zk/prove-attestation");

const { describeProofs } = require("../helpers/zkProofs");
const { validUntilIn } = require("../helpers/attestationFixture");
const ROOT = path.join(__dirname, "../..");
const run = (script, args, env = {}) =>
  new Promise((resolve) =>
    execFile(
      process.execPath,
      [path.join(ROOT, "scripts/zk", script), ...args],
      { cwd: ROOT, env: { ...process.env, ...env } },
      (err, stdout, stderr) =>
        resolve({ code: err ? err.code : 0, stdout, stderr }),
    ),
  );
const forms = (v) => {
  const b = BigInt(v);
  return [b.toString(), b.toString(16)];
};
function expectNoSecrets(out, att, key) {
  const all = out.stdout + out.stderr;
  if (key) {
    expect(all).to.not.include(key.slice(2));
    expect(all.toLowerCase()).to.not.include(key.slice(2).toLowerCase());
  }
  if (att) {
    for (const k of ["salt", "R8x", "R8y", "S"]) {
      for (const f of forms(att[k])) expect(all, k).to.not.include(f);
    }
  }
}

describeProofs("Attestation CLIs (Task 3.7b)", function () {
  this.timeout(300000);

  const key = newAttestorKey();
  const identity = "0x5FbDB2315678afecb367f032d93F642f64180aa3";
  // Task 3.8 M1: an attestation is for one chain and one PrivacyManager.
  const PMX = "0x" + "11".repeat(20);
  // Task 3.10: and until a date the issuer sets.
  const VALIDITY = ["--valid-days", "365"];
  const TARGET = ["--chain-id", "31337", "--privacy-manager", PMX, ...VALIDITY];
  let tmp;

  before(function () {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "att-cli-"));
  });
  after(function () {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  describe("attest.js (issuer)", function () {
    it("--new-key prints a key once with its public key; --public-key matches", async function () {
      const a = await run("attest.js", ["--new-key"]);
      expect(a.code).to.equal(0);
      const k = JSON.parse(a.stdout);
      expect(k.privateKey).to.match(/^0x[0-9a-f]{64}$/);
      expect(a.stderr).to.match(/printed once/);
      const pub = await attestorPublicKey(k.privateKey);
      expect([k.Ax, k.Ay]).to.deep.equal([
        pub.Ax.toString(),
        pub.Ay.toString(),
      ]);
      const p = await run("attest.js", ["--public-key"], {
        ATTESTOR_KEY: k.privateKey,
      });
      expect(JSON.parse(p.stdout)).to.deep.equal({ Ax: k.Ax, Ay: k.Ay });
      expectNoSecrets(p, null, k.privateKey);
      const b = await run("attest.js", ["--new-key"]);
      expect(JSON.parse(b.stdout).privateKey).to.not.equal(k.privateKey);
    });

    it("--sign prints a verifying attestation; never the key", async function () {
      const s = await run(
        "attest.js",
        [
          "--sign",
          "--circuit",
          "jurisdiction",
          ...TARGET,
          "--identity",
          identity,
          "--mask",
          "4",
        ],
        { ATTESTOR_KEY: key },
      );
      expect(s.code, s.stderr).to.equal(0);
      expectNoSecrets(s, null, key);
      const att = JSON.parse(s.stdout);
      expect(Object.keys(att)).to.deep.equal([
        "circuit",
        "chainId",
        "privacyManager",
        "validUntil",
        "identity",
        "attributes",
        "salt",
        "R8x",
        "R8y",
        "S",
        "Ax",
        "Ay",
      ]);
      expect([att.chainId, att.privacyManager]).to.deep.equal([
        "31337",
        ethers.getAddress(PMX),
      ]);
      expect(att.identity).to.equal(BigInt(identity).toString());
      expect(att.attributes).to.deep.equal(["4"]);
      // --valid-days 365 from the clock (offline: no --rpc).
      const year = Math.floor(Date.now() / 1000) + 365 * 86400;
      expect(Number(att.validUntil)).to.be.within(year - 60, year + 1);
      expect(s.stderr).to.match(/attestation expires \d{4}-\d\d-\d\dT/);
      expect(BigInt(att.salt) < 2n ** 248n).to.equal(true);
      await loadAttestation(att); // the signature verifies
    });

    // Review 3.7b M1: the attestation is a bearer credential.
    it("--sign --out writes the attestation 0600 only, never overwrites, prints nothing secret", async function () {
      const out = path.join(tmp, "j.json");
      const args = [
        "--sign",
        "--circuit",
        "jurisdiction",
        ...TARGET,
        "--identity",
        identity,
        "--mask",
        "4",
        "--out",
        out,
      ];
      const s = await run("attest.js", args, { ATTESTOR_KEY: key });
      expect(s.code, s.stderr).to.equal(0);
      const att = JSON.parse(fs.readFileSync(out, "utf8"));
      expect(fs.statSync(out).mode & 0o777).to.equal(0o600);
      await loadAttestation(att);
      expectNoSecrets(s, att, key);
      expect(JSON.parse(s.stdout)).to.deep.equal({
        out,
        circuit: "jurisdiction",
        validUntil: new Date(Number(att.validUntil) * 1000).toISOString(),
        Ax: att.Ax,
        Ay: att.Ay,
      });
      const again = await run("attest.js", args, { ATTESTOR_KEY: key });
      expect(again.code).to.equal(1);
      expect(again.stderr).to.match(/EEXIST/);
      expect(again.stdout).to.equal("");
      expect(JSON.parse(fs.readFileSync(out, "utf8"))).to.deep.equal(att);
    });

    it("decimal, lowercase hex and checksum identities sign the same identity", async function () {
      const ids = [
        identity,
        identity.toLowerCase(),
        BigInt(identity).toString(),
      ];
      const got = await Promise.all(
        ids.map((i) =>
          signAttestation({
            key,
            chainId: 31337,
            privacyManager: PMX,
            validUntil: 2n ** 40n,
            circuit: "accreditation",
            identity: i,
            amount: 5,
          }),
        ),
      );
      expect(new Set(got.map((g) => g.identity)).size).to.equal(1);
      expect(
        new Set(got.map((g) => g.salt)).size,
        "fresh salt each time",
      ).to.equal(3);
    });

    it("refuses the key on argv, a missing key and bad attributes, echoing nothing", async function () {
      const argv = await run("attest.js", ["--key", key]);
      expect(argv.code).to.equal(1);
      expect(argv.stderr).to.match(
        /never pass the issuer key on the command line/,
      );
      expectNoSecrets(argv, null, key);
      const none = await run("attest.js", ["--sign"], { ATTESTOR_KEY: "" });
      expect(none.stderr).to.match(/set env ATTESTOR_KEY/);
      const cases = [
        [["--circuit", "jurisdiction", "--mask", "3"], /power of two/],
        [["--circuit", "jurisdiction", "--mask", String(2n ** 64n)], /above/],
        [["--circuit", "compliance", "--scores", "90,80,70,101"], /above 100/],
        [["--circuit", "compliance", "--scores", "90,80"], /four values/],
        [["--circuit", "nope", "--amount", "1"], /expected one of/],
      ];
      for (const [args, re] of cases) {
        const r = await run(
          "attest.js",
          ["--sign", "--identity", identity, ...TARGET, ...args],
          {
            ATTESTOR_KEY: key,
          },
        );
        expect(r.code, args.join(" ")).to.equal(1);
        expect(r.stderr).to.match(re);
        expect(r.stdout).to.equal("");
        expectNoSecrets(r, null, key);
      }
      // The deployment it is for is required (review 3.8 M1).
      for (const [args, re] of [
        [["--chain-id", "31337"], /--privacy-manager is required/],
        [["--privacy-manager", PMX], /--chain-id or --rpc is required/],
        [["--chain-id", "0", "--privacy-manager", PMX], /chainId: zero/],
        [["--chain-id", "1", "--privacy-manager", "0x12"], /not an address/],
      ]) {
        const r = await run(
          "attest.js",
          [
            "--sign",
            "--identity",
            identity,
            "--circuit",
            "accreditation",
            "--amount",
            "5",
            ...VALIDITY,
            ...args,
          ],
          { ATTESTOR_KEY: key },
        );
        expect(r.code, args.join(" ")).to.equal(1);
        expect(r.stderr).to.match(re);
        expect(r.stdout).to.equal("");
      }
      const badKey = await run("attest.js", ["--public-key"], {
        ATTESTOR_KEY: "0x1234",
      });
      expect(badKey.stderr).to.match(/expected 32 bytes/);
      expect(badKey.stderr).to.not.include("1234");
    });
  });

  describe("prove-attestation.js (investor)", function () {
    let att;
    let file;
    let wallet;

    before(async function () {
      [, wallet] = await ethers.getSigners();
      att = await signAttestation({
        key,
        chainId: 31337,
        privacyManager: PMX,
        validUntil: await validUntilIn(),
        circuit: "compliance",
        identity,
        scores: [90, 80, 70, 60],
      });
      file = path.join(tmp, "c.json");
      fs.writeFileSync(file, JSON.stringify(att));
    });

    it("offline with an explicit policy: a proof the wrapper accepts, no salt or signature printed", async function () {
      const out = path.join(tmp, "proof.json");
      const r = await run("prove-attestation.js", [
        "--attestation",
        file,
        "--wallet",
        wallet.address,
        "--policy",
        "70,25,25,25,25",
        "--out",
        out,
      ]);
      expect(r.code, r.stderr).to.equal(0);
      expectNoSecrets(r, att, key);
      const cd = JSON.parse(r.stdout);
      expect(cd.circuitId).to.equal(CIRCUITS.compliance.id);
      expect(cd.signals.slice(1)).to.deep.equal([
        att.Ax,
        att.Ay,
        "31337",
        BigInt(PMX).toString(),
        att.validUntil,
        "70",
        "25",
        "25",
        "25",
        "25",
        BigInt(wallet.address).toString(),
      ]);
      expect(JSON.parse(fs.readFileSync(out, "utf8"))).to.deep.equal(cd);
      const zk = await (
        await ethers.getContractFactory("ZKVerifierIntegrated")
      ).deploy(false);
      expect(
        await zk.verifyComplianceAggregation.staticCall(cd.proof, cd.signals),
      ).to.equal(true);
    });

    it("refuses a tampered attestation, a low score and a bare --submit before proving", async function () {
      const bad = path.join(tmp, "bad.json");
      fs.writeFileSync(
        bad,
        JSON.stringify({ ...att, attributes: ["99", "80", "70", "60"] }),
      );
      const t = await run("prove-attestation.js", [
        "--attestation",
        bad,
        "--wallet",
        wallet.address,
        "--policy",
        "70,25,25,25,25",
      ]);
      expect(t.code).to.equal(1);
      expect(t.stderr).to.match(/signature does not verify/);
      expectNoSecrets(t, att, key);
      const low = await run("prove-attestation.js", [
        "--attestation",
        file,
        "--wallet",
        wallet.address,
        "--policy",
        "90,25,25,25,25",
      ]);
      expect(low.stderr).to.match(/below the compliance minimum/);
      const sub = await run("prove-attestation.js", [
        "--attestation",
        file,
        "--wallet",
        wallet.address,
        "--policy",
        "70,25,25,25,25",
        "--submit",
      ]);
      expect(sub.stderr).to.match(
        /--submit needs --rpc, --privacy-manager and env WHITELIST_WALLET_KEY/,
      );
      expect(sub.stdout).to.equal("");
    });

    it("submit (library): binds, names reverts, refuses another wallet's key", async function () {
      const [owner, , other] = await ethers.getSigners();
      const zk = await (
        await ethers.getContractFactory("ZKVerifierIntegrated")
      ).deploy(false);
      const pm = await (
        await ethers.getContractFactory("PrivacyManager")
      ).deploy(await zk.getAddress());
      await pm.connect(owner).setCompliancePolicy(70, 25, 25, 25, 25);
      // An attestation for another PrivacyManager or chain: refused before
      // proving (review 3.8 M1).
      await expect(
        proveAttestation({
          attestation: att,
          wallet: wallet.address,
          privacyManager: pm.target,
          runner: wallet,
        }),
      ).to.be.rejectedWith(/the attestation is for PrivacyManager/);
      const forPm = (chainId) =>
        signAttestation({
          key,
          chainId,
          privacyManager: pm.target,
          validUntil: att.validUntil,
          circuit: "compliance",
          identity,
          scores: [90, 80, 70, 60],
        });
      await expect(
        proveAttestation({
          attestation: await forPm(1),
          wallet: wallet.address,
          privacyManager: pm.target,
          runner: wallet,
        }),
      ).to.be.rejectedWith(/the attestation is for chain 1, not chain 31337/);
      const mine = await forPm(31337);
      // Untrusted issuer: refused before proving.
      await expect(
        proveAttestation({
          attestation: mine,
          wallet: wallet.address,
          privacyManager: pm.target,
          runner: wallet,
        }),
      ).to.be.rejectedWith(/not trusted for compliance/);
      await pm.setTrustedAttestor(CIRCUITS.compliance.id, att.Ax, att.Ay, true);
      const cd = await proveAttestation({
        attestation: mine,
        wallet: wallet.address,
        privacyManager: pm.target,
        runner: wallet,
      });
      await expect(
        submitAttestationProof({
          calldata: cd,
          privacyManager: pm.target,
          signer: other,
        }),
      ).to.be.rejectedWith(new RegExp(`key is for ${other.address}`));
      const badProof = {
        ...cd,
        proof: cd.proof.map((w, i) => (i ? w : (BigInt(w) ^ 1n).toString())),
      };
      await expect(
        submitAttestationProof({
          calldata: badProof,
          privacyManager: pm.target,
          signer: wallet,
        }),
      ).to.be.rejectedWith(
        /submitAttestationProof reverted: .*InvalidAttestationProof/,
      );
      const rec = await submitAttestationProof({
        calldata: cd,
        privacyManager: pm.target,
        signer: wallet,
      });
      expect(rec.nullifier).to.equal(cd.signals[0]);
      expect(rec.policyHash).to.equal(
        await pm.currentPolicyHash(CIRCUITS.compliance.id),
      );
      expect(
        await pm.validatePrivateCompliance.staticCall(wallet.address),
      ).to.equal(true);
    });
  });
});
