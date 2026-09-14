import { expect } from "chai";
import { ethers } from "hardhat";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";

/**
 * Quorum denominator integrity.
 *
 * `registeredIdentityCount` is the governance quorum denominator, snapshotted
 * at proposal creation. `batchRegisterIdentity` used to store identities
 * without incrementing it, while `deleteIdentity` still decremented — so the
 * counter drifted below the real electorate and could reach zero with live
 * voters, making `eligibleVoters * quorum == 0` and any single vote sufficient.
 */
describe("Quorum denominator integrity", function () {
  let owner: SignerWithAddress;
  let signers: SignerWithAddress[];
  let idReg: any, rules: any;

  beforeEach(async function () {
    signers = await ethers.getSigners();
    owner = signers[0];
    idReg = await (await ethers.getContractFactory("IdentityRegistry")).deploy();
    rules = await (await ethers.getContractFactory("ComplianceRules")).deploy(owner.address, [840], [643]);
    await idReg.addAgent(owner.address);
  });

  async function newId(who: SignerWithAddress): Promise<string> {
    const id = await (await ethers.getContractFactory("OnchainID")).deploy(who.address);
    return await id.getAddress();
  }

  async function countVerified(from: number, to: number): Promise<number> {
    let n = 0;
    for (let i = from; i <= to; i++) if (await idReg.isVerified(signers[i].address)) n++;
    return n;
  }

  it("batch registration increments the counter", async function () {
    const addrs = [], ids = [], cc = [];
    for (let i = 1; i <= 5; i++) { addrs.push(signers[i].address); ids.push(await newId(signers[i])); cc.push(840); }
    await idReg.batchRegisterIdentity(addrs, ids, cc);
    expect(await idReg.registeredIdentityCount()).to.equal(5n);
  });

  it("the counter matches the real electorate across mixed paths", async function () {
    for (let i = 1; i <= 3; i++) await idReg.registerIdentity(signers[i].address, await newId(signers[i]), 840);
    const addrs = [], ids = [], cc = [];
    for (let i = 4; i <= 9; i++) { addrs.push(signers[i].address); ids.push(await newId(signers[i])); cc.push(840); }
    await idReg.batchRegisterIdentity(addrs, ids, cc);

    expect(await idReg.registeredIdentityCount()).to.equal(BigInt(await countVerified(1, 9)));
  });

  it("deleting batch-registered identities cannot drive the counter below the electorate", async function () {
    for (let i = 1; i <= 3; i++) await idReg.registerIdentity(signers[i].address, await newId(signers[i]), 840);
    const addrs = [], ids = [], cc = [];
    for (let i = 4; i <= 9; i++) { addrs.push(signers[i].address); ids.push(await newId(signers[i])); cc.push(840); }
    await idReg.batchRegisterIdentity(addrs, ids, cc);

    for (let i = 4; i <= 9; i++) await idReg.deleteIdentity(signers[i].address);

    const live = await countVerified(1, 9);
    expect(live).to.equal(3);
    expect(await idReg.registeredIdentityCount()).to.equal(3n);
  });

  it("batch registration enforces jurisdiction like the single path", async function () {
    // 643 is on this token's blocked list; the single path rejects it, and the
    // batch path must not be a way around that check.
    await rules.setJurisdictionRule(await idReg.getAddress(), [840], [643]);
    await idReg.setComplianceRules(await rules.getAddress(), await idReg.getAddress());

    await expect(idReg.registerIdentity(signers[1].address, await newId(signers[1]), 643)).to.be.reverted;
    await expect(
      idReg.batchRegisterIdentity([signers[2].address], [await newId(signers[2])], [643])
    ).to.be.reverted;
  });
});

/**
 * Defence in depth: a zero eligible-voter snapshot must never satisfy quorum.
 * `totalVotes * 10000 >= eligibleVoters * quorumPct` is trivially true when the
 * denominator is 0, so one vote used to carry any proposal. The guard now
 * requires a non-empty electorate.
 *
 * LIMITATION, stated rather than implied: this is a source-text assertion, not
 * a behavioral one. The zero-electorate state is unreachable through the
 * public API after the D3 fix (createProposal requires a verified proposer, so
 * the snapshot is always >= 1). The guard exists for the case where the
 * counter is corrupted by a future path this suite does not know about.
 */
describe("Zero electorate cannot satisfy quorum", function () {
  it("requires a non-empty electorate for quorum", async function () {
    const src = require("fs").readFileSync(
      "contracts/governance/VanguardGovernance.sol", "utf8"
    );
    // The guard must be part of the quorum expression itself, not a comment.
    const m = src.match(/bool quorumMet =([\s\S]{0,200}?);/);
    expect(m, "quorumMet assignment not found").to.not.be.null;
    expect(m![1]).to.match(/eligibleVoters\s*>\s*0/);
  });
});

/**
 * List-update proposals must honour the execution delay.
 *
 * `createListUpdateProposal` hardcoded `executionTime: 0` while the regular
 * path computed `votingEnds + executionDelay`. The guard
 * `block.timestamp >= executionTime` is vacuously true for 0, so blacklisting
 * executed the instant voting ended and the cancel window never opened.
 */
