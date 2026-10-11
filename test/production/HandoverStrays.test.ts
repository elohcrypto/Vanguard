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
    expect(hit, `completion line for ${line}`).to.not.equal(undefined);
  }

  it("a stray Token agent", async function () {
    const s = f.stranger.address;
    await c.token.addAgent(s);
    await both(
      new RegExp(
        `Token agent\\(s\\) ${s} besides the deployer and ops: .*removeAgent`,
      ),
      `Token agents are exactly {${f.ops.address}}`,
    );
  });

  it("a stray GovernanceToken agent", async function () {
    const s = f.stranger.address;
    await c.governanceToken.addAgent(s);
    await both(
      new RegExp(
        `GovernanceToken agent\\(s\\) ${s} besides the deployer, ops and governance`,
      ),
      `GovernanceToken agents are exactly {${f.ops.address}, ${f.govAddr}}`,
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
      `GovernanceToken agents are exactly {${f.ops.address}, ${f.govAddr}}`,
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
      "InvestorTypeRegistry compliance officers are ops and officer contracts only",
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
      "InvestorTypeRegistry authorizes no token but VSC",
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
      `${label}: every live key is issuerAdmin's`,
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
      label: `${label}: every live key is issuerAdmin's`,
      ok: true,
    });
    // issuerAdmin re-adds the deployer: the line fails again.
    await f.kycIssuer
      .connect(f.issuerAdmin)
      .addIssuerKey(keyOf(f.stranger.address), 3, 1);
    const after = await assertHandoverComplete(args);
    expect(after.failures).to.include(
      `${label}: every live key is issuerAdmin's`,
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
      await both(
        new RegExp(
          `${a} is a ComplianceRules registrar or InvestorTypeRegistry officer whose runtime code is neither the compiled InvestorRequestManager nor EscrowWalletFactory`,
        ),
        `registrar / officer contract ${a} code matches the compiled InvestorRequestManager or EscrowWalletFactory`,
      );
    });
  });
});
