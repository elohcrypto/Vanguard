import { expect } from "chai";
import { ethers } from "hardhat";
import { ageVoters, handoverFixture } from "../helpers/governanceFixture";
import { attest, deployIdentity } from "../helpers/kyc";

const {
  acceptAllByVote,
  handoverDeployerPowers,
} = require("../../demo/utils/Handover");
const { verifiedHumans } = require("../../demo/utils/VoterPicker");
const {
  postCeremonyOf,
  guardDeployerKey,
} = require("../../demo/utils/PostCeremony");
const { bindWhitelistToToken } = require("../../demo/utils/WhitelistBindFlow");
const { runCompleteWorkflow } = require("../../demo/utils/GovernanceWorkflow");

// Task 5.6b round 3 (R-56-5): after the ceremony the deployer key (wallet
// 0) sends nothing. One check (PostCeremony.postCeremony) leaves wallet 0
// out of every demo picker, and the demo's provider guard refuses any
// transaction from it. Options 38a and 82 vote and execute after the
// ceremony with no transaction from wallet 0 (every block's senders).
describe("No transaction from wallet 0 after the ceremony (Task 5.6b)", function () {
  let f: Awaited<ReturnType<typeof handoverFixture>>;
  let state: any;
  const quiet = console.log;

  beforeEach(async function () {
    f = await handoverFixture();
    // Wallet 0 and the stranger (3) are verified, funded, aged voters, so a
    // picker that kept wallet 0 would choose it.
    for (const w of [f.deployer, f.stranger]) {
      const id = await deployIdentity(f.factory, w.address);
      await f.c.identityRegistry.registerIdentity(w.address, id, 840);
      await attest(f.kycIssuer, f.deployer, id);
      await f.c.governanceToken.mint(w.address, ethers.parseEther("1000"));
    }
    await ageVoters(f.c.governance);
    const byName: Record<string, any> = {
      vanguardGovernance: f.c.governance,
      governanceToken: f.c.governanceToken,
      identityRegistry: f.c.identityRegistry,
      complianceRules: f.c.complianceRules,
      digitalToken: f.c.token,
      whitelistOracle: f.args.oracles[0],
    };
    state = {
      signers: await ethers.getSigners(),
      getContract: (n: string) => byName[n],
      deployStartBlock: f.args.fromBlock,
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

  /** The sender of every transaction mined after block `from`. */
  async function sendersSince(from: number) {
    const out = new Set<string>();
    const to = await ethers.provider.getBlockNumber();
    for (let b = from + 1; b <= to; b++) {
      const block = await ethers.provider.getBlock(b);
      for (const h of block!.transactions) {
        const rc = await ethers.provider.getTransactionReceipt(h);
        out.add(rc!.from);
      }
    }
    return out;
  }

  it("the pickers keep wallet 0 before the ceremony and leave it out after", async function () {
    const has0 = async () =>
      (await verifiedHumans(state)).some(
        (s: any) => s.address === f.deployer.address,
      );
    expect(await postCeremonyOf(state)).to.equal(false);
    expect(await has0()).to.equal(true);
    await ceremony();
    expect(await postCeremonyOf(state)).to.equal(true);
    expect(await has0()).to.equal(false);
  });

  it("38a binds the whitelist oracle by vote with no transaction from wallet 0", async function () {
    await ceremony();
    const from = await ethers.provider.getBlockNumber();
    await bindWhitelistToToken({ state, promptUser: async () => "y" });
    const vsc = await f.c.token.getAddress();
    expect(await f.c.complianceRules.whitelistOracle(vsc)).to.equal(
      await f.args.oracles[0].getAddress(),
    );
    const senders = await sendersSince(from);
    expect(senders.size).to.be.greaterThan(0);
    expect([...senders]).to.not.include(f.deployer.address);
  });

  it("82 runs a vote to execution with no transaction from wallet 0", async function () {
    await ceremony();
    const from = await ethers.provider.getBlockNumber();
    const res = await runCompleteWorkflow({
      state,
      promptUser: async () => "yes",
      log: () => {},
    });
    expect(res.status).to.equal("Executed");
    const senders = await sendersSince(from);
    expect(senders.size).to.be.greaterThan(0);
    expect([...senders]).to.not.include(f.deployer.address);
  });

  it("the provider guard refuses wallet 0's transactions only after the ceremony", async function () {
    const seen: string[] = [];
    const fake: any = {
      request: async (a: any) => (seen.push(a.method), "ok"),
      send: async (m: string) => (seen.push(m), "ok"),
    };
    guardDeployerKey(state, fake);
    const tx = (a: string) => [{ from: a, to: f.ops.address }];
    const d = f.deployer.address;
    await fake.request({ method: "eth_sendTransaction", params: tx(d) });
    await ceremony();
    for (const call of [
      () => fake.request({ method: "eth_sendTransaction", params: tx(d) }),
      () => fake.send("eth_sendTransaction", tx(d.toLowerCase())),
    ]) {
      const err = (await call().catch((e: Error) => e)) as Error;
      expect(err.name).to.equal("DeployerKeyAfterCeremony");
      expect(err.message).to.equal(
        "R-56-5: wallet 0 (the deployer) sends nothing after the ceremony (eth_sendTransaction refused); use another wallet",
      );
    }
    await fake.request({ method: "eth_call", params: tx(d) });
    await fake.send("eth_sendTransaction", tx(f.ops.address));
    expect(seen).to.deep.equal([
      "eth_sendTransaction",
      "eth_call",
      "eth_sendTransaction",
    ]);
  });
});
