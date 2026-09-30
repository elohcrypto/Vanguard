import { expect } from "chai";
import { ethers, network } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import { handoverFixture } from "../helpers/governanceFixture";

// Plan 2F.1 (M1, L5). Review probes probe-b P2 / probe-b2 (a stranger
// under-gasses executeProposal so a PASSED proposal settles Rejected) and
// probe-b4 (a passed VGT transfer drains other proposals' deposits).
const RULES = 1; // ProposalType.ComplianceRules
const LIST = 6; // ProposalType.ListUpdate
const IRP = 7; // ProposalType.IdentityRegistryParameters
const GTP = 8; // ProposalType.GovernanceTokenParameters
const ACTIVE = 1n,
  REJECTED = 3n,
  EXECUTED = 4n;

async function setup() {
  const f = await handoverFixture();
  const { c, proposer, voters } = f;
  const gov = c.governance;
  for (const s of [proposer, ...voters])
    await c.governanceToken.connect(s).approve(f.govAddr, ethers.MaxUint256);
  const propose = async (type: number, target: any, data: string) => {
    await gov
      .connect(proposer)
      .createProposal(type, "t", "", await target.getAddress(), data);
    return gov.proposalCount();
  };
  /** Propose, collect both votes, wait out voting and delay. */
  const passed = async (type: number, target: any, data: string) => {
    const id = await propose(type, target, data);
    for (const v of voters) await gov.connect(v).castVote(id, true, "");
    await time.increase(4 * 24 * 3600);
    return id;
  };
  const status = async (id: bigint) => (await gov.getProposal(id))[0].status;
  /** Governance takes ownership of `target` by an acceptOwnership vote. */
  const handTo = async (type: number, target: any) => {
    await target.transferOwnership(f.govAddr);
    const id = await passed(
      type,
      target,
      target.interface.encodeFunctionData("acceptOwnership"),
    );
    await gov.executeProposal(id);
    expect(await target.owner()).to.equal(f.govAddr);
  };
  return { ...f, gov, propose, passed, status, handTo };
}

describe("Execution gas floor (M1)", function () {
  async function heavyProposal() {
    const s = await setup();
    const ir = s.c.identityRegistry;
    await s.handTo(IRP, ir);
    // A normal onboarding batch: 20 new wallets, 20 distinct identities.
    const n = 20;
    const ws = Array.from(
      { length: n },
      () => ethers.Wallet.createRandom().address,
    );
    const ids = Array.from(
      { length: n },
      () => ethers.Wallet.createRandom().address,
    );
    const data = ir.interface.encodeFunctionData("batchRegisterIdentity", [
      ws,
      ids,
      ws.map(() => 840),
    ]);
    const id = await s.passed(IRP, ir, data);
    expect((await s.gov.getProposal(id))[3]).to.equal(true); // canExecute
    return { ...s, ir, ws, id };
  }

  it("P2: no gas limit settles a passed proposal as Rejected; it stays Active", async function () {
    const { gov, stranger, id, status } = await heavyProposal();
    for (let g = 200_000; g <= 3_000_000; g += 100_000) {
      const snap = await network.provider.send("evm_snapshot");
      try {
        await (
          await gov.connect(stranger).executeProposal(id, { gasLimit: g })
        ).wait();
      } catch {
        // an out-of-gas or floor revert is the safe outcome
      }
      const st = await status(id);
      await network.provider.send("evm_revert", [snap]);
      expect(st, `gasLimit ${g}`).to.equal(ACTIVE);
    }
    expect(await gov.MIN_EXECUTION_GAS()).to.equal(3_000_000n);
    await expect(
      gov.connect(stranger).executeProposal(id, { gasLimit: 2_900_000 }),
    ).to.be.revertedWith("Insufficient gas for execution");
    expect(await status(id)).to.equal(ACTIVE);
  });

  it("estimateGas covers the floor, and the estimated call executes", async function () {
    const { gov, stranger, ir, ws, id, status } = await heavyProposal();
    const est = await gov.connect(stranger).executeProposal.estimateGas(id);
    expect(est).to.be.greaterThanOrEqual(3_000_000n);
    await gov.connect(stranger).executeProposal(id, { gasLimit: est });
    expect(await status(id)).to.equal(EXECUTED);
    expect(await ir.identity(ws[19])).to.not.equal(ethers.ZeroAddress);
  });

  it("a genuine target revert with ample gas still settles Rejected", async function () {
    const s = await setup();
    const ir = s.c.identityRegistry;
    await s.handTo(IRP, ir);
    // The proposer is already registered: the target call reverts.
    const data = ir.interface.encodeFunctionData("registerIdentity", [
      s.proposer.address,
      ethers.Wallet.createRandom().address,
      840,
    ]);
    const id = await s.passed(IRP, ir, data);
    await expect(s.gov.executeProposal(id)).to.emit(
      s.gov,
      "ProposalExecutionFailed",
    );
    expect(await s.status(id)).to.equal(REJECTED);
    await expect(s.gov.executeProposal(id)).to.be.revertedWith(
      "Proposal not active",
    );
  });
});

