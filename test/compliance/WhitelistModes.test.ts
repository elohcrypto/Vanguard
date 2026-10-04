import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";
import type { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import {
  ComplianceRules,
  ComplianceRules__factory,
  PrivacyManager,
  PrivacyManager__factory,
  ZKVerifierIntegrated__factory,
} from "../../typechain-types";
import { attest, configureKyc } from "../helpers/kyc";

// Plan v2 Task 3.4 (R-3R-5): the whitelist source per token in
// ComplianceRules. OracleOnly (default), ZkOnly (a live PrivacyManager
// binding), Either. Real PLONK proofs, fixture style of
// test/privacy/WhitelistBinder.test.ts.
/* eslint-disable @typescript-eslint/no-var-requires */
const path = require("path");
const { RealProofGenerator } = require(
  path.join(__dirname, "../../scripts/generate-real-proofs.js"),
);
const { MerkleTreeBuilder } = require(
  path.join(__dirname, "../../utils/merkle-tree-builder.js"),
);

const M = { OracleOnly: 0, ZkOnly: 1, Either: 2 } as const;
const MODES = ["OracleOnly", "ZkOnly", "Either"] as const;
const DAY = 24 * 3600;

type Signals = [bigint, bigint, bigint];
interface Proof {
  proof: bigint[];
  signals: Signals;
}
interface Member {
  identity: bigint;
  secret: bigint;
}

describe("ComplianceRules whitelist modes (Task 3.4)", function () {
  this.timeout(300000);

  let owner: HardhatEthersSigner;
  let alice: HardhatEthersSigner;
  let bob: HardhatEthersSigner;
  let carol: HardhatEthersSigner;
  let dave: HardhatEthersSigner;
  // The untyped JS RealProofGenerator.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let gen: any;
  const A: Member = { identity: 12345n, secret: 0xabcdef0123456789n };
  const B: Member = { identity: 22222n, secret: 202n };
  const C: Member = { identity: 44444n, secret: 404n };
  const list1: Member[] = [{ identity: 11111n, secret: 101n }, A, B];
  const list2: Member[] = [...list1, C];
  let root1: bigint;
  let root2: bigint;
  let aliceA1: Proof; // A under root1, bound to alice
  let bobB1: Proof; // B under root1, bound to bob
  let carolA1: Proof; // A under root1, bound to carol: alice's nullifier
  let aliceA2: Proof; // A under root2, bound to alice
  let carolC2: Proof; // C under root2 (unpublished at first), bound to carol

  const hex32 = (x: bigint) => ethers.toBeHex(x, 32);
  async function prove(m: Member, members: Member[], wallet: string) {
    const r = await gen.generateWhitelistProof({
      ...m,
      members,
      walletBinding: wallet,
    });
    return {
      proof: r.proof.map(BigInt),
      signals: r.publicSignals.map(BigInt) as Signals,
    };
  }
  const rootOf = async (members: Member[]): Promise<bigint> =>
    (
      await MerkleTreeBuilder.createFromCommitments(
        members.map((m) => gen.hash([m.identity, m.secret])),
      )
    ).getRoot();
  const submit = (pm: PrivacyManager, who: HardhatEthersSigner, p: Proof) =>
    pm.connect(who).submitWhitelistProof(p.proof, p.signals);

  before(async function () {
    [owner, alice, bob, carol, dave] = await ethers.getSigners();
    gen = new RealProofGenerator();
    await gen.initialize();
    root1 = await rootOf(list1);
    root2 = await rootOf(list2);
    aliceA1 = await prove(A, list1, alice.address);
    bobB1 = await prove(B, list1, bob.address);
    carolA1 = await prove(A, list1, carol.address);
    aliceA2 = await prove(A, list2, alice.address);
    carolC2 = await prove(C, list2, carol.address);
  });

  /** VSC on ComplianceRules, four verified 840 holders, a WhitelistOracle
   *  bound, a real-mode PrivacyManager under root1 with alice and bob bound. */
  async function system() {
    const deploy = async (name: string, ...a: unknown[]) =>
      (await ethers.getContractFactory(name)).deploy(...a);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const idReg: any = await deploy("IdentityRegistry");
    const rules = await new ComplianceRules__factory(owner).deploy(
      owner.address,
      [840],
      [],
    );
    const rAddr = await rules.getAddress();
    const iAddr = await idReg.getAddress();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const token: any = await deploy("Token", "VSC", "VSC", iAddr, rAddr);
    const tAddr: string = await token.getAddress();
    await rules.setTokenIdentityRegistry(tAddr, iAddr);
    await idReg.addAgent(owner.address);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const issuer: any = await deploy("ClaimIssuer", owner.address, "KYC", "d");
    await configureKyc(idReg, await issuer.getAddress());
    const OID = await ethers.getContractFactory("OnchainID");
    for (const w of [alice, bob, carol, dave]) {
      const id = await (await OID.deploy(w.address)).getAddress();
      await idReg.registerIdentity(w.address, id, 840);
      await attest(issuer, owner, id);
    }
    const om = await deploy("OracleManager");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const wl: any = await deploy(
      "WhitelistOracle",
      await om.getAddress(),
      "WL",
      "d",
    );
    await rules.setWhitelistOracle(tAddr, await wl.getAddress());
    const zk = await new ZKVerifierIntegrated__factory(owner).deploy(false);
    const pm = await new PrivacyManager__factory(owner).deploy(
      await zk.getAddress(),
    );
    await pm.publishWhitelistRoot(hex32(root1));
    await submit(pm, alice, aliceA1);
    await submit(pm, bob, bobB1);
    await rules.setPrivacyManager(tAddr, await pm.getAddress());
    const escrow = await deploy("MockToken", "T", "T", 0);
    const eAddr = await escrow.getAddress();
    await rules.addTrustedContract(tAddr, eAddr);
    return { rules, token, tAddr, wl, pm, idReg, eAddr };
  }

  let s: Awaited<ReturnType<typeof system>>;
  let rules: ComplianceRules;
  let asToken: ComplianceRules; // read-only, msg.sender = the token
  beforeEach(async function () {
    s = await loadFixture(system);
    rules = s.rules;
    asToken = rules.connect(ethers.provider);
  });

  const can = (from: string, to: string) =>
    asToken.canTransfer.staticCall(from, to, 1n, { from: s.tAddr });
  const receives = (to: string) =>
    asToken.canReceive.staticCall(to, { from: s.tAddr });
  const mode = (m: number) => rules.setWhitelistMode(s.tAddr, m);
  async function list(...who: HardhatEthersSigner[]) {
    for (const w of who) await s.wl.addToWhitelist(w.address, 1, 0, "kyc");
  }

  describe("normal path", function () {
    it("three modes x oracle listed/unlisted x proof valid/absent", async function () {
      const table: string[] = [];
      const expected: string[] = [];
      for (const m of [M.OracleOnly, M.ZkOnly, M.Either]) {
        await mode(m);
        for (const listed of [true, false]) {
          for (const who of [alice, bob, carol, dave]) {
            const on = await s.wl.isWhitelisted(who.address);
            if (listed && !on) await list(who);
            if (!listed && on) await s.wl.removeFromWhitelist(who.address, "x");
          }
          for (const proof of [true, false]) {
            // alice and bob hold live bindings; carol and dave none.
            const [a, b] = proof ? [alice, bob] : [carol, dave];
            const got = await can(a.address, b.address);
            const want =
              m === M.OracleOnly
                ? listed
                : m === M.ZkOnly
                  ? proof
                  : listed || proof;
            const cell = `${MODES[m]} listed=${listed} proof=${proof}`;
            table.push(`${cell}: ${got}`);
            expected.push(`${cell}: ${want}`);
          }
        }
      }
      expect(table).to.deep.equal(expected);
      expect(table.length).to.equal(12);
    });

    it("no oracle: OracleOnly is off, Either degrades to ZkOnly", async function () {
      await rules.setWhitelistOracle(s.tAddr, ethers.ZeroAddress);
      expect(await rules.whitelistMode(s.tAddr)).to.equal(BigInt(M.OracleOnly));
      expect(await can(carol.address, dave.address)).to.equal(true);
      await mode(M.Either);
      expect(await can(alice.address, bob.address)).to.equal(true);
      expect(await can(carol.address, dave.address)).to.equal(false);
      expect(await can(alice.address, carol.address)).to.equal(false);
    });

    it("each party is checked: one bound, one not, blocks in ZkOnly", async function () {
      await mode(M.ZkOnly);
      await list(carol);
      expect(await can(alice.address, carol.address)).to.equal(false);
      expect(await can(carol.address, alice.address)).to.equal(false);
      await mode(M.Either);
      expect(await can(alice.address, carol.address)).to.equal(true);
    });

    it("a real transfer obeys ZkOnly end to end", async function () {
      await list(alice, carol);
      await s.token.mint(alice.address, 100n);
      await mode(M.ZkOnly);
      await expect(s.token.connect(alice).transfer(bob.address, 10n)).to.not.be
        .reverted;
      await expect(
        s.token.connect(alice).transfer(carol.address, 10n),
      ).to.be.revertedWith("Compliance check failed");
    });
  });

  describe("mint, trusted path, canReceive (R-3R-5)", function () {
    it("mint: the recipient obeys the mode; burn is never gated", async function () {
      const Z = ethers.ZeroAddress;
      await list(carol);
      const rows: boolean[][] = [];
      for (const m of [M.OracleOnly, M.ZkOnly, M.Either]) {
        await mode(m);
        rows.push([
          await can(Z, alice.address),
          await can(Z, carol.address),
          await can(Z, dave.address),
          await can(dave.address, Z),
        ]);
      }
      // [alice bound, carol listed, dave neither, burn from dave]
      expect(rows).to.deep.equal([
        [false, true, false, true],
        [true, false, false, true],
        [true, true, false, true],
      ]);
      await mode(M.ZkOnly);
      await expect(s.token.mint(alice.address, 5n)).to.not.be.reverted;
      await expect(s.token.mint(carol.address, 5n)).to.be.revertedWith(
        "Compliance check failed",
      );
    });

    it("trusted path: the counterparty obeys the mode, the escrow is exempt", async function () {
      const e = s.eAddr;
      await list(carol);
      const rows: boolean[][] = [];
      for (const m of [M.OracleOnly, M.ZkOnly, M.Either]) {
        await mode(m);
        rows.push([
          await can(alice.address, e),
          await can(e, alice.address),
          await can(carol.address, e),
          await can(e, dave.address),
        ]);
      }
      // [alice bound, carol listed, dave neither]; the escrow never is.
      expect(rows).to.deep.equal([
        [false, false, true, false],
        [true, true, false, false],
        [true, true, true, false],
      ]);
    });

    it("canReceive (wallet recovery) obeys the mode", async function () {
      await list(carol);
      const rows: boolean[][] = [];
      for (const m of [M.OracleOnly, M.ZkOnly, M.Either]) {
        await mode(m);
        rows.push([
          await receives(alice.address),
          await receives(carol.address),
          await receives(dave.address),
        ]);
      }
      expect(rows).to.deep.equal([
        [false, true, false],
        [true, false, false],
        [true, true, false],
      ]);
    });
  });

  describe("binding lifecycle under ZkOnly", function () {
    beforeEach(async function () {
      await mode(M.ZkOnly);
    });

    it("root rotation blocks until the holder resubmits", async function () {
      expect(await receives(alice.address)).to.equal(true);
      await s.pm.publishWhitelistRoot(hex32(root2));
      expect(await receives(alice.address)).to.equal(false);
      await submit(s.pm, alice, aliceA2);
      expect(await receives(alice.address)).to.equal(true);
    });

    it("expiry blocks once the validity period passes", async function () {
      expect(await s.pm.proofValidityPeriod()).to.equal(BigInt(30 * DAY));
      // From chain, so fixture block timing cannot shift it (review LOW-4b).
      const { expiresAt } = await s.pm.whitelistBindings(alice.address);
      await time.increaseTo(expiresAt - 2n);
      expect(await receives(alice.address)).to.equal(true);
      await time.increaseTo(expiresAt);
      expect(await receives(alice.address)).to.equal(false);
    });

    it("re-pointing to a new PrivacyManager drops holders until they re-bind", async function () {
      const pm2 = await new PrivacyManager__factory(owner).deploy(
        await s.pm.zkVerifier(),
      );
      await pm2.publishWhitelistRoot(hex32(root1));
      expect(await receives(alice.address)).to.equal(true);
      // Allowed while ZkOnly uses it: the new one has no bindings yet.
      await rules.setPrivacyManager(s.tAddr, await pm2.getAddress());
      expect(await receives(alice.address)).to.equal(false);
      expect(await receives(bob.address)).to.equal(false);
      await submit(pm2, alice, aliceA1);
      expect(await receives(alice.address)).to.equal(true);
      expect(await receives(bob.address)).to.equal(false);
    });

    it("replay: alice's nullifier cannot bind carol, carol stays blocked", async function () {
      expect(carolA1.signals[0]).to.equal(aliceA1.signals[0]);
      await expect(submit(s.pm, carol, carolA1))
        .to.be.revertedWithCustomError(s.pm, "NullifierBoundToOtherWallet")
        .withArgs(alice.address, 1n);
      expect(await receives(carol.address)).to.equal(false);
      expect(await can(alice.address, carol.address)).to.equal(false);
    });

    it("forged root: a proof under an unpublished root binds nothing", async function () {
      await expect(submit(s.pm, carol, carolC2)).to.be.revertedWithCustomError(
        s.pm,
        "RootNotCurrent",
      );
      expect((await s.pm.whitelistBindings(carol.address)).version).to.equal(
        0n,
      );
      expect(await receives(carol.address)).to.equal(false);
      // The same proof is valid once that root is the published one.
      await s.pm.publishWhitelistRoot(hex32(root2));
      await submit(s.pm, carol, carolC2);
      expect(await receives(carol.address)).to.equal(true);
    });
  });

  // Review LOW-4a: the mode and the PrivacyManager are per token.
  it("another token on the same rules keeps OracleOnly behaviour", async function () {
    const t2 = await (
      await ethers.getContractFactory("Token")
    ).deploy("V2", "V2", await s.idReg.getAddress(), await rules.getAddress());
    const t2Addr = await t2.getAddress();
    await rules.setTokenIdentityRegistry(t2Addr, await s.idReg.getAddress());
    await mode(M.ZkOnly);
    expect(await can(carol.address, dave.address)).to.equal(false);
    expect(await rules.whitelistMode(t2Addr)).to.equal(BigInt(M.OracleOnly));
    expect(await rules.privacyManager(t2Addr)).to.equal(ethers.ZeroAddress);
    // No oracle, no binding, no mode on t2: the gate is off there.
    const on2 = (from: string, to: string) =>
      asToken.canTransfer.staticCall(from, to, 1n, { from: t2Addr });
    expect(await on2(carol.address, dave.address)).to.equal(true);
    expect(
      await asToken.canReceive.staticCall(dave.address, { from: t2Addr }),
    ).to.equal(true);
  });

  describe("setter guards", function () {
    it("ZkOnly/Either need a PrivacyManager; it cannot be cleared while used", async function () {
      const t = s.tAddr;
      await rules.setPrivacyManager(t, ethers.ZeroAddress);
      for (const m of [M.ZkOnly, M.Either]) {
        await expect(mode(m))
          .to.be.revertedWithCustomError(rules, "PrivacyManagerNotSet")
          .withArgs(t);
      }
      const pmAddr = await s.pm.getAddress();
      await expect(rules.setPrivacyManager(t, pmAddr))
        .to.emit(rules, "PrivacyManagerSet")
        .withArgs(t, pmAddr);
      await expect(mode(M.Either))
        .to.emit(rules, "WhitelistModeSet")
        .withArgs(t, M.Either);
      await expect(rules.setPrivacyManager(t, ethers.ZeroAddress))
        .to.be.revertedWithCustomError(rules, "PrivacyManagerInUse")
        .withArgs(t);
      await mode(M.OracleOnly);
      await rules.setPrivacyManager(t, ethers.ZeroAddress);
      expect(await rules.privacyManager(t)).to.equal(ethers.ZeroAddress);
    });

    it("refuses a non-contract or incompatible PrivacyManager, token 0, a bad mode", async function () {
      const t = s.tAddr;
      await expect(rules.setPrivacyManager(t, dave.address))
        .to.be.revertedWithCustomError(rules, "PrivacyManagerNotAContract")
        .withArgs(dave.address);
      const other = await s.idReg.getAddress();
      await expect(rules.setPrivacyManager(t, other))
        .to.be.revertedWithCustomError(rules, "PrivacyManagerIncompatible")
        .withArgs(other);
      const pmAddr = await s.pm.getAddress();
      const Z = ethers.ZeroAddress;
      await expect(
        rules.setPrivacyManager(Z, pmAddr),
      ).to.be.revertedWithCustomError(rules, "InvalidTokenAddress");
      await expect(
        rules.setWhitelistMode(Z, M.OracleOnly),
      ).to.be.revertedWithCustomError(rules, "InvalidTokenAddress");
      // Out of enum range: the ABI decoder refuses the argument with an
      // empty revert (no panic: no conversion in the body is reached).
      await expect(rules.setWhitelistMode(t, 3)).to.be.revertedWithoutReason();
    });

    it("only the owner sets either", async function () {
      const r = rules.connect(alice);
      await expect(
        r.setPrivacyManager(s.tAddr, await s.pm.getAddress()),
      ).to.be.revertedWithCustomError(rules, "OwnableUnauthorizedAccount");
      await expect(
        r.setWhitelistMode(s.tAddr, M.ZkOnly),
      ).to.be.revertedWithCustomError(rules, "OwnableUnauthorizedAccount");
    });
  });
});
