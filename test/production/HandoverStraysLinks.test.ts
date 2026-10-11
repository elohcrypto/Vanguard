import { expect } from "chai";
import { ethers, network } from "hardhat";
import { handoverFixture } from "../helpers/governanceFixture";

const {
  assertHandoverComplete,
  handoverDeployerPowers,
} = require("../../demo/utils/Handover");
const { checkFromBlock } = require("../../demo/utils/HandoverScans");

/**
 * Task 4.13 fix round (M-4, M-2, M-3, L-2): the link lines, the D56
 * lines, the oracle-manager link, the stranger root, the pending owner,
 * the parameter floors the chain itself cannot reach, checkFromBlock per
 * scanned contract, the snapshot's "derived changed" line, a
 * third-party-owned issuer, a deployer-owned registrar, per-filter empty
 * scans, and the null semantics (R-413-12). Each case gives the power
 * back, then both preflight and completion must fail with its line.
 */
describe("Handover strays: links and parameters (Task 4.13)", function () {
  let f: Awaited<ReturnType<typeof handoverFixture>>;
  let c: Record<string, any>;
  let args: Record<string, any>;
  let vsc: string;
  let vgt: string;

  beforeEach(async function () {
    f = await handoverFixture();
    ({ c, args } = f);
    vsc = await c.token.getAddress();
    vgt = await c.governanceToken.getAddress();
  });

  async function both(msg: RegExp, line: string | RegExp) {
    const nonce = await ethers.provider.getTransactionCount(f.deployer.address);
    await expect(handoverDeployerPowers(args)).to.be.rejectedWith(msg);
    expect(
      await ethers.provider.getTransactionCount(f.deployer.address),
    ).to.equal(nonce);
    const { failures } = await assertHandoverComplete(args);
    const hit = failures.find((l: string) =>
      typeof line === "string" ? l === line : line.test(l),
    );
    expect(
      hit,
      `completion line for ${line}; failures: ${failures.join(" | ")}`,
    ).to.not.equal(undefined);
  }

  /** The storage slot of `addr` holding `value` (for floors the setters guard). */
  async function slotOf(addr: string, value: bigint): Promise<string> {
    for (let i = 0; i < 64; i++) {
      const slot = ethers.toBeHex(i, 32);
      const v = await ethers.provider.getStorage(addr, slot);
      if (BigInt(v) === value) return slot;
    }
    throw new Error(`no slot holds ${value}`);
  }
  const otherRegistry = () =>
    (ethers.getContractFactory("IdentityRegistry") as any).then((F: any) =>
      F.deploy(),
    );

  describe("links (A1 H2, D56, M1)", function () {
    it("registry B on the Token", async function () {
      const b = await (await otherRegistry()).getAddress();
      await c.token.setIdentityRegistry(b);
      const reg = await c.identityRegistry.getAddress();
      await both(
        new RegExp(`Token identityRegistry\\(\\): ${reg}; found ${b}`),
        `Token identityRegistry(): ${reg}`,
      );
    });

    it("registry B on VGT and in ComplianceRules", async function () {
      const b = await (await otherRegistry()).getAddress();
      const reg = await c.identityRegistry.getAddress();
      await c.governanceToken.setIdentityRegistry(b);
      await both(
        /GovernanceToken identityRegistry\(\): .*setIdentityRegistry/,
        `GovernanceToken identityRegistry(): ${reg}`,
      );
      await c.governanceToken.setIdentityRegistry(reg);
      await c.complianceRules.setTokenIdentityRegistry(vsc, b);
      await both(
        /ComplianceRules tokenIdentityRegistry\(VSC\): .*setTokenIdentityRegistry\(VSC/,
        `ComplianceRules tokenIdentityRegistry(VSC): ${reg}`,
      );
    });

    it("the registry reading another ComplianceRules", async function () {
      const other = await (
        await ethers.getContractFactory("ComplianceRules")
      ).deploy(f.deployer.address, [840], []);
      await c.identityRegistry.setComplianceRules(
        await other.getAddress(),
        vsc,
      );
      const rules = await c.complianceRules.getAddress();
      await both(
        /IdentityRegistry getComplianceRules\(\): .*setComplianceRules/,
        `IdentityRegistry getComplianceRules(): ${rules}`,
      );
    });

    it("escrow factory links off the plan", async function () {
      const b = await (await otherRegistry()).getAddress();
      await c.escrowWalletFactory.setIdentityRegistry(b);
      const reg = await c.identityRegistry.getAddress();
      await both(
        /EscrowWalletFactory identityRegistry\(\): .*setIdentityRegistry/,
        `EscrowWalletFactory identityRegistry(): ${reg}`,
      );
    });

    it("a bound list oracle answering to another OracleManager (A1 M1)", async function () {
      const om2 = await (
        await ethers.getContractFactory("OracleManager")
      ).deploy();
      const wl2 = await (
        await ethers.getContractFactory("WhitelistOracle")
      ).deploy(await om2.getAddress(), "WL2", "d");
      await c.complianceRules.setWhitelistOracle(vsc, await wl2.getAddress());
      args.oracles = [...args.oracles, wl2];
      const om = await c.oracleManager.getAddress();
      await both(
        new RegExp(
          `oracle ${await wl2.getAddress()} oracleManager\\(\\): ${om}; found ${await om2.getAddress()}`,
        ),
        `oracle ${await wl2.getAddress()} oracleManager(): ${om}`,
      );
    });

    it("an investor registry on VGT (D56)", async function () {
      await c.governanceToken.setInvestorTypeRegistry(
        await c.investorTypeRegistry.getAddress(),
      );
      await both(
        /a registry on VGT .* redeploy VGT and governance/,
        "GovernanceToken has no investorTypeRegistry (D56)",
      );
    });

    it("a whitelist oracle on VGT (D56)", async function () {
      await c.complianceRules.setWhitelistOracle(
        vgt,
        await args.oracles[0].getAddress(),
      );
      await both(
        /a whitelist oracle on VGT .* setWhitelistOracle\(VGT, 0\)/,
        "no whitelist oracle bound to GovernanceToken (D56)",
      );
    });
  });

  describe("parameters", function () {
    it("a root published by a stranger", async function () {
      const s = f.stranger;
      await c.privacyManager.setListOperator(s.address);
      await c.privacyManager
        .connect(s)
        .publishWhitelistRoot(ethers.toBeHex(9n, 32));
      await both(
        new RegExp(
          `current whitelist root \\(version 1\\) was published by ${s.address}, neither the deployer, ops nor governance`,
        ),
        "the current whitelist root was published by the deployer (warned), ops or governance",
      );
    });

    it("a pending owner on the demo identity", async function () {
      const km = await (await ethers.getContractFactory("KeyManager")).deploy();
      const idAddr = await c.identityRegistry.identity(f.proposer.address);
      const id = await ethers.getContractAt("OnchainID", idAddr);
      await id.connect(f.proposer).authorizeManager(await km.getAddress());
      await id.connect(f.proposer).pinRecoveryManager(await km.getAddress());
      await c.onchainIDFactory.setRecoveryManager(await km.getAddress());
      await id.connect(f.proposer).transferOwnership(f.stranger.address);
      args.keyManagerIdentity = idAddr;
      await both(
        new RegExp(
          `demo identity ${idAddr} has pending owner ${f.stranger.address}`,
        ),
        `demo identity ${idAddr} has no pending owner`,
      );
    });

    it("maxVerdictAge and votingCost below what the setters allow (storage)", async function () {
      const [wl] = args.oracles;
      const wlAddr = await wl.getAddress();
      const slot = await slotOf(wlAddr, 86400n);
      await network.provider.send("hardhat_setStorageAt", [
        wlAddr,
        slot,
        ethers.toBeHex(60n, 32),
      ]);
      await both(
        /maxVerdictAge 60s is outside \[1 hour, 30 days\]/,
        /maxVerdictAge is between 1 hour and 30 days \(60s\)$/,
      );
      await network.provider.send("hardhat_setStorageAt", [
        wlAddr,
        slot,
        ethers.toBeHex(86400n, 32),
      ]);
      const g = await c.governance.getAddress();
      const cost = await c.governance.votingCost();
      const cslot = await slotOf(g, cost);
      await network.provider.send("hardhat_setStorageAt", [
        g,
        cslot,
        ethers.ZeroHash,
      ]);
      await both(
        /governance proposalCreationCost or votingCost is zero/,
        /^governance costs are above zero/,
      );
    });

    it("a paused OnchainIDFactory", async function () {
      await c.onchainIDFactory.setDeploymentPaused(true);
      await both(
        /OnchainIDFactory deployment is paused/,
        "OnchainIDFactory deployment is not paused",
      );
    });

    it("checkFromBlock covers the Token, the manager, the escrow factory and PrivacyManager", async function () {
      for (const [key, label] of [
        ["token", "Token"],
        ["oracleManager", "OracleManager"],
        ["escrowWalletFactory", "EscrowWalletFactory"],
        ["privacyManager", "PrivacyManager"],
      ]) {
        const block = (await c[key].deploymentTransaction().wait()).blockNumber;
        await expect(
          checkFromBlock({ fromBlock: block + 1, [key]: c[key] }),
        ).to.be.rejectedWith(
          `fromBlock ${block + 1} is after the ${label} deploy`,
        );
        await checkFromBlock({ fromBlock: block, [key]: c[key] });
      }
    });
  });

  describe("snapshot, issuers, custody, empty scans", function () {
    it("a derived contract changed between the preflight and completion", async function () {
      const report = await handoverDeployerPowers(args);
      const other = await (
        await ethers.getContractFactory("ZKVerifierIntegrated")
      ).deploy(false);
      await c.privacyManager.setZKVerifier(await other.getAddress()); // still the deployer's
      const { failures } = await assertHandoverComplete({
        ...args,
        snapshot: report.snapshot,
      });
      expect(failures.join("\n")).to.include(
        `derived contract(s) changed since the preflight: zkVerifier ${await c.zkVerifier.getAddress()} -> ${await other.getAddress()}`,
      );
    });

    it("a trusted issuer owned by a third party (R-413-7)", async function () {
      const theirs = await (
        await ethers.getContractFactory("ClaimIssuer")
      ).deploy(f.stranger.address, "Theirs", "d");
      await c.identityRegistry.addTrustedIssuer(await theirs.getAddress(), [6]);
      delete args.issuers; // derived: the config list would omit it first
      const label = `Theirs (${await theirs.getAddress()})`;
      await both(
        new RegExp(
          `Theirs .* is owned by ${f.stranger.address}, neither the deployer nor issuerAdmin`,
        ),
        `${label}: owned by issuerAdmin and every live key is issuerAdmin's`,
      );
    });

    it("a deployer-owned InvestorRequestManager is refused before step 1 (M-2)", async function () {
      const m = await (
        await ethers.getContractFactory("InvestorRequestManager")
      ).deploy(
        f.ops.address,
        vsc,
        await c.investorTypeRegistry.getAddress(),
        await c.identityRegistry.getAddress(),
      );
      const mAddr = await m.getAddress();
      await c.investorTypeRegistry.setComplianceOfficer(mAddr, true);
      await both(
        new RegExp(
          `registrar / officer contract ${mAddr} is owned by ${f.deployer.address}, neither ops nor governance`,
        ),
        `registrar / officer contract ${mAddr} is owned by ops or governance`,
      );
    });

    /** `real` with one event filter's queryFilter answering []. */
    const silenced = (real: any, event: string) =>
      new Proxy(real, {
        get: (t, p) =>
          p === "queryFilter"
            ? async (flt: any, ...rest: any[]) =>
                flt?.fragment?.name === event
                  ? []
                  : real.queryFilter(flt, ...rest)
            : Reflect.get(t, p),
      });

    it("an empty TrustedRegistrarSet scan with a live registrar is refused (M-3)", async function () {
      // A trusted escrow names its factory(), a candidate read directly.
      const e = c.escrowWalletFactory;
      const [, , , , alice, bob, carol] = await ethers.getSigners();
      await e.registerInvestor(carol.address, carol.address);
      await e
        .connect(carol)
        .createEscrowWallet(alice.address, bob.address, ethers.parseEther("1"));
      args.complianceRules = silenced(c.complianceRules, "TrustedRegistrarSet");
      const re =
        /TrustedRegistrarSet event scan found none of the holders it must see/;
      await expect(handoverDeployerPowers(args)).to.be.rejectedWith(re);
      // L-7: at completion the proof is a failing line, not a throw.
      const { failures } = await assertHandoverComplete(args);
      expect(failures.join("\n")).to.match(re);
    });

    it("an empty GovernorUpdated scan with a weight-0 governor is refused (N-2)", async function () {
      await c.investorTypeRegistry.setGovernor(f.stranger.address, true, 0);
      args.investorTypeRegistry = silenced(
        c.investorTypeRegistry,
        "GovernorUpdated",
      );
      const re =
        /GovernorUpdated event scan found 0 event\(s\) while governorEpoch is 1/;
      await expect(handoverDeployerPowers(args)).to.be.rejectedWith(re);
      const { failures } = await assertHandoverComplete(args);
      expect(failures.join("\n")).to.match(re);
    });

    it("empty OracleRegistered and InvestorLimitExemptionUpdated scans with live holders are refused (M-3)", async function () {
      await c.oracleManager.registerOracle(f.stranger.address, "n", "", 500);
      args.oracleNodes = [f.stranger.address];
      args.oracleManager = silenced(c.oracleManager, "OracleRegistered");
      await expect(handoverDeployerPowers(args)).to.be.rejectedWith(
        /OracleRegistered event scan found none of the holders it must see/,
      );
      args.oracleManager = c.oracleManager;
      await c.investorTypeRegistry.setInvestorLimitExempt(
        f.feeWallet.address,
        true,
      );
      args.feeWallets = [f.feeWallet.address];
      args.investorTypeRegistry = silenced(
        c.investorTypeRegistry,
        "InvestorLimitExemptionUpdated",
      );
      await expect(handoverDeployerPowers(args)).to.be.rejectedWith(
        /InvestorLimitExemptionUpdated event scan found none of the holders it must see/,
      );
    });
  });

  describe("null keys (R-413-12)", function () {
    it("null is refused where governance derives the contract", async function () {
      await c.complianceRules.setPrivacyManager(
        vsc,
        await c.privacyManager.getAddress(),
      );
      await c.complianceRules.setWhitelistMode(vsc, 2);
      args.zkVerifier = null;
      await expect(handoverDeployerPowers(args)).to.be.rejectedWith(
        /config "zkVerifier" is null \(asserts none\), but PrivacyManager .* zkVerifier\(\) is/,
      );
      args.zkVerifier = c.zkVerifier;
      args.privacyManager = null;
      await expect(handoverDeployerPowers(args)).to.be.rejectedWith(
        /config "privacyManager" is null \(asserts none\), but ComplianceRules.privacyManager\(VSC\) is/,
      );
      args.privacyManager = c.privacyManager;
      await c.onchainIDFactory.transferOwnership(f.govAddr);
      await c.governance.setOnchainIDFactory(
        await c.onchainIDFactory.getAddress(),
      );
      args.onchainIDFactory = null;
      await expect(handoverDeployerPowers(args)).to.be.rejectedWith(
        /config "onchainIDFactory" is null \(asserts none\), but governance.boundTarget\(10\)/,
      );
    });

    it("null where nothing derives is a residual warning, never green", async function () {
      args.privacyManager = null;
      args.zkVerifier = null;
      const { acceptAllByVote } = require("../../demo/utils/Handover");
      const report = await handoverDeployerPowers(args);
      await acceptAllByVote({
        governance: c.governance,
        contracts: { ...c, privacyManager: null, zkVerifier: null },
        proposer: f.proposer,
        voters: f.voters,
        registryProposals: report.registryProposals,
        log: () => {},
      });
      const { ok, failures, residual } = await assertHandoverComplete(args);
      expect(ok, failures.join(" | ")).to.equal(true);
      expect(residual).to.include(
        'config "privacyManager" is null and governance derives none: the deployer keeps it if it exists; name it, or state in the runbook why it does not exist',
      );
    });
  });

  // L-12: with the in-process memory bypassed, no snapshot is a failing line.
  it("completion fails without any preflight snapshot", async function () {
    const { preflightSnapshots } = require("../../demo/utils/HandoverSnapshot");
    await handoverDeployerPowers(args);
    preflightSnapshots.delete(f.govAddr.toLowerCase());
    const { failures } = await assertHandoverComplete({
      ...args,
      snapshot: undefined,
    });
    expect(failures).to.include(
      "no preflight snapshot: nothing proves the chain did not change since step 1 (run the full phase, or pass the snapshot the full phase wrote)",
    );
  });
});
