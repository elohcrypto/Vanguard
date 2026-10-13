import { expect } from "chai";
import { ethers, network } from "hardhat";
import { handoverFixture } from "../helpers/governanceFixture";

const {
  acceptAllByVote,
  assertHandoverComplete,
  handoverDeployerPowers,
} = require("../../demo/utils/Handover");
const { privacySteps } = require("../../demo/utils/HandoverPrivacy");

// The completion table (every line fails when its power is given back) is
// HandoverCompletionTable.test.ts; here, the warnings and the deployer-era
// residue around it.
describe("Handover completion check (warnings)", function () {
  let f: Awaited<ReturnType<typeof handoverFixture>>;
  let c: Record<string, any>;
  let args: Record<string, any>;

  beforeEach(async function () {
    f = await handoverFixture();
    ({ c, args } = f);
    const report = await handoverDeployerPowers(args);
    await acceptAllByVote({
      governance: c.governance,
      contracts: c,
      proposer: f.proposer,
      voters: f.voters,
      registryProposals: report.registryProposals,
      log: () => {},
    });
  });

  /** Governance as a signer (impersonated, funded). */
  async function govSigner() {
    await network.provider.send("hardhat_impersonateAccount", [f.govAddr]);
    await network.provider.send("hardhat_setBalance", [
      f.govAddr,
      "0xDE0B6B3A7640000",
    ]);
    return ethers.getSigner(f.govAddr);
  }

  // Review 3.3 LOW-3: a deployer-published root is a warning, not a failure.
  // Task 4.17: published before the ceremony (in the voting window the
  // deployer's publication is refused, HandoverWindow.test.ts).
  it("warns while the current whitelist root was published by the deployer", async function () {
    const line =
      "was published by the deployer: republish as ops so deployer-era bindings lapse";
    expect(
      (await assertHandoverComplete(args)).warnings.join("\n"),
    ).to.not.include(line);
    const g = await handoverFixture();
    const pm = g.c.privacyManager;
    await pm.connect(g.deployer).publishWhitelistRoot(ethers.toBeHex(7n, 32));
    const report = await handoverDeployerPowers(g.args);
    await acceptAllByVote({
      governance: g.c.governance,
      contracts: g.c,
      proposer: g.proposer,
      voters: g.voters,
      registryProposals: report.registryProposals,
      log: () => {},
    });
    const before = await assertHandoverComplete(g.args);
    expect(before.ok, before.failures.join(" | ")).to.equal(true);
    expect(before.warnings).to.include(
      `PrivacyManager whitelist root ${ethers.toBeHex(7n, 32)} (version 1) ${line}`,
    );
    await pm.connect(g.ops).publishWhitelistRoot(ethers.toBeHex(8n, 32));
    const after = await assertHandoverComplete(g.args);
    expect(after.warnings.join("\n")).to.not.include(line);
  });

  // Review 3.3 LOW-4: governance owns PrivacyManager; step 5 says so.
  it("step 5 leaves a governance-owned listOperator to a vote, with a line", async function () {
    const gov = await govSigner();
    const pm = c.privacyManager;
    await pm.connect(gov).setListOperator(f.stranger.address);
    const lines: string[] = [];
    await privacySteps({
      o: args,
      d: f.deployer,
      dAddr: f.deployer.address,
      ok: (m: string) => lines.push(m),
      log: (m: string) => lines.push(m),
    });
    expect(lines).to.deep.equal([
      "   ⚠️  PrivacyManager: governance must set listOperator to ops by a PrivacyParameters vote",
    ]);
    expect(await pm.listOperator()).to.equal(f.stranger.address);
    await network.provider.send("hardhat_stopImpersonatingAccount", [
      f.govAddr,
    ]);
  });

  // Review L-5 (mutant M9): the fee-wallet warning, present and absent.
  it("warns on a non-exempt escrow fee wallet, not on an exempt one", async function () {
    const { govAddr, feeWallet } = f;
    await network.provider.send("hardhat_impersonateAccount", [govAddr]);
    await network.provider.send("hardhat_setBalance", [
      govAddr,
      "0xDE0B6B3A7640000",
    ]);
    const gov = await ethers.getSigner(govAddr);
    const reg = c.investorTypeRegistry;
    await c.token.connect(gov).setInvestorTypeRegistry(await reg.getAddress());
    await reg.connect(gov).authorizeToken(await c.token.getAddress(), true);
    const line = `escrow fee wallet ${feeWallet.address} (factory ownerWallet) is not investorLimitExempt`;
    const before = await assertHandoverComplete(args);
    expect(before.ok, before.failures.join(" | ")).to.equal(true);
    expect(before.warnings.join("\n")).to.include(line);
    await reg.connect(gov).setInvestorLimitExempt(feeWallet.address, true);
    const after = await assertHandoverComplete(args);
    expect(after.warnings.join("\n")).to.not.include(line);
    await network.provider.send("hardhat_stopImpersonatingAccount", [govAddr]);
  });
});

