import { expect } from "chai";
import { ethers } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import { anyValue } from "@nomicfoundation/hardhat-chai-matchers/withArgs";
import type { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import {
  PrivacyManager,
  PrivacyManager__factory,
  ZKVerifierIntegrated__factory,
} from "../../typechain-types";

// PrivacyManager as the whitelist root registry and wallet binder (plan
// Task 3.3; D29/D30, R-3R-7, R-3R-10). Real PLONK proofs, no testingMode.
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
const DAY = 24 * 3600;
const WL = ethers.keccak256(ethers.toUtf8Bytes("WHITELIST_MEMBERSHIP"));

type Words = bigint[];
type Signals = [bigint, bigint, bigint];
interface Proof {
  proof: Words;
  signals: Signals;
}
interface Member {
  identity: bigint;
  secret: bigint;
}

describe("PrivacyManager whitelist binder (Task 3.3)", function () {
  this.timeout(300000);

  let owner: HardhatEthersSigner;
  let alice: HardhatEthersSigner;
  let bob: HardhatEthersSigner;
  let ops: HardhatEthersSigner;
  // The untyped JS RealProofGenerator.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let gen: any;
  const me: Member = { identity: 12345n, secret: 0xabcdef0123456789n };
  const list1: Member[] = [
    { identity: 11111n, secret: 101n },
    me,
    { identity: 33333n, secret: 303n },
  ];
  const list2: Member[] = [...list1, { identity: 44444n, secret: 404n }];
  let root1: bigint;
  let root2: bigint;
  let aliceR1: Proof; // me, list1, bound to alice
  let bobR1: Proof; // me, list1, bound to bob: same nullifier
  let aliceR2: Proof; // me, list2, bound to alice
  let bobAliased: Proof; // me, list1, bound to bob, nullifier n + q

  const words = (xs: (string | bigint)[]) => xs.map((x) => BigInt(x));
  const hex32 = (x: bigint) => ethers.toBeHex(x, 32);
  async function prove(members: Member[], wallet: string): Promise<Proof> {
    const r = await gen.generateWhitelistProof({
      ...me,
      members,
      walletBinding: wallet,
    });
    return {
      proof: words(r.proof),
      signals: words(r.publicSignals) as Signals,
    };
  }
  async function treeOf(members: Member[]) {
    return MerkleTreeBuilder.createFromCommitments(
      members.map((m) => gen.hash([m.identity, m.secret])),
    );
  }

  async function deploy(): Promise<PrivacyManager> {
    const zk = await new ZKVerifierIntegrated__factory(owner).deploy(false);
    const pm = await new PrivacyManager__factory(owner).deploy(
      await zk.getAddress(),
    );
    await pm.publishWhitelistRoot(hex32(root1));
    return pm;
  }
  const submit = (pm: PrivacyManager, who: HardhatEthersSigner, p: Proof) =>
    pm.connect(who).submitWhitelistProof(p.proof, p.signals);

  before(async function () {
    [owner, alice, bob, ops] = await ethers.getSigners();
    gen = new RealProofGenerator();
    await gen.initialize();
    const t1 = await treeOf(list1);
    root1 = t1.getRoot();
    root2 = (await treeOf(list2)).getRoot();
    aliceR1 = await prove(list1, alice.address);
    bobR1 = await prove(list1, bob.address);
    aliceR2 = await prove(list2, alice.address);

    // Same witness as bobR1, transcript over n + q (R-3R-7).
    const input = {
      identity: me.identity.toString(),
      secret: me.secret.toString(),
      ...t1.getProof(1),
      merkleRoot: root1.toString(),
      walletBinding: BigInt(bob.address).toString(),
    };
    input.pathElements = input.pathElements.map(String);
    const paths = gen.getCircuitPaths("whitelist_membership");
    const wtns = { type: "mem" };
    await snarkjs.wtns.calculate(input, paths.wasm, wtns);
    const aliasing = loadAliasingSnarkjs();
    aliasing.__setAliasK(1);
    const m = await aliasing.plonk.prove(paths.zkey, wtns);
    aliasing.__setAliasK(0);
    const c = await ProofFormatter.formatPlonkForSolidity(
      m.proof,
      m.publicSignals,
    );
    const cs = words(c.publicSignals);
    expect(cs[0]).to.equal(bobR1.signals[0]);
    bobAliased = {
      proof: words(c.proof),
      signals: [cs[0] + Q, cs[1], cs[2]],
    };
  });

  describe("root registry", function () {
    it("publishes by owner or listOperator only, bumping the version", async function () {
      const pm = await deploy();
      expect(await pm.whitelistRoot()).to.equal(hex32(root1));
      expect(await pm.whitelistVersion()).to.equal(1n);
      await expect(
        pm.connect(ops).publishWhitelistRoot(hex32(root2)),
      ).to.be.revertedWithCustomError(pm, "NotListOperator");
      await expect(
        pm.connect(alice).setListOperator(ops.address),
      ).to.be.revertedWithCustomError(pm, "OwnableUnauthorizedAccount");
      await expect(pm.setListOperator(ops.address))
        .to.emit(pm, "ListOperatorUpdated")
        .withArgs(ethers.ZeroAddress, ops.address);
      await expect(pm.connect(ops).publishWhitelistRoot(hex32(root2)))
        .to.emit(pm, "WhitelistRootPublished")
        .withArgs(hex32(root2), 2n, ops.address);
    });

    it("refuses a zero root and a root at or above the field order", async function () {
      const pm = await deploy();
      for (const bad of [0n, Q, 2n ** 256n - 1n]) {
        await expect(
          pm.publishWhitelistRoot(hex32(bad)),
        ).to.be.revertedWithCustomError(pm, "InvalidWhitelistRoot");
      }
    });

    it("accepts nothing before a root is published", async function () {
      const zk = await new ZKVerifierIntegrated__factory(owner).deploy(false);
      const pm = await new PrivacyManager__factory(owner).deploy(
        await zk.getAddress(),
      );
      await expect(submit(pm, alice, aliceR1)).to.be.revertedWithCustomError(
        pm,
        "RootNotCurrent",
      );
    });
  });

  describe("binding", function () {
    it("binds the submitting wallet and emits", async function () {
      const pm = await deploy();
      await expect(submit(pm, alice, aliceR1)).to.emit(
        pm,
        "WhitelistProofBound",
      );
      const b = await pm.whitelistBindings(alice.address);
      expect(b.version).to.equal(1n);
      expect(b.nullifier).to.equal(aliceR1.signals[0]);
      expect(await pm.nullifierWallet(1n, aliceR1.signals[0])).to.equal(
        alice.address,
      );
      expect(await pm.hasValidWhitelistProof(alice.address)).to.equal(true);
    });

    it("refuses a second wallet for the same nullifier", async function () {
      const pm = await deploy();
      await submit(pm, alice, aliceR1);
      expect(bobR1.signals[0]).to.equal(aliceR1.signals[0]);
      await expect(submit(pm, bob, bobR1))
        .to.be.revertedWithCustomError(pm, "NullifierBoundToOtherWallet")
        .withArgs(alice.address, 1n);
      expect(await pm.hasValidWhitelistProof(bob.address)).to.equal(false);
    });

    it("a false proof records nothing", async function () {
      const pm = await deploy();
      const bad: Proof = {
        proof: [...aliceR1.proof],
        signals: aliceR1.signals,
      };
      bad.proof[9] += 1n;
      await expect(submit(pm, alice, bad)).to.be.revertedWithCustomError(
        pm,
        "InvalidWhitelistProof",
      );
      expect((await pm.whitelistBindings(alice.address)).version).to.equal(0n);
      expect(await pm.nullifierWallet(1n, aliceR1.signals[0])).to.equal(
        ethers.ZeroAddress,
      );
    });

    it("refuses aliased signals end-to-end", async function () {
      const pm = await deploy();
      await submit(pm, alice, aliceR1);
      // n + q: a fresh map key, but the wrapper refuses the non-canonical signal.
      await expect(submit(pm, bob, bobAliased)).to.be.revertedWithCustomError(
        pm,
        "InvalidWhitelistProof",
      );
      // root + q and a binding above 2^160 never reach the verifier.
      const [n, r, w] = aliceR1.signals;
      await expect(
        pm.connect(alice).submitWhitelistProof(aliceR1.proof, [n, r + Q, w]),
      ).to.be.revertedWithCustomError(pm, "RootNotCurrent");
      await expect(
        pm
          .connect(alice)
          .submitWhitelistProof(aliceR1.proof, [n, r, w + 2n ** 160n]),
      ).to.be.revertedWithCustomError(pm, "WalletBindingMismatch");
      await expect(
        pm.connect(alice).submitWhitelistProof(aliceR1.proof, [n, r, 0n]),
      ).to.be.revertedWithCustomError(pm, "WalletBindingMismatch");
      expect(await pm.hasValidWhitelistProof(bob.address)).to.equal(false);
    });

    it("rotation lapses a binding and a re-proof under the new root rebinds", async function () {
      const pm = await deploy();
      await submit(pm, alice, aliceR1);
      await pm.publishWhitelistRoot(hex32(root2));
      expect(await pm.hasValidWhitelistProof(alice.address)).to.equal(false);
      // Single current root: the old one is no longer accepted.
      await expect(submit(pm, alice, aliceR1)).to.be.revertedWithCustomError(
        pm,
        "RootNotCurrent",
      );
      await submit(pm, alice, aliceR2);
      expect(aliceR2.signals[0]).to.not.equal(aliceR1.signals[0]);
      expect((await pm.whitelistBindings(alice.address)).version).to.equal(2n);
      expect(await pm.hasValidWhitelistProof(alice.address)).to.equal(true);
    });

    it("republishing the same root lapses bindings until re-proved", async function () {
      const pm = await deploy();
      await submit(pm, alice, aliceR1);
      await pm.publishWhitelistRoot(hex32(root1));
      expect(await pm.hasValidWhitelistProof(alice.address)).to.equal(false);
      await submit(pm, alice, aliceR1);
      expect(await pm.hasValidWhitelistProof(alice.address)).to.equal(true);
    });

    // Review LOW-2: the reservation is per root version, so a holder who
    // lost alice's key binds bob after A -> B -> A; never two per version.
    it("A -> B -> A frees the nullifier for a new wallet, one per version", async function () {
      const pm = await deploy();
      await submit(pm, alice, aliceR1);
      await pm.publishWhitelistRoot(hex32(root2));
      await pm.publishWhitelistRoot(hex32(root1));
      expect(await pm.whitelistVersion()).to.equal(3n);
      await expect(submit(pm, bob, bobR1))
        .to.emit(pm, "WhitelistProofBound")
        .withArgs(bob.address, bobR1.signals[0], 3n, anyValue);
      expect(await pm.nullifierWallet(3n, bobR1.signals[0])).to.equal(
        bob.address,
      );
      expect(await pm.nullifierWallet(1n, aliceR1.signals[0])).to.equal(
        alice.address,
      );
      expect(await pm.hasValidWhitelistProof(bob.address)).to.equal(true);
      expect(await pm.hasValidWhitelistProof(alice.address)).to.equal(false);
      // Same version: alice cannot take the commitment back.
      await expect(submit(pm, alice, aliceR1))
        .to.be.revertedWithCustomError(pm, "NullifierBoundToOtherWallet")
        .withArgs(bob.address, 3n);
      expect(await pm.hasValidWhitelistProof(alice.address)).to.equal(false);
    });

    it("a same-root republish lets a new wallet bind, not a second one", async function () {
      const pm = await deploy();
      await submit(pm, alice, aliceR1);
      await pm.publishWhitelistRoot(hex32(root1));
      await submit(pm, bob, bobR1);
      expect(await pm.hasValidWhitelistProof(bob.address)).to.equal(true);
      expect(await pm.hasValidWhitelistProof(alice.address)).to.equal(false);
      await expect(submit(pm, alice, aliceR1))
        .to.be.revertedWithCustomError(pm, "NullifierBoundToOtherWallet")
        .withArgs(bob.address, 2n);
    });
  });

  describe("expiry", function () {
    it("a binding expires after the owner's validity period", async function () {
      const pm = await deploy();
      await submit(pm, alice, aliceR1);
      const period = await pm.proofValidityPeriod();
      expect(period).to.equal(BigInt(30 * DAY));
      await time.increase(Number(period) - 10);
      expect(await pm.hasValidWhitelistProof(alice.address)).to.equal(true);
      await time.increase(10);
      expect(await pm.hasValidWhitelistProof(alice.address)).to.equal(false);
    });

    it("validity is frozen per binding; user settings never change it", async function () {
      const pm = await deploy();
      await submit(pm, alice, aliceR1);
      const { expiresAt } = await pm.whitelistBindings(alice.address);
      await expect(pm.setProofValidityPeriod(DAY))
        .to.emit(pm, "ProofValidityPeriodUpdated")
        .withArgs(BigInt(30 * DAY), BigInt(DAY));
      await pm.connect(alice).setUserPrivacySettings({
        enablePrivateWhitelist: false,
        enablePrivateJurisdiction: true,
        enablePrivateAccreditation: true,
        enablePrivateCompliance: true,
        proofValidityPeriod: 3600,
      });
      expect((await pm.whitelistBindings(alice.address)).expiresAt).to.equal(
        expiresAt,
      );
      await time.increase(2 * DAY);
      expect(await pm.hasValidWhitelistProof(alice.address)).to.equal(true);
      // A new submission takes the new period.
      await submit(pm, alice, aliceR1);
      const now = BigInt(await time.latest());
      expect((await pm.whitelistBindings(alice.address)).expiresAt).to.equal(
        now + BigInt(DAY),
      );
    });

    it("the owner's period is bounded to [1 day, 365 days]", async function () {
      const pm = await deploy();
      for (const bad of [DAY - 1, 365 * DAY + 1, 0]) {
        await expect(
          pm.setProofValidityPeriod(bad),
        ).to.be.revertedWithCustomError(pm, "InvalidValidityPeriod");
      }
      await pm.setProofValidityPeriod(365 * DAY);
      await expect(
        pm.connect(alice).setProofValidityPeriod(DAY),
      ).to.be.revertedWithCustomError(pm, "OwnableUnauthorizedAccount");
    });
  });

  describe("verifier and ownership", function () {
    it("refuses a testingMode verifier in the constructor and the setter", async function () {
      const mock = await new ZKVerifierIntegrated__factory(owner).deploy(true);
      const factory = new PrivacyManager__factory(owner);
      await expect(
        factory.deploy(await mock.getAddress()),
      ).to.be.revertedWithCustomError(factory, "TestingModeVerifier");
      const pm = await deploy();
      await expect(
        pm.setZKVerifier(await mock.getAddress()),
      ).to.be.revertedWithCustomError(pm, "TestingModeVerifier");
      // No testingMode() at all fails closed; an EOA has no code.
      const noFlag = await (
        await ethers.getContractFactory("AlwaysTrueVerifier")
      ).deploy();
      await expect(
        pm.setZKVerifier(await noFlag.getAddress()),
      ).to.be.revertedWithCustomError(pm, "TestingModeVerifier");
      await expect(pm.setZKVerifier(alice.address)).to.be.revertedWith(
        "PrivacyManager: ZK verifier is not a contract",
      );
      const real = await new ZKVerifierIntegrated__factory(owner).deploy(false);
      await expect(pm.setZKVerifier(await real.getAddress())).to.emit(
        pm,
        "ZKVerifierUpdated",
      );
    });

    it("is Ownable2Step and renounceOwnership reverts", async function () {
      const pm = await deploy();
      await expect(pm.renounceOwnership()).to.be.revertedWithCustomError(
        pm,
        "RenounceDisabled",
      );
      await pm.transferOwnership(bob.address);
      expect(await pm.owner()).to.equal(owner.address);
      expect(await pm.pendingOwner()).to.equal(bob.address);
      await pm.connect(bob).acceptOwnership();
      expect(await pm.owner()).to.equal(bob.address);
      await expect(
        pm.publishWhitelistRoot(hex32(root2)),
      ).to.be.revertedWithCustomError(pm, "NotListOperator");
    });

    it("submitAttestationProof refuses the whitelist circuit", async function () {
      const pm = await deploy();
      await expect(
        pm.submitAttestationProof(WL, aliceR1.proof, aliceR1.signals),
      )
        .to.be.revertedWithCustomError(pm, "NotAttestationCircuit")
        .withArgs(WL);
      const [wl] = await pm.validateAllPrivateCompliance(alice.address);
      expect(wl).to.equal(false);
    });
  });
});
