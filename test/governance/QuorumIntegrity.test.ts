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
    const reg = await idReg.getAddress(); // the batch path must not bypass:
    await rules.setRuleAdministrator(reg, owner.address, true);
    await rules.setJurisdictionRule(reg, [840], [643]); // 643 blocked
    await idReg.setComplianceRules(
      await rules.getAddress(),
      await idReg.getAddress(),
    );

    await expect(
      idReg.registerIdentity(signers[1].address, await newId(signers[1]), 643),
    ).to.be.revertedWith("Country not allowed: Country is blocked");
    await expect(
      idReg.batchRegisterIdentity(
        [signers[2].address],
        [await newId(signers[2])],
        [643],
      ),
    ).to.be.revertedWith("Country not allowed: Country is blocked");
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

    const idReg = await (
      await ethers.getContractFactory("IdentityRegistry")
    ).deploy();
    const rules = await (
      await ethers.getContractFactory("ComplianceRules")
    ).deploy(owner.address, [840], []);
    const regAddr = await idReg.getAddress();
    const rulesAddr = await rules.getAddress();
    const vgt = await (
      await ethers.getContractFactory("GovernanceToken")
    ).deploy("VGT", "VGT", regAddr, rulesAddr);
    const vgtAddr = await vgt.getAddress();
    const gov = await (
      await ethers.getContractFactory("VanguardGovernance")
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
    await rules.addTrustedContract(vgtAddr, govAddr);
    const kycIssuer = await (
      await ethers.getContractFactory("ClaimIssuer")
    ).deploy(owner.address, "KYC", "d");
    await configureKyc(idReg, await kycIssuer.getAddress());

    const now = (await ethers.provider.getBlock("latest"))!.timestamp;
    for (const w of [...live, ...lapsed]) {
      const id = await (
        await (await ethers.getContractFactory("OnchainID")).deploy(w.address)
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
