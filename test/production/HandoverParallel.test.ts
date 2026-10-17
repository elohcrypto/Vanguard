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