describe("Selector denylist (L5)", function () {
  it("probe-b4: a VGT transfer of governance's deposits is refused at creation", async function () {
    const { c, gov, propose, proposer, govAddr } = await setup();
    const vgt = c.governanceToken;
    const bal = await vgt.balanceOf(govAddr);
    const drain = vgt.interface.encodeFunctionData("transfer", [
      proposer.address,
      bal,
    ]);
    await expect(propose(GTP, vgt, drain)).to.be.revertedWith(
      "Selector not allowed",
    );
    for (const data of [
      vgt.interface.encodeFunctionData("approve", [proposer.address, 1n]),
      vgt.interface.encodeFunctionData("transferFrom", [
        govAddr,
        proposer.address,
        1n,
      ]),
      vgt.interface.encodeFunctionData("renounceOwnership"),
    ])
      await expect(propose(GTP, vgt, data)).to.be.revertedWith(
        "Selector not allowed",
      );
    expect(await gov.proposalCount()).to.equal(0n);
  });

  it("refuses renounceOwnership on every bound type and calldata under 4 bytes", async function () {
    const { c, propose } = await setup();
    const renounce =
      c.complianceRules.interface.encodeFunctionData("renounceOwnership");
    await expect(
      propose(RULES, c.complianceRules, renounce),
    ).to.be.revertedWith("Selector not allowed");
    await expect(propose(IRP, c.identityRegistry, renounce)).to.be.revertedWith(
      "Selector not allowed",
    );
    for (const data of ["0x", "0x123456"])
      await expect(propose(RULES, c.complianceRules, data)).to.be.revertedWith(
        "Selector not allowed",
      );
  });

  it("keeps transferOwnership and acceptOwnership proposable (ceremony, migration)", async function () {
    const { c, propose, ops } = await setup();
    const ir = c.identityRegistry;
    await propose(IRP, ir, ir.interface.encodeFunctionData("acceptOwnership"));
    await propose(
      IRP,
      ir,
      ir.interface.encodeFunctionData("transferOwnership", [ops.address]),
    );
  });

  it("a legitimate GovernanceTokenParameters action still passes (addAgent)", async function () {
    const { c, gov, passed, status, handTo, stranger } = await setup();
    const vgt = c.governanceToken;
    await handTo(GTP, vgt);
    const id = await passed(
      GTP,
      vgt,
      vgt.interface.encodeFunctionData("addAgent", [stranger.address]),
    );
    await gov.executeProposal(id);
    expect(await status(id)).to.equal(EXECUTED);
    expect(await vgt.isAgent(stranger.address)).to.equal(true);
  });

  it("ListUpdate accepts the four list writes and the ownership steps only", async function () {
    const { c, propose, stranger, ops } = await setup();
    const dlm = c.dynamicListManager;
    const who = stranger.address;
    const DAY = 86400;
    for (const data of [
      dlm.interface.encodeFunctionData("addToWhitelist", [who, 0, 1, DAY, "r"]),
      dlm.interface.encodeFunctionData("addToBlacklist", [who, 0, 1, DAY, "r"]),
      dlm.interface.encodeFunctionData("removeFromWhitelist", [who, 0, "r"]),
      dlm.interface.encodeFunctionData("removeFromBlacklist", [who, 0, "r"]),
      // The ceremony accepts the manager's ownership under ListUpdate.
      dlm.interface.encodeFunctionData("acceptOwnership"),
      dlm.interface.encodeFunctionData("transferOwnership", [ops.address]),
    ])
      await propose(LIST, dlm, data);
    for (const data of [
      dlm.interface.encodeFunctionData("setGovernanceContract", [ops.address]),
      dlm.interface.encodeFunctionData("setOracles", [who, who]),
      dlm.interface.encodeFunctionData("setProofExpiryDuration", [DAY]),
    ])
      await expect(propose(LIST, dlm, data)).to.be.revertedWith(
        "Selector not allowed",
      );
  });
});
