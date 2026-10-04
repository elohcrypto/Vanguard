import { expect } from "chai";
import { ethers } from "hardhat";
import { ageVoters } from "../helpers/governanceFixture";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import { attest, configureKyc, KYC_TOPIC } from "../helpers/kyc";

// Plan 2B.2: once the deployer hands IdentityRegistry to governance, the
// registry's onlyOwner surface (claim topics, trusted issuers, agents, rule
// wiring) is only reachable through a proposal. IdentityRegistryParameters is
// the type bound to the registry for that, with the ComplianceRules thresholds.
describe("IdentityRegistry is governable by proposal", function () {
  const T = {
    ComplianceRules: 1,
    IdentityRegistryParameters: 7,
  };
  const S = [
    "Pending",
    "Active",
    "Approved",
    "Rejected",
    "Executed",
    "Cancelled",
  ];
  const E = ethers.parseEther;

  let owner: SignerWithAddress,
    alice: SignerWithAddress,
    bob: SignerWithAddress,
    carol: SignerWithAddress;
  let gov: any, idReg: any, rules: any, govAddr: string, idRegAddr: string;

  // Alice proposes, Bob and Carol vote for, time passes the execution delay,
  // anyone executes. Asserts the proposal really executed rather than settling
  // as Rejected after a reverting target call.
  async function propose(type: number, target: string, callData: string) {
    await gov.connect(alice).createProposal(type, "t", "d", target, callData);
    const id = Number(await gov.proposalCount());
    await gov.connect(bob).castVote(id, true, "");
    await gov.connect(carol).castVote(id, true, "");
    const [p] = await gov.getProposal(id);
    await ethers.provider.send("evm_increaseTime", [
      Number(p.executionTime - p.createdAt) + 5,
    ]);
    await ethers.provider.send("evm_mine", []);
    await gov.executeProposal(id);
    const [after] = await gov.getProposal(id);
    expect(S[Number(after.status)]).to.equal("Executed");
  }

  async function handover() {
    await idReg.transferOwnership(govAddr);
    await propose(
      T.IdentityRegistryParameters,
      idRegAddr,
      idReg.interface.encodeFunctionData("acceptOwnership"),
    );
  }

  beforeEach(async function () {
    [owner, alice, bob, carol] = await ethers.getSigners();
    idReg = await (
      await ethers.getContractFactory("IdentityRegistry")
    ).deploy();
    idRegAddr = await idReg.getAddress();
    rules = await (
      await ethers.getContractFactory("ComplianceRules")
    ).deploy(owner.address, [840], []);
    const vgt = await (
      await ethers.getContractFactory("GovernanceToken")
    ).deploy("VGT", "VGT", idRegAddr, await rules.getAddress());
    gov = await (
      await ethers.getContractFactory("VanguardGovernance")
    ).deploy(
      await vgt.getAddress(),
      idRegAddr,
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
    await rules.setTokenIdentityRegistry(await vgt.getAddress(), idRegAddr);
    await rules.addTrustedContract(await vgt.getAddress(), govAddr);

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
  });

  it("binds IdentityRegistryParameters to the registry", async function () {
    expect(await gov.boundTarget(T.IdentityRegistryParameters)).to.equal(
      idRegAddr,
    );
  });

  it("takes ownership of the registry by vote (acceptOwnership)", async function () {
    await idReg.transferOwnership(govAddr);
    expect(await idReg.pendingOwner()).to.equal(govAddr);
    expect(await idReg.owner()).to.equal(owner.address);

    await handover();

    expect(await idReg.owner()).to.equal(govAddr);
    expect(await idReg.pendingOwner()).to.equal(ethers.ZeroAddress);
    // The deployer no longer holds the registry's admin surface.
    await expect(idReg.addClaimTopic(99)).to.be.revertedWithCustomError(
      idReg,
      "OwnableUnauthorizedAccount",
    );
  });

  it("adds and then removes a trusted issuer by vote", async function () {
    await handover();

    const newIssuer = await (
      await ethers.getContractFactory("ClaimIssuer")
    ).deploy(owner.address, "Second KYC Issuer", "Governed trust");
    const issuerAddr = await newIssuer.getAddress();
    expect(await idReg.isTrustedIssuer(issuerAddr, KYC_TOPIC)).to.equal(false);

    await propose(
      T.IdentityRegistryParameters,
      idRegAddr,
      idReg.interface.encodeFunctionData("addTrustedIssuer", [
        issuerAddr,
        [KYC_TOPIC],
      ]),
    );
    expect(await idReg.isTrustedIssuer(issuerAddr, KYC_TOPIC)).to.equal(true);
    expect(await idReg.getTrustedIssuersForClaimTopic(KYC_TOPIC)).to.include(
      issuerAddr,
    );

    await propose(
      T.IdentityRegistryParameters,
      idRegAddr,
      idReg.interface.encodeFunctionData("removeTrustedIssuer", [issuerAddr]),
    );
    expect(await idReg.isTrustedIssuer(issuerAddr, KYC_TOPIC)).to.equal(false);
    expect(
      await idReg.getTrustedIssuersForClaimTopic(KYC_TOPIC),
    ).to.not.include(issuerAddr);
  });

  it("rejects a registry call under ComplianceRules", async function () {
    await expect(
      gov
        .connect(alice)
        .createProposal(
          T.ComplianceRules,
          "t",
          "d",
          idRegAddr,
          idReg.interface.encodeFunctionData("addClaimTopic", [99]),
        ),
    )
      .to.be.revertedWithCustomError(gov, "TargetNotBoundToType")
      .withArgs(T.ComplianceRules, idRegAddr);
  });

  it("rejects a compliance call under IdentityRegistryParameters", async function () {
    const rulesAddr = await rules.getAddress();
    await expect(
      gov
        .connect(alice)
        .createProposal(
          T.IdentityRegistryParameters,
          "t",
          "d",
          rulesAddr,
          "0x",
        ),
    )
      .to.be.revertedWithCustomError(gov, "TargetNotBoundToType")
      .withArgs(T.IdentityRegistryParameters, rulesAddr);
  });

  it("uses the ComplianceRules thresholds", async function () {
    const a = await gov.proposalThresholds(T.IdentityRegistryParameters);
    const b = await gov.proposalThresholds(T.ComplianceRules);
    expect(a.quorumPercentage).to.equal(b.quorumPercentage);
    expect(a.approvalPercentage).to.equal(b.approvalPercentage);
    expect(a.votingPeriod).to.equal(b.votingPeriod);
    expect(a.executionDelay).to.equal(b.executionDelay);
    expect(a.quorumPercentage).to.equal(2500n);
    expect(a.approvalPercentage).to.equal(6500n);
  });
});
