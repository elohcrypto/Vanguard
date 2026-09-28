import { expect } from "chai";
import { ethers, network } from "hardhat";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import { attest, configureKyc, deployIdentity } from "../helpers/kyc";

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
    let alice: SignerWithAddress,
      bob: SignerWithAddress,
      carol: SignerWithAddress;
    [deployer, ops, guardian, stranger, alice, bob, carol] =
      await ethers.getSigners();
    proposer = alice;
    voters = [bob, carol];
    const deploy = async (name: string, ...a: any[]) =>
      (await ethers.getContractFactory(name)).deploy(...a);

    const identityRegistry = await deploy("IdentityRegistry");
    const complianceRules = await deploy(
      "ComplianceRules",
      deployer.address,
      [840, 344],
      [],
    );
    const idRegAddr = await identityRegistry.getAddress();
    const rulesAddr = await complianceRules.getAddress();
    const token = await deploy("Token", "VSC", "VSC", idRegAddr, rulesAddr);
    const oracleManager = await deploy("OracleManager");
    const kycIssuer = await deploy(
      "ClaimIssuer",
      deployer.address,
      "KYC Issuer",
      "KYC",
    );
    await configureKyc(identityRegistry, await kycIssuer.getAddress());
    const factory = await deploy("OnchainIDFactory", deployer.address);
    const governanceToken = await deploy(
      "GovernanceToken",
      "VGT",
      "VGT",
      idRegAddr,
      rulesAddr,
    );
    const investorTypeRegistry = await deploy("InvestorTypeRegistry");
    const governance = await deploy(
      "VanguardGovernance",
      await governanceToken.getAddress(),
      idRegAddr,
      await investorTypeRegistry.getAddress(),
      rulesAddr,
      await oracleManager.getAddress(),
      await token.getAddress(),
      1440,
    );
    govAddr = await governance.getAddress();
    const dynamicListManager = await deploy(
      "DynamicListManager",
      deployer.address,
    );
    await governance.setDynamicListManager(
      await dynamicListManager.getAddress(),
    );
    const whitelistOracle = await deploy(
      "WhitelistOracle",
      await oracleManager.getAddress(),
      "Whitelist",
      "KYC whitelist",
    );
    const vgtAddr = await governanceToken.getAddress();
    await governanceToken.addAgent(deployer.address);
    await governanceToken.addAgent(govAddr);
    await complianceRules.setTokenIdentityRegistry(vgtAddr, idRegAddr);
    await complianceRules.addTrustedContract(govAddr);
    for (const w of [alice, bob, carol]) {
      const id = await deployIdentity(factory, w.address);
      await identityRegistry.registerIdentity(w.address, id, 840);
      await attest(kycIssuer, deployer, id);
      await governanceToken.mint(w.address, ethers.parseEther("1000"));
    }

    c = {
      token,
      governanceToken,
      identityRegistry,
      complianceRules,
      oracleManager,
      dynamicListManager,
      investorTypeRegistry,
      governance,
    };
    args = {
      ...c,
      deployer,
      ops,
      guardian,
      oracles: [whitelistOracle],
      issuers: [kycIssuer],
      log: quiet,
    };
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

  it("rejects an issuer where ops holds a non-management key", async function () {
    const [issuer] = args.issuers;
    const keyOf = (a: string) =>
      ethers.keccak256(ethers.solidityPacked(["address"], [a]));
    await issuer.addIssuerKey(keyOf(ops.address), 3, 1); // CLAIM_SIGNER_KEY
    await rejectsBeforeAnyTx(
      /already holds a purpose-3 key .* cannot be re-added/,
    );
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
});
