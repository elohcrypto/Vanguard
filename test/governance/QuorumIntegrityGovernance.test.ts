import { expect } from "chai";
import { ethers } from "hardhat";
import { ageVoters, NOOP } from "../helpers/governanceFixture";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import { attest, configureKyc } from "../helpers/kyc";

/**
 * List-update proposals must honour the execution delay.
 *
 * The old `createListUpdateProposal` hardcoded `executionTime: 0`, so the
 * `block.timestamp >= executionTime` guard was vacuous and blacklisting ran
 * the instant voting ended. Now createProposal(ListUpdate, ...) (plan 2D.1).
 */
describe("List-update proposals honour the execution delay", function () {
  it("sets a real execution time, not zero", async function () {
    const [owner, alice] = await ethers.getSigners();

    const idReg = await (
      await ethers.getContractFactory("IdentityRegistry")
    ).deploy();
    const rules = await (
      await ethers.getContractFactory("ComplianceRules")
    ).deploy(owner.address, [840], []);
    const vgt = await (
      await ethers.getContractFactory("GovernanceToken")
    ).deploy(
      "Vanguard Governance",
      "VGT",
      await idReg.getAddress(),
      await rules.getAddress(),
    );
    const gov = await (
      await ethers.getContractFactory("VanguardGovernance")
    ).deploy(
      await vgt.getAddress(),
      await idReg.getAddress(),
      owner.address,
      await rules.getAddress(),
      owner.address,
      await vgt.getAddress(),
      1440,
    );
    await idReg.addAgent(owner.address);
    await vgt.addAgent(owner.address);
    await rules.setTokenIdentityRegistry(
      await vgt.getAddress(),
      await idReg.getAddress(),
    );
    await rules.addTrustedContract(vgt.target, gov.target);

    const kycIssuer = await (
      await ethers.getContractFactory("ClaimIssuer")
    ).deploy(owner.address, "KYC Issuer", "Trusted KYC attestations");
    await configureKyc(idReg, await kycIssuer.getAddress());

    const OID = await ethers.getContractFactory("OnchainID");
    const aliceId = await (await OID.deploy(alice.address)).getAddress();
    await idReg.registerIdentity(alice.address, aliceId, 840);
    await attest(kycIssuer, owner, aliceId);
    await vgt.mint(alice.address, ethers.parseEther("1000"));
    await vgt.connect(alice).approve(await gov.getAddress(), ethers.MaxUint256);
    // Voters must be older than minVoterAge before they propose (D25).
    await ageVoters(gov);

    const dlm = await (
      await ethers.getContractFactory("DynamicListManager")
    ).deploy(owner.address);
    await gov.setDynamicListManager(await dlm.getAddress());
    await dlm.setGovernanceContract(await gov.getAddress());

    // ProposalType.ListUpdate (6): a plain call on the manager.
    const cd = dlm.interface.encodeFunctionData("addToBlacklist", [
      alice.address,
      0,
      2,
      ethers.MaxUint256,
      "test",
    ]);
    const dlmAddr = await dlm.getAddress();
    await gov.connect(alice).createProposal(6, "bl", "d", dlmAddr, cd);
    const [p] = await gov.getProposal(1);

    expect(p.executionTime, "executionTime must not be zero").to.be.greaterThan(
      0n,
    );
    expect(
      p.executionTime,
      "delay must sit after voting ends",
    ).to.be.greaterThan(p.votingEnds);
  });
});

/**
 * cancelProposal under self-ownership: reachable AND safe.
 *
 * Two failure modes bracket the correct design:
 *   - With nonReentrant on cancelProposal, a self-owned governance (which can
 *     only act through executeProposal, also guarded) could never cancel
 *     anything: the emergency brake was permanently unreachable.
 *   - With the guard simply removed, a proposal whose callData cancels ITSELF
 *     re-entered cancelProposal mid-execution: the inner call marked it
 *     Cancelled and zeroed the lock, then the outer call overwrote the status
 *     to Executed. Deposits were neither burned nor claimable.
 *
 * The fix: executeProposal re-reads the status after the target call and, if
 * the proposal is no longer Active, treats that settlement as final instead of
 * stamping Executed over it.
 */
