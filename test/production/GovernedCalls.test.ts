import { expect } from "chai";
import { ethers } from "hardhat";
import { handoverFixture } from "../helpers/governanceFixture";

const {
  acceptAllByVote,
  handoverDeployerPowers,
} = require("../../demo/utils/Handover");
const {
  registerRegistrar,
  walletCodeHash,
} = require("../../demo/utils/GovernedCalls");

// Review L-5 (mutant M10), Task 4.3: option 61's registerRegistrar after
// the handover becomes a ComplianceRules proposal and never calls as the
// deployer; with a third owner it refuses and sends nothing.
describe("GovernedCalls after the handover (2F.5 L11)", function () {
  let f: Awaited<ReturnType<typeof handoverFixture>>;
  let state: any;

  beforeEach(async function () {
    f = await handoverFixture();
    const { c } = f;
    const report = await handoverDeployerPowers(f.args);
    await acceptAllByVote({
      governance: c.governance,
      contracts: c,
      proposer: f.proposer,
      voters: f.voters,
      registryProposals: report.registryProposals,
      log: () => {},
    });
    const byName: Record<string, any> = {
      complianceRules: c.complianceRules,
      vanguardGovernance: c.governance,
      identityRegistry: c.identityRegistry,
      governanceToken: c.governanceToken,
      digitalToken: c.token,
    };
    state = {
      signers: await ethers.getSigners(),
      getContract: (n: string) => byName[n],
    };
  });

  it("creates a type-1 proposal by a verified holder, never as the deployer", async function () {
    const { c, deployer, stranger } = f;
    const nonce = await ethers.provider.getTransactionCount(deployer.address);
    const reg = await c.escrowWalletFactory.getAddress();
    // The fixture registered the factory: an unchanged registrar sends nothing.
    expect(
      (await registerRegistrar(state, reg, "MultiSigEscrowWallet", () => {}))
        .direct,
    ).to.equal(true);
    const res = await registerRegistrar(state, reg, "MultiSigWallet", () => {});
    expect(res.direct).to.equal(undefined);
    expect(res.proposalId).to.be.a("number");
    expect(
      await ethers.provider.getTransactionCount(deployer.address),
    ).to.equal(nonce);
    const [p] = await c.governance.getProposal(res.proposalId);
    expect(p.proposalType).to.equal(1n);
    expect(p.proposer).to.equal(f.proposer.address);
    expect(p.target).to.equal(await c.complianceRules.getAddress());
    // Registrars are per token (Task 4.1 G5, 4.3): the vote names it on VSC.
    const hash = await walletCodeHash("MultiSigWallet");
    expect(p.callData).to.equal(
      c.complianceRules.interface.encodeFunctionData("setTrustedRegistrar", [
        await c.token.getAddress(),
        reg,
        hash,
      ]),
    );
    expect(
      await c.complianceRules.trustedRegistrars(
        await c.token.getAddress(),
        reg,
      ),
    ).to.not.equal(hash);
    expect(stranger.address).to.not.equal(reg);
  });

  it("refuses when a third party owns ComplianceRules", async function () {
    const { deployer, stranger } = f;
    const other = await (
      await ethers.getContractFactory("ComplianceRules")
    ).deploy(stranger.address, [840], []);
    const real = state.getContract;
    state.getContract = (n: string) =>
      n === "complianceRules" ? other : real(n);
    const nonce = await ethers.provider.getTransactionCount(deployer.address);
    const res = await registerRegistrar(
      state,
      stranger.address,
      "MultiSigWallet",
      () => {},
    );
    expect(res.refused).to.match(/neither the deployer nor governance/);
    expect(
      await ethers.provider.getTransactionCount(deployer.address),
    ).to.equal(nonce);
  });
});
