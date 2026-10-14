import { expect } from "chai";
import { ethers } from "hardhat";
import { ageVoters, handoverFixture } from "../helpers/governanceFixture";
import { attest, deployIdentity } from "../helpers/kyc";

const {
  acceptAllByVote,
  handoverDeployerPowers,
} = require("../../demo/utils/Handover");
const {
  pickProposer,
  barredProposer,
} = require("../../demo/utils/GovernedCalls");
const flow = require("../../demo/utils/GovernanceProposalFlow");
const { createPrivacyProposal } = require("../../demo/utils/PrivacyProposal");

// Task 5.6b round 2 (R-56-5): the deployer sends nothing after the
// ceremony. Option 76 proposed from wallet 0 (types 0 and 1 always, types
// 2, 11 and 12 whenever wallet 0 was the first eligible wallet). Before
// the ceremony wallet 0 still proposes; after it the first eligible other
// wallet does, else one asked for (0 refused).
describe("Option 76 proposes from a non-deployer wallet after the ceremony (Task 5.6b)", function () {
  let f: Awaited<ReturnType<typeof handoverFixture>>;
  let state: any;
  const quiet = console.log;

  beforeEach(async function () {
    f = await handoverFixture();
    // Wallet 0 is a verified, funded, aged voter, as in the demo drives.
    const id = await deployIdentity(f.factory, f.deployer.address);
    await f.c.identityRegistry.registerIdentity(f.deployer.address, id, 840);
    await attest(f.kycIssuer, f.deployer, id);
    await f.c.governanceToken.mint(
      f.deployer.address,
      ethers.parseEther("1000"),
    );
    await ageVoters(f.c.governance);
    const byName: Record<string, any> = {
      vanguardGovernance: f.c.governance,
      governanceToken: f.c.governanceToken,
      identityRegistry: f.c.identityRegistry,
      investorTypeRegistry: f.c.investorTypeRegistry,
      zkVerifierIntegrated: f.c.zkVerifier,
    };
    state = {
      signers: await ethers.getSigners(),
      getContract: (n: string) => byName[n],
    };
    console.log = () => {};
  });
  afterEach(() => {
    console.log = quiet;
  });

  async function ceremony() {
    const report = await handoverDeployerPowers(f.args);
    await acceptAllByVote({
      governance: f.c.governance,
      contracts: f.c,
      proposer: f.proposer,
      voters: f.voters,
      registryProposals: report.registryProposals,
      log: () => {},
    });
  }
  const last = async () => {
    const g = f.c.governance;
    return (await g.getProposal(await g.proposalCount()))[0];
  };

  it("before the ceremony wallet 0 proposes; after it the first other eligible wallet", async function () {
    expect((await pickProposer(state)).address).to.equal(f.deployer.address);
    expect(await barredProposer(state, async () => "")).to.equal(null);
    await ceremony();
    expect((await pickProposer(state)).address).to.equal(f.proposer.address);
  });

  it("type 0 after the ceremony: proposed and paid by that wallet, the deployer sends nothing", async function () {
    await ceremony();
    const answers = ["0", "1", "1", "100", "1000"];
    const mod: any = {
      state,
      promptUser: async () => answers.shift() as string,
    };
    mod._createInvestorTypeConfigProposal = () =>
      flow._createInvestorTypeConfigProposal(mod);
    const nonce = await ethers.provider.getTransactionCount(f.deployer.address);
    const before = await f.c.governance.proposalCount();
    await flow.createProposal(mod);
    expect(answers).to.deep.equal([]);
    expect(await f.c.governance.proposalCount()).to.equal(before + 1n);
    expect((await last()).proposer).to.equal(f.proposer.address);
    expect(
      await ethers.provider.getTransactionCount(f.deployer.address),
    ).to.equal(nonce);
  });

  it("type 12 after the ceremony leaves wallet 0 out of the picker", async function () {
    await ceremony();
    const answers = ["24"];
    const id = await createPrivacyProposal(
      state,
      async () => answers.shift() as string,
      12,
    );
    expect(id).to.be.a("number");
    expect((await last()).proposer).to.equal(f.proposer.address);
  });

  it("after the ceremony with no eligible other wallet it asks and refuses 0", async function () {
    await ceremony();
    state.signers = [f.deployer, f.ops, f.guardian, f.stranger];
    expect(await pickProposer(state)).to.equal(null);
    expect(await barredProposer(state, async () => "0")).to.deep.equal({
      refused: 'wallet "0" is not a wallet index 1-3',
    });
    const pick = await barredProposer(state, async () => "3");
    expect(pick.signer.address).to.equal(f.stranger.address);
  });
});
