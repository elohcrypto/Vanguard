import { expect } from "chai";
import { ethers } from "hardhat";
import { attest, configureKyc } from "../helpers/kyc";

/**
 * D23: after the handover ops is a GovernanceToken agent (issuance, voter
 * compliance), but the levers that act ON a holder refuse a trusted
 * contract. Freezing, burning or recovering governance's VGT would stop
 * voting or drain the locked fees, and no vote could undo it. The VSC
 * Token keeps every agent power; governance's own burn(uint256) is intact.
 */
describe("GovernanceToken agent limits (D23)", function () {
  const FEE = ethers.parseEther("10");
  const PAST_VOTE_AND_DELAY = 9 * 86400 + 60;
  const REASON = "GovernanceToken: trusted contract";
  const D = async (name: string, ...args: any[]): Promise<any> =>
    (await ethers.getContractFactory(name)).deploy(...args);
  const refused = (tx: Promise<unknown>) =>
    expect(tx).to.be.revertedWith(REASON);

  async function fixture() {
    const [owner, proposer, v1, v2, v3, ops, fresh] = await ethers.getSigners();
    const idReg = await D("IdentityRegistry");
    const rules = await D("ComplianceRules", owner.address, [840], []);
    const idAddr = await idReg.getAddress();
    const rulesAddr = await rules.getAddress();
    const vgt = await D("GovernanceToken", "VGT", "VGT", idAddr, rulesAddr);
    const vgtAddr = await vgt.getAddress();
    const gov = await D(
      "VanguardGovernance",
      ...[vgtAddr, idAddr, owner.address, rulesAddr, owner.address, vgtAddr, 1],
    );
    const govAddr = await gov.getAddress();
    await vgt.addAgent(govAddr);
    await vgt.addAgent(ops.address);
    await rules.setTokenIdentityRegistry(vgtAddr, idAddr);
    await rules.addTrustedContract(govAddr);

    const kycIssuer = await D("ClaimIssuer", owner.address, "KYC", "KYC");
    await configureKyc(idReg, await kycIssuer.getAddress());
    for (const s of [owner, proposer, v1, v2, v3]) {
      const id = await (await D("OnchainID", s.address)).getAddress();
      await idReg.registerIdentity(s.address, id, 840);
      await attest(kycIssuer, owner, id);
      if (s !== owner) await vgt.transfer(s.address, ethers.parseEther("100"));
      await vgt.connect(s).approve(govAddr, ethers.MaxUint256);
    }
    await gov
      .connect(proposer)
      .createProposal(
        4,
        "t",
        "d",
        govAddr,
        gov.interface.encodeFunctionData("proposalCount"),
      );
    const pid = await gov.proposalCount();
    const sig = { owner, v1, v2, v3, ops, fresh };
    const addrs = { idAddr, rulesAddr, govAddr };
    return { ...sig, ...addrs, idReg, rules, vgt, gov, pid };
  }

  it("ops cannot freeze, partially freeze, burn or recover governance", async function () {
    const { ops, fresh, idReg, vgt, govAddr } = await fixture();
    expect(await idReg.identity(govAddr)).to.equal(ethers.ZeroAddress);
    expect(await vgt.balanceOf(govAddr)).to.equal(FEE);
    const agent = vgt.connect(ops);
    await refused(agent.setAddressFrozen(govAddr, true));
    await refused(agent.freezePartialTokens(govAddr, 1n));
    expect(await vgt.frozenTokens(govAddr)).to.equal(0n);
    await refused(agent["burn(address,uint256)"](govAddr, 1n));
    // Pre-D23 this succeeded: all three identities are zero, so recovery
    // took the "already moved" branch and sent every locked fee to fresh.
    await refused(
      agent.recoveryAddress(govAddr, fresh.address, ethers.ZeroAddress),
    );
    expect(await vgt.balanceOf(govAddr)).to.equal(FEE);
  });

  it("no recovery INTO governance: no freeze, no identity lands on it", async function () {
    const { v1, ops, fresh, idReg, vgt, govAddr } = await fixture();
    const agent = vgt.connect(ops);
    // An unregistered frozen wallet (all-zero identities) and a frozen voter.
    await agent.setAddressFrozen(fresh.address, true);
    await agent.setAddressFrozen(v1.address, true);
    const v1Id = await idReg.identity(v1.address);
    for (const [from, id] of [
      [fresh.address, ethers.ZeroAddress],
      [v1.address, v1Id],
    ]) {
      await refused(agent.recoveryAddress(from, govAddr, id));
    }
    expect(await vgt.isFrozen(govAddr)).to.equal(false);
    expect(await idReg.identity(govAddr)).to.equal(ethers.ZeroAddress);
  });

  it("a contract frozen before it was trusted can still be unfrozen", async function () {
    const { ops, rules, vgt } = await fixture();
    const stub = await (await D("MockToken", "Stub", "STB", 0)).getAddress();
    await vgt.connect(ops).setAddressFrozen(stub, true);
    await rules.addTrustedContract(stub);
    await vgt.connect(ops).setAddressFrozen(stub, false);
    expect(await vgt.isFrozen(stub)).to.equal(false);
    await refused(vgt.connect(ops).setAddressFrozen(stub, true));
  });

  it("ops keeps every lever on a voter", async function () {
    const { v1, ops, vgt } = await fixture();
    const agent = vgt.connect(ops);
    await agent.setAddressFrozen(v1.address, true);
    expect(await vgt.isFrozen(v1.address)).to.equal(true);
    await agent.setAddressFrozen(v1.address, false);
    expect(await vgt.isFrozen(v1.address)).to.equal(false);
    await agent.freezePartialTokens(v1.address, 1n);
    expect(await vgt.frozenTokens(v1.address)).to.equal(1n);
    const b0 = await vgt.balanceOf(v1.address);
    await agent["burn(address,uint256)"](v1.address, 1n);
    expect(await vgt.balanceOf(v1.address)).to.equal(b0 - 1n);
  });

  it("the VSC Token keeps agent powers over a trusted contract", async function () {
    const { owner, ops, idAddr, rulesAddr, rules } = await fixture();
    const vsc = await D("Token", "Vanguard", "VSC", idAddr, rulesAddr);
    await rules.setTokenIdentityRegistry(await vsc.getAddress(), idAddr);
    await vsc.addAgent(ops.address);
    const stub = await (await D("MockToken", "Stub", "STB", 0)).getAddress();
    await rules.addTrustedContract(stub);
    await vsc.mint(owner.address, 100n);
    await vsc.transfer(stub, 100n);

    await vsc.connect(ops).setAddressFrozen(stub, true);
    expect(await vsc.isFrozen(stub)).to.equal(true);
    await vsc.connect(ops).setAddressFrozen(stub, false);
    await vsc.connect(ops).burn(stub, 40n);
    expect(await vsc.balanceOf(stub)).to.equal(60n);
  });

  it("a passed proposal still burns governance's locked fees", async function () {
    const { v1, v2, v3, vgt, gov, govAddr, pid } = await fixture();
    for (const v of [v1, v2, v3]) await gov.connect(v).castVote(pid, true, "y");
    expect(await vgt.balanceOf(govAddr)).to.equal(FEE * 4n);
    const supply0 = await vgt.totalSupply();
    await ethers.provider.send("evm_increaseTime", [PAST_VOTE_AND_DELAY]);
    await ethers.provider.send("evm_mine", []);
    await expect(gov.executeProposal(pid)).to.emit(gov, "ProposalExecuted");
    expect(await vgt.balanceOf(govAddr)).to.equal(0n);
    expect(supply0 - (await vgt.totalSupply())).to.equal(FEE * 4n);
  });
});
