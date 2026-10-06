import { expect } from "chai";
import { ethers, network } from "hardhat";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import { bindEngine } from "../helpers/oracles";

// Plan v2 Task 4.4 fix round (review M-1, L-1, L-3): a query snapshots the
// REGISTERED nodes (active or paused) with their weights and freezes its
// bar when it opens. Pausing can stop a query resolving, never ease it;
// only snapshot members vote; later weight, threshold or expiry changes
// leave an open query alone.

const WHITELIST = 1;

describe("Consensus snapshot: pausing never lowers the bar", function () {
  let owner: SignerWithAddress, ops: SignerWithAddress;
  let n1: SignerWithAddress, n2: SignerWithAddress, n3: SignerWithAddress;
  let n4: SignerWithAddress, subject: SignerWithAddress;
  let OM: any, CO: any;

  beforeEach(async function () {
    [owner, ops, n1, n2, n3, n4, subject] = await ethers.getSigners();
    OM = await (await ethers.getContractFactory("OracleManager")).deploy();
    CO = await bindEngine(OM);
    for (const n of [n1, n2, n3]) {
      await OM.registerOracle(n.address, "node", "", 500);
    }
    await OM.setOperator(ops.address);
  });

  const idOf = (rc: any) =>
    rc.logs
      .map((l: any) => CO.interface.parseLog(l))
      .find((e: any) => e?.name === "ConsensusQueryCreated").args[0];
  async function raise(by: SignerWithAddress = owner): Promise<string> {
    const tx = OM.connect(by).submitQuery(subject.address, WHITELIST, "0x");
    return idOf(await (await tx).wait());
  }
  const answer = (n: SignerWithAddress, q: string, v: boolean) =>
    OM.connect(n).submitResponse(q, v);
  const resolved = async (q: string) =>
    (await OM.getQueryResolution(q)).slice(0, 2);

  it("one node cannot resolve alone after the other two are paused", async function () {
    await OM.connect(ops).pauseOracle(n2.address);
    await OM.connect(ops).pauseOracle(n3.address);
    const q = await raise(n1);
    expect((await CO.getConsensusResult(q)).snapshotWeight).to.equal(300);
    await answer(n1, q, true);
    expect(await resolved(q)).to.deep.equal([false, false]);
  });

  it("with one node paused, two of three still resolve", async function () {
    await OM.connect(ops).pauseOracle(n3.address);
    const q = await raise(n1);
    await answer(n1, q, true);
    await answer(n2, q, true);
    expect(await resolved(q)).to.deep.equal([true, true]);
  });

  it("parking two nodes (penalizeOracle) does not lower the bar either", async function () {
    await OM.penalizeOracle(n2.address, 1000, "parked");
    await OM.penalizeOracle(n3.address, 1000, "parked");
    const q = await raise(n1);
    await answer(n1, q, true);
    expect(await resolved(q)).to.deep.equal([false, false]);
  });

  it("pausing two nodes after open does not let the third resolve alone", async function () {
    const q = await raise();
    await OM.connect(ops).pauseOracle(n2.address);
    await OM.connect(ops).pauseOracle(n3.address);
    await answer(n1, q, true);
    expect(await resolved(q)).to.deep.equal([false, false]);
  });

  it("a node paused at open and unpaused later votes with its snapshot weight", async function () {
    await OM.connect(ops).pauseOracle(n3.address);
    const q = await raise();
    expect((await CO.snapshotOf(q, n3.address)).weight).to.equal(100);
    await OM.connect(ops).unpauseOracle(n3.address);
    await answer(n1, q, true);
    await expect(answer(n3, q, true))
      .to.emit(CO, "ConsensusReached")
      .withArgs(q, true, 200, 0, 300, (t: bigint) => t > 0n);
  });

  it("a node registered after open is refused (NotInSnapshot)", async function () {
    const q = await raise();
    await OM.registerOracle(n4.address, "late", "", 500);
    expect((await CO.snapshotOf(q, n4.address)).weight).to.equal(0);
    await expect(answer(n4, q, true)).to.be.revertedWithCustomError(
      CO,
      "NotInSnapshot",
    );
  });

  it("weight, threshold and expiry changes do not touch an open query", async function () {
    const q = await raise();
    const before = await CO.getConsensusResult(q);
    await OM.setOracleWeight(n1.address, 1000);
    await OM.setConsensusThreshold(51);
    await OM.setQueryExpiryTime(10 * 60);
    expect((await CO.snapshotOf(q, n1.address)).bar).to.equal(300n * 66n);
    // n1 votes with its snapshot weight 100, against the frozen bar 19,800.
    await expect(answer(n1, q, true))
      .to.emit(CO, "ConsensusVoteSubmitted")
      .withArgs(q, n1.address, true, 100);
    expect(await resolved(q)).to.deep.equal([false, false]);
    expect((await CO.getConsensusResult(q)).expiresAt).to.equal(
      before.expiresAt,
    );
    // A query opened now uses the new parameters: 1000 of 1200 >= 51%.
    const later = await raise();
    await answer(n1, later, true);
    expect(await resolved(later)).to.deep.equal([true, true]);
  });

  it("NO resolves exactly at the bar", async function () {
    await OM.setOracleWeight(n1.address, 200);
    await OM.setConsensusThreshold(75);
    const q = await raise(); // snapshot 400, bar 30,000
    await answer(n1, q, false); // 20,000
    expect(await resolved(q)).to.deep.equal([false, false]);
    await answer(n2, q, false); // 30,000 == bar
    expect(await resolved(q)).to.deep.equal([true, false]);
  });

  it("the same query id twice in one block is refused (QueryExists)", async function () {
    await network.provider.send("evm_setAutomine", [false]);
    try {
      const args = [subject.address, WHITELIST, "0x"] as const;
      const t1 = await OM.submitQuery(...args, { gasLimit: 3_000_000 });
      const t2 = await OM.submitQuery(...args, { gasLimit: 3_000_000 });
      await network.provider.send("evm_mine");
      const r1 = await t1.wait();
      const r2 = await ethers.provider.getTransactionReceipt(t2.hash);
      expect([r2!.blockNumber, r2!.status]).to.deep.equal([r1.blockNumber, 0]);
      // The revert data of the mined failure names the engine's error.
      const trace = await network.provider.send("debug_traceTransaction", [
        t2.hash,
      ]);
      expect(CO.interface.parseError(trace.returnValue)?.name).to.equal(
        "QueryExists",
      );
    } finally {
      await network.provider.send("evm_setAutomine", [true]);
    }
  });

  it("no registered node: a query fails closed (NoRegisteredWeight)", async function () {
    const empty = await (
      await ethers.getContractFactory("OracleManager")
    ).deploy();
    const engine = await bindEngine(empty);
    await expect(
      empty.submitQuery(subject.address, WHITELIST, "0x"),
    ).to.be.revertedWithCustomError(engine, "NoRegisteredWeight");
  });
});
