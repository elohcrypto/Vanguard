import { expect } from "chai";
import { ethers, artifacts } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import type { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import {
  IZKVerifier__factory,
  ZKVerifierIntegrated,
  ZKVerifierIntegrated__factory,
} from "../../typechain-types";

// Wrapper unit tests for Task 3.2 (plan v2 §7): batch, cache, the 27-word
// verifyCircuitProof route, testingMode, verifyBatchProofs and the typed
// IZKVerifier ABI that PrivacyManager (3.3) consumes. Real PLONK proofs,
// built the way ZKSoundness.test.js test D builds them.
/* eslint-disable @typescript-eslint/no-var-requires */
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

const Q =
  21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const WL = ethers.keccak256(ethers.toUtf8Bytes("WHITELIST_MEMBERSHIP"));
const BL = ethers.keccak256(ethers.toUtf8Bytes("BLACKLIST_MEMBERSHIP"));
const JUR = ethers.keccak256(ethers.toUtf8Bytes("JURISDICTION_PROOF"));
const COMP = ethers.keccak256(ethers.toUtf8Bytes("COMPLIANCE_AGGREGATION"));
const EMPTY = {
  a: [0n, 0n] as [bigint, bigint],
  b: [
    [0n, 0n],
    [0n, 0n],
  ] as [[bigint, bigint], [bigint, bigint]],
  c: [0n, 0n] as [bigint, bigint],
};

type Words = bigint[];
type Signals = [bigint, bigint, bigint];

describe("ZKVerifierIntegrated wrapper (Task 3.2)", function () {
  this.timeout(300000);

  let alice: HardhatEthersSigner;
  let proof: Words; // real member proof bound to alice
  let signals: Signals;
  let tampered: Words;
  let aliasedProof: Words; // same witness, transcript over n + q
  let aliasedSignals: Signals;

  const deploy = async (testingMode: boolean): Promise<ZKVerifierIntegrated> =>
    new ZKVerifierIntegrated__factory((await ethers.getSigners())[0]).deploy(
      testingMode,
    );
  const asWords = (xs: (string | bigint)[]) => xs.map((x) => BigInt(x));
  const route = (p: Words, s: Signals) => [...p, ...s];

  before(async function () {
    [, alice] = await ethers.getSigners();
    const gen = new RealProofGenerator();
    await gen.initialize();
    const identity = 12345n;
    const secret = 0xabcdef0123456789n;
    const members = [
      { identity: 11111n, secret: 101n },
      { identity, secret },
      { identity: 33333n, secret: 303n },
    ];
    const r = await gen.generateWhitelistProof({
      identity,
      secret,
      members,
      walletBinding: alice.address,
    });
    proof = asWords(r.proof);
    signals = asWords(r.publicSignals) as Signals;
    tampered = [...proof];
    tampered[9] += 1n;

    // Aliased entry: same statement, nullifier n + q (R-3R-7).
    const tree = await MerkleTreeBuilder.createFromCommitments(
      members.map((m) => gen.hash([m.identity, m.secret])),
    );
    const input = {
      identity: identity.toString(),
      secret: secret.toString(),
      ...tree.getProof(1),
      merkleRoot: tree.getRoot().toString(),
      walletBinding: BigInt(alice.address).toString(),
    };
    input.pathElements = input.pathElements.map(String);
    const wtns = { type: "mem" };
    await snarkjs.wtns.calculate(
      input,
      gen.getCircuitPaths("whitelist_membership").wasm,
      wtns,
    );
    const aliasing = loadAliasingSnarkjs();
    aliasing.__setAliasK(1);
    const m = await aliasing.plonk.prove(
      gen.getCircuitPaths("whitelist_membership").zkey,
      wtns,
    );
    aliasing.__setAliasK(0);
    const c = await ProofFormatter.formatPlonkForSolidity(
      m.proof,
      m.publicSignals,
    );
    aliasedProof = asWords(c.proof);
    const cs = asWords(c.publicSignals);
    expect(cs[0]).to.equal(signals[0]);
    aliasedSignals = [cs[0] + Q, cs[1], cs[2]];
  });

  describe("(a) verifyBatchWhitelistMembership", function () {
    it("returns per-entry results for [valid, tampered, aliased, valid] and never reverts", async function () {
      const zk = await deploy(false);
      const plonk = await ethers.getContractAt(
        "WhitelistMembershipVerifier",
        await zk.whitelistVerifier(),
      );
      expect(
        await plonk.verifyProof(aliasedProof, aliasedSignals),
        "precondition: the raw verifier accepts the alias",
      ).to.equal(true);

      const proofs = [proof, tampered, aliasedProof, proof];
      const sigs = [signals, signals, aliasedSignals, signals];
      const [results, successCount] =
        await zk.verifyBatchWhitelistMembership.staticCall(proofs, sigs);
      expect(results).to.deep.equal([true, false, false, true]);
      expect(successCount).to.equal(2n);
      await expect(zk.verifyBatchWhitelistMembership(proofs, sigs)).to.not.be
        .reverted;
    });
  });

  describe("(b) proof cache on the PLONK path", function () {
    it("caches, hits, expires, clears and re-verifies", async function () {
      const zk = await deploy(false);
      const key = await zk.whitelistProofCacheKey(proof, signals);

      await expect(zk.verifyWhitelistMembership(proof, signals))
        .to.emit(zk, "ProofCached")
        .withArgs(key, "whitelist");
      await expect(zk.verifyWhitelistMembership(proof, signals))
        .to.emit(zk, "ProofCacheHit")
        .withArgs(key, "whitelist");

      await zk.setProofCacheExpiry(3600);
      await time.increase(3601);
      await zk.clearExpiredProofs([key]);
      await expect(zk.verifyWhitelistMembership(proof, signals))
        .to.emit(zk, "ProofCached")
        .withArgs(key, "whitelist");
    });
  });

  describe("(c) the 27-word verifyCircuitProof route", function () {
    it("agrees with the typed entry on a real and on a tampered proof", async function () {
      const zk = await deploy(false);
      for (const [p, want] of [
        [proof, true],
        [tampered, false],
      ] as [Words, boolean][]) {
        const typed = await zk.verifyWhitelistMembership.staticCall(p, signals);
        const routed = await zk.verifyCircuitProof.staticCall(
          WL,
          EMPTY,
          route(p, signals),
        );
        expect(typed).to.equal(want);
        expect(routed).to.equal(typed);
      }
    });

    it("reverts on a malformed whitelist input count", async function () {
      const zk = await deploy(false);
      await expect(
        zk.verifyCircuitProof(WL, EMPTY, [...proof, signals[0]]),
      ).to.be.revertedWith("Invalid public inputs for whitelist circuit");
    });
  });

  describe("(d) testingMode whitelist mock", function () {
    it("requires all three signals non-zero, binding included", async function () {
      const zk = await deploy(true);
      const garbage = Array<bigint>(24).fill(0n);
      expect(
        await zk.verifyWhitelistMembership.staticCall(garbage, [1n, 1n, 0n]),
      ).to.equal(false);
      expect(
        await zk.verifyWhitelistMembership.staticCall(garbage, [0n, 1n, 1n]),
      ).to.equal(false);
      expect(
        await zk.verifyWhitelistMembership.staticCall(garbage, [1n, 0n, 1n]),
      ).to.equal(false);
      expect(
        await zk.verifyWhitelistMembership.staticCall(garbage, [1n, 1n, 1n]),
      ).to.equal(true);
    });

    it("never forwards the proof to the verifier in the whitelist slot", async function () {
      const zk = await deploy(true);
      const strict = await ethers.getContractAt(
        "WhitelistMembershipVerifier",
        await zk.whitelistVerifier(),
      );
      const s: Signals = [1n, 2n, BigInt(alice.address)];
      expect(
        await strict.verifyProof(tampered, s),
        "the strict verifier refuses this proof",
      ).to.equal(false);
      expect(
        await zk.verifyWhitelistMembership.staticCall(tampered, s),
      ).to.equal(true);
      expect(
        await zk.verifyCircuitProof.staticCall(WL, EMPTY, route(tampered, s)),
      ).to.equal(true);
    });
  });

  describe("(e) verifyBatchProofs, mixed circuits", function () {
    it("returns per-entry results with real verifiers", async function () {
      const zk = await deploy(false);
      const ids = [WL, WL, BL, COMP, ethers.ZeroHash, WL];
      const inputs = [
        route(proof, signals),
        route(tampered, signals),
        [1n], // garbage Groth16 proof: the real blacklist verifier refuses it
        [1n], // compliance needs 6 inputs: false, not a revert
        [1n], // unknown circuit: false, not a revert
        route(proof, signals), // cache hit
      ];
      const proofs = ids.map(() => EMPTY);
      const [results, successCount] = await zk.verifyBatchProofs.staticCall(
        ids,
        proofs,
        inputs,
      );
      expect(results).to.deep.equal([true, false, false, false, false, true]);
      expect(successCount).to.equal(2n);
      await expect(zk.verifyBatchProofs(ids, proofs, inputs))
        .to.emit(zk, "BatchProofsVerified")
        .withArgs(6n, 2n);
    });

    it("routes every circuit in testingMode and counts the real caller", async function () {
      const zk = await deploy(true);
      const [caller] = await ethers.getSigners();
      const ids = [WL, BL, BL, JUR, COMP];
      const inputs = [
        route(Array<bigint>(24).fill(0n), [1n, 1n, 1n]),
        [1n], // isNotBlacklisted
        [0n],
        [7n],
        [5n, 1n, 1n, 1n, 1n, 1n],
      ];
      const [results, successCount] = await zk.verifyBatchProofs.staticCall(
        ids,
        ids.map(() => EMPTY),
        inputs,
      );
      expect(results).to.deep.equal([true, true, false, true, true]);
      expect(successCount).to.equal(4n);

      await zk.verifyBatchProofs(
        ids,
        ids.map(() => EMPTY),
        inputs,
      );
      // Internal routing: stats go to the caller, not to the wrapper itself.
      expect(await zk.userProofCount(caller.address)).to.equal(5n);
      expect(await zk.userProofCount(await zk.getAddress())).to.equal(0n);
    });
  });

  describe("(f) IZKVerifier is the consumer ABI", function () {
    const LEGACY = ["verifyProof", "setVerifyingKey", "getVerifyingKey"];

    it("the wrapper has every interface selector except the legacy three", async function () {
      const iface = new ethers.Interface(
        (await artifacts.readArtifact("IZKVerifier")).abi,
      );
      const wrapper = ZKVerifierIntegrated__factory.createInterface();
      const missing: string[] = [];
      iface.forEachFunction((f) => {
        if (LEGACY.includes(f.name)) {
          expect(wrapper.hasFunction(f.selector), f.format()).to.equal(false);
        } else if (!wrapper.hasFunction(f.selector)) {
          missing.push(f.format());
        }
      });
      expect(missing, "interface functions the wrapper lacks").to.deep.equal(
        [],
      );
      for (const sig of [
        "verifyWhitelistMembership(uint256[24],uint256[3])",
        "whitelistProofCacheKey(uint256[24],uint256[3])",
        "testingMode()",
      ]) {
        expect(iface.hasFunction(sig), sig).to.equal(true);
      }
    });

    it("a consumer typed as IZKVerifier verifies through the wrapper", async function () {
      const zk = await deploy(false);
      const consumer = IZKVerifier__factory.connect(
        await zk.getAddress(),
        alice,
      );
      expect(await consumer.testingMode()).to.equal(false);
      expect(
        await consumer.verifyWhitelistMembership.staticCall(proof, signals),
      ).to.equal(true);
      expect(await consumer.whitelistProofCacheKey(proof, signals)).to.equal(
        await zk.whitelistProofCacheKey(proof, signals),
      );
      expect(await consumer.isCircuitRegistered(WL)).to.equal(true);
    });
  });
});
