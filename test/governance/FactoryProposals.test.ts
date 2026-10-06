import { expect } from "chai";
import { addRegistrar } from "../helpers/registrars";
import { ethers } from "hardhat";
import { ageVoters } from "../helpers/governanceFixture";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import { attest, configureKyc } from "../helpers/kyc";

// Plan v2 Task 2F.5 (M4): the two factories leave the deployer at the
// ceremony. Both are Ownable2Step; governance binds them only while they are
// being handed to it, and takes them by vote under their own types.
describe("Factories are governable by proposal (2F.5)", function () {
  const T = { TokenParameters: 3, EscrowFactory: 9, IdentityFactory: 10 };
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
    carol: SignerWithAddress,
    fees: SignerWithAddress;
  let gov: any, vsc: any, escrowF: any, idF: any;
  let govAddr: string, escrowAddr: string, idFAddr: string;

  async function proposeAndVote(type: number, target: string, data: string) {
    await gov.connect(alice).createProposal(type, "t", "d", target, data);
    const id = Number(await gov.proposalCount());
    await gov.connect(bob).castVote(id, true, "");
    await gov.connect(carol).castVote(id, true, "");
    const [p] = await gov.getProposal(id);
    const now = BigInt((await ethers.provider.getBlock("latest"))!.timestamp);
    if (p.executionTime >= now) {
      await ethers.provider.send("evm_increaseTime", [
        Number(p.executionTime - now) + 5,
      ]);
      await ethers.provider.send("evm_mine", []);
    }
    return id;
  }

  async function passByVote(type: number, target: any, data: string) {
    const id = await proposeAndVote(type, await target.getAddress(), data);
    const tx = await gov.executeProposal(id);
    const [after] = await gov.getProposal(id);
    expect(S[Number(after.status)]).to.equal("Executed");
    return tx;
  }

  const accept = (c: any) => c.interface.encodeFunctionData("acceptOwnership");

  beforeEach(async function () {
    [owner, alice, bob, carol, fees] = await ethers.getSigners();
    const idReg = await (
      await ethers.getContractFactory("IdentityRegistry")
    ).deploy();
    const idRegAddr = await idReg.getAddress();
    const rules = await (
      await ethers.getContractFactory("ComplianceRules")
    ).deploy(owner.address, [840], []);
    const rulesAddr = await rules.getAddress();
    const vgt = await (
      await ethers.getContractFactory("GovernanceToken")
    ).deploy("VGT", "VGT", idRegAddr, rulesAddr);
    const vgtAddr = await vgt.getAddress();
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
    await rules.addTrustedContract(vgtAddr, govAddr);
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
    await ageVoters(gov);

    escrowF = await (
      await ethers.getContractFactory("EscrowWalletFactory")
    ).deploy(await vsc.getAddress(), fees.address, idRegAddr, rulesAddr);
    escrowAddr = await escrowF.getAddress();
    await addRegistrar(rules, vsc, escrowF, "MultiSigEscrowWallet");
    idF = await (
      await ethers.getContractFactory("OnchainIDFactory")
    ).deploy(owner.address);
    idFAddr = await idF.getAddress();
  });

  it("types 9 and 10 are unbound until a factory is handed over", async function () {
    expect(await gov.boundTarget(T.EscrowFactory)).to.equal(ethers.ZeroAddress);
    expect(await gov.boundTarget(T.IdentityFactory)).to.equal(
      ethers.ZeroAddress,
    );
    await expect(
      gov
        .connect(alice)
        .createProposal(T.EscrowFactory, "t", "d", escrowAddr, accept(escrowF)),
    ).to.be.revertedWithCustomError(gov, "TargetNotBoundToType");
  });

  it("refuses to bind a factory not being handed to governance", async function () {
    await expect(gov.setEscrowWalletFactory(escrowAddr)).to.be.revertedWith(
      "Target not handed to governance",
    );
    await expect(gov.setOnchainIDFactory(idFAddr)).to.be.revertedWith(
      "Target not handed to governance",
    );
    // A factory nominated to someone else is not governance's either.
    await escrowF.transferOwnership(alice.address);
    await expect(gov.setEscrowWalletFactory(escrowAddr)).to.be.revertedWith(
      "Target not handed to governance",
    );
    // No code, and not the owner of governance.
    await expect(gov.setOnchainIDFactory(bob.address)).to.be.revertedWith(
      "Target not handed to governance",
    );
    await idF.transferOwnership(govAddr);
    await expect(
      gov.connect(alice).setOnchainIDFactory(idFAddr),
    ).to.be.revertedWithCustomError(gov, "OwnableUnauthorizedAccount");
  });

  it("uses the TokenParameters thresholds for both types", async function () {
    const t = await gov.proposalThresholds(T.TokenParameters);
    for (const k of [T.EscrowFactory, T.IdentityFactory]) {
      const a = await gov.proposalThresholds(k);
      expect(a.quorumPercentage).to.equal(t.quorumPercentage);
      expect(a.approvalPercentage).to.equal(t.approvalPercentage);
      expect(a.votingPeriod).to.equal(t.votingPeriod);
      expect(a.executionDelay).to.equal(t.executionDelay);
    }
  });

  it("EscrowWalletFactory: accepted by vote, DEFAULT_ADMIN moves, fee wallet by vote", async function () {
    const ADMIN = await escrowF.DEFAULT_ADMIN_ROLE();
    expect(await escrowF.owner()).to.equal(owner.address);
    expect(await escrowF.hasRole(ADMIN, owner.address)).to.equal(true);
    await escrowF.transferOwnership(govAddr);
    // Two-step: nothing moves before the vote.
    expect(await escrowF.owner()).to.equal(owner.address);
    await gov.setEscrowWalletFactory(escrowAddr);
    expect(await gov.boundTarget(T.EscrowFactory)).to.equal(escrowAddr);

    // Bound to its type only.
    await expect(
      gov
        .connect(alice)
        .createProposal(
          T.TokenParameters,
          "t",
          "d",
          escrowAddr,
          accept(escrowF),
        ),
    ).to.be.revertedWithCustomError(gov, "TargetNotBoundToType");
    // 2F.1 selector rules apply unchanged.
    await expect(
      gov
        .connect(alice)
        .createProposal(
          T.EscrowFactory,
          "t",
          "d",
          escrowAddr,
          escrowF.interface.encodeFunctionData("renounceOwnership"),
        ),
    ).to.be.revertedWith("Selector not allowed");

    await passByVote(T.EscrowFactory, escrowF, accept(escrowF));
    expect(await escrowF.owner()).to.equal(govAddr);
    expect(await escrowF.hasRole(ADMIN, govAddr)).to.equal(true);
    expect(await escrowF.hasRole(ADMIN, owner.address)).to.equal(false);
    for (const fn of [
      () => escrowF.setOwnerWallet(alice.address),
      () => escrowF.setIdentityRegistry(escrowAddr),
      () => escrowF.setComplianceRules(escrowAddr),
    ]) {
      await expect(fn()).to.be.revertedWithCustomError(
        escrowF,
        "OwnableUnauthorizedAccount",
      );
    }
    // ADMIN_ROLE stays operational (ops after the ceremony).
    await escrowF.registerInvestor(carol.address, carol.address);
    await expect(
      escrowF.grantRole(await escrowF.ADMIN_ROLE(), alice.address),
    ).to.be.revertedWithCustomError(
      escrowF,
      "AccessControlUnauthorizedAccount",
    );

    await passByVote(
      T.EscrowFactory,
      escrowF,
      escrowF.interface.encodeFunctionData("setOwnerWallet", [bob.address]),
    );
    expect(await escrowF.ownerWallet()).to.equal(bob.address);

    // Every escrow created now names governance (owner()) as its owner.
    await escrowF
      .connect(carol)
      .createEscrowWallet(alice.address, bob.address, E("10"));
    const w = await ethers.getContractAt(
      "MultiSigEscrowWallet",
      await escrowF.getWalletAddress(1),
    );
    expect(await w.owner()).to.equal(govAddr);
    expect(await w.ownerWallet()).to.equal(bob.address);
  });

  it("EscrowWalletFactory: accepting ownership revokes every other DEFAULT_ADMIN (review M-1)", async function () {
    const DA = await escrowF.DEFAULT_ADMIN_ROLE();
    // Planted before the ceremony: a second role admin.
    await escrowF.grantRole(DA, alice.address);
    expect(await escrowF.getRoleMemberCount(DA)).to.equal(2n);
    await escrowF.transferOwnership(govAddr);
    await gov.setEscrowWalletFactory(escrowAddr);
    await passByVote(T.EscrowFactory, escrowF, accept(escrowF));
    expect(await escrowF.hasRole(DA, alice.address)).to.equal(false);
    expect(await escrowF.getRoleMemberCount(DA)).to.equal(1n);
    expect(await escrowF.getRoleMember(DA, 0)).to.equal(govAddr);
    await expect(
      escrowF
        .connect(alice)
        .grantRole(await escrowF.ADMIN_ROLE(), owner.address),
    ).to.be.revertedWithCustomError(
      escrowF,
      "AccessControlUnauthorizedAccount",
    );
  });

  it("OnchainIDFactory: two-step ownership, accepted by vote, fee recipient by vote", async function () {
    await idF.transferOwnership(govAddr);
    expect(await idF.owner()).to.equal(owner.address);
    expect(await idF.pendingOwner()).to.equal(govAddr);
    await gov.setOnchainIDFactory(idFAddr);
    expect(await gov.boundTarget(T.IdentityFactory)).to.equal(idFAddr);

    const tx = await passByVote(T.IdentityFactory, idF, accept(idF));
    await expect(tx)
      .to.emit(idF, "FactoryOwnershipTransferred")
      .withArgs(owner.address, govAddr);
    expect(await idF.owner()).to.equal(govAddr);
    await expect(idF.setDeploymentPaused(true)).to.be.revertedWithCustomError(
      idF,
      "OwnableUnauthorizedAccount",
    );

    await passByVote(
      T.IdentityFactory,
      idF,
      idF.interface.encodeFunctionData("setFeeRecipient", [bob.address]),
    );
    expect(await idF.feeRecipient()).to.equal(bob.address);

    // Review L-3: governance has no receive(), so fees leave by
    // emergencyWithdrawTo(recipient) under type 10.
    await owner.sendTransaction({ to: idFAddr, value: E("1") });
    await expect(
      idF.emergencyWithdrawTo(owner.address),
    ).to.be.revertedWithCustomError(idF, "OwnableUnauthorizedAccount");
    const before = await ethers.provider.getBalance(fees.address);
    await passByVote(
      T.IdentityFactory,
      idF,
      idF.interface.encodeFunctionData("emergencyWithdrawTo", [fees.address]),
    );
    expect(await ethers.provider.getBalance(fees.address)).to.equal(
      before + E("1"),
    );
    expect(await ethers.provider.getBalance(idFAddr)).to.equal(0n);
  });
});
