import { expect } from "chai";
import { ethers } from "hardhat";
import { ageVoters } from "../helpers/governanceFixture";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import { attest, configureKyc } from "../helpers/kyc";

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
  let idReg: any, rules: any, kycIssuer: any;

  beforeEach(async function () {
    signers = await ethers.getSigners();
    owner = signers[0];
    idReg = await (
      await ethers.getContractFactory("IdentityRegistry")
    ).deploy();
    rules = await (
      await ethers.getContractFactory("ComplianceRules")
    ).deploy(owner.address, [840], [643]);
    await idReg.addAgent(owner.address);

    kycIssuer = await (
      await ethers.getContractFactory("ClaimIssuer")
    ).deploy(owner.address, "KYC Issuer", "Trusted KYC attestations");
    await configureKyc(idReg, await kycIssuer.getAddress());
  });

  async function newId(who: SignerWithAddress): Promise<string> {
    const id = await (
      await ethers.getContractFactory("OnchainID")
    ).deploy(who.address);
    return await id.getAddress();
  }

  async function countVerified(from: number, to: number): Promise<number> {
    let n = 0;
    for (let i = from; i <= to; i++)
      if (await idReg.isVerified(signers[i].address)) n++;
    return n;
  }

  it("batch registration increments the counter", async function () {
    const addrs = [],
      ids = [],
      cc = [];
    for (let i = 1; i <= 5; i++) {
      addrs.push(signers[i].address);
      ids.push(await newId(signers[i]));
      cc.push(840);
    }
    await idReg.batchRegisterIdentity(addrs, ids, cc);
    expect(await idReg.registeredIdentityCount()).to.equal(5n);
  });

  it("the counter matches the real electorate across mixed paths", async function () {
    for (let i = 1; i <= 3; i++) {
      const id = await newId(signers[i]);
      await idReg.registerIdentity(signers[i].address, id, 840);
      await attest(kycIssuer, owner, id);
    }
    const addrs = [],
      ids = [],
      cc = [];
    for (let i = 4; i <= 9; i++) {
      const id = await newId(signers[i]);
      addrs.push(signers[i].address);
      ids.push(id);
      cc.push(840);
    }
    await idReg.batchRegisterIdentity(addrs, ids, cc);
    for (const id of ids) await attest(kycIssuer, owner, id);

    expect(await idReg.registeredIdentityCount()).to.equal(
      BigInt(await countVerified(1, 9)),
    );
  });

  it("deleting batch-registered identities cannot drive the counter below the electorate", async function () {
    for (let i = 1; i <= 3; i++) {
      const id = await newId(signers[i]);
      await idReg.registerIdentity(signers[i].address, id, 840);
      await attest(kycIssuer, owner, id);
    }
    const addrs = [],
      ids = [],
      cc = [];
    for (let i = 4; i <= 9; i++) {
      const id = await newId(signers[i]);
      addrs.push(signers[i].address);
      ids.push(id);
      cc.push(840);
    }
    await idReg.batchRegisterIdentity(addrs, ids, cc);
    for (const id of ids) await attest(kycIssuer, owner, id);

    for (let i = 4; i <= 9; i++) await idReg.deleteIdentity(signers[i].address);

    const live = await countVerified(1, 9);
    expect(live).to.equal(3);
    expect(await idReg.registeredIdentityCount()).to.equal(3n);
  });

  it("batch registration enforces jurisdiction like the single path", async function () {
    // 643 is on this token's blocked list; the single path rejects it, and the
    // batch path must not be a way around that check.
    await rules.setJurisdictionRule(await idReg.getAddress(), [840], [643]);
    await idReg.setComplianceRules(
      await rules.getAddress(),
      await idReg.getAddress(),
    );

    await expect(
      idReg.registerIdentity(signers[1].address, await newId(signers[1]), 643),
    ).to.be.reverted;
    await expect(
      idReg.batchRegisterIdentity(
        [signers[2].address],
        [await newId(signers[2])],
        [643],
      ),
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
      "contracts/governance/VanguardGovernance.sol",
      "utf8",
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
    await rules.addTrustedContract(await gov.getAddress());

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
      .createProposal(0, "victim", "d", owner.address, "0x");
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

/**
 * D7 electorate rule. The quorum denominator is registeredIdentityCount, but
 * voting needs isVerified, which turns false once a required claim expires.
 * An expired identity stays in the denominator until an operator deletes it.
 */
describe("Expired claims and the electorate (D7)", function () {
  it("expired claims inflate the denominator until deleteIdentity", async function () {
    const all = await ethers.getSigners();
    const owner = all[0];
    // Three live identities: a proposer (cannot vote on its own proposal)
    // plus two voters. Seven identities whose claim expires in a day.
    const live = all.slice(1, 4);
    const [proposer, v1, v2] = live;
    const lapsed = all.slice(4, 11);
    const REJECTED = 3n,
      EXECUTED = 4n; // ProposalStatus
    const F = (name: string) => ethers.getContractFactory(name);

    const idReg = await (await F("IdentityRegistry")).deploy();
    const rules = await (
      await F("ComplianceRules")
    ).deploy(owner.address, [840], []);
    const regAddr = await idReg.getAddress();
    const rulesAddr = await rules.getAddress();
    const vgt = await (
      await F("GovernanceToken")
    ).deploy("VGT", "VGT", regAddr, rulesAddr);
    const vgtAddr = await vgt.getAddress();
    const gov = await (
      await F("VanguardGovernance")
    ).deploy(
      vgtAddr,
      regAddr,
      owner.address,
      rulesAddr,
      owner.address,
      vgtAddr,
      1440,
    );
    const govAddr = await gov.getAddress();
    await idReg.addAgent(owner.address);
    await vgt.addAgent(owner.address);
    await vgt.addAgent(govAddr);
    await rules.setTokenIdentityRegistry(vgtAddr, regAddr);
    await rules.addTrustedContract(govAddr);
    const kycIssuer = await (
      await F("ClaimIssuer")
    ).deploy(owner.address, "KYC", "d");
    await configureKyc(idReg, await kycIssuer.getAddress());

    const now = (await ethers.provider.getBlock("latest"))!.timestamp;
    for (const w of [...live, ...lapsed]) {
      const id = await (
        await (await F("OnchainID")).deploy(w.address)
      ).getAddress();
      await idReg.registerIdentity(w.address, id, 840);
      const ok = live.includes(w);
      await attest(kycIssuer, owner, id, undefined, ok ? 0 : now + 86400);
      if (!ok) continue;
      await vgt.mint(w.address, ethers.parseEther("1000"));
      await vgt.connect(w).approve(govAddr, ethers.MaxUint256);
    }
    await ethers.provider.send("evm_increaseTime", [86400 + 10]);
    await ethers.provider.send("evm_mine", []);

    expect(await idReg.registeredIdentityCount()).to.equal(10n);
    for (const w of lapsed)
      expect(await idReg.isVerified(w.address)).to.be.false;

    // SystemParameters (25% quorum, 65% approval); the call is a harmless view.
    const run = async (id: number, electorate: bigint) => {
      const call = gov.interface.encodeFunctionData("owner");
      await gov.connect(proposer).createProposal(4, "p", "d", govAddr, call);
      const [p] = await gov.getProposal(id);
      expect(p.eligibleVotersAtCreation).to.equal(electorate);
      await gov.connect(v1).castVote(id, true, "");
      await gov.connect(v2).castVote(id, true, "");
      for (const w of lapsed)
        await expect(gov.connect(w).castVote(id, true, "")).to.be.revertedWith(
          "Must be KYC/AML verified",
        );
      await ethers.provider.send("evm_increaseTime", [
        Number(p.executionTime - p.createdAt) + 5,
      ]);
      await ethers.provider.send("evm_mine", []);
      await gov.executeProposal(id);
      return (await gov.getProposal(id))[0].status;
    };

    // 2 of 10 = 20% < 25%: the lapsed identities hold the bar out of reach.
    expect(await run(1, 10n)).to.equal(REJECTED);

    for (const w of lapsed) await idReg.deleteIdentity(w.address);
    expect(await idReg.registeredIdentityCount()).to.equal(3n);
    // 2 of 3 clears quorum and approval.
    // The denominator is the count at the voter-age cutoff (D25), so a
    // deletion lowers it for proposals created minVoterAge later.
    await ageVoters(gov);
    expect(await run(2, 3n)).to.equal(EXECUTED);
  });
});
