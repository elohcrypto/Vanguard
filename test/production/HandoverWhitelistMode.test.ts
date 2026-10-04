import { expect } from "chai";
import { ethers } from "hardhat";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import { handoverFixture } from "../helpers/governanceFixture";

const {
  acceptAllByVote,
  assertHandoverComplete,
  handoverDeployerPowers,
} = require("../../demo/utils/Handover");

// Plan v2 Task 3.4 (R-3R-15): the ceremony derives PrivacyManager from
// ComplianceRules.privacyManager(token) as well as from the type-11 bound
// target, refuses a config or a chain that disagrees, and reports what
// ComplianceRules wires per token.
describe("Handover: PrivacyManager wired in ComplianceRules (3.4)", function () {
  let f: Awaited<ReturnType<typeof handoverFixture>>;
  let c: Record<string, any>;
  let args: Record<string, any>;
  let deployer: SignerWithAddress;
  let govAddr: string;
  let vsc: string;
  let vgt: string;
  let pmAddr: string;
  const EITHER = 2;

  beforeEach(async function () {
    f = await handoverFixture();
    ({ c, args, deployer, govAddr } = f);
    vsc = await c.token.getAddress();
    vgt = await c.governanceToken.getAddress();
    pmAddr = await c.privacyManager.getAddress();
  });

  async function refused(msg: RegExp) {
    const nonce = await ethers.provider.getTransactionCount(deployer.address);
    await expect(handoverDeployerPowers(args)).to.be.rejectedWith(msg);
    expect(
      await ethers.provider.getTransactionCount(deployer.address),
    ).to.equal(nonce);
  }

  async function otherPm() {
    const pm = await (
      await ethers.getContractFactory("PrivacyManager")
    ).deploy(await c.zkVerifier.getAddress());
    return { pm, addr: await pm.getAddress() };
  }

  async function wire(token: string, pm: string, mode = EITHER) {
    await c.complianceRules.setPrivacyManager(token, pm);
    await c.complianceRules.setWhitelistMode(token, mode);
  }

  it("a wired, unbound PrivacyManager must be named; then it is bound and accepted", async function () {
    await wire(vsc, pmAddr);
    expect(await c.governance.boundTarget(11)).to.equal(ethers.ZeroAddress);
    delete args.privacyManager;
    await refused(
      new RegExp(
        `ComplianceRules wires PrivacyManager ${pmAddr} for VSC, which the config does not name: add "privacyManager"`,
      ),
    );
    args.privacyManager = c.privacyManager;
    const report = await handoverDeployerPowers(args);
    await acceptAllByVote({
      governance: c.governance,
      contracts: c,
      proposer: f.proposer,
      voters: f.voters,
      registryProposals: report.registryProposals,
      log: () => {},
    });
    expect(await c.governance.boundTarget(11)).to.equal(pmAddr);
    expect(await c.privacyManager.owner()).to.equal(govAddr);
    const { checks, failures } = await assertHandoverComplete(args);
    expect(failures).to.deep.equal([]);
    expect(checks.map((x: any) => x.label)).to.include.members([
      `ComplianceRules privacyManager for VSC: ${pmAddr} (mode Either)`,
      "ComplianceRules privacyManager for VGT: none (mode OracleOnly)",
    ]);
  });

  it("refuses a config naming a different PrivacyManager than the wired one", async function () {
    await wire(vsc, pmAddr);
    const other = await otherPm();
    args.privacyManager = other.pm;
    await refused(
      new RegExp(
        `ComplianceRules wires PrivacyManager ${pmAddr} for VSC, which the config does not name \\(it names ${other.addr}\\)`,
      ),
    );
  });

  it("refuses two different PrivacyManagers wired for VSC and VGT", async function () {
    const other = await otherPm();
    await wire(vsc, pmAddr);
    await wire(vgt, other.addr, 1);
    await refused(
      new RegExp(
        `ComplianceRules wires PrivacyManager ${pmAddr} for VSC, but ComplianceRules wires PrivacyManager ${other.addr} for VGT: one PrivacyManager per deployment`,
      ),
    );
    // The completion check reports it rather than throwing.
    const { failures } = await assertHandoverComplete(args);
    expect(failures).to.include(
      `ComplianceRules privacyManager for VGT: ${other.addr} (mode ZkOnly)`,
    );
  });

  // Review 3.4 LOW-3: a ComplianceRules from before 3.4 has every getter
  // the ceremony reads except privacyManager(token). Stand-in: the real
  // rules, with that one call sent to a contract that lacks it on chain.
  it("names a ComplianceRules that predates 3.4 instead of crashing", async function () {
    const rules = c.complianceRules;
    const rulesAddr = await rules.getAddress();
    const lacking = await ethers.getContractAt(
      "ComplianceRules",
      await c.identityRegistry.getAddress(),
    );
    args.complianceRules = new Proxy(rules, {
      get: (t, k) =>
        k === "privacyManager" ? lacking.privacyManager : Reflect.get(t, k),
    });
    await refused(
      new RegExp(
        `ComplianceRules ${rulesAddr} has no privacyManager\\(token\\) \\(predates Task 3.4\\): redeploy it before the ceremony`,
      ),
    );
  });

  // D33 (a), review B-M1 (probe /tmp/p3b/vgtzk.test.js): with VGT in a ZK
  // mode the preflight used to pass, the deployer steps ran and every
  // fee-paying vote then reverted "Compliance check failed".
  for (const [mode, name] of [
    [1, "ZkOnly"],
    [2, "Either"],
  ] as const) {
    it(`refuses VGT in whitelist mode ${name} before Step 1 (D33)`, async function () {
      await wire(vgt, pmAddr, mode);
      const lines: string[] = [];
      args.log = (m: string) => lines.push(m);
      await refused(
        new RegExp(
          `GovernanceToken ${vgt} is in whitelist mode ${name}: D33 allows only OracleOnly on VGT .*setWhitelistMode\\(VGT, 0\\) \\(OracleOnly\\) before the ceremony`,
        ),
      );
      expect(lines.join("\n")).to.not.include("Step 1");
      expect(await c.token.isAgent(deployer.address)).to.equal(true);
      expect(await c.token.isAgent(f.ops.address)).to.equal(false);
      expect(await c.complianceRules.pendingOwner()).to.equal(
        ethers.ZeroAddress,
      );
      // Back to OracleOnly, the same ceremony runs.
      await c.complianceRules.setWhitelistMode(vgt, 0);
      args.log = () => {};
      await handoverDeployerPowers(args);
    });
  }

  // Review B-M2: a token that enforces another ComplianceRules.
  for (const key of ["token", "governanceToken"]) {
    it(`refuses when ${key}.compliance() is not the config's ComplianceRules`, async function () {
      const other = await (
        await ethers.getContractFactory("ComplianceRules")
      ).deploy(deployer.address, [840], []);
      const otherAddr = await other.getAddress();
      await c[key].setCompliance(otherAddr);
      const label =
        key === "token" ? "Token \\(VSC\\)" : "GovernanceToken \\(VGT\\)";
      await refused(
        new RegExp(
          `${label} ${await c[key].getAddress()} enforces ComplianceRules ${otherAddr} \\(compliance\\(\\)\\), but the config names ComplianceRules ${await c.complianceRules.getAddress()}`,
        ),
      );
      const { failures } = await assertHandoverComplete(args);
      expect(failures).to.include(
        `VSC and VGT enforce ComplianceRules ${await c.complianceRules.getAddress()}`,
      );
    });
  }

  it("refuses a wired PrivacyManager that is not the bound one", async function () {
    await c.privacyManager.transferOwnership(govAddr);
    await c.governance.setPrivacyManager(pmAddr);
    const other = await otherPm();
    await wire(vsc, other.addr);
    await refused(
      new RegExp(
        `governance is bound to PrivacyManager ${pmAddr}, but ComplianceRules wires PrivacyManager ${other.addr} for VSC`,
      ),
    );
  });
});
