import { expect } from "chai";
import { ethers } from "hardhat";
import { ageVoters } from "../helpers/governanceFixture";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import { attest, configureKyc } from "../helpers/kyc";

// Plan v2 Task 3.3 (R-3R-3, R-3R-4): PrivacyManager and ZKVerifierIntegrated
// leave the deployer at the ceremony. Governance binds each only while it is
// being handed over and governs it under its own type (11, 12) with the
// TokenParameters thresholds; the global selector denylist applies.
describe("Privacy contracts are governable by proposal (3.3)", function () {
  const T = { TokenParameters: 3, Privacy: 11, Verifier: 12 };
  const E = ethers.parseEther;

  let owner: SignerWithAddress,
    alice: SignerWithAddress,
    bob: SignerWithAddress,
    carol: SignerWithAddress,
    ops: SignerWithAddress;
  let gov: any, pm: any, zk: any, rules: any, vsc: any;
  let govAddr: string, pmAddr: string, zkAddr: string;

  async function passByVote(type: number, target: any, data: string) {
    await gov
      .connect(alice)
      .createProposal(type, "t", "d", await target.getAddress(), data);
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
    await gov.executeProposal(id);
    const [after] = await gov.getProposal(id);
    expect(Number(after.status)).to.equal(4); // Executed
  }

  const accept = (c: any) => c.interface.encodeFunctionData("acceptOwnership");

  beforeEach(async function () {
    [owner, alice, bob, carol, ops] = await ethers.getSigners();
    const idReg = await (
      await ethers.getContractFactory("IdentityRegistry")
    ).deploy();
    const idRegAddr = await idReg.getAddress();
    rules = await (
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

    zk = await (
      await ethers.getContractFactory("ZKVerifierIntegrated")
    ).deploy(false);
    zkAddr = await zk.getAddress();
    pm = await (
      await ethers.getContractFactory("PrivacyManager")
    ).deploy(zkAddr);
    pmAddr = await pm.getAddress();
  });

  it("types 11 and 12 are unbound until handed over, and use the TokenParameters row", async function () {
    expect(await gov.boundTarget(T.Privacy)).to.equal(ethers.ZeroAddress);
    expect(await gov.boundTarget(T.Verifier)).to.equal(ethers.ZeroAddress);
    await expect(
      gov
        .connect(alice)
        .createProposal(T.Privacy, "t", "d", pmAddr, accept(pm)),
    ).to.be.revertedWithCustomError(gov, "TargetNotBoundToType");
    const t = await gov.proposalThresholds(T.TokenParameters);
    for (const k of [T.Privacy, T.Verifier]) {
      const a = await gov.proposalThresholds(k);
      expect([
        a.quorumPercentage,
        a.approvalPercentage,
        a.votingPeriod,
        a.executionDelay,
      ]).to.deep.equal([
        t.quorumPercentage,
        t.approvalPercentage,
        t.votingPeriod,
        t.executionDelay,
      ]);
    }
  });

  it("refuses to bind a contract not being handed to governance", async function () {
    await expect(gov.setPrivacyManager(pmAddr)).to.be.revertedWith(
      "Target not handed to governance",
    );
    await expect(gov.setZKVerifier(zkAddr)).to.be.revertedWith(
      "Target not handed to governance",
    );
    await pm.transferOwnership(alice.address);
    await expect(gov.setPrivacyManager(pmAddr)).to.be.revertedWith(
      "Target not handed to governance",
    );
    await expect(gov.setZKVerifier(bob.address)).to.be.revertedWith(
      "Target not handed to governance",
    );
    await zk.transferOwnership(govAddr);
    await expect(
      gov.connect(alice).setZKVerifier(zkAddr),
    ).to.be.revertedWithCustomError(gov, "OwnableUnauthorizedAccount");
  });

  it("PrivacyManager: accepted by vote, root and listOperator by vote, denylist applies", async function () {
    await pm.transferOwnership(govAddr);
    await gov.setPrivacyManager(pmAddr);
    expect(await gov.boundTarget(T.Privacy)).to.equal(pmAddr);
    // Bound to its own type only.
    await expect(
      gov
        .connect(alice)
        .createProposal(T.TokenParameters, "t", "d", pmAddr, accept(pm)),
    ).to.be.revertedWithCustomError(gov, "TargetNotBoundToType");
    await expect(
      gov
        .connect(alice)
        .createProposal(
          T.Privacy,
          "t",
          "d",
          pmAddr,
          pm.interface.encodeFunctionData("renounceOwnership"),
        ),
    ).to.be.revertedWith("Selector not allowed");

    await passByVote(T.Privacy, pm, accept(pm));
    expect(await pm.owner()).to.equal(govAddr);
    const root = ethers.toBeHex(123456789n, 32);
    await expect(pm.publishWhitelistRoot(root)).to.be.revertedWithCustomError(
      pm,
      "NotListOperator",
    );
    await passByVote(
      T.Privacy,
      pm,
      pm.interface.encodeFunctionData("publishWhitelistRoot", [root]),
    );
    expect(await pm.whitelistRoot()).to.equal(root);
    expect(await pm.whitelistVersion()).to.equal(1n);
    await passByVote(
      T.Privacy,
      pm,
      pm.interface.encodeFunctionData("setListOperator", [ops.address]),
    );
    expect(await pm.listOperator()).to.equal(ops.address);
    await pm.connect(ops).publishWhitelistRoot(ethers.toBeHex(42n, 32));
    expect(await pm.whitelistVersion()).to.equal(2n);
  });

  // Task 3.7b: the attestation setters are plain onlyOwner calls, so a type
  // 11 vote reaches them with no governance change.
  it("PrivacyManager: trusted attestor keys and policies by vote (3.7b)", async function () {
    await pm.transferOwnership(govAddr);
    await gov.setPrivacyManager(pmAddr);
    await passByVote(T.Privacy, pm, accept(pm));
    const JUR = ethers.id("JURISDICTION_PROOF");
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const {
      attestorPublicKey,
      newAttestorKey,
    } = require("../../scripts/zk/attest");
    const { Ax: ax, Ay: ay } = await attestorPublicKey(newAttestorKey());
    await expect(
      pm.setTrustedAttestor(JUR, ax, ay, true),
    ).to.be.revertedWithCustomError(pm, "OwnableUnauthorizedAccount");
    const call = (fn: string, a: unknown[]) =>
      pm.interface.encodeFunctionData(fn, a);
    await passByVote(
      T.Privacy,
      pm,
      call("setTrustedAttestor", [JUR, ax, ay, true]),
    );
    await passByVote(T.Privacy, pm, call("setMinimumAccreditation", [100000]));
    await passByVote(
      T.Privacy,
      pm,
      call("setCompliancePolicy", [70, 25, 25, 25, 25]),
    );
    const key = ethers.keccak256(
      ethers.AbiCoder.defaultAbiCoder().encode(
        ["uint256", "uint256"],
        [ax, ay],
      ),
    );
    expect(await pm.trustedAttestor(JUR, key)).to.equal(true);
    expect(await pm.trustedAttestorCount(JUR)).to.equal(1n);
    expect(await pm.minimumAccreditation()).to.equal(100000n);
    expect(
      await pm.currentPolicy(ethers.id("COMPLIANCE_AGGREGATION")),
    ).to.deep.equal([70n, 25n, 25n, 25n, 25n]);
    // Task 3.8: the policy token and a code's bit, also by vote.
    await expect(
      pm.setPolicyToken(await vsc.getAddress()),
    ).to.be.revertedWithCustomError(pm, "OwnableUnauthorizedAccount");
    await passByVote(
      T.Privacy,
      pm,
      call("setPolicyToken", [await vsc.getAddress()]),
    );
    await passByVote(T.Privacy, pm, call("registerJurisdictionCode", [840]));
    expect(await pm.complianceRules()).to.equal(await rules.getAddress());
    expect(await pm.policyToken()).to.equal(await vsc.getAddress());
    expect(await pm.jurisdictionBit(840)).to.equal(1n);
    expect(await pm.allowedJurisdictionMask()).to.equal(1n);
  });

  it("ZKVerifierIntegrated: accepted by vote, updateVerifier only by vote", async function () {
    await zk.transferOwnership(govAddr);
    await gov.setZKVerifier(zkAddr);
    expect(await gov.boundTarget(T.Verifier)).to.equal(zkAddr);
    // A PrivacyParameters proposal cannot reach the verifier.
    await expect(
      gov
        .connect(alice)
        .createProposal(T.Privacy, "t", "d", zkAddr, accept(zk)),
    ).to.be.revertedWithCustomError(gov, "TargetNotBoundToType");
    await expect(
      gov
        .connect(alice)
        .createProposal(
          T.Verifier,
          "t",
          "d",
          zkAddr,
          zk.interface.encodeFunctionData("renounceOwnership"),
        ),
    ).to.be.revertedWith("Selector not allowed");

    await passByVote(T.Verifier, zk, accept(zk));
    expect(await zk.owner()).to.equal(govAddr);
    const yes = await (
      await ethers.getContractFactory("AlwaysTrueVerifier")
    ).deploy();
    const yesAddr = await yes.getAddress();
    await expect(
      zk.updateVerifier("jurisdiction", yesAddr),
    ).to.be.revertedWithCustomError(zk, "OwnableUnauthorizedAccount");
    await passByVote(
      T.Verifier,
      zk,
      zk.interface.encodeFunctionData("updateVerifier", [
        "jurisdiction",
        yesAddr,
      ]),
    );
    expect((await zk.getVerifierAddresses()).jurisdiction).to.equal(yesAddr);
  });

  // Task 3.4: the whitelist-mode setters are plain onlyOwner calls on the
  // ComplianceRules bound target, so a ComplianceRules vote reaches them.
  it("ComplianceRules: privacyManager and whitelistMode set by vote", async function () {
    const T_RULES = 1;
    const vscAddr = await vsc.getAddress();
    await rules.transferOwnership(govAddr);
    await passByVote(T_RULES, rules, accept(rules));
    expect(await rules.owner()).to.equal(govAddr);
    await expect(
      rules.setPrivacyManager(vscAddr, pmAddr),
    ).to.be.revertedWithCustomError(rules, "OwnableUnauthorizedAccount");
    const call = (fn: string, a: unknown[]) =>
      rules.interface.encodeFunctionData(fn, a);
    await passByVote(
      T_RULES,
      rules,
      call("setPrivacyManager", [vscAddr, pmAddr]),
    );
    await passByVote(T_RULES, rules, call("setWhitelistMode", [vscAddr, 2]));
    expect(await rules.privacyManager(vscAddr)).to.equal(pmAddr);
    expect(await rules.whitelistMode(vscAddr)).to.equal(2n);
  });
});
