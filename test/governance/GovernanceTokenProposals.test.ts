import { expect } from "chai";
import { ethers } from "hardhat";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import { attest, configureKyc } from "../helpers/kyc";

// Plan v2 Task 2C.2 (D19): castVote pays votingCost by VGT transferFrom, so
// whoever can pause VGT, freeze a voter or add VGT agents can stop every vote.
// After the handover governance owns the GovernanceToken, and
// GovernanceTokenParameters is the type bound to it (TokenParameters row).
describe("GovernanceToken is governable by proposal", function () {
  const T = {
    TokenParameters: 3,
    GovernanceTokenParameters: 11,
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
  let gov: any, vgt: any, vsc: any, govAddr: string, vgtAddr: string;

  // Alice proposes, Bob and Carol vote for. Returns the proposal id.
  async function proposeAndVote(
    type: number,
    target: string,
    callData: string,
  ): Promise<number> {
    await gov.connect(alice).createProposal(type, "t", "d", target, callData);
    const id = Number(await gov.proposalCount());
    await gov.connect(bob).castVote(id, true, "");
    await gov.connect(carol).castVote(id, true, "");
    return id;
  }

  async function passDelay(id: number) {
    const [p] = await gov.getProposal(id);
    const now = BigInt((await ethers.provider.getBlock("latest"))!.timestamp);
    if (p.executionTime >= now) {
      await ethers.provider.send("evm_increaseTime", [
        Number(p.executionTime - now) + 5,
      ]);
      await ethers.provider.send("evm_mine", []);
    }
  }

  // Executes and asserts the proposal really executed rather than settling as
  // Rejected after a reverting target call.
  async function execute(id: number) {
    await gov.executeProposal(id);
    const [after] = await gov.getProposal(id);
    expect(S[Number(after.status)]).to.equal("Executed");
  }

  const call = (fn: string, args: any[] = []) =>
    vgt.interface.encodeFunctionData(fn, args);

  async function handover() {
    await vgt.transferOwnership(govAddr);
    const id = await proposeAndVote(
      T.GovernanceTokenParameters,
      vgtAddr,
      call("acceptOwnership"),
    );
    await passDelay(id);
    await execute(id);
  }

  beforeEach(async function () {
    [owner, alice, bob, carol] = await ethers.getSigners();
    const idReg = await (
      await ethers.getContractFactory("IdentityRegistry")
    ).deploy();
    const idRegAddr = await idReg.getAddress();
    const rules = await (
      await ethers.getContractFactory("ComplianceRules")
    ).deploy(owner.address, [840], []);
    const rulesAddr = await rules.getAddress();
    vgt = await (
      await ethers.getContractFactory("GovernanceToken")
    ).deploy("VGT", "VGT", idRegAddr, rulesAddr);
    vgtAddr = await vgt.getAddress();
    // A distinct VSC token in the TokenParameters slot, so a wrong pairing
    // between the two token types is detectable.
    vsc = await (
      await ethers.getContractFactory("Token")
    ).deploy("Vanguard StableCoin", "VSC", idRegAddr, rulesAddr);
    gov = await (
      await ethers.getContractFactory("VanguardGovernance")
    ).deploy(
      vgtAddr,
      idRegAddr,
      owner.address,
      rulesAddr,
      owner.address,
      await vsc.getAddress(),
      1440,
    );
    govAddr = await gov.getAddress();
    await idReg.addAgent(owner.address);
    await vgt.addAgent(govAddr);
    await rules.setTokenIdentityRegistry(vgtAddr, idRegAddr);
    await rules.addTrustedContract(govAddr);

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
  });

  it("binds GovernanceTokenParameters to the GovernanceToken", async function () {
    expect(await gov.boundTarget(T.GovernanceTokenParameters)).to.equal(
      vgtAddr,
    );
  });

  it("takes ownership of the GovernanceToken by vote (acceptOwnership)", async function () {
    await vgt.transferOwnership(govAddr);
    expect(await vgt.pendingOwner()).to.equal(govAddr);

    await handover();

    expect(await vgt.owner()).to.equal(govAddr);
    expect(await vgt.pendingOwner()).to.equal(ethers.ZeroAddress);
    // The deployer no longer holds the vote token's admin surface.
    await expect(vgt.addAgent(owner.address)).to.be.revertedWithCustomError(
      vgt,
      "OwnableUnauthorizedAccount",
    );
    await expect(vgt.pause()).to.be.reverted;
  });

  // Shape: the unpause proposal is created AND voted before the pause executes
  // (a paused VGT refuses every createProposal and castVote fee transfer).
  // The test shows the lockout explicitly, then recovers by the pre-voted
  // unpause, which needs no VGT transfer to execute.
  it("pauses VGT by vote and recovers with a pre-voted unpause", async function () {
    await handover();

    const pauseId = await proposeAndVote(
      T.GovernanceTokenParameters,
      vgtAddr,
      call("pause"),
    );
    const unpauseId = await proposeAndVote(
      T.GovernanceTokenParameters,
      vgtAddr,
      call("unpause"),
    );
    await passDelay(unpauseId);
    // A proposal still open for voting when the pause lands.
    await gov
      .connect(alice)
      .createProposal(
        T.GovernanceTokenParameters,
        "t",
        "d",
        vgtAddr,
        call("removeAgent", [owner.address]),
      );
    const openId = Number(await gov.proposalCount());

    await execute(pauseId);
    expect(await vgt.paused()).to.equal(true);

    // The lockout: no vote can be cast and no proposal created while paused.
    await expect(
      gov.connect(bob).castVote(openId, true, ""),
    ).to.be.revertedWithCustomError(vgt, "EnforcedPause");
    await expect(
      gov
        .connect(alice)
        .createProposal(
          T.GovernanceTokenParameters,
          "t",
          "d",
          vgtAddr,
          call("unpause"),
        ),
    ).to.be.revertedWithCustomError(vgt, "EnforcedPause");

    await execute(unpauseId);
    expect(await vgt.paused()).to.equal(false);

    // Voting works again.
    await gov.connect(bob).castVote(openId, true, "");
    const [p] = await gov.getProposal(openId);
    expect(p.votesFor).to.equal(1n);
  });

  it("rejects a VGT call under TokenParameters", async function () {
    await expect(
      gov
        .connect(alice)
        .createProposal(T.TokenParameters, "t", "d", vgtAddr, call("pause")),
    )
      .to.be.revertedWithCustomError(gov, "TargetNotBoundToType")
      .withArgs(T.TokenParameters, vgtAddr);
  });

  it("rejects a VSC call under GovernanceTokenParameters", async function () {
    const vscAddr = await vsc.getAddress();
    await expect(
      gov
        .connect(alice)
        .createProposal(
          T.GovernanceTokenParameters,
          "t",
          "d",
          vscAddr,
          call("pause"),
        ),
    )
      .to.be.revertedWithCustomError(gov, "TargetNotBoundToType")
      .withArgs(T.GovernanceTokenParameters, vscAddr);
  });

  it("uses the TokenParameters thresholds", async function () {
    const a = await gov.proposalThresholds(T.GovernanceTokenParameters);
    const b = await gov.proposalThresholds(T.TokenParameters);
    expect(a.quorumPercentage).to.equal(b.quorumPercentage);
    expect(a.approvalPercentage).to.equal(b.approvalPercentage);
    expect(a.votingPeriod).to.equal(b.votingPeriod);
    expect(a.executionDelay).to.equal(b.executionDelay);
    expect(a.quorumPercentage).to.equal(3000n);
    expect(a.approvalPercentage).to.equal(7000n);
  });
});
