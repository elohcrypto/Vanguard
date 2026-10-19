import { expect } from "chai";
import { ethers } from "hardhat";
import * as fs from "fs";
import { handoverFixture } from "../helpers/governanceFixture";
import { cliConfig, captured } from "../helpers/handoverCli";
import { runHandover } from "../../scripts/handover";

const Votes = require("../../demo/utils/HandoverVotes");

/**
 * Task 5.15 (readiness review H-1, M-3; Q14 = A): the ceremony's
 * acceptance votes run in parallel (propose all, vote all, settle in
 * order), stop at the first that does not pass, and a re-run finishes the
 * rest without proposing or voting anything twice. The archive
 * requirement is checked before anything else.
 */
describe("Handover parallel acceptance (Q14 = A)", function () {
  this.timeout(600_000);
  let f: Awaited<ReturnType<typeof handoverFixture>>;
  let cfg: Record<string, any>;
  let cfgPath: string;
  const out: string[] = [];
  const realVote = Votes.castAcceptanceVotes;
  const realSettle = Votes.settleProposal;

  beforeEach(async function () {
    f = await handoverFixture();
    ({ cfg, cfgPath } = await cliConfig(f));
    out.length = 0;
  });
  afterEach(function () {
    Votes.castAcceptanceVotes = realVote;
    Votes.settleProposal = realSettle;
    delete process.env.HANDOVER_SNAPSHOT_SHA256;
  });
  const g = () => f.c.governance;
  const accepts = async () => {
    const ps = [];
    for (let id = 1; id <= Number(await g().proposalCount()); id++) {
      const [p] = await g().getProposal(id);
      if (p.title.startsWith("Accept ownership of")) ps.push(p);
    }
    return ps;
  };
  const executed = (ps: any[]) =>
    ps.filter((p: any) => Number(p.status) === 4).length;
  const useDigest = () =>
    (process.env.HANDOVER_SNAPSHOT_SHA256 = fs
      .readFileSync(`${cfgPath}.snapshot.json.sha256`, "utf8")
      .trim()
      .split(/\s+/)[0]);
  const text = () => out.join("\n");
  const adopted = () => (text().match(/already open; adopted/g) || []).length;

  it("proposes every acceptance before the first vote ends and settles them all", async function () {
    await captured(out, () => runHandover(cfg, "full", cfgPath));
    const ps = await accepts();
    expect(ps.length).to.be.at.least(5);
    const made = ps.map((p: any) => Number(p.createdAt));
    const ends = ps.map((p: any) => Number(p.votingEnds));
    // Every acceptance existed before any of their votes closed.
    expect(Math.max(...made)).to.be.lessThan(Math.min(...ends));
    expect(executed(ps)).to.equal(ps.length);
    expect(text()).to.match(
      new RegExp(`🗳️  ${ps.length} proposal\\(s\\) open at once`),
    );
    expect(text()).to.match(/⏱️  \d+ proposal\(s\) settled \d+ s of chain/);
    expect(text()).to.contain("Handover complete");
  });

  it("stops at the first acceptance that does not pass; a re-run finishes the rest", async function () {
    let third = 0;
    let n = 0;
    Votes.castAcceptanceVotes = async (gov: any, id: number, v: any[]) => {
      if (++n === 3) return void (third = id); // nobody votes on it
      return realVote(gov, id, v);
    };
    const err: any = await captured(out, () =>
      runHandover(cfg, "full", cfgPath),
    ).catch((e) => e);
    expect(err?.code).to.equal("NOT_PASSED");
    expect(err.message).to.match(
      /stopped here: proposals settled before it stay, a re-run finishes the rest \(\d+ left\)/,
    );
    const before = await accepts();
    expect(executed(before)).to.equal(2);

    Votes.castAcceptanceVotes = realVote;
    useDigest();
    out.length = 0;
    await captured(out, () => runHandover(cfg, "accept", cfgPath));
    expect(text()).to.match(
      new RegExp(
        `proposal #${third} \\(.*\\) is past its vote without passing: not adopted; settled as Rejected, a new one is proposed`,
      ),
    );
    expect(adopted()).to.equal(before.length - 3);
    const after = await accepts();
    expect(after.length).to.equal(before.length + 1);
    expect(executed(after)).to.equal(before.length);
    expect(text()).to.contain("Handover complete");
  });

  it("a run stopped mid-settlement resumes without a second proposal or vote", async function () {
    let n = 0;
    Votes.settleProposal = async (...a: any[]) => {
      if (++n === 2) throw new Error("killed");
      return realSettle(...a);
    };
    const err: any = await captured(out, () =>
      runHandover(cfg, "full", cfgPath),
    ).catch((e) => e);
    expect(err?.message).to.match(/^killed; stopped here/);
    const votes = async () =>
      (await accepts()).reduce(
        (v: number, p: any) => v + Number(p.votesFor),
        0,
      );
    const count = (await accepts()).length;
    const cast = await votes();
    Votes.settleProposal = realSettle;
    useDigest();
    out.length = 0;
    await captured(out, () => runHandover(cfg, "accept", cfgPath));
    expect((await accepts()).length).to.equal(count);
    expect(await votes()).to.equal(cast);
    expect(adopted()).to.equal(count - 1);
    expect(text()).to.contain("Handover complete");
  });

  it("a re-run inside the execution delay waits for passed proposals (review M-1)", async function () {
    Votes.settleProposal = async () => {
      throw new Error("killed");
    };
    const err: any = await captured(out, () =>
      runHandover(cfg, "full", cfgPath),
    ).catch((e) => e);
    expect(err?.message).to.match(/^killed; stopped here/);
    const ps = await accepts();
    // Into the window: every vote over, execution delays not all met.
    const ends = Math.max(...ps.map((p: any) => Number(p.votingEnds)));
    const now = (await ethers.provider.getBlock("latest"))!.timestamp;
    await ethers.provider.send("evm_increaseTime", [ends - now + 1]);
    await ethers.provider.send("evm_mine", []);
    const t = (await ethers.provider.getBlock("latest"))!.timestamp;
    const waiting = ps.filter((p: any) => t < Number(p.executionTime));
    expect(waiting.length).to.be.greaterThan(0);
    Votes.settleProposal = realSettle;
    useDigest();
    out.length = 0;
    await captured(out, () => runHandover(cfg, "accept", cfgPath));
    expect(adopted()).to.equal(ps.length);
    expect((await accepts()).length).to.equal(ps.length);
    expect(executed(await accepts())).to.equal(ps.length);
    expect(text()).to.contain("Handover complete");
  });

  it("a proposal a stranger executed first is done, not a failure (review L-4)", async function () {
    await captured(out, () => runHandover(cfg, "full", cfgPath));
    const gov = g();
    const data = gov.interface.encodeFunctionData("setVotingCost", [
      ethers.parseEther("11"),
    ]);
    const id = await Votes.proposeCall(gov, f.proposer, 4, gov, data, "t");
    await Votes.castAcceptanceVotes(gov, id, f.voters);
    const [p] = await gov.getProposal(id);
    const now = (await ethers.provider.getBlock("latest"))!.timestamp;
    await ethers.provider.send("evm_increaseTime", [
      Number(p.executionTime) - now + 1,
    ]);
    await ethers.provider.send("evm_mine", []);
    const stranger = (await ethers.getSigners())[18];
    await (await gov.connect(stranger).executeProposal(id)).wait();
    out.length = 0;
    const st = await captured(out, () =>
      Votes.settleProposal(gov.connect(f.proposer), id, "t"),
    );
    expect(st).to.equal(4);
    expect(text()).to.contain(
      `proposal #${id} already executed by ${stranger.address}`,
    );
  });

  it("a run stopped mid-vote resumes; no voter votes twice", async function () {
    let n = 0;
    Votes.castAcceptanceVotes = async (...a: any[]) => {
      if (++n === 3) throw new Error("killed");
      return realVote(...a);
    };
    const err: any = await captured(out, () =>
      runHandover(cfg, "full", cfgPath),
    ).catch((e) => e);
    expect(err?.message).to.equal("killed");
    const count = (await accepts()).length;
    Votes.castAcceptanceVotes = realVote;
    useDigest();
    out.length = 0;
    await captured(out, () => runHandover(cfg, "accept", cfgPath));
    expect(adopted()).to.equal(count);
    const ps = await accepts();
    expect(ps.length).to.equal(count);
    for (const p of ps) expect(Number(p.votesFor), p.title).to.equal(2);
    expect(text()).to.contain("Handover complete");
  });

  it("adopts only the same proposer's open proposal of the same call", async function () {
    await captured(out, () => runHandover(cfg, "full", cfgPath));
    const gov = g();
    const call = (vgt: number) =>
      gov.interface.encodeFunctionData("setVotingCost", [
        ethers.parseEther(String(vgt)),
      ]);
    const SYSTEM = 4;
    const mine = await Votes.proposeCall(
      gov,
      f.proposer,
      SYSTEM,
      gov,
      call(10),
      "t",
    );
    await Votes.proposeCall(gov, f.voters[0], SYSTEM, gov, call(12), "t");
    await Votes.proposeCall(gov, f.proposer, SYSTEM, gov, call(11), "t");
    const before = Number(await gov.proposalCount());
    out.length = 0;
    await captured(out, () =>
      Votes.voteAll({
        governance: gov,
        proposer: f.proposer,
        voters: f.voters,
        log: console.log,
        items: [
          {
            label: "same call",
            proposalType: SYSTEM,
            target: gov,
            callData: call(10),
          },
          {
            label: "another's call",
            proposalType: SYSTEM,
            target: gov,
            callData: call(12),
          },
        ],
      }),
    );
    expect(text()).to.contain(
      `same call: proposal #${mine} already open; adopted`,
    );
    expect(adopted()).to.equal(1);
    // A new proposal for the call only another proposer had made.
    expect(Number(await gov.proposalCount())).to.equal(before + 1);
    expect(await gov.votingCost()).to.equal(ethers.parseEther("12"));
  });

  it("refuses every phase up front on an RPC without historical state", async function () {
    const real = ethers.provider.getBalance.bind(ethers.provider);
    (ethers.provider as any).getBalance = async (a: any, tag?: any) => {
      if (tag !== undefined && tag !== "latest")
        throw new Error("missing trie node 0xabc (path ) <nil>");
      return real(a, tag);
    };
    try {
      for (const phase of ["full", "accept", "audit", "preflight"]) {
        const err: any = await captured(out, () =>
          runHandover(cfg, phase, cfgPath),
        ).catch((e) => e);
        expect(err?.message, phase).to.match(
          /the RPC cannot serve state at block \d+ \(not an archive node\).*use an archive RPC/,
        );
      }
    } finally {
      (ethers.provider as any).getBalance = real;
    }
    expect(await g().proposalCount()).to.equal(0n);
  });
});
