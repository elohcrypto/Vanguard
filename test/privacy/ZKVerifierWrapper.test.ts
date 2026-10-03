import { expect } from "chai";
import { ethers, artifacts } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import type { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import {
  IZKVerifier__factory,
  ZKVerifierIntegrated,
  ZKVerifierIntegrated__factory,
} from "../../typechain-types";

// Wrapper unit tests for Task 3.2 (plan v2 §7): batch, cache, the closed
// whitelist route of verifyCircuitProof (Task 3.3) and its closed blacklist
// route (Task 3.7), the PLONK attestation routes (Task 3.7b), testingMode,
// verifyBatchProofs and the typed IZKVerifier ABI that PrivacyManager
// consumes. Real PLONK proofs, built the way ZKSoundness.test.js test D
// builds them.
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
const EMPTY = Array<bigint>(24).fill(0n);
const ones = (n: number) => Array<bigint>(n).fill(1n);

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

  describe("(c) verifyCircuitProof refuses the PLONK circuits", function () {
    it("reverts in strict mode, real and testingMode alike", async function () {
      for (const mode of [false, true]) {
        const zk = await deploy(mode);
        for (const inputs of [route(proof, signals), [...proof, signals[0]]]) {
          await expect(
            zk.verifyCircuitProof(WL, EMPTY, inputs),
          ).to.be.revertedWith("use verifyWhitelistMembership");
        }
      }
    });

    it("refuses the blacklist circuit (PLONK since Task 3.7) the same way", async function () {
      for (const mode of [false, true]) {
        const zk = await deploy(mode);
        for (const inputs of [[1n], [...proof, 1n, 1n, 1n, 1n]]) {
          await expect(
            zk.verifyCircuitProof(BL, EMPTY, inputs),
          ).to.be.revertedWith("use verifyBlacklistNonMembership");
        }
      }
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

    it("blacklist mock requires nullifier, whitelistRoot, binding non-zero", async function () {
      const zk = await deploy(true);
      const garbage = Array<bigint>(24).fill(0n);
      // blacklistRoot 0 is an empty sanctions list: accepted, as in real mode.
      expect(
        await zk.verifyBlacklistNonMembership.staticCall(garbage, [
          1n,
          1n,
          0n,
          1n,
        ]),
        "empty sanctions list",
      ).to.equal(true);
      for (const i of [0, 1, 3]) {
        const s: [bigint, bigint, bigint, bigint] = [1n, 1n, 1n, 1n];
        s[i] = 0n;
        expect(
          await zk.verifyBlacklistNonMembership.staticCall(garbage, s),
          `signal ${i} zero`,
        ).to.equal(false);
      }
      expect(
        await zk.verifyBlacklistNonMembership.staticCall(garbage, [
          1n,
          1n,
          1n,
          1n,
        ]),
      ).to.equal(true);
      expect(
        await zk.verifyBlacklistNonMembership.staticCall(garbage, [
          1n,
          1n,
          Q,
          1n,
        ]),
        "out of field even in testingMode",
      ).to.equal(false);
    });

    it("attestation mocks require nullifier, Ax, Ay, binding non-zero; policy may be 0", async function () {
      const zk = await deploy(true);
      // Task 3.8 M1: 7 and 11 signals (chainId, verifierContext added).
      for (const n of [7, 11]) {
        const call = (s: bigint[]) =>
          n === 7
            ? zk.verifyJurisdictionProof.staticCall(EMPTY, s as never)
            : zk.verifyComplianceAggregation.staticCall(EMPTY, s as never);
        const policyZero = ones(n);
        for (let i = 3; i < n - 1; i++) policyZero[i] = 0n;
        expect(await call(policyZero), `n ${n}, policy 0`).to.equal(true);
        for (const i of [0, 1, 2, n - 1]) {
          const s = ones(n);
          s[i] = 0n;
          expect(await call(s), `n ${n}, signal ${i} zero`).to.equal(false);
        }
        const big = ones(n);
        big[3] = Q;
        expect(await call(big), "out of field even in testingMode").to.equal(
          false,
        );
      }
      expect(
        await zk.verifyAccreditationProof.staticCall(EMPTY, ones(7) as never),
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
    });
  });

  describe("(e) verifyBatchProofs, mixed circuits", function () {
    it("returns per-entry results with real verifiers", async function () {
      const zk = await deploy(false);
      const yes = await (
        await ethers.getContractFactory("AlwaysTrueVerifier")
      ).deploy();
      await zk.updateVerifier("jurisdiction", await yes.getAddress());
      const ids = [WL, JUR, BL, COMP, ethers.ZeroHash, JUR];
      const inputs = [
        [...signals], // whitelist has its own route: refused here, false
        [7n, 1n, 2n, 3n, 4n, 5n, 6n], // accepted by the jurisdiction slot
        [1n], // blacklist has its own route: refused here, false
        [1n], // compliance needs 11 signals: false, not a revert
        [1n], // unknown circuit: false, not a revert
        [7n, 1n, 2n, 3n, 4n, 5n, 6n], // cache hit
      ];
      const proofs = ids.map(() => EMPTY);
      const [results, successCount] = await zk.verifyBatchProofs.staticCall(
        ids,
        proofs,
        inputs,
      );
      expect(results).to.deep.equal([false, true, false, false, false, true]);
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
        [1n, 1n, 1n],
        [1n], // blacklist has its own route: refused like the whitelist
        [0n],
        [7n, 1n, 1n, 1n, 1n, 0n, 1n],
        [5n, 1n, 1n, 1n, 1n, 0n, 0n, 0n, 0n, 0n, 1n],
      ];
      const [results, successCount] = await zk.verifyBatchProofs.staticCall(
        ids,
        ids.map(() => EMPTY),
        inputs,
      );
      expect(results).to.deep.equal([false, false, false, true, true]);
      expect(successCount).to.equal(2n);

      await zk.verifyBatchProofs(
        ids,
        ids.map(() => EMPTY),
        inputs,
      );
      // Internal routing: stats go to the caller, not to the wrapper itself;
      // the refused PLONK entries reach no verifier and count nothing.
      expect(await zk.userProofCount(caller.address)).to.equal(2n);
      expect(await zk.userProofCount(await zk.getAddress())).to.equal(0n);
    });
  });

  // Review 3.2 L1: a mutation that routed the blacklist id to the
  // jurisdiction internal survived every test, because the batch entries were
  // garbage under both verifiers. Pin each routed id to its own slot (the
  // blacklist left the router in Task 3.7: an accepting blacklist slot must
  // not answer any routed id).
  describe("(g) every attestation id reaches its own verifier", function () {
    const ACC = ethers.keccak256(ethers.toUtf8Bytes("ACCREDITATION_PROOF"));

    it("an accepting verifier in one slot answers only that circuit", async function () {
      for (const [slot, id] of [
        ["blacklist", BL],
        ["jurisdiction", JUR],
        ["accreditation", ACC],
      ] as [string, string][]) {
        const routed = [JUR, ACC];
        const zk = await deploy(false);
        const yes = await (
          await ethers.getContractFactory("AlwaysTrueVerifier")
        ).deploy();
        await zk.updateVerifier(slot, await yes.getAddress());
        for (const other of routed) {
          expect(
            await zk.verifyCircuitProof.staticCall(other, EMPTY, ones(7)),
            `${slot} slot accepting, querying ${other}`,
          ).to.equal(other === id);
        }
        const [batch] = await zk.verifyBatchProofs.staticCall(
          [BL],
          [EMPTY],
          [[1n]],
        );
        expect(batch[0], `${slot} slot accepting, querying BL`).to.equal(false);
        expect(
          await zk.verifyCircuitProof.staticCall(COMP, EMPTY, ones(11)),
        ).to.equal(false);
      }
    });

    it("strict mode keeps the original revert messages", async function () {
      const zk = await deploy(false);
      const cases: [string, bigint[], string][] = [
        [BL, [1n, 2n], "use verifyBlacklistNonMembership"],
        [JUR, [], "Invalid public inputs for jurisdiction circuit"],
        [ACC, [1n, 2n], "Invalid public inputs for accreditation circuit"],
        [COMP, [1n], "Invalid public inputs for compliance circuit"],
        [ethers.ZeroHash, [1n], "ZKVerifierIntegrated: Unknown circuit ID"],
      ];
      for (const [id, inputs, message] of cases) {
        await expect(
          zk.verifyCircuitProof(id, EMPTY, inputs),
        ).to.be.revertedWith(message);
      }
    });
  });

  describe("(f) IZKVerifier is the consumer ABI", function () {
    // The Groth16 ABI nothing implemented (Proof, VerifyingKey) left in 3.7b.
    const LEGACY = ["verifyProof", "setVerifyingKey", "getVerifyingKey"];

    it("the wrapper has every interface selector; the legacy ABI is gone", async function () {
      const iface = new ethers.Interface(
        (await artifacts.readArtifact("IZKVerifier")).abi,
      );
      const wrapper = ZKVerifierIntegrated__factory.createInterface();
      const missing: string[] = [];
      iface.forEachFunction((f) => {
        expect(LEGACY, f.format()).to.not.include(f.name);
        if (!wrapper.hasFunction(f.selector)) missing.push(f.format());
      });
      expect(missing, "interface functions the wrapper lacks").to.deep.equal(
        [],
      );
      for (const sig of [
        "verifyWhitelistMembership(uint256[24],uint256[3])",
        "whitelistProofCacheKey(uint256[24],uint256[3])",
        "verifyBlacklistNonMembership(uint256[24],uint256[4])",
        "blacklistProofCacheKey(uint256[24],uint256[4])",
        "verifyCircuitProof(bytes32,uint256[24],uint256[])",
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
