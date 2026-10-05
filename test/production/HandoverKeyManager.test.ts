import { expect } from "chai";
import { ethers } from "hardhat";
import { handoverFixture } from "../helpers/governanceFixture";
import { runHandover } from "../../scripts/handover";

const {
  acceptAllByVote,
  assertHandoverComplete,
  handoverDeployerPowers,
} = require("../../demo/utils/Handover");

// Plan v2 Task 4.2: KeyManager in the handover ceremony. It has no owner,
// so nothing moves; the preflight refuses a KeyManager that is not one and
// the completion check proves the deployer holds no KeyManager power and
// that the demo identity authorizes it.
describe("Handover: KeyManager (4.2)", function () {
  let f: Awaited<ReturnType<typeof handoverFixture>>;
  let km: any;
  let kmAddr: string;
  let identity: any;
  let args: Record<string, any>;

  const kmLine = (a: string) =>
    `KeyManager ${a} code matches the compiled KeyManager: no owner, no allowlist, the deployer holds no KeyManager power`;
  const idLine = (id: string, a: string) =>
    `demo identity ${id} authorizes KeyManager ${a}; the deployer is not its manager`;

  beforeEach(async function () {
    f = await handoverFixture();
    km = await (await ethers.getContractFactory("KeyManager")).deploy();
    kmAddr = await km.getAddress();
    // The proposer's identity opted in, as demo option 12 does for wallet 1.
    const idAddr = await f.c.identityRegistry.identity(f.proposer.address);
    identity = await ethers.getContractAt("OnchainID", idAddr);
    await identity.connect(f.proposer).authorizeManager(kmAddr);
    args = { ...f.args, keyManager: km, keyManagerIdentity: idAddr };
  });

  async function ceremony() {
    const report = await handoverDeployerPowers(args);
    await acceptAllByVote({
      governance: f.c.governance,
      contracts: f.c,
      proposer: f.proposer,
      voters: f.voters,
      registryProposals: report.registryProposals,
      log: () => {},
    });
  }

  it("the completion check proves no KeyManager power and the opt-in", async function () {
    await ceremony();
    const idAddr = await identity.getAddress();
    const r = await assertHandoverComplete(args);
    expect(r.failures).to.deep.equal([]);
    const labels = r.checks.map((c: any) => c.label);
    expect(labels).to.include.members([kmLine(kmAddr), idLine(idAddr, kmAddr)]);

    // Each line catches its break: the identity withdraws the opt-in ...
    await identity.connect(f.proposer).deauthorizeManager(kmAddr);
    let after = await assertHandoverComplete(args);
    expect(after.failures).to.deep.equal([idLine(idAddr, kmAddr)]);
    // ... or makes the deployer one of its managers.
    await identity.connect(f.proposer).authorizeManager(kmAddr);
    await identity.connect(f.proposer).authorizeManager(f.deployer.address);
    after = await assertHandoverComplete(args);
    expect(after.failures).to.deep.equal([idLine(idAddr, kmAddr)]);
    // A look-alike (another contract) fails the code line.
    const other = await f.c.token.getAddress();
    after = await assertHandoverComplete({ ...args, keyManager: other });
    expect(after.failures).to.include(kmLine(other));
  });

  it("without a keyManager key the ceremony adds no KeyManager line", async function () {
    const r = await assertHandoverComplete(f.args);
    expect(
      r.checks.some((c: any) => c.label.startsWith("KeyManager ")),
    ).to.equal(false);
  });

  it("preflight refuses a KeyManager with no code, before any transaction", async function () {
    const eoa = f.stranger.address;
    await expect(
      handoverDeployerPowers({ ...args, keyManager: eoa }),
    ).to.be.rejectedWith(`Handover: keyManager ${eoa} has no code`);
    expect(await f.c.token.isAgent(f.ops.address)).to.equal(false);
  });

  it("preflight refuses code that is not the compiled KeyManager", async function () {
    const other = await f.c.oracleManager.getAddress();
    await expect(
      handoverDeployerPowers({ ...args, keyManager: other }),
    ).to.be.rejectedWith(/is not the compiled KeyManager/);
  });

  it("preflight refuses a keyManagerIdentity with no code", async function () {
    const eoa = f.stranger.address;
    await expect(
      handoverDeployerPowers({ ...args, keyManagerIdentity: eoa }),
    ).to.be.rejectedWith(`keyManagerIdentity ${eoa} has no code`);
  });

  it("scripts/handover.ts reads keyManager from handover.json", async function () {
    const a = async (k: string) => f.c[k].getAddress();
    const cfg: Record<string, any> = {
      token: await a("token"),
      governanceToken: await a("governanceToken"),
      identityRegistry: await a("identityRegistry"),
      complianceRules: await a("complianceRules"),
      oracleManager: await a("oracleManager"),
      governance: f.govAddr,
      investorTypeRegistry: await a("investorTypeRegistry"),
      dynamicListManager: await a("dynamicListManager"),
      escrowWalletFactory: await a("escrowWalletFactory"),
      onchainIDFactory: await a("onchainIDFactory"),
      privacyManager: await a("privacyManager"),
      zkVerifier: await a("zkVerifier"),
      keyManager: f.stranger.address,
      logChunk: 100,
      ops: 1,
      guardian: 2,
      issuerAdmin: 7,
      proposer: 4,
      voters: [5, 6],
    };
    const quiet = console.log;
    const out: string[] = [];
    console.log = (m: string) => out.push(m);
    try {
      await expect(runHandover(cfg)).to.be.rejectedWith(
        `keyManager ${f.stranger.address} has no code`,
      );
      cfg.keyManager = kmAddr;
      cfg.keyManagerIdentity = await identity.getAddress();
      await runHandover(cfg);
    } finally {
      console.log = quiet;
    }
    expect(out.join("\n")).to.contain(`✅ ${kmLine(kmAddr)}`);
  });
});
