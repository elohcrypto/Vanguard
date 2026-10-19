import { expect } from "chai";
import { ethers } from "hardhat";
import * as fs from "fs";
import { handoverFixture } from "../helpers/governanceFixture";
import { byVote, captured, cliConfig } from "../helpers/handoverCli";
import { runHandover } from "../../scripts/handover";
import { handoverArgs } from "../../scripts/handoverConfig";
import {
  cancelHazards,
  parseNodes,
  requireSameChain,
  roundOneItems,
  roundTwoItems,
  runPostCeremony,
} from "../../scripts/production/postCeremonyVotes";

const Votes = require("../../demo/utils/HandoverVotes");
const { withDerivedContracts } = require("../../demo/utils/HandoverDerive");

/**
 * Task 5.15 (owner Q15 = A, D50 / R-56-2; Q20 = B; the lead's two-round
 * ruling): round 1 registers the production nodes and re-approves the
 * issuer keys the deployer trusted; round 2, proposed only once every
 * production node is registered on chain and only when every subset of
 * the removals leaves a valid node set, removes the deployer-era nodes
 * (anyone may execute a passed proposal, in any order). The phase is the
 * chain's; the day-2 audit then shows neither deployer-era line. Inputs
 * are refused before any proposal.
 */
describe("Post-ceremony votes (D50 rotation, attestor re-approval)", function () {
  this.timeout(600_000);
  let f: Awaited<ReturnType<typeof handoverFixture>>;
  let cfg: Record<string, any>;
  let cfgPath: string;
  let dir: string;
  const out: string[] = [];
  const PASSED = "\n✅ Audit passed: the deployer holds no power.";
  const JUR = ethers.id("JURISDICTION_PROOF");
  const realVote = Votes.castAcceptanceVotes;
  const signer = async (i: number) => (await ethers.getSigners())[i];
  const addrs = async (is: number[]) =>
    Promise.all(is.map(async (i) => (await signer(i)).address));

  beforeEach(async function () {
    f = await handoverFixture();
    ({ cfg, cfgPath, dir } = await cliConfig(f));
    out.length = 0;
    // The deployer era: three nodes and one issuer key, the deployer's own.
    const om = f.c.oracleManager.connect(f.deployer);
    for (const a of await addrs([9, 10, 11]))
      await om.registerOracle(a, `DEP_${a.slice(2, 6)}`, "deployer era", 500);
    const {
      attestorPublicKey,
      newAttestorKey,
    } = require("../../scripts/zk/attest");
    const { Ax, Ay } = await attestorPublicKey(newAttestorKey());
    await f.c.privacyManager
      .connect(f.deployer)
      .setTrustedAttestor(JUR, Ax, Ay, true);
    cfg.oracleNodes = await addrs([9, 10, 11]);
    cfg.attestors = [Ax.toString()];
  });
  afterEach(() => {
    Votes.castAcceptanceVotes = realVote;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const ceremony = () => captured(out, () => runHandover(cfg, "full", cfgPath));
  const derive = async () => {
    const { args, wallet } = await handoverArgs(cfg, "audit", cfgPath);
    const o = await withDerivedContracts(args);
    return { o, voters: [cfg.proposer, ...cfg.voters].map(wallet) };
  };
  const roundOne = async (nodes: string) => {
    const { o, voters } = await derive();
    return roundOneItems(o, parseNodes(nodes), cfg, voters);
  };
  const NEW = async () =>
    (await addrs([13, 14, 15])).map((a, k) => `${a}:NODE_${k + 1}`).join(",");
  const run = async (nodes: string) => {
    const { o } = await derive();
    return captured(out, () =>
      runPostCeremony(o, f.proposer, f.voters, parseNodes(nodes), cfg),
    );
  };
  /** Proposals since `from`, by title pattern. */
  const proposals = async (from: number, title: RegExp) => {
    const ps = [];
    for (
      let id = from + 1;
      id <= Number(await f.c.governance.proposalCount());
      id++
    ) {
      const [p] = await f.c.governance.getProposal(id);
      if (title.test(p.title)) ps.push(p);
    }
    return ps;
  };
  /** A stranger executes every removal proposal it can (anyone may). */
  const strangerExecutes = async () => {
    const stranger = await signer(18);
    let n = 0;
    for (const p of await proposals(0, /remove deployer-era/)) {
      const [, , , can] = await f.c.governance.getProposal(p.id);
      if (Number(p.status) === 1 && can) {
        await (
          await f.c.governance.connect(stranger).executeProposal(p.id)
        ).wait();
        n++;
      }
    }
    return n;
  };
  const executedIds = async (): Promise<number[]> =>
    (
      await f.c.governance.queryFilter(
        f.c.governance.filters.ProposalExecuted(),
      )
    ).map((e: any) => Number(e.args[0]));
  const titleOf = async (id: number): Promise<string> =>
    (await f.c.governance.getProposal(id))[0].title as string;
  const nodesNow = async () =>
    [...(await f.c.oracleManager.getRegisteredOracles())].sort();

  it("refuses malformed node lists", async function () {
    const [a, b] = await addrs([13, 14]);
    expect(() => parseNodes(`${a.toLowerCase()}:N`)).to.throw(/checksummed/);
    expect(() => parseNodes(`${a}`)).to.throw(/checksummed address>:<name>/);
    expect(() => parseNodes(`${ethers.ZeroAddress}:Z`)).to.throw(/zero/);
    expect(() => parseNodes(`${a}:N,${b}:M,${a}:O`)).to.throw(/twice/);
  });

  it("refuses a handover.json whose ceremony ran on another chain", async function () {
    expect(() => requireSameChain(cfgPath, 31337)).to.throw(
      /no ceremony snapshot/,
    );
    await ceremony();
    expect(() => requireSameChain(cfgPath, 31337)).to.not.throw();
    expect(() => requireSameChain(cfgPath, 11155111)).to.throw(
      /is for chain 31337, not the connected chain 11155111/,
    );
  });

  it("refuses before the ceremony, and a role, voter, claim signer or deployer-era node as new", async function () {
    await expect(roundOne(await NEW())).to.be.rejectedWith(
      /finish the ceremony first/,
    );
    await ceremony();
    const made = await f.c.governance.proposalCount();
    const [voter] = await addrs([cfg.voters[0]]);
    for (const bad of [
      voter,
      f.ops.address,
      f.issuerAdmin.address,
      f.proposer.address,
    ]) {
      await expect(roundOne(`${bad}:X`)).to.be.rejectedWith(
        /a node is a key of its own/,
      );
    }
    cfg.claimSigners = [(await signer(16)).address];
    await expect(roundOne(`${cfg.claimSigners[0]}:CS`)).to.be.rejectedWith(
      /a node is a key of its own/,
    );
    const [old] = await addrs([9]);
    await expect(roundOne(`${old}:OLD`)).to.be.rejectedWith(
      /already a node, not one a vote registered/,
    );
    await expect(roundOne("")).to.be.rejectedWith(
      /0 node\(s\) would remain, below MIN_NODES \(2\)/,
    );
    const [one] = await addrs([13]);
    await expect(roundOne(`${one}:ONE`)).to.be.rejectedWith(
      /1 node\(s\) would remain/,
    );
    expect(await f.c.governance.proposalCount()).to.equal(made);
  });

  it("round 1 registers and re-approves; round 2, after every node is in, removes; the audit then shows no deployer era", async function () {
    await ceremony();
    const before = Number(await f.c.governance.proposalCount());
    await run(await NEW());
    const text0 = out.join("\n");
    expect(text0).to.contain(
      "round 1: 4 proposal(s), registrations and re-approvals",
    );
    expect(text0).to.contain(
      "round 2: 3 removal(s), every production node registered",
    );
    const regs = await proposals(before, /register node/);
    const rms = await proposals(before, /remove deployer-era/);
    expect([regs.length, rms.length]).to.deep.equal([3, 3]);
    // Round 2 was proposed only after every registration executed.
    const g = f.c.governance;
    const at = async (filter: any, id: any) =>
      (await g.queryFilter(filter(id)))[0].blockNumber;
    const lastReg = Math.max(
      ...(await Promise.all(
        regs.map((p: any) => at(g.filters.ProposalExecuted, p.id)),
      )),
    );
    const firstRm = Math.min(
      ...(await Promise.all(
        rms.map((p: any) => at(g.filters.ProposalCreated, p.id)),
      )),
    );
    expect(firstRm).to.be.greaterThan(lastReg);
    for (const p of [...regs, ...rms]) {
      expect(Number((await g.getProposal(p.id))[0].status), p.title).to.equal(
        4,
      );
    }
    expect(await nodesNow()).to.deep.equal((await addrs([13, 14, 15])).sort());
    // A re-run finds nothing to vote; the audit passes clean.
    out.length = 0;
    await run(await NEW());
    expect(out.join("\n")).to.contain("nothing to vote");
    cfg.oracleNodes = await addrs([13, 14, 15]);
    out.length = 0;
    await captured(out, () => runHandover(cfg, "audit", cfgPath));
    const text = out.join("\n");
    expect(text).to.not.include("was registered by the deployer");
    expect(text).to.not.include("was trusted by the deployer");
    expect(out).to.include(PASSED);
  });

  it("a defeated registration: no removal is ever proposed, so none can be executed early; a re-run resumes", async function () {
    await ceremony();
    let n = 0;
    Votes.castAcceptanceVotes = async (...a: any[]) => {
      if (++n === 1) return; // nobody votes on the first registration
      return realVote(...a);
    };
    const err: any = await run(await NEW()).catch((e) => e);
    expect(err?.code).to.equal("NOT_PASSED");
    // A stranger finds no passed removal to execute: none exists.
    expect(await proposals(0, /remove deployer-era/)).to.deep.equal([]);
    expect(await strangerExecutes()).to.equal(0);
    expect(await nodesNow()).to.deep.equal((await addrs([9, 10, 11])).sort());
    // Round 2 is refused while a production node is missing.
    const { o } = await derive();
    await expect(roundTwoItems(o, parseNodes(await NEW()))).to.be.rejectedWith(
      /round 2 not proposed: production node\(s\) (0x[0-9a-fA-F]{40}(, )?){3} not registered on chain/,
    );
    // The re-run: round 1 again (the defeated one re-proposed), then round 2.
    Votes.castAcceptanceVotes = realVote;
    out.length = 0;
    await run(await NEW());
    expect(out.join("\n")).to.match(
      /is past its vote without passing: not adopted; settled as Rejected/,
    );
    expect(await nodesNow()).to.deep.equal((await addrs([13, 14, 15])).sort());
  });

  it("a run stopped in round 2 resumes by adopting the open removals", async function () {
    await ceremony();
    const realSettle = Votes.settleProposal;
    let removals = 0;
    Votes.settleProposal = async (...a: any[]) => {
      if (/remove deployer-era/.test(a[2]) && ++removals === 2)
        throw new Error("killed");
      return realSettle(...a);
    };
    try {
      const err: any = await run(await NEW()).catch((e) => e);
      expect(err?.message).to.match(/^killed; stopped here/);
    } finally {
      Votes.settleProposal = realSettle;
    }
    const before = (await proposals(0, /remove deployer-era/)).length;
    out.length = 0;
    await run(await NEW());
    expect(out.join("\n")).to.match(
      /remove deployer-era node .*: proposal #\d+ already open; adopted/,
    );
    expect((await proposals(0, /remove deployer-era/)).length).to.equal(before);
    expect(await nodesNow()).to.deep.equal((await addrs([13, 14, 15])).sort());
  });

  it("round 2 is refused when some order of the removals leaves a node alone at the bar", async function () {
    await ceremony();
    const { o, voters } = await derive();
    const one = await roundOneItems(o, parseNodes(await NEW()), cfg, voters);
    const args = {
      governance: o.governance,
      proposer: f.proposer,
      voters: f.voters,
      log: () => {},
    };
    await Votes.settleAll({
      ...args,
      open: await Votes.openAll({ ...args, items: one }),
    });
    // A deployer-era node made heavy by vote: 600 of 1,100 now (54%), but
    // with the other two removed first it would hold 600 of 900 (66.7%).
    const [heavy] = await addrs([9]);
    const om = f.c.oracleManager;
    await byVote(
      f,
      2,
      om,
      om.interface.encodeFunctionData("setOracleWeight", [heavy, 600]),
    );
    await expect(roundTwoItems(o, parseNodes(await NEW()))).to.be.rejectedWith(
      /round 2 not proposed: removing 0x[0-9a-fA-F]{40}, 0x[0-9a-fA-F]{40} 4 node\(s\) would remain, one alone at the 66% bar/,
    );
  });

  it("a removal is checked again just before this CLI executes it", async function () {
    await ceremony();
    const { o, voters } = await derive();
    const args = {
      governance: o.governance,
      proposer: f.proposer,
      voters: f.voters,
      log: () => {},
    };
    const one = await roundOneItems(o, parseNodes(await NEW()), cfg, voters);
    await Votes.settleAll({
      ...args,
      open: await Votes.openAll({ ...args, items: one }),
    });
    const open = await Votes.openAll({
      ...args,
      items: await roundTwoItems(o, parseNodes(await NEW())),
    });
    // Meanwhile two production nodes leave by other votes.
    const om = f.c.oracleManager;
    const [a, b, c] = await addrs([13, 14, 15]);
    for (const x of [a, b])
      await byVote(
        f,
        2,
        om,
        om.interface.encodeFunctionData("removeOracle", [x, "test"]),
      );
    const err: any = await Votes.settleAll({ ...args, open }).catch(
      (e: any) => e,
    );
    expect(err?.message).to.match(
      /removing 0x[0-9a-fA-F]{40} now: 1 node\(s\) would remain, below MIN_NODES \(2\); not executed; stopped here/,
    );
    const left = await nodesNow();
    expect(left.length).to.equal(2);
    expect(left).to.include(c);
  });

  it("a hazardous passed removal fails the audit and is cancelled by vote (review M-2)", async function () {
    await ceremony();
    const { o, voters } = await derive();
    const args = {
      governance: o.governance,
      proposer: f.proposer,
      voters: f.voters,
      log: () => {},
    };
    const one = await roundOneItems(o, parseNodes(await NEW()), cfg, voters);
    await Votes.settleAll({
      ...args,
      open: await Votes.openAll({ ...args, items: one }),
    });
    const open = await Votes.openAll({
      ...args,
      items: await roundTwoItems(o, parseNodes(await NEW())),
    });
    const om = f.c.oracleManager;
    for (const x of await addrs([13, 14]))
      await byVote(
        f,
        2,
        om,
        om.interface.encodeFunctionData("removeOracle", [x, "test"]),
      );
    await Votes.settleAll({ ...args, open }).catch(() => undefined);
    // (b) While a passed removal that would break the set is open, the
    // day-2 audit fails naming it.
    cfg.oracleNodes = [...(await om.getRegisteredOracles())];
    out.length = 0;
    await expect(
      captured(out, () => runHandover(cfg, "audit", cfgPath)),
    ).to.be.rejectedWith(/audit failed/);
    expect(out.join("\n")).to.match(
      /❌ no open governance proposal targets a plan contract/,
    );
    // (a) The hazard is printed and cancelled by a SystemParameters vote.
    const lines: string[] = [];
    const ids = await cancelHazards(
      o,
      f.proposer,
      f.voters,
      open,
      (m: string) => lines.push(m),
    );
    expect(ids.length).to.be.greaterThan(0);
    expect(lines.join("\n")).to.match(
      /STANDING HAZARD: proposal #\d+ \(a removal\)/,
    );
    for (const id of ids)
      expect(Number((await f.c.governance.getProposal(id))[0].status)).to.equal(
        5,
      );
    expect((await nodesNow()).length).to.be.at.least(2);
  });

  it("refuses round 2 for more than 12 deployer-era nodes (review I-4)", async function () {
    const om = f.c.oracleManager.connect(f.deployer);
    for (let i = 0; i < 10; i++)
      await om.registerOracle(
        ethers.Wallet.createRandom().address,
        `D${i}`,
        "d",
        500,
      );
    cfg.oracleNodes = [...(await f.c.oracleManager.getRegisteredOracles())];
    await ceremony();
    const { o } = await derive();
    await expect(roundTwoItems(o, [])).to.be.rejectedWith(
      /13 deployer-era nodes; more than 12 cannot be checked/,
    );
  });
});
