import { expect } from "chai";
import { ethers } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import { handoverFixture } from "../helpers/governanceFixture";
import { runHandover } from "../../scripts/handover";

const {
  acceptAllByVote,
  assertHandoverComplete,
  handoverDeployerPowers,
} = require("../../demo/utils/Handover");

// Plan v2 Task 4.2: KeyManager in the handover ceremony. It has no owner,
// so nothing moves; the preflight refuses a KeyManager that is not one and
// the completion check proves the deployer holds no KeyManager power and
// that the demo identity authorizes it.
describe("Handover: KeyManager (4.2)", function () {
  let f: Awaited<ReturnType<typeof handoverFixture>>;
  let km: any;
  let kmAddr: string;
  let identity: any;
  let args: Record<string, any>;

  const kmLine = (a: string) =>
    `KeyManager ${a} code matches the compiled KeyManager: no owner, no allowlist, the deployer holds no KeyManager power; only an identity's pinned recovery manager can move its ownership: its recovery agents at their threshold evict its MANAGEMENT keys after 48h and move its owner after 7 days`;
  const idLine = (id: string, a: string) =>
    `demo identity ${id} pins KeyManager ${a} as its recovery manager and authorizes only it; the deployer is not its owner, manager, MANAGEMENT key or recovery agent`;
  const facLine = (fac: string, a: string) =>
    `OnchainIDFactory ${fac} pins KeyManager ${a} as the recovery manager of every identity it creates (recoveryManager, code-hash checked)`;
  const dKey = () =>
    ethers.solidityPackedKeccak256(["address"], [f.deployer.address]);

  beforeEach(async function () {
    f = await handoverFixture();
    // The fixture's KeyManager: the factory pins it on every identity it
    // creates (Task 4.16), so the proposer's identity is pinned already.
    km = f.keyManager;
    kmAddr = await km.getAddress();
    // The proposer's identity opted in, as demo option 12 does for wallet 1.
    const idAddr = await f.c.identityRegistry.identity(f.proposer.address);
    identity = await ethers.getContractAt("OnchainID", idAddr);
    await identity.connect(f.proposer).authorizeManager(kmAddr);
    expect(await identity.recoveryManager()).to.equal(kmAddr);
    args = { ...f.args, keyManager: km, keyManagerIdentity: idAddr };
  });

  async function ceremony() {
    const report = await handoverDeployerPowers(args);
    await acceptAllByVote({
      governance: f.c.governance,
      contracts: f.c,
      proposer: f.proposer,
      voters: f.voters,
      registryProposals: report.registryProposals,
      log: () => {},
    });
  }

  it("the completion check proves no KeyManager power and the opt-in", async function () {
    // Before the ceremony (the deployer still owns the factory): the
    // factory line catches a factory that pins nothing (R-411-19).
    const facAt = await f.c.onchainIDFactory.getAddress();
    await f.c.onchainIDFactory.setRecoveryManager(ethers.ZeroAddress);
    const unpinned = await assertHandoverComplete(args);
    expect(unpinned.failures).to.include(facLine(facAt, kmAddr));
    await f.c.onchainIDFactory.setRecoveryManager(kmAddr);
    const pinned = await assertHandoverComplete(args);
    expect(pinned.failures).to.not.include(facLine(facAt, kmAddr));
    await ceremony();
    const idAddr = await identity.getAddress();
    const r = await assertHandoverComplete(args);
    expect(r.failures).to.deep.equal([]);
    const labels = r.checks.map((c: any) => c.label);
    const facAddr = await f.c.onchainIDFactory.getAddress();
    expect(labels).to.include.members([
      kmLine(kmAddr),
      idLine(idAddr, kmAddr),
      facLine(facAddr, kmAddr),
    ]);

    // Each line catches its break: the identity withdraws the opt-in ...
    await identity.connect(f.proposer).deauthorizeManager(kmAddr);
    let after = await assertHandoverComplete(args);
    expect(after.failures).to.deep.equal([idLine(idAddr, kmAddr)]);
    // ... or makes the deployer one of its managers.
    await identity.connect(f.proposer).authorizeManager(kmAddr);
    await identity.connect(f.proposer).authorizeManager(f.deployer.address);
    after = await assertHandoverComplete(args);
    expect(after.failures).to.deep.equal([idLine(idAddr, kmAddr)]);
    // ... or gives the deployer a MANAGEMENT key (review L1) ...
    await identity.connect(f.proposer).deauthorizeManager(f.deployer.address);
    await identity.connect(f.proposer).addKey(dKey(), 1, 1);
    after = await assertHandoverComplete(args);
    expect(after.failures).to.deep.equal([idLine(idAddr, kmAddr)]);
    await identity.connect(f.proposer).removeKey(dKey(), 1);
    expect((await assertHandoverComplete(args)).failures).to.deep.equal([]);
    // ... or seats the deployer as a recovery agent (Task 4.11) ...
    await km
      .connect(f.proposer)
      .setupKeyRecovery(idAddr, [f.deployer.address], 1);
    after = await assertHandoverComplete(args);
    expect(after.failures).to.deep.equal([idLine(idAddr, kmAddr)]);
    // The re-seat waits 48h (R-411-16), then applies.
    await km
      .connect(f.proposer)
      .setupKeyRecovery(idAddr, [f.stranger.address], 1);
    await time.increase(48 * 3600 + 1);
    await km.applyKeyRecoverySetup(idAddr);
    expect((await assertHandoverComplete(args)).failures).to.deep.equal([]);
    // ... or authorizes another manager besides KeyManager ...
    await identity.connect(f.proposer).authorizeManager(f.stranger.address);
    after = await assertHandoverComplete(args);
    expect(after.failures).to.deep.equal([idLine(idAddr, kmAddr)]);
    await identity.connect(f.proposer).deauthorizeManager(f.stranger.address);
    expect((await assertHandoverComplete(args)).failures).to.deep.equal([]);
    // ... or makes the deployer its owner.
    await identity.connect(f.proposer).transferOwnership(f.deployer.address);
    await identity.connect(f.deployer).acceptOwnership();
    after = await assertHandoverComplete(args);
    expect(after.failures).to.deep.equal([idLine(idAddr, kmAddr)]);
    // A look-alike named by the config fails the derivation line (4.13):
    // the factory and the identity both pin the real KeyManager.
    const other = await f.c.token.getAddress();
    after = await assertHandoverComplete({ ...args, keyManager: other });
    expect(after.failures.join("\n")).to.include(
      `config "keyManager" names ${other}, but OnchainIDFactory ${facAddr} recoveryManager() is ${kmAddr}`,
    );
  });

  it("without a keyManager key the ceremony adds no KeyManager line", async function () {
    await f.c.onchainIDFactory.setRecoveryManager(ethers.ZeroAddress);
    const r = await assertHandoverComplete(f.args);
    expect(
      r.checks.some((c: any) => c.label.startsWith("KeyManager ")),
    ).to.equal(false);
    // L-1: the factory still gets its line; unpinned, KeyManager hash: ok.
    const fac = r.checks.find((c: any) => /pins no recovery/.test(c.label));
    expect(fac.ok).to.equal(true);
  });

  it("L-1: an unpinned factory with keyManager omitted passes", async function () {
    await f.c.onchainIDFactory.setRecoveryManager(ethers.ZeroAddress);
    await handoverDeployerPowers(f.args);
    expect(await f.c.token.isAgent(f.ops.address)).to.equal(true);
  });

  // Task 4.13: with nothing pinning a KeyManager the config may still name
  // one; what it names is then checked as before.
  async function nothingPins() {
    await f.c.onchainIDFactory.setRecoveryManager(ethers.ZeroAddress);
    const o = { ...f.args };
    delete o.keyManagerIdentity;
    return o;
  }

  it("preflight refuses a KeyManager with no code, before any transaction", async function () {
    const eoa = f.stranger.address;
    await expect(
      handoverDeployerPowers({ ...(await nothingPins()), keyManager: eoa }),
    ).to.be.rejectedWith(`Handover: keyManager ${eoa} has no code`);
    expect(await f.c.token.isAgent(f.ops.address)).to.equal(false);
  });

  it("preflight refuses code that is not the compiled KeyManager", async function () {
    const other = await f.c.oracleManager.getAddress();
    await expect(
      handoverDeployerPowers({ ...(await nothingPins()), keyManager: other }),
    ).to.be.rejectedWith(/is not the compiled KeyManager/);
  });

  it("refuses a config naming a KeyManager other than the pinned one (4.13)", async function () {
    const other = await f.c.oracleManager.getAddress();
    const err = await handoverDeployerPowers({
      ...args,
      keyManager: other,
    }).catch((e: Error) => e);
    expect((err as Error).message).to.equal(
      `Handover: config "keyManager" names ${other}, but OnchainIDFactory ${await f.c.onchainIDFactory.getAddress()} recoveryManager() is ${kmAddr}: the ceremony derives every contract from governance; drop the key or fix the chain`,
    );
  });

  it("preflight refuses a keyManagerIdentity with no code", async function () {
    const eoa = f.stranger.address;
    await expect(
      handoverDeployerPowers({ ...args, keyManagerIdentity: eoa }),
    ).to.be.rejectedWith(`keyManagerIdentity ${eoa} has no code`);
  });

  // Review L1: nothing in the ceremony changes the identity, so a failing
  // one is refused before Step 1, transaction-free.
  describe("preflight refuses the demo identity before Step 1", function () {
    const refuses = async (o: Record<string, any>, msg: RegExp) => {
      await expect(handoverDeployerPowers(o)).to.be.rejectedWith(msg);
      expect(await f.c.token.isAgent(f.ops.address)).to.equal(false);
    };

    it("one that has not authorized the named KeyManager", async function () {
      await identity.connect(f.proposer).deauthorizeManager(kmAddr);
      await refuses(args, /has not authorized KeyManager/);
    });

    it("one where the deployer is an authorized manager", async function () {
      await identity.connect(f.proposer).authorizeManager(f.deployer.address);
      await refuses(args, /the deployer is still authorized manager/);
    });

    it("one where the deployer is a recovery agent (4.11)", async function () {
      await km
        .connect(f.proposer)
        .setupKeyRecovery(await identity.getAddress(), [f.deployer.address], 1);
      await refuses(args, /the deployer is still recovery agent/);
    });

    it("one where the deployer holds a MANAGEMENT key", async function () {
      await identity.connect(f.proposer).addKey(dKey(), 1, 1);
      await refuses(args, /the deployer is still MANAGEMENT key/);
    });

    it("one the deployer owns", async function () {
      const mine = await (
        await ethers.getContractFactory("OnchainID")
      ).deploy(f.deployer.address);
      await mine.authorizeManager(kmAddr);
      await refuses(
        { ...args, keyManagerIdentity: await mine.getAddress() },
        /the deployer is still owner, MANAGEMENT key/,
      );
    });

    it("one that does not pin KeyManager as its recovery manager (4.11)", async function () {
      const theirs = await (
        await ethers.getContractFactory("OnchainID")
      ).deploy(f.stranger.address);
      await theirs.connect(f.stranger).authorizeManager(kmAddr);
      await refuses(
        { ...args, keyManagerIdentity: await theirs.getAddress() },
        /does not pin KeyManager .* as its recovery manager/,
      );
    });

    it("one that authorizes another manager besides KeyManager (4.11)", async function () {
      await identity.connect(f.proposer).authorizeManager(f.stranger.address);
      await refuses(args, /authorizes managers other than KeyManager/);
    });

    it("a factory that does not pin KeyManager (4.11 R-411-19)", async function () {
      await f.c.onchainIDFactory.setRecoveryManager(ethers.ZeroAddress);
      await refuses(
        args,
        /does not pin KeyManager .* on the identities it creates/,
      );
    });

    // Review L-1: the factory is checked even when keyManager is left out.
    it("a factory pinning its own code hash, keyManager omitted", async function () {
      const evil = await (
        await ethers.getContractFactory("EvilRecoveryManager")
      ).deploy();
      const evilA = await evil.getAddress();
      const evilHash = ethers.keccak256(await ethers.provider.getCode(evilA));
      const fac = await (
        await ethers.getContractFactory("OnchainIDFactory")
      ).deploy(f.deployer.address, evilHash);
      await fac.setRecoveryManager(evilA);
      // Task 4.13: the ceremony derives the pinned manager and refuses its
      // code before it reaches the factory's hash.
      const o = { ...f.args, onchainIDFactory: fac };
      await refuses(
        o,
        new RegExp(
          `KeyManager ${evilA} runtime code hash .* is not the compiled KeyManager`,
        ),
      );
      const r = await assertHandoverComplete(o);
      expect(r.failures).to.include.members([
        kmLine(evilA),
        facLine(await fac.getAddress(), evilA),
      ]);
    });

    // Task 4.13: what the factory pins is the ceremony's KeyManager.
    it("a factory pinning a recovery manager, keyManager omitted: derived", async function () {
      await handoverDeployerPowers(f.args);
      const r = await assertHandoverComplete(f.args);
      expect(r.checks.map((c: any) => c.label)).to.include(kmLine(kmAddr));
    });

    // Task 4.13: the KeyManager is derived from what the factory and the
    // identity pin; only an identity pinning nothing still needs the key.
    it("keyManagerIdentity named without keyManager derives it; a pinless one is refused", async function () {
      const o = { ...args };
      delete o.keyManager;
      await handoverDeployerPowers(o);
      expect(await f.c.token.isAgent(f.ops.address)).to.equal(true);
      const r = await assertHandoverComplete(o);
      expect(r.checks.map((c: any) => c.label)).to.include(kmLine(kmAddr));
      const theirs = await (
        await ethers.getContractFactory("OnchainID")
      ).deploy(f.stranger.address);
      await f.c.onchainIDFactory.setRecoveryManager(ethers.ZeroAddress);
      await expect(
        handoverDeployerPowers({
          ...o,
          keyManagerIdentity: await theirs.getAddress(),
        }),
      ).to.be.rejectedWith(/keyManagerIdentity is named without keyManager/);
    });
  });

  // 4.11 round 5: demo option 1 pins its KeyManager on the factory, so
  // option 83c's config must name it or the preflight refuses.
  it("option 83c's config names the KeyManager option 1 pinned", async function () {
    const HandoverModule = require("../../demo/modules/HandoverModule");
    const byKey: Record<string, any> = {
      ...f.c,
      digitalToken: f.c.token,
      escrowFactory: f.c.escrowWalletFactory,
      zkVerifierIntegrated: f.c.zkVerifier,
      vanguardGovernance: f.c.governance,
      keyManager: km,
      whitelistOracle: f.args.oracles[0],
      kycIssuer: f.kycIssuer,
    };
    const signers: any[] = [];
    signers[0] = f.deployer;
    signers[1] = f.feeWallet; // the escrow fee wallet slot (D54)
    signers[9] = f.issuerAdmin;
    signers[10] = f.ops;
    signers[11] = f.guardian;
    const state = {
      signers,
      deployStartBlock: f.args.fromBlock, // as option 1 records it
      getContract: (k: string) => byKey[k] ?? null,
      keyLifecycle: { identity: await identity.getAddress() },
      oracleConfig: new Map(),
      attestorKey: null,
    };
    const built = await new HandoverModule(state, null, null)._ceremonyArgs();
    expect(built.keyManager).to.equal(km);
    // Option 12's identity rides along, so the preflight checks it too.
    expect(built.keyManagerIdentity).to.equal(await identity.getAddress());
    await handoverDeployerPowers({ ...built, log: () => {} });
    expect(await f.c.token.isAgent(f.ops.address)).to.equal(true);
  });

  it("scripts/handover.ts reads keyManager from handover.json", async function () {
    const a = async (k: string) => f.c[k].getAddress();
    const cfg: Record<string, any> = {
      token: await a("token"),
      governanceToken: await a("governanceToken"),
      identityRegistry: await a("identityRegistry"),
      complianceRules: await a("complianceRules"),
      oracleManager: await a("oracleManager"),
      governance: f.govAddr,
      investorTypeRegistry: await a("investorTypeRegistry"),
      dynamicListManager: await a("dynamicListManager"),
      escrowWalletFactory: await a("escrowWalletFactory"),
      onchainIDFactory: await a("onchainIDFactory"),
      privacyManager: await a("privacyManager"),
      zkVerifier: await a("zkVerifier"),
      keyManager: f.stranger.address,
      fromBlock: f.args.fromBlock,
      logChunk: 100,
      feeWallets: [f.feeWallet.address],
      ops: 1,
      guardian: 2,
      issuerAdmin: 7,
      proposer: 4,
      voters: [5, 6],
    };
    const quiet = console.log;
    const out: string[] = [];
    console.log = (m: string) => out.push(m);
    try {
      // Task 4.13: the factory pins kmAddr, so another address is refused.
      const tmp = require("path").join(
        require("os").tmpdir(),
        `hkm-${Date.now()}.json`,
      );
      await expect(runHandover(cfg, "full", tmp)).to.be.rejectedWith(
        `config "keyManager" names ${f.stranger.address}, but OnchainIDFactory`,
      );
      cfg.keyManager = kmAddr;
      cfg.keyManagerIdentity = await identity.getAddress();
      await runHandover(cfg, "full", tmp);
      require("fs").rmSync(`${tmp}.snapshot.json`, { force: true });
    } finally {
      console.log = quiet;
    }
    expect(out.join("\n")).to.contain(`✅ ${kmLine(kmAddr)}`);
  });
});
