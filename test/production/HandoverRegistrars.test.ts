import { expect } from "chai";
import { ethers, network } from "hardhat";
import { handoverFixture } from "../helpers/governanceFixture";
import { walletCodeHash } from "../helpers/registrars";

const {
  acceptAllByVote,
  assertHandoverComplete,
  handoverDeployerPowers,
} = require("../../demo/utils/Handover");
const { liveRegistrars } = require("../../demo/utils/HandoverRegistrars");

/**
 * Plan v2 Task 4.3 (lead ruling 1): the ceremony lists every live
 * ComplianceRules trusted-contract registrar with its code hash, and the
 * preflight refuses, before any transaction, a registrar without code or
 * one whose hash is not the compiled MultiSigWallet / MultiSigEscrowWallet.
 */
describe("Handover: trusted-contract registrars (Task 4.3)", function () {
  let f: Awaited<ReturnType<typeof handoverFixture>>;
  let vsc: string;
  const quiet = () => {};

  beforeEach(async function () {
    f = await handoverFixture();
    vsc = await f.c.token.getAddress();
  });

  async function refused(re: RegExp) {
    const nonce = await ethers.provider.getTransactionCount(f.deployer.address);
    await expect(handoverDeployerPowers(f.args)).to.be.rejectedWith(re);
    expect(
      await ethers.provider.getTransactionCount(f.deployer.address),
    ).to.equal(nonce);
  }

  async function stub(): Promise<string> {
    const s = await (await ethers.getContractFactory("MockTarget")).deploy();
    return s.getAddress();
  }

  it("lists the escrow factory with the compiled MultiSigEscrowWallet hash", async function () {
    const report = await handoverDeployerPowers(f.args);
    await acceptAllByVote({
      governance: f.c.governance,
      contracts: f.c,
      proposer: f.proposer,
      voters: f.voters,
      registryProposals: report.registryProposals,
      log: quiet,
    });
    const fAddr = await f.c.escrowWalletFactory.getAddress();
    const hash = await walletCodeHash("MultiSigEscrowWallet");
    const { ok, checks } = await assertHandoverComplete(f.args);
    expect(ok).to.equal(true);
    expect(checks).to.deep.include({
      label: `ComplianceRules registrar ${fAddr} on token ${vsc} trusts only code hash ${hash} (the compiled MultiSigEscrowWallet)`,
      ok: true,
    });
  });

  it("refuses a registrar whose hash is not a compiled wallet", async function () {
    const s = await stub();
    const bad = ethers.keccak256(ethers.toUtf8Bytes("not a wallet"));
    await f.c.complianceRules.setTrustedRegistrar(vsc, s, bad);
    await refused(
      new RegExp(
        `registrar ${s} on token ${vsc} may trust code hash ${bad}, which is not the compiled MultiSigWallet or MultiSigEscrowWallet`,
      ),
    );
    // Cleared: no longer live, the ceremony proceeds past it.
    await f.c.complianceRules.setTrustedRegistrar(vsc, s, ethers.ZeroHash);
    const live = await liveRegistrars(f.args);
    expect(live.map((r: any) => r.registrar)).to.not.include(s);
  });

  it("refuses a registrar that has lost its code", async function () {
    const s = await stub();
    await f.c.complianceRules.setTrustedRegistrar(
      vsc,
      s,
      await walletCodeHash("MultiSigWallet"),
    );
    await network.provider.send("hardhat_setCode", [s, "0x"]);
    await refused(new RegExp(`registrar ${s} on token ${vsc} has no code`));
  });
});
