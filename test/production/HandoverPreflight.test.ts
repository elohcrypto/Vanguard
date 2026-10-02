import { expect } from "chai";
import { ethers, network } from "hardhat";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import { handoverFixture } from "../helpers/governanceFixture";

const {
  acceptAllByVote,
  assertHandoverComplete,
  castAcceptanceVotes,
  handoverDeployerPowers,
  proposeAcceptOwnership,
  settleProposal,
} = require("../../demo/utils/Handover");

// Plan v2 Task 2E.2 (.omc/plans/2026-09-25-zk-kyc-ownership-cleanup-v2.md):
// the ceremony checks every precondition before its first transaction,
// tolerates a registry governance already owns, clears a VGT guardian and an
// oracle list-manager role left on the deployer, and its completion check
// catches both hazards plus trusted-contract residue. Fixture copied from
// Handover.test.ts (which runs the ceremony in its beforeEach).
describe("Handover preflight and self-healing (plan 2E.2)", function () {
  let deployer: SignerWithAddress;
  let ops: SignerWithAddress;
  let guardian: SignerWithAddress;
  let proposer: SignerWithAddress;
  let stranger: SignerWithAddress;
  let voters: SignerWithAddress[];
  let c: Record<string, any>;
  let args: Record<string, any>;
  let govAddr: string;

  const quiet = () => {};
  const keyOf = (a: string) =>
    ethers.keccak256(ethers.solidityPacked(["address"], [a]));

  /** The whole ceremony: deployer powers, acceptance votes, registry calls. */
  async function ceremony(): Promise<void> {
    const report = await handoverDeployerPowers(args);
    await acceptAllByVote({
      governance: c.governance,
      contracts: c,
      proposer,
      voters,
      registryProposals: report.registryProposals,
      log: quiet,
    });
  }

  const check = async (label: string) =>
    (await assertHandoverComplete(args)).checks.find(
      (x: any) => x.label === label,
    );

  beforeEach(async function () {
    const f = await handoverFixture();
    ({ deployer, ops, guardian, stranger, proposer, voters, c, args, govAddr } =
      f);
  });

  it("completes when governance already owns the registry (option 83b ran)", async function () {
    const reg = c.investorTypeRegistry;
    await reg.transferOwnership(govAddr);
    const id = await proposeAcceptOwnership(
      c.governance,
      proposer,
      reg,
      0,
      "InvestorTypeRegistry",
    );
    await castAcceptanceVotes(c.governance, id, voters);
    await settleProposal(c.governance, id, "InvestorTypeRegistry");
    expect(await reg.owner()).to.equal(govAddr);

    const steps: string[] = [];
    const report = await handoverDeployerPowers({
      ...args,
      log: (m: string) => steps.push(m),
    });
    expect(steps).to.include(
      "   ✅ InvestorTypeRegistry: already owned by governance",
    );
    expect(report.registryProposals.map((r: any) => r.label)).to.deep.equal([
      `InvestorTypeRegistry compliance officer ${ops.address} = true`,
      `InvestorTypeRegistry compliance officer ${deployer.address} = false`,
    ]);
    await acceptAllByVote({
      governance: c.governance,
      contracts: c,
      proposer,
      voters,
      registryProposals: report.registryProposals,
      log: quiet,
    });
    expect(await reg.isComplianceOfficer(ops.address)).to.equal(true);
    const result = await assertHandoverComplete(args);
    expect(result.failures).to.deep.equal([]);
  });

  it("a failing precondition sends no transaction", async function () {
    // The deployer keeps its MANAGEMENT_KEY but ownership moved elsewhere.
    const other = await (
      await ethers.getContractFactory("ClaimIssuer")
    ).deploy(deployer.address, "AML Issuer", "AML");
    await other.transferOwnership(stranger.address);
    await other.connect(stranger).acceptOwnership();
    const nonce = await ethers.provider.getTransactionCount(deployer.address);

    await expect(
      handoverDeployerPowers({ ...args, issuers: [...args.issuers, other] }),
    ).to.be.rejectedWith(/deployer holds a key on AML Issuer .* not its owner/);
    expect(await c.token.isAgent(ops.address)).to.equal(false);
    expect(
      await ethers.provider.getTransactionCount(deployer.address),
    ).to.equal(nonce);
  });

  it("clears a VGT guardian; the check fails while one is set", async function () {
    await c.governanceToken.setGuardian(deployer.address);
    expect((await check("GovernanceToken has no guardian")).ok).to.equal(false);
    await ceremony();
    expect(await c.governanceToken.guardian()).to.equal(ethers.ZeroAddress);
    expect((await assertHandoverComplete(args)).failures).to.deep.equal([]);
  });

  it("moves an oracle listManager off the deployer to the DynamicListManager", async function () {
    const [oracle] = args.oracles;
    const label = `oracle ${await oracle.getAddress()} listManager is not the deployer`;
    await oracle.setListManager(deployer.address);
    expect((await check(label)).ok).to.equal(false);
    await ceremony();
    expect(await oracle.listManager()).to.equal(
      await c.dynamicListManager.getAddress(),
    );
    expect(await oracle.owner()).to.equal(ops.address);
    expect((await check(label)).ok).to.equal(true);
  });

  it("flags a still-trusted address without code; the deployer is not trusted", async function () {
    const stub = await (
      await ethers.getContractFactory("MockToken")
    ).deploy("Stub", "STB", 0);
    const stubAddr = await stub.getAddress();
    await c.complianceRules.addTrustedContract(stubAddr);
    expect((await check("every trusted contract has code")).ok).to.equal(true);
    expect((await check("deployer is not a trusted contract")).ok).to.equal(
      true,
    );
    // Residue from a pre-2E.1 chain: a trusted address that has no code.
    await network.provider.send("hardhat_setCode", [stubAddr, "0x"]);
    expect(
      (
        await check(
          `trusted address ${stubAddr} is a wallet or delegated wallet`,
        )
      ).ok,
    ).to.equal(false);
    expect(await check("every trusted contract has code")).to.equal(undefined);
  });

  it("flags a trusted address that now carries an EIP-7702 delegation", async function () {
    const stub = await (
      await ethers.getContractFactory("MockToken")
    ).deploy("Stub", "STB", 0);
    const stubAddr = await stub.getAddress();
    await c.complianceRules.addTrustedContract(stubAddr);
    // Code is the 23-byte delegation indicator, not a contract.
    await network.provider.send("hardhat_setCode", [
      stubAddr,
      "0xef0100" + govAddr.slice(2),
    ]);
    const label = `trusted address ${stubAddr} is a wallet or delegated wallet`;
    const result = await assertHandoverComplete(args);
    expect(result.failures).to.include(label);
    expect(await check("every trusted contract has code")).to.equal(undefined);
  });

  it("fails completion when governance is not trusted", async function () {
    await c.complianceRules.removeTrustedContract(govAddr);
    expect((await assertHandoverComplete(args)).failures).to.include(
      "governance is a trusted contract",
    );
  });

  it("fails completion when governance still has a registry identity", async function () {
    const id = await (
      await ethers.getContractFactory("OnchainID")
    ).deploy(govAddr);
    await c.identityRegistry.registerIdentity(
      govAddr,
      await id.getAddress(),
      840,
    );
    expect((await assertHandoverComplete(args)).failures).to.include(
      "governance has no registry identity",
    );
  });

  /** Preflight rejects with `msg` and the deployer sends no transaction. */
  async function rejectsBeforeAnyTx(msg: RegExp): Promise<void> {
    const nonce = await ethers.provider.getTransactionCount(deployer.address);
    await expect(handoverDeployerPowers(args)).to.be.rejectedWith(msg);
    expect(await c.token.isAgent(ops.address)).to.equal(false);
    expect(
      await ethers.provider.getTransactionCount(deployer.address),
    ).to.equal(nonce);
  }

  it("rejects an issuer where issuerAdmin holds a non-management key", async function () {
    const [issuer] = args.issuers;
    await issuer.addIssuerKey(keyOf(args.issuerAdmin.address), 3, 1); // CLAIM_SIGNER_KEY
    await rejectsBeforeAnyTx(
      /issuerAdmin .* already holds a purpose-3 key .* cannot be re-added/,
    );
  });

  it("rejects an untrusted governance (pre-D21 or half-deployed)", async function () {
    await c.complianceRules.removeTrustedContract(govAddr);
    await rejectsBeforeAnyTx(/must addTrustedContract\(governance\) first/);
  });

  it("rejects a governance that still has a registry identity", async function () {
    const id = await (
      await ethers.getContractFactory("OnchainID")
    ).deploy(govAddr);
    await c.identityRegistry.registerIdentity(
      govAddr,
      await id.getAddress(),
      840,
    );
    await rejectsBeforeAnyTx(/must deleteIdentity\(governance\) first/);
  });

  it("rejects a registry owned by a third party", async function () {
    await c.investorTypeRegistry.transferOwnership(stranger.address);
    await c.investorTypeRegistry.connect(stranger).acceptOwnership();
    await rejectsBeforeAnyTx(/does not own InvestorTypeRegistry/);
  });

  it("rejects an ops-owned oracle whose listManager is the deployer", async function () {
    const [oracle] = args.oracles;
    await oracle.setListManager(deployer.address);
    await oracle.transferOwnership(ops.address);
    await rejectsBeforeAnyTx(
      /listManager is the deployer and only ops can clear it/,
    );
  });

  it("finds trusted residue across several log chunks", async function () {
    const stub = await (
      await ethers.getContractFactory("MockToken")
    ).deploy("Stub", "STB", 0);
    const stubAddr = await stub.getAddress();
    await c.complianceRules.addTrustedContract(stubAddr);
    await network.provider.send("hardhat_mine", ["0x10"]);
    await network.provider.send("hardhat_setCode", [stubAddr, "0x"]);
    args.logChunk = 3;
    expect(
      (
        await check(
          `trusted address ${stubAddr} is a wallet or delegated wallet`,
        )
      ).ok,
    ).to.equal(false);
    // A start block after the event finds nothing.
    args.fromBlock = await ethers.provider.getBlockNumber();
    expect((await check("every trusted contract has code")).ok).to.equal(true);
  });

  it("halves the log chunk on a range error; rethrows anything else (M4)", async function () {
    const real = c.complianceRules;
    const spans: number[] = [];
    let other = false;
    const queryFilter = async (f: any, from: number, to: number) => {
      if (other) throw new Error("connection reset");
      spans.push(to - from + 1);
      if (to - from + 1 > 150) throw new Error("block range is too large");
      return real.queryFilter(f, from, to);
    };
    args.complianceRules = new Proxy(real, {
      get: (t, p) => (p === "queryFilter" ? queryFilter : Reflect.get(t, p)),
    });
    await network.provider.send("hardhat_mine", ["0x400"]);
    args.logChunk = 1000;
    expect((await check("every trusted contract has code")).ok).to.equal(true);
    expect(spans.slice(0, 4)).to.deep.equal([1000, 500, 250, 125]);
    other = true;
    await expect(assertHandoverComplete(args)).to.be.rejectedWith(
      "connection reset",
    );
  });

  // Review M6: every preflight refusal has a failing test.
  it("rejects a governance not bound to a plan contract", async function () {
    const other = await (
      await ethers.getContractFactory("Token")
    ).deploy(
      "VSC2",
      "VSC2",
      await c.identityRegistry.getAddress(),
      await c.complianceRules.getAddress(),
    );
    args.token = other;
    await rejectsBeforeAnyTx(/governance is not bound to Token/);
  });

  it("rejects an issuerAdmin that cannot sign when the deployer owns an issuer", async function () {
    args.issuerAdmin = args.issuerAdmin.address;
    await rejectsBeforeAnyTx(
      /issuerAdmin must be a signer to accept ownership of/,
    );
  });

  it("rejects an oracle owned by a third party", async function () {
    await args.oracles[0].transferOwnership(stranger.address);
    await rejectsBeforeAnyTx(/is owned by .*, neither deployer nor ops/);
  });

  it("rejects a deployer-called contract governance already owns", async function () {
    await c.identityRegistry.transferOwnership(govAddr);
    const id = await proposeAcceptOwnership(
      c.governance,
      proposer,
      c.identityRegistry,
      7,
      "IdentityRegistry",
    );
    await castAcceptanceVotes(c.governance, id, voters);
    await settleProposal(c.governance, id, "IdentityRegistry");
    await rejectsBeforeAnyTx(/does not own IdentityRegistry/);
  });

  it("rejects an issuer where issuerAdmin holds a revoked key", async function () {
    const [issuer] = args.issuers;
    const admin = args.issuerAdmin.address;
    await issuer.addIssuerKey(keyOf(admin), 1, 1);
    await issuer.revokeIssuerKey(keyOf(admin));
    await rejectsBeforeAnyTx(
      /already holds a revoked key .* cannot be re-added/,
    );
  });

  // Review H1/H2 (R1, R2), M2 (R3), M3 (P2).
  for (const [name, role, other, msg] of [
    [
      "guardian == deployer (R2)",
      "guardian",
      "deployer",
      /guardian .* is the deployer/,
    ],
    ["ops == deployer (R1)", "ops", "deployer", /ops .* is the deployer/],
    ["ops == governance", "ops", "governance", /ops .* is the governance/],
    [
      "guardian == governance",
      "guardian",
      "governance",
      /guardian .* is the governance/,
    ],
  ] as const) {
    it(`rejects ${name}`, async function () {
      args[role] = other === "deployer" ? deployer : govAddr;
      await rejectsBeforeAnyTx(msg);
    });
  }

  it("rejects a paused VGT (R3)", async function () {
    await c.governanceToken.pause();
    await rejectsBeforeAnyTx(
      /VGT is paused: every acceptance vote would revert/,
    );
  });

  it("rejects a blacklist oracle bound to VGT (P2, D23); completion flags it", async function () {
    const bl = await (
      await ethers.getContractFactory("BlacklistOracle")
    ).deploy(await c.oracleManager.getAddress(), "BL", "d");
    const vgt = await c.governanceToken.getAddress();
    await c.complianceRules.setBlacklistOracle(vgt, await bl.getAddress());
    // Bound on chain, so the config must list it (2F.5) to reach the D23 check.
    args.oracles = [...args.oracles, bl];
    const label = "no blacklist oracle bound to GovernanceToken (D23)";
    expect((await check(label)).ok).to.equal(false);
    await rejectsBeforeAnyTx(/bound to GovernanceToken: D23 forbids it/);
  });

  const unboundRegistry = async () => {
    const reg2 = await (
      await ethers.getContractFactory("InvestorTypeRegistry")
    ).deploy();
    args.investorTypeRegistry = reg2;
    c.investorTypeRegistry = reg2;
    return reg2;
  };
  const SKIP_LINE =
    "InvestorTypeRegistry is not live on Token or is owned by governance";

  it("leaves out an unbound registry the Token does not use, with a warning", async function () {
    const reg2 = await unboundRegistry();
    expect(await c.token.investorTypeRegistry()).to.equal(ethers.ZeroAddress);
    const steps: string[] = [];
    args.log = (m: string) => steps.push(m);
    await ceremony();
    expect(steps.join("\n")).to.match(
      /not bound to InvestorTypeRegistry .* left out of this handover/,
    );
    expect(await reg2.owner()).to.equal(deployer.address);
    const result = await assertHandoverComplete(args);
    expect(result.failures).to.deep.equal([]);
    const labels = result.checks.map((x: any) => x.label);
    expect(
      labels.filter((l: string) => /InvestorTypeRegistry/.test(l)),
    ).to.deep.equal([SKIP_LINE]);
  });

  it("refuses to leave out an unbound registry the Token enforces (M-A)", async function () {
    const reg2 = await unboundRegistry();
    await c.token.setInvestorTypeRegistry(await reg2.getAddress());
    expect((await check(SKIP_LINE)).ok).to.equal(false);
    await rejectsBeforeAnyTx(
      /not bound to InvestorTypeRegistry .* which the Token enforces: redeploy governance/,
    );
  });
});
