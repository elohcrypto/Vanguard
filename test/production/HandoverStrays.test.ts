import { expect } from "chai";
import { ethers } from "hardhat";
import { handoverFixture } from "../helpers/governanceFixture";

const {
  assertHandoverComplete,
  handoverDeployerPowers,
} = require("../../demo/utils/Handover");

/**
 * Plan v2 Task 4.13 (A1 H1, B G-1/G-5): every power a deployer could keep
 * by preparing the chain before the ceremony is refused by the preflight
 * (before any transaction) AND fails the completion check with the same
 * line, from the event scans. Each case gives the power back on the
 * fixture, then runs both checks (R-413-4: refused, never removed
 * silently).
 */
describe("Handover strays: roles (Task 4.13)", function () {
  let f: Awaited<ReturnType<typeof handoverFixture>>;
  let c: Record<string, any>;
  let args: Record<string, any>;
  const keyOf = (a: string) =>
    ethers.keccak256(ethers.solidityPacked(["address"], [a]));

  beforeEach(async function () {
    f = await handoverFixture();
    ({ c, args } = f);
  });

  /** Preflight refuses with `msg` and sends nothing; completion fails `line`. */
  async function both(msg: RegExp, line: string | RegExp) {
    const nonce = await ethers.provider.getTransactionCount(f.deployer.address);
    await expect(handoverDeployerPowers(args)).to.be.rejectedWith(msg);
    expect(
      await ethers.provider.getTransactionCount(f.deployer.address),
    ).to.equal(nonce);
    expect(await c.token.isAgent(f.ops.address)).to.equal(false);
    const { failures } = await assertHandoverComplete(args);
    const hit = failures.find((l: string) =>
      typeof line === "string" ? l === line : line.test(l),
    );
    expect(
      hit,
      `completion line for ${line}; failures: ${failures.join(" | ")}`,
    ).to.not.equal(undefined);
  }

  it("a stray Token agent", async function () {
    const s = f.stranger.address;
    await c.token.addAgent(s);
    await both(
      new RegExp(
        `Token agent\\(s\\) ${s} besides the deployer and ops: .*removeAgent`,
      ),
      `Token agents are exactly {${f.ops.address}} (AgentAdded scan)`,
    );
  });

  it("a stray GovernanceToken agent", async function () {
    const s = f.stranger.address;
    await c.governanceToken.addAgent(s);
    await both(
      new RegExp(
        `GovernanceToken agent\\(s\\) ${s} besides the deployer, ops and governance`,
      ),
      `GovernanceToken agents are exactly {${f.ops.address}, ${f.govAddr}} (AgentAdded scan)`,
    );
  });

  it("a stray IdentityRegistry agent", async function () {
    const s = f.stranger.address;
    await c.identityRegistry.addAgent(s);
    await both(
      new RegExp(
        `IdentityRegistry agent\\(s\\) ${s} besides the deployer, ops, VSC and VGT`,
      ),
      new RegExp(`^IdentityRegistry agents are exactly \\{${f.ops.address}, `),
    );
  });

  it("governance missing as a VGT agent, VGT missing as a registry agent", async function () {
    await c.governanceToken.removeAgent(f.govAddr);
    await both(
      new RegExp(
        `GovernanceToken is missing agent\\(s\\) ${f.govAddr}: .*addAgent`,
      ),
      `GovernanceToken agents are exactly {${f.ops.address}, ${f.govAddr}} (AgentAdded scan)`,
    );
    await c.governanceToken.addAgent(f.govAddr);
    const vgt = await c.governanceToken.getAddress();
    await c.identityRegistry.removeAgent(vgt);
    await both(
      new RegExp(`IdentityRegistry is missing agent\\(s\\) ${vgt}`),
      new RegExp(`^IdentityRegistry agents are exactly `),
    );
  });

  it("a stray InvestorTypeRegistry officer wallet (demo option 51)", async function () {
    const s = f.stranger.address;
    await c.investorTypeRegistry.setComplianceOfficer(s, true);
    await both(
      new RegExp(
        `compliance officer wallet\\(s\\) ${s} besides the deployer and ops: .*setComplianceOfficer\\(<wallet>, false\\)`,
      ),
      "InvestorTypeRegistry compliance officers are ops and officer contracts only (ComplianceOfficerUpdated scan)",
    );
  });

  it("a token other than VSC authorized on the registry", async function () {
    const probe = await (
      await ethers.getContractFactory("MockTarget")
    ).deploy();
    const p = await probe.getAddress();
    await c.investorTypeRegistry.authorizeToken(p, true);
    await both(
      new RegExp(`InvestorTypeRegistry authorizes ${p} besides VSC`),
      "InvestorTypeRegistry authorizes no token but VSC (TokenAuthorized scan)",
    );
  });

  it("a stray CLAIM_SIGNER key on an issuer the deployer hands over", async function () {
    const planted = keyOf(ethers.Wallet.createRandom().address);
    await f.kycIssuer.addIssuerKey(planted, 3, 1);
    const label = `KYC Issuer (${await f.kycIssuer.getAddress()})`;
    await both(
      new RegExp(
        `${label.replace(/[()]/g, "\\$&")} carries live CLAIM_SIGNER key ${planted} that is neither the deployer's nor issuerAdmin's`,
      ),
      `${label}: owned by issuerAdmin and every live key is issuerAdmin's`,
    );
  });

  it("an oracle node holding an issuer key (D25 b extended)", async function () {
    const node = f.stranger.address;
    await c.oracleManager.registerOracle(node, "node", "", 500);
    await f.kycIssuer.addIssuerKey(keyOf(node), 3, 1);
    const label = `KYC Issuer (${await f.kycIssuer.getAddress()})`;
    // The node itself is refused first unless acknowledged (HandoverNodes).
    args.oracleNodes = [node];
    await both(
      new RegExp(
        `carries a live key of oracle node ${node} \\(CLAIM_SIGNER\\)`,
      ),
      `${label}: no key of the deployer, ops, the guardian, governance, a registry agent or an oracle node (D25 b)`,
    );
  });

  it("the deployer's own issuer key fails completion once handed over", async function () {
    // Nothing planted: the ceremony's own lines pass before and after.
    const before = await handoverDeployerPowers(args);
    expect(before.steps.length).to.be.greaterThan(0);
    const label = `KYC Issuer (${await f.kycIssuer.getAddress()})`;
    const { checks } = await assertHandoverComplete(args);
    expect(checks).to.deep.include({
      label: `${label}: owned by issuerAdmin and every live key is issuerAdmin's`,
      ok: true,
    });
    // issuerAdmin re-adds the deployer: the line fails again.
    await f.kycIssuer
      .connect(f.issuerAdmin)
      .addIssuerKey(keyOf(f.stranger.address), 3, 1);
    const after = await assertHandoverComplete(args);
    expect(after.failures).to.include(
      `${label}: owned by issuerAdmin and every live key is issuerAdmin's`,
    );
  });

  // B G-4 / G-10, A1 M2: trust and custody.
  describe("trust", function () {
    it("a deployer-trusted contract, unless acknowledged in extraTrusted", async function () {
      const stub = await (
        await ethers.getContractFactory("MockTarget")
      ).deploy();
      const a = await stub.getAddress();
      const vsc = await c.token.getAddress();
      await c.complianceRules.addTrustedContract(vsc, a);
      await both(
        new RegExp(
          `trusted contract\\(s\\) ${a} on VSC were not created by a live registrar and are not acknowledged in extraTrusted: .*removeTrustedContract`,
        ),
        /^every trusted contract is governance on VGT, a wallet a live registrar created, or acknowledged/,
      );
      args.extraTrusted = [a];
      await handoverDeployerPowers(args);
      const { checks } = await assertHandoverComplete(args);
      expect(checks).to.deep.include({
        label:
          "every trusted contract is governance on VGT, a wallet a live registrar created, or acknowledged (2 live, 1 acknowledged)",
        ok: true,
      });
    });

    it("an InvestorRequestManager whose immutable bank is the deployer (A1 M2)", async function () {
      const m = await (
        await ethers.getContractFactory("InvestorRequestManager")
      ).deploy(
        f.deployer.address,
        await c.token.getAddress(),
        await c.investorTypeRegistry.getAddress(),
        await c.identityRegistry.getAddress(),
      );
      await m.transferOwnership(f.ops.address);
      const mAddr = await m.getAddress();
      await c.investorTypeRegistry.setComplianceOfficer(mAddr, true);
      await both(
        new RegExp(
          `InvestorRequestManager ${mAddr} bank\\(\\) is ${f.deployer.address}, not ops`,
        ),
        `InvestorRequestManager ${mAddr} bank() is ops (A1 M2: the bank co-signs every custody wallet and approves investor types): ${f.ops.address}`,
      );
    });

    it("a registrar whose code is neither manager nor factory", async function () {
      const stub = await (
        await ethers.getContractFactory("MockTarget")
      ).deploy();
      const a = await stub.getAddress();
      const { walletCodeHash } = require("../helpers/registrars");
      await c.complianceRules.setTrustedRegistrar(
        await c.token.getAddress(),
        a,
        await walletCodeHash("MultiSigWallet"),
      );
      // M-2's owner line (unreadable owner) fires before the code line.
      await both(
        new RegExp(
          `registrar / officer contract ${a} is owned by nobody readable|${a} is a ComplianceRules registrar or InvestorTypeRegistry officer whose runtime code is neither`,
        ),
        `registrar / officer contract ${a} code matches the compiled InvestorRequestManager or EscrowWalletFactory`,
      );
    });
  });

  // R-413-6: a scan that returns nothing fails, never passes as clean.
  describe("empty scans", function () {
    const silenced = (real: any) =>
      new Proxy(real, {
        get: (t, p) =>
          p === "queryFilter" ? async () => [] : Reflect.get(t, p),
      });

    it("an empty AgentAdded scan on VGT fails preflight and completion", async function () {
      args.governanceToken = silenced(c.governanceToken);
      await both(
        new RegExp(
          `GovernanceToken AgentAdded event scan found none of the holders it must see \\(${f.govAddr};`,
        ),
        // L-7: the whole roles section is one failing line at completion.
        /^roles: GovernanceToken AgentAdded event scan found none of the holders it must see/,
      );
    });

    it("an empty TrustedContractAdded scan on ComplianceRules is refused in both phases", async function () {
      args.complianceRules = silenced(c.complianceRules);
      const re =
        /TrustedContractAdded event scan found none of the holders it must see/;
      await expect(handoverDeployerPowers(args)).to.be.rejectedWith(re);
      await expect(assertHandoverComplete(args)).to.be.rejectedWith(re);
    });
  });

  // A1 M3, B G-6/G-7/G-8/G-9, A2 M-B: nodes, floors, fee sink, re-seat.
  describe("nodes and parameters", function () {
    it("an unacknowledged node; acknowledged, it warns about its provenance", async function () {
      const node = f.stranger.address;
      await c.oracleManager.registerOracle(node, "RISK", "", 500);
      await both(
        new RegExp(
          `OracleManager node\\(s\\) ${node} are registered but not acknowledged`,
        ),
        /^every registered OracleManager node is acknowledged in oracleNodes/,
      );
      args.oracleNodes = [node];
      await handoverDeployerPowers(args);
      const { warnings, residual } = await assertHandoverComplete(args);
      const w = `OracleManager node ${node} (RISK) was registered by the deployer at block`;
      expect(warnings.find((x: string) => x.startsWith(w))).to.not.equal(
        undefined,
      );
      expect(residual.find((x: string) => x.startsWith(w))).to.not.equal(
        undefined,
      );
      expect(warnings.join("\n")).to.include(
        "below ConsensusOracle.MIN_NODES (2)",
      );
    });

    it("the deployer as a node", async function () {
      await c.oracleManager.registerOracle(f.deployer.address, "D", "", 500);
      args.oracleNodes = [f.deployer.address];
      // The issuer-key line (D25 b: an oracle node holds a key) fires first.
      await both(
        /carries a live key of oracle node .* \(MANAGEMENT\)|is a registered OracleManager node/,
        new RegExp(
          `^the deployer ${f.deployer.address} is not an OracleManager node`,
        ),
      );
    });

    it("an emergency designation on an unacknowledged node; an acknowledged one is cleared at step 5", async function () {
      const node = f.stranger.address;
      await c.oracleManager.registerOracle(node, "AML", "", 500);
      await c.oracleManager.setEmergencyOracle(node, true);
      // The node line is first; the designation line is its own.
      const { failures } = await assertHandoverComplete(args);
      expect(failures).to.include(
        "every emergency designation sits on an acknowledged node (1 designated)",
      );
      await expect(handoverDeployerPowers(args)).to.be.rejectedWith(
        /registered but not acknowledged/,
      );
      args.oracleNodes = [node];
      const report = await handoverDeployerPowers(args);
      expect(report.steps).to.include(
        `emergency designation of node ${node} cleared (deployer era)`,
      );
      expect(await c.oracleManager.isEmergencyOracle(node)).to.equal(false);
    });

    it("a paused list oracle, and one requiring a single consensus oracle", async function () {
      const [wl] = args.oracles;
      await wl.emergencyPause();
      await both(
        /is paused: a paused list freezes every verdict/,
        /is not paused and is active$/,
      );
      await wl.unpause();
      await wl.setMinimumConsensusOracles(1);
      await both(
        /minimumConsensusOracles is 1: below 2/,
        /minimumConsensusOracles >= 2 \(1\)$/,
      );
    });

    it("minVoterAge below 7 days (the setter's floor is 1 day)", async function () {
      const scale = await c.governance.TIME_SCALE();
      await c.governance.setMinVoterAge(86400n / scale);
      await both(
        /minVoterAge is \d+s, below 7 days \/ TIME_SCALE/,
        /^governance minVoterAge \d+s is at least 7 days/,
      );
    });

    it("an open governance proposal targeting a plan contract", async function () {
      const { proposeCall } = require("../../demo/utils/Handover");
      const data = c.token.interface.encodeFunctionData("setGuardian", [
        f.stranger.address,
      ]);
      await proposeCall(c.governance, f.proposer, 3, c.token, data, "planted");
      await both(
        /open governance proposal\(s\) #1 "planted" -> Token/,
        /^no open governance proposal targets a plan contract/,
      );
    });

    it("feeRecipient off the deployer and ops; step 5 moves it to ops (D54)", async function () {
      await c.onchainIDFactory.setFeeRecipient(f.stranger.address);
      await both(
        /OnchainIDFactory feeRecipient is 0x[0-9a-fA-F]+, not the deployer or ops/,
        /^OnchainIDFactory feeRecipient is ops/,
      );
      await c.onchainIDFactory.setFeeRecipient(f.deployer.address);
      const report = await handoverDeployerPowers(args);
      expect(report.steps).to.include(
        `OnchainIDFactory feeRecipient: ops ${f.ops.address} (D54)`,
      );
      expect(await c.onchainIDFactory.feeRecipient()).to.equal(f.ops.address);
    });

    it("a pending recovery re-seat on the demo identity (A2 M-B)", async function () {
      // The fixture's KeyManager, pinned by the factory at creation (4.16).
      const km = f.keyManager;
      const idAddr = await c.identityRegistry.identity(f.proposer.address);
      const id = await ethers.getContractAt("OnchainID", idAddr);
      await id.connect(f.proposer).authorizeManager(await km.getAddress());
      await km
        .connect(f.proposer)
        .setupKeyRecovery(idAddr, [f.stranger.address], 1);
      await km
        .connect(f.proposer)
        .setupKeyRecovery(idAddr, [f.guardian.address], 1);
      args.keyManagerIdentity = idAddr;
      await both(
        /has a pending recovery re-seat/,
        new RegExp(`^demo identity ${idAddr} has no pending recovery re-seat`),
      );
    });

    it("something appearing between the preflight and completion", async function () {
      const report = await handoverDeployerPowers(args);
      // The deployer still owns the Token until the vote: a late grant.
      await c.token.addAgent(f.stranger.address);
      const { failures } = await assertHandoverComplete({
        ...args,
        snapshot: report.snapshot,
      });
      expect(failures).to.include(
        `appeared after the preflight, not granted by the ceremony: ${f.stranger.address} in Token agents`,
      );
    });
  });

  // Moved here from HandoverCompletion/HandoverPowers (size rule): what
  // the derivation changes in the completion check and the escrow leg.
  describe("derivation", function () {
    async function ceremony(log: (m: string) => void = () => {}) {
      const { acceptAllByVote } = require("../../demo/utils/Handover");
      const report = await handoverDeployerPowers({ ...args, log });
      await acceptAllByVote({
        governance: c.governance,
        contracts: c,
        proposer: f.proposer,
        voters: f.voters,
        registryProposals: report.registryProposals,
        log: () => {},
      });
    }
    /** carol registers, creates an escrow (alice pays bob), rules trust it. */
    async function trustedEscrow() {
      const e = c.escrowWalletFactory;
      const [, , , , alice, bob, carol] = await ethers.getSigners();
      await e.registerInvestor(carol.address, carol.address);
      await e
        .connect(carol)
        .createEscrowWallet(alice.address, bob.address, ethers.parseEther("1"));
      return e.getWalletAddress(1);
    }

    // Review 3.3 MEDIUM-2 (d), Task 4.13: the verifier is derived from
    // PrivacyManager.zkVerifier() (which the contract refuses to point at a
    // testingMode wrapper, TestingModeVerifier), so a config naming one
    // fails the derivation line; the derived verifier's flag and pin pass.
    it("a config naming a testingMode wrapper fails the derivation line", async function () {
      await ceremony(); // binds the privacy pair, so the verifier derives
      const tm = await (
        await ethers.getContractFactory("ZKVerifierIntegrated")
      ).deploy(true);
      const tmAddr = await tm.getAddress();
      const { failures, checks } = await assertHandoverComplete({
        ...args,
        zkVerifier: tm,
      });
      expect(failures).to.include(
        `config "zkVerifier" names ${tmAddr}, but PrivacyManager ${await c.privacyManager.getAddress()} zkVerifier() is ${await c.zkVerifier.getAddress()}: the ceremony derives every contract from governance; drop the key or fix the chain`,
      );
      expect(checks).to.deep.include({
        label: "ZKVerifierIntegrated is not in testingMode",
        ok: true,
      });
    });

    // Task 4.13: the factory a trusted escrow names is derived (M-2), as
    // is the registrar for MultiSigEscrowWallet; a null key hides nothing.
    // R-413-12: null asserts absence; the registrar derives one, so refused.
    it("M-2: a null escrow factory key is refused while the registrar derives one", async function () {
      await trustedEscrow();
      const fAddr = await c.escrowWalletFactory.getAddress();
      args.escrowWalletFactory = null;
      await expect(handoverDeployerPowers(args)).to.be.rejectedWith(
        new RegExp(
          `config "escrowWalletFactory" is null \\(asserts none\\), but the ComplianceRules registrar for MultiSigEscrowWallet on VSC is ${fAddr}`,
        ),
      );
      delete args.escrowWalletFactory;
      await ceremony();
      expect(await c.escrowWalletFactory.owner()).to.equal(f.govAddr);
    });
  });
});