describe("cancelProposal under self-ownership", function () {
  let owner: SignerWithAddress,
    alice: SignerWithAddress,
    bob: SignerWithAddress,
    carol: SignerWithAddress;
  let gov: any, vgt: any, govAddr: string;
  const E = ethers.parseEther;
  const S = [
    "Pending",
    "Active",
    "Approved",
    "Rejected",
    "Executed",
    "Cancelled",
  ];

  async function pass(id: number) {
    await gov.connect(bob).castVote(id, true, "");
    await gov.connect(carol).castVote(id, true, "");
    const [p] = await gov.getProposal(id);
    await ethers.provider.send("evm_increaseTime", [
      Number(p.executionTime - p.createdAt) + 5,
    ]);
    await ethers.provider.send("evm_mine", []);
  }

  beforeEach(async function () {
    [owner, alice, bob, carol] = await ethers.getSigners();
    const idReg = await (
      await ethers.getContractFactory("IdentityRegistry")
    ).deploy();
    const rules = await (
      await ethers.getContractFactory("ComplianceRules")
    ).deploy(owner.address, [840], []);
    vgt = await (
      await ethers.getContractFactory("GovernanceToken")
    ).deploy("VGT", "VGT", await idReg.getAddress(), await rules.getAddress());
    gov = await (
      await ethers.getContractFactory("VanguardGovernance")
    ).deploy(
      await vgt.getAddress(),
      await idReg.getAddress(),
      owner.address,
      await rules.getAddress(),
      owner.address,
      await vgt.getAddress(),
      1440,
    );
    govAddr = await gov.getAddress();
    await idReg.addAgent(owner.address);
    await vgt.addAgent(owner.address);
    await vgt.addAgent(govAddr);
    await rules.setTokenIdentityRegistry(
      await vgt.getAddress(),
      await idReg.getAddress(),
    );
    await rules.addTrustedContract(vgt.target, govAddr);

    const kycIssuer = await (
      await ethers.getContractFactory("ClaimIssuer")
    ).deploy(owner.address, "KYC Issuer", "Trusted KYC attestations");
    await configureKyc(idReg, await kycIssuer.getAddress());

    const OID = await ethers.getContractFactory("OnchainID");
    for (const w of [alice, bob, carol]) {
      const id = await (await OID.deploy(w.address)).getAddress();
      await idReg.registerIdentity(w.address, id, 840);
      await attest(kycIssuer, owner, id);
      await vgt.mint(w.address, E("1000"));
      await vgt.connect(w).approve(govAddr, ethers.MaxUint256);
    }
    // Voters must be older than minVoterAge before they propose (D25).
    await ageVoters(gov);
    // Governance takes ownership of itself by vote.
    await gov.transferOwnership(govAddr);
    await gov
      .connect(alice)
      .createProposal(
        4 /* SystemParameters: target is governance itself */,
        "self-own",
        "d",
        govAddr,
        gov.interface.encodeFunctionData("acceptOwnership"),
      );
    await pass(1);
    await gov.executeProposal(1);
    expect(await gov.owner()).to.equal(govAddr);
  });

  it("a proposal can cancel ANOTHER proposal by vote (brake reachable)", async function () {
    await gov
      .connect(alice)
      .createProposal(0, "victim", "d", owner.address, NOOP);
    await gov.connect(bob).castVote(2, true, "");
    await gov
      .connect(alice)
      .createProposal(
        4 /* SystemParameters: target is governance itself */,
        "cancel-2",
        "d",
        govAddr,
        gov.interface.encodeFunctionData("cancelProposal", [2]),
      );
    await pass(3);
    await gov.executeProposal(3);

    const [p2] = await gov.getProposal(2);
    expect(S[Number(p2.status)]).to.equal("Cancelled");
    await expect(gov.connect(bob).claimRefund(2)).to.not.be.reverted;
  });

  it("a proposal that cancels ITSELF cannot strand its deposits", async function () {
    await gov
      .connect(alice)
      .createProposal(
        4 /* SystemParameters: target is governance itself */,
        "cancel-self",
        "d",
        govAddr,
        gov.interface.encodeFunctionData("cancelProposal", [2]),
      );
    await pass(2);
    await gov.executeProposal(2);

    const [p2] = await gov.getProposal(2);
    expect(S[Number(p2.status)]).to.not.equal("Active");
    // Every deposit must end up either burned or claimed. Nothing may remain
    // sitting in the contract with no path out.
    for (const w of [alice, bob, carol]) {
      try {
        await gov.connect(w).claimRefund(2);
      } catch {
        /* burned path is also fine */
      }
    }
    expect(
      await vgt.balanceOf(govAddr),
      `stranded deposits, status=${S[Number(p2.status)]}`,
    ).to.equal(0n);
  });
});
