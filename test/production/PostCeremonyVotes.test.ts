import { expect } from "chai";
import { ethers } from "hardhat";
import * as fs from "fs";
import { handoverFixture } from "../helpers/governanceFixture";
import { captured, cliConfig } from "../helpers/handoverCli";
import { runHandover } from "../../scripts/handover";
import { handoverArgs } from "../../scripts/handoverConfig";
import {
  parseNodes,
  postCeremonyItems,
  requireSameChain,
  runPostCeremony,
} from "../../scripts/production/postCeremonyVotes";

const Votes = require("../../demo/utils/HandoverVotes");
const { withDerivedContracts } = require("../../demo/utils/HandoverDerive");

/**
 * Task 5.15 (owner Q15 = A, D50 / R-56-2; Q20 = B): just after the
 * ceremony the production nodes are registered, the issuer keys the
 * deployer trusted re-approved, and the deployer-era nodes removed, by
 * one voting period; the removals are proposed a gap later, settled after
 * every registration, and checked just before each executes. The day-2
 * audit then shows neither deployer-era line. Inputs are refused before
 * any proposal.
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
  const waves = async (nodes: string) => {
    const { o, voters } = await derive();
    return postCeremonyItems(o, parseNodes(nodes), cfg, voters);
  };
  const NEW = async () =>
    (await addrs([13, 14, 15])).map((a, k) => `${a}:NODE_${k + 1}`).join(",");
  const run = async (w: any) => {
    const { o } = await derive();
    return captured(out, () => runPostCeremony(o, f.proposer, f.voters, w));
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
    await expect(waves(await NEW())).to.be.rejectedWith(
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
      await expect(waves(`${bad}:X`)).to.be.rejectedWith(
        /a node is a key of its own/,
      );
    }
    cfg.claimSigners = [(await signer(16)).address];
    await expect(waves(`${cfg.claimSigners[0]}:CS`)).to.be.rejectedWith(
      /a node is a key of its own/,
    );
    const [old] = await addrs([9]);
    await expect(waves(`${old}:OLD`)).to.be.rejectedWith(
      /already a node, not one a vote registered/,
    );
    await expect(waves("")).to.be.rejectedWith(
      /0 node\(s\) would remain, below MIN_NODES \(2\)/,
    );
    const [one] = await addrs([13]);
    await expect(waves(`${one}:ONE`)).to.be.rejectedWith(
      /1 node\(s\) would remain/,
    );
    expect(await f.c.governance.proposalCount()).to.equal(made);
  });

  it("registers and re-approves, removes a gap later, settles in order; the audit then shows no deployer era", async function () {
    await ceremony();
    const before = Number(await f.c.governance.proposalCount());
    const w = await waves(await NEW());
    expect(w.wave1.map((i: any) => i.label.split(" ")[0])).to.deep.equal([
      "register",
      "register",
      "register",
      "re-approve",
    ]);
    expect(w.wave2.length).to.equal(3);
    await run(w);
    expect(out.join("\n")).to.contain(
      "🗳️  7 proposal(s) open together (4, then 3 removals)",
    );
    const ps = [];
    for (
      let id = before + 1;
      id <= Number(await f.c.governance.proposalCount());
      id++
    )
      ps.push((await f.c.governance.getProposal(id))[0]);
    expect(ps.length).to.equal(7);
    // Voted in one period: every proposal existed before any vote closed.
    expect(Math.max(...ps.map((p: any) => Number(p.createdAt)))).to.be.lessThan(
      Math.min(...ps.map((p: any) => Number(p.votingEnds))),
    );
    // Each removal matures a gap (an hour / TIME_SCALE, at least 60 s)
    // after every registration.
    const regs = ps.filter((p: any) => /register node/.test(p.title));
    const rms = ps.filter((p: any) => /remove deployer-era/.test(p.title));
    const gap = Math.max(
      60,
      Math.floor(3600 / Number(await f.c.governance.TIME_SCALE())),
    );
    expect(
      Math.min(...rms.map((p: any) => Number(p.executionTime))) -
        Math.max(...regs.map((p: any) => Number(p.executionTime))),
    ).to.be.at.least(gap);
    // Executed in order: registrations, re-approval, removals.
    const order = (await executedIds()).filter((id) => id > before);
    expect(order).to.deep.equal(ps.map((p: any) => Number(p.id)));
    expect(await nodesNow()).to.deep.equal((await addrs([13, 14, 15])).sort());
    // A re-run finds nothing to vote; the audit passes clean.
    const again = await waves(await NEW());
    expect([...again.wave1, ...again.wave2]).to.deep.equal([]);
    cfg.oracleNodes = await addrs([13, 14, 15]);
    out.length = 0;
    await captured(out, () => runHandover(cfg, "audit", cfgPath));
    const text = out.join("\n");
    expect(text).to.not.include("was registered by the deployer");
    expect(text).to.not.include("was trusted by the deployer");
    expect(out).to.include(PASSED);
  });

  it("a failed registration stops the run before any removal; a re-run resumes in order", async function () {
    await ceremony();
    const before = Number(await f.c.governance.proposalCount());
    let n = 0;
    Votes.castAcceptanceVotes = async (...a: any[]) => {
      if (++n === 1) return; // nobody votes on the first registration
      return realVote(...a);
    };
    const err: any = await run(await waves(await NEW())).catch((e) => e);
    expect(err?.code).to.equal("NOT_PASSED");
    expect(err.message).to.match(/stopped here/);
    expect(await nodesNow()).to.deep.equal((await addrs([9, 10, 11])).sort());
    Votes.castAcceptanceVotes = realVote;
    out.length = 0;
    await run(await waves(await NEW()));
    expect(out.join("\n")).to.match(
      /is past its vote without passing: not adopted; settled as Rejected/,
    );
    const ids = (await executedIds()).filter((id) => id > before);
    const titles = await Promise.all(ids.map(titleOf));
    const firstRemoval = titles.findIndex((t) => /remove deployer-era/.test(t));
    const lastRegistration = titles
      .map((t) => /register node/.test(t))
      .lastIndexOf(true);
    expect(firstRemoval).to.be.greaterThan(lastRegistration);
    expect(await nodesNow()).to.deep.equal((await addrs([13, 14, 15])).sort());
  });

  it("a removal is checked just before it executes, and not executed when it would leave too few nodes", async function () {
    await ceremony();
    const w = await waves(await NEW());
    // The registrations never run here: the removals meet three nodes.
    const err: any = await run({ wave1: [], wave2: w.wave2 }).catch((e) => e);
    expect(err?.message).to.match(
      /removing 0x[0-9a-fA-F]{40} now: 1 node\(s\) would remain, below MIN_NODES \(2\); not executed; stopped here/,
    );
    expect((await nodesNow()).length).to.equal(2);
  });
});
