import { expect } from "chai";
import { ethers } from "hardhat";
import { handoverFixture } from "../helpers/governanceFixture";

const {
  ACTIONS,
  createOracleParametersProposal,
} = require("../../demo/utils/OracleProposal");
const { nodeSigners } = require("../../demo/utils/OracleLifecycleFlow");

const ORACLE = 2n; // ProposalType.OracleParameters

// Task 5.12 (D50, R-56-2): option 76 -> type 2 registers a node by vote,
// so the deployer-era nodes can be rotated out add-before-remove, and
// every consensus round is answered by the nodes registered on chain.
describe("Option 76 registers a node by vote; rounds follow the chain (Task 5.12)", function () {
  let f: Awaited<ReturnType<typeof handoverFixture>>;
  let state: any;
  let s: any[];
  let out: string[];
  const quiet = console.log;

  beforeEach(async function () {
    f = await handoverFixture();
    s = await ethers.getSigners();
    const byName: Record<string, any> = {
      oracleManager: f.c.oracleManager,
      vanguardGovernance: f.c.governance,
      governanceToken: f.c.governanceToken,
      identityRegistry: f.c.identityRegistry,
    };
    // As DemoState: wallets 0-3 and 9-11 reserved, the next free is 12.
    state = {
      signers: s,
      getContract: (n: string) => byName[n],
      reservedSigners: new Set([0, 1, 2, 3, 9, 10, 11]),
      allocatedSigners: new Map(),
      nextAvailableSignerIndex: 12,
    };
    out = [];
    console.log = (...a: any[]) => out.push(a.join(" "));
  });
  afterEach(() => {
    console.log = quiet;
  });

  const propose = (answers: string[]) =>
    createOracleParametersProposal(state, async () => {
      expect(answers.length, "a prompt with no answer left").to.be.above(0);
      return answers.shift() as string;
    });
  const proposal = async (id: bigint) =>
    (await f.c.governance.getProposal(id))[0];

  it("action 7 proposes registerOracle(next free wallet, name, description, 500)", async function () {
    expect(ACTIONS.map((a: string[]) => a[1])).to.deep.equal([
      "pauseOracle",
      "unpauseOracle",
      "removeOracle",
      "setEmergencyOracle",
      "setConsensusThreshold",
      "setOperator",
      "registerOracle",
    ]);
    const answers = ["7", "NODE_4", "", ""];
    const id = await propose(answers);
    expect(answers).to.deep.equal([]);
    const p = await proposal(id);
    const om = f.c.oracleManager;
    expect(p.proposalType).to.equal(ORACLE);
    expect(p.target).to.equal(await om.getAddress());
    expect(p.proposer).to.equal(f.proposer.address);
    expect(p.callData).to.equal(
      om.interface.encodeFunctionData("registerOracle", [
        s[12].address,
        "NODE_4",
        "registered by an OracleParameters vote",
        500,
      ]),
    );
    // Allocated on demand, never reserved: onboarding skips it from now.
    expect(state.allocatedSigners.get(12)).to.deep.equal({
      type: "oracle node",
      name: "NODE_4",
    });
    expect(state.reservedSigners.has(12)).to.equal(false);
    expect(state.nextAvailableSignerIndex).to.equal(13);
    expect(state.proposedNodes).to.deep.equal([s[12].address]);
  });

  it("refuses an already-registered address before any VGT is spent", async function () {
    const om = f.c.oracleManager;
    await om.registerOracle(s[13].address, "KYC", "deployer era", 500);
    const before = await f.c.governance.proposalCount();
    const nonce = await ethers.provider.getTransactionCount(f.proposer.address);
    const answers = ["7", "AGAIN", s[13].address];
    expect(await propose(answers)).to.equal(null);
    expect(answers).to.deep.equal([]);
    expect(out.join("\n")).to.include(
      `${s[13].address} is already a registered node: nothing to propose`,
    );
    expect(await f.c.governance.proposalCount()).to.equal(before);
    expect(
      await ethers.provider.getTransactionCount(f.proposer.address),
    ).to.equal(nonce);
    expect(state.allocatedSigners.size).to.equal(0);
  });

  it("with no free demo wallet says so and takes a typed address", async function () {
    state.nextAvailableSignerIndex = s.length;
    const node = ethers.Wallet.createRandom().address;
    const answers = ["7", "NODE_X", "", node, "external key"];
    const id = await propose(answers);
    expect(answers).to.deep.equal([]);
    expect(out.join("\n")).to.include(
      "no free demo wallet: type the node's address",
    );
    expect((await proposal(id)).callData).to.equal(
      f.c.oracleManager.interface.encodeFunctionData("registerOracle", [
        node,
        "NODE_X",
        "external key",
        500,
      ]),
    );
  });

  it("nodeSigners reads the registered nodes from chain, also after a removal", async function () {
    const om = f.c.oracleManager;
    const keyless = ethers.Wallet.createRandom().address;
    for (const [i, a] of [s[1], s[2], s[3]].map((w, j) => [j, w.address])) {
      await om.registerOracle(a, `N${i}`, "node", 500);
    }
    await om.registerOracle(keyless, "EXT", "no demo key", 500);
    const addrs = async () =>
      (await nodeSigners(state, (m: string) => out.push(m))).map(
        (n: any) => n.address,
      );
    expect(await addrs()).to.deep.equal(
      [s[1], s[2], s[3]].map((w) => w.address),
    );
    expect(out.join("\n")).to.include(
      `node ${keyless} (registered on chain): no demo key: cannot answer`,
    );
    await om.removeOracle(s[1].address, "rotated");
    expect(await addrs()).to.have.members([s[2].address, s[3].address]);
    expect(await addrs()).to.have.length(2);
  });
});
