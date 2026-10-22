// Review D-9 (ported from the reviewer's P-D-9.test.ts): "Executed"
// implies the call succeeded, and round 1 of the post-ceremony votes now
// reads each item's effect back from the chain, as round 2 does, so a
// proposal settled without its effect (executed by someone else, undone
// since) stops the run naming the item.
import { expect } from "chai";
import * as fs from "fs";
import { ethers } from "hardhat";
import { handoverFixture } from "../helpers/governanceFixture";
import { byVote, captured, cliConfig } from "../helpers/handoverCli";
import { runHandover } from "../../scripts/handover";
import { handoverArgs } from "../../scripts/handoverConfig";
import {
  parseNodes,
  runPostCeremony,
} from "../../scripts/production/postCeremonyVotes";

const Votes = require("../../demo/utils/HandoverVotes");
const { withDerivedContracts } = require("../../demo/utils/HandoverDerive");
const {
  attestorPublicKey,
  newAttestorKey,
} = require("../../scripts/zk/attest");
const JUR = ethers.id("JURISDICTION_PROOF");

describe("D-9 round-1 post-ceremony items are read back from chain", function () {
  this.timeout(600000);
  let f: Awaited<ReturnType<typeof handoverFixture>>;
  let cfg: Record<string, any>;
  let cfgPath: string;
  let dir: string;
  const signer = async (i: number) => (await ethers.getSigners())[i];
  const addrs = async (is: number[]) =>
    Promise.all(is.map(async (i) => (await signer(i)).address));

  before(async function () {
    f = await handoverFixture();
    ({ cfg, cfgPath, dir } = await cliConfig(f));
    const om = f.c.oracleManager.connect(f.deployer);
    for (const a of await addrs([9, 10, 11]))
      await om.registerOracle(a, `DEP_${a.slice(2, 6)}`, "deployer era", 500);
    const { Ax, Ay } = await attestorPublicKey(newAttestorKey());
    await f.c.privacyManager
      .connect(f.deployer)
      .setTrustedAttestor(JUR, Ax, Ay, true);
    cfg.oracleNodes = await addrs([9, 10, 11]);
    cfg.attestors = [Ax.toString()];
    await captured([], () => runHandover(cfg, "full", cfgPath));
  });
  after(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("a reverting passed call settles Rejected and the settle step throws; a good one is Executed with its effect on chain", async function () {
    const pm = f.c.privacyManager;
    const g = f.c.governance;
    expect(await pm.owner()).to.equal(f.govAddr);
    // setTrustedAttestor reverts InvalidAttestorKey: (1, 1) is not on Baby Jubjub
    const bad = pm.interface.encodeFunctionData("setTrustedAttestor", [
      JUR,
      1n,
      1n,
      true,
    ]);
    const before = Number(await g.proposalCount());
    const err: any = await byVote(f, 11, pm, bad).catch((e) => e);
    const failed = await g.queryFilter(
      g.filters.ProposalExecutionFailed(before + 1),
    );
    expect(err.code).to.equal("NOT_EXECUTED");
    expect(err.message).to.match(/settled as Rejected, not Executed/);
    expect(failed.length).to.equal(1);
    const { Ax, Ay } = await attestorPublicKey(newAttestorKey());
    const id = await byVote(
      f,
      11,
      pm,
      pm.interface.encodeFunctionData("setTrustedAttestor", [
        JUR,
        Ax,
        Ay,
        true,
      ]),
    );
    const key = ethers.keccak256(
      ethers.AbiCoder.defaultAbiCoder().encode(
        ["uint256", "uint256"],
        [Ax, Ay],
      ),
    );
    expect(Number((await g.getProposal(id))[0].status)).to.equal(4);
    expect(await pm.trustedAttestor(JUR, key)).to.equal(true);
  });

  it("a round-1 item settled without its effect stops the run naming it", async function () {
    const { args, wallet } = await handoverArgs(cfg, "audit", cfgPath);
    const o = await withDerivedContracts(args);
    const nodes = parseNodes(
      (await addrs([13, 14, 15])).map((a, k) => `${a}:NODE_${k + 1}`).join(","),
    );
    const run = (out: string[]) =>
      captured(out, () =>
        runPostCeremony(
          o,
          wallet(cfg.proposer),
          cfg.voters.map(wallet),
          nodes,
          cfg,
        ),
      );
    const realSettle = Votes.settleProposal;
    try {
      // settled without executing: its effect is not on chain
      Votes.settleProposal = async () => {};
      const out: string[] = [];
      await expect(run(out)).to.be.rejectedWith(
        /is not a registered node after the vote/,
      );
      expect(out.join("\n")).to.not.match(/✅ register production node/);

      Votes.settleProposal = async (...a: any[]) =>
        /re-approve/.test(a[2]) ? undefined : realSettle(...a);
      const out2: string[] = [];
      await expect(run(out2)).to.be.rejectedWith(
        /issuer key .* is still the deployer's after the vote/,
      );
      expect(out2.join("\n")).to.match(/✅ register production node/);
      expect(out2.join("\n")).to.not.match(/✅ re-approve issuer key/);
    } finally {
      Votes.settleProposal = realSettle;
    }
  });
});