describe("List-update proposals honour the execution delay", function () {
  it("sets a real execution time, not zero", async function () {
    const [owner, alice] = await ethers.getSigners();

    const idReg = await (await ethers.getContractFactory("IdentityRegistry")).deploy();
    const rules = await (await ethers.getContractFactory("ComplianceRules")).deploy(owner.address, [840], []);
    const vgt = await (await ethers.getContractFactory("GovernanceToken")).deploy(
      "Vanguard Governance", "VGT", await idReg.getAddress(), await rules.getAddress()
    );
    const gov = await (await ethers.getContractFactory("VanguardGovernance")).deploy(
      await vgt.getAddress(), await idReg.getAddress(), owner.address,
      await rules.getAddress(), owner.address, await vgt.getAddress(), 1440
    );
    await idReg.addAgent(owner.address);
    await vgt.addAgent(owner.address);
    await rules.setTokenIdentityRegistry(await vgt.getAddress(), await idReg.getAddress());
    await rules.addTrustedContract(await gov.getAddress());

    const OID = await ethers.getContractFactory("OnchainID");
    await idReg.registerIdentity(alice.address, await (await OID.deploy(alice.address)).getAddress(), 840);
    await vgt.mint(alice.address, ethers.parseEther("1000"));
    await vgt.connect(alice).approve(await gov.getAddress(), ethers.MaxUint256);

    const dlm = await (await ethers.getContractFactory("DynamicListManager")).deploy(owner.address);
    await gov.setDynamicListManager(await dlm.getAddress());

    // ProposalType.AddToBlacklist
    await gov.connect(alice).createListUpdateProposal(
      6, "blacklist bob", "sanctions", alice.address, 0, "test"
    );
    const [p] = await gov.getProposal(1);

    expect(p.executionTime, "executionTime must not be zero").to.be.greaterThan(0n);
    expect(p.executionTime, "delay must sit after voting ends").to.be.greaterThan(p.votingEnds);
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
  let owner: SignerWithAddress, alice: SignerWithAddress, bob: SignerWithAddress, carol: SignerWithAddress;
  let gov: any, vgt: any, govAddr: string;
  const E = ethers.parseEther;
  const S = ["Pending", "Active", "Approved", "Rejected", "Executed", "Cancelled"];

  async function pass(id: number) {
    await gov.connect(bob).castVote(id, true, "");
    await gov.connect(carol).castVote(id, true, "");
    const [p] = await gov.getProposal(id);
    await ethers.provider.send("evm_increaseTime", [Number(p.executionTime - p.createdAt) + 5]);
    await ethers.provider.send("evm_mine", []);
  }

  beforeEach(async function () {
    [owner, alice, bob, carol] = await ethers.getSigners();
    const idReg = await (await ethers.getContractFactory("IdentityRegistry")).deploy();
    const rules = await (await ethers.getContractFactory("ComplianceRules")).deploy(owner.address, [840], []);
    vgt = await (await ethers.getContractFactory("GovernanceToken")).deploy(
      "VGT", "VGT", await idReg.getAddress(), await rules.getAddress()
    );
    gov = await (await ethers.getContractFactory("VanguardGovernance")).deploy(
      await vgt.getAddress(), await idReg.getAddress(), owner.address,
      await rules.getAddress(), owner.address, await vgt.getAddress(), 1440
    );
    govAddr = await gov.getAddress();
    await idReg.addAgent(owner.address);
    await vgt.addAgent(owner.address);
    await vgt.addAgent(govAddr);
    await rules.setTokenIdentityRegistry(await vgt.getAddress(), await idReg.getAddress());
    await rules.addTrustedContract(govAddr);
    const OID = await ethers.getContractFactory("OnchainID");
    for (const w of [alice, bob, carol]) {
      await idReg.registerIdentity(w.address, await (await OID.deploy(w.address)).getAddress(), 840);
      await vgt.mint(w.address, E("1000"));
      await vgt.connect(w).approve(govAddr, ethers.MaxUint256);
    }
    // Governance takes ownership of itself by vote.
    await gov.transferOwnership(govAddr);
    await gov.connect(alice).createProposal(4 /* SystemParameters: target is governance itself */, "self-own", "d", govAddr,
      gov.interface.encodeFunctionData("acceptOwnership"));
    await pass(1);
    await gov.executeProposal(1);
    expect(await gov.owner()).to.equal(govAddr);
  });

  it("a proposal can cancel ANOTHER proposal by vote (brake reachable)", async function () {
    await gov.connect(alice).createProposal(0, "victim", "d", owner.address, "0x");
    await gov.connect(bob).castVote(2, true, "");
    await gov.connect(alice).createProposal(4 /* SystemParameters: target is governance itself */, "cancel-2", "d", govAddr,
      gov.interface.encodeFunctionData("cancelProposal", [2]));
    await pass(3);
    await gov.executeProposal(3);

    const [p2] = await gov.getProposal(2);
    expect(S[Number(p2.status)]).to.equal("Cancelled");
    await expect(gov.connect(bob).claimRefund(2)).to.not.be.reverted;
  });

  it("a proposal that cancels ITSELF cannot strand its deposits", async function () {
    await gov.connect(alice).createProposal(4 /* SystemParameters: target is governance itself */, "cancel-self", "d", govAddr,
      gov.interface.encodeFunctionData("cancelProposal", [2]));
    await pass(2);
    await gov.executeProposal(2);

    const [p2] = await gov.getProposal(2);
    expect(S[Number(p2.status)]).to.not.equal("Active");
    // Every deposit must end up either burned or claimed. Nothing may remain
    // sitting in the contract with no path out.
    for (const w of [alice, bob, carol]) {
      try { await gov.connect(w).claimRefund(2); } catch { /* burned path is also fine */ }
    }
    expect(await vgt.balanceOf(govAddr), `stranded deposits, status=${S[Number(p2.status)]}`).to.equal(0n);
  });
});