// Task 3.9 (review B-L2, B-L4): what the deployer did before the ceremony.
describe("Handover completion check: deployer-era residue (3.9)", function () {
  let f: Awaited<ReturnType<typeof handoverFixture>>;
  let c: Record<string, any>;
  let args: Record<string, any>;

  beforeEach(async function () {
    f = await handoverFixture();
    ({ c, args } = f);
  });

  async function ceremony() {
    const report = await handoverDeployerPowers(args);
    await acceptAllByVote({
      governance: c.governance,
      contracts: c,
      proposer: f.proposer,
      voters: f.voters,
      registryProposals: report.registryProposals,
      log: () => {},
    });
  }

  // Review 3.9 L3: refused before Step 1, while the deployer can still
  // revoke it in one transaction; the completion line is in the table.
  it("refuses a rule administrator the deployer authorized before Step 1", async function () {
    const s = f.stranger.address;
    const vsc = await c.token.getAddress();
    await c.complianceRules.setRuleAdministrator(vsc, s, true);
    const nonce = await ethers.provider.getTransactionCount(f.deployer.address);
    await expect(handoverDeployerPowers(args)).to.be.rejectedWith(
      new RegExp(
        `ComplianceRules rule administrator\\(s\\) ${s} on ${vsc} besides the deployer, ops and governance: .*setRuleAdministrator\\(<token>, <address>, false\\) first`,
      ),
    );
    expect(
      await ethers.provider.getTransactionCount(f.deployer.address),
    ).to.equal(nonce);
    expect(await c.token.isAgent(f.deployer.address)).to.equal(true);
    // Revoked, the same ceremony completes.
    await c.complianceRules.setRuleAdministrator(vsc, s, false);
    await ceremony();
    expect((await assertHandoverComplete(args)).failures).to.deep.equal([]);
  });

  // Review B-L4: the two deployer-era privacy warnings, as warnings.
  it("warns, without failing, on an issuer key the deployer trusted", async function () {
    const {
      attestorPublicKey,
      newAttestorKey,
    } = require("../../scripts/zk/attest");
    const { Ax, Ay } = await attestorPublicKey(newAttestorKey());
    const JUR = ethers.id("JURISDICTION_PROOF");
    await c.privacyManager.setTrustedAttestor(JUR, Ax, Ay, true);
    // Task 4.13: unacknowledged, the key is refused; acknowledged, it warns.
    await expect(handoverDeployerPowers(args)).to.be.rejectedWith(
      new RegExp(
        `trusts attestor key\\(s\\) Ax ${Ax} for jurisdiction that the config does not acknowledge`,
      ),
    );
    args.attestors = [Ax.toString()];
    await ceremony();
    const line = `PrivacyManager issuer key (Ax ${Ax}) for jurisdiction was trusted by the deployer: re-approve it by a PrivacyParameters vote or untrust it`;
    const before = await assertHandoverComplete(args);
    expect(before.ok).to.equal(true);
    expect(before.failures).to.deep.equal([]);
    expect(before.warnings).to.include(line);
    expect(before.residual).to.deep.equal([line]);
    // Untrusted by governance (as a vote would): the warning goes.
    await network.provider.send("hardhat_impersonateAccount", [f.govAddr]);
    await network.provider.send("hardhat_setBalance", [
      f.govAddr,
      "0xDE0B6B3A7640000",
    ]);
    const gov = await ethers.getSigner(f.govAddr);
    await c.privacyManager.connect(gov).setTrustedAttestor(JUR, Ax, Ay, false);
    const after = await assertHandoverComplete(args);
    expect(after.warnings).to.not.include(line);
    expect(after.residual).to.deep.equal([]);
    await network.provider.send("hardhat_stopImpersonatingAccount", [
      f.govAddr,
    ]);
  });

  it("warns, without failing, on a whitelist root the deployer published", async function () {
    const root = ethers.toBeHex(5n, 32);
    await c.privacyManager.publishWhitelistRoot(root);
    await ceremony();
    const line = `PrivacyManager whitelist root ${root} (version 1) was published by the deployer: republish as ops so deployer-era bindings lapse`;
    const r = await assertHandoverComplete(args);
    expect(r.ok).to.equal(true);
    expect(r.warnings).to.include(line);
    expect(r.residual).to.deep.equal([line]);
  });
});
