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
} from "../../scripts/production/postCeremonyVotes";

const Votes = require("../../demo/utils/HandoverVotes");
const { withDerivedContracts } = require("../../demo/utils/HandoverDerive");

/**
 * Task 5.15 (owner Q15 = A, D50 / R-56-2; Q20 = B): just after the
 * ceremony one parallel vote registers the production nodes, re-approves
 * the issuer keys the deployer trusted, and removes the deployer-era
 * nodes after the registrations; the day-2 audit then shows neither.
 * Refused before any proposal: an unfinished ceremony, a new node that is
 * a role or a voter, and a rotation that would leave fewer than
 * MIN_NODES nodes or one alone at the bar.
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
  let Ax: bigint;
  let Ay: bigint;
  const signer = async (i: number) => (await ethers.getSigners())[i];

  beforeEach(async function () {
    f = await handoverFixture();
    ({ cfg, cfgPath, dir } = await cliConfig(f));
    out.length = 0;
    // The deployer era: three nodes and one issuer key, the deployer's own.
    const om = f.c.oracleManager.connect(f.deployer);
    for (const i of [9, 10, 11])
      await om.registerOracle(
        (await signer(i)).address,
        `DEP_${i}`,
        "deployer era",
        500,
      );
    const {
      attestorPublicKey,
      newAttestorKey,
    } = require("../../scripts/zk/attest");
    ({ Ax, Ay } = await attestorPublicKey(newAttestorKey()));
    await f.c.privacyManager
      .connect(f.deployer)
      .setTrustedAttestor(JUR, Ax, Ay, true);
    cfg.oracleNodes = await Promise.all(
      [9, 10, 11].map(async (i) => (await signer(i)).address),
    );
    cfg.attestors = [Ax.toString()];
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  const items = async (nodes: string) => {
    const { args, wallet } = await handoverArgs(cfg, "audit", cfgPath);
    const o = await withDerivedContracts(args);
    const voters = [cfg.proposer, ...cfg.voters].map(wallet);
    return {
      o,
      list: await postCeremonyItems(o, parseNodes(nodes), cfg, voters),
      voters,
    };
  };
  const NEW = async () =>
    (await Promise.all([13, 14, 15].map(signer)))
      .map((s, k) => `${s.address}:NODE_${k + 1}`)
      .join(",");

  it("refuses before the ceremony completed", async function () {
    await expect(items(await NEW())).to.be.rejectedWith(
      /finish the ceremony first/,
    );
  });

  it("refuses a new node that is a voter or a role, and a rotation leaving too few nodes", async function () {
    await captured(out, () => runHandover(cfg, "full", cfgPath));
    const made = await f.c.governance.proposalCount();
    const voter = (await signer(cfg.voters[0])).address;
    await expect(items(`${voter}:V`)).to.be.rejectedWith(
      /a node is a key of its own/,
    );
    await expect(items(`${f.ops.address}:OPS`)).to.be.rejectedWith(
      /a node is a key of its own/,
    );
    await expect(items("")).to.be.rejectedWith(
      /0 node\(s\) would remain, below MIN_NODES \(2\)/,
    );
    await expect(items(`${(await signer(13)).address}:ONE`)).to.be.rejectedWith(
      /1 node\(s\) would remain, below MIN_NODES/,
    );
    expect(await f.c.governance.proposalCount()).to.equal(made);
  });

  it("registers, re-approves and removes in one vote; the audit then shows no deployer era", async function () {
    await captured(out, () => runHandover(cfg, "full", cfgPath));
    const before = Number(await f.c.governance.proposalCount());
    const { o, list } = await items(await NEW());
    expect(list.map((i: any) => i.label.split(" ")[0])).to.deep.equal([
      "register",
      "register",
      "register",
      "re-approve",
      "remove",
      "remove",
      "remove",
    ]);
    await captured(out, () =>
      Votes.voteAll({
        governance: o.governance,
        proposer: f.proposer,
        voters: f.voters,
        items: list,
        log: console.log,
      }),
    );
    expect(out.join("\n")).to.contain("🗳️  7 proposal(s) open at once");
    const ps = [];
    for (
      let id = before + 1;
      id <= Number(await f.c.governance.proposalCount());
      id++
    )
      ps.push((await f.c.governance.getProposal(id))[0]);
    expect(ps.length).to.equal(7);
    expect(Math.max(...ps.map((p: any) => Number(p.createdAt)))).to.be.lessThan(
      Math.min(...ps.map((p: any) => Number(p.votingEnds))),
    );
    for (const p of ps) expect(Number(p.status), p.title).to.equal(4);
    // Registrations executed before any removal (settled in order).
    const executed = await f.c.governance.queryFilter(
      f.c.governance.filters.ProposalExecuted(),
    );
    const order = executed
      .map((e: any) => Number(e.args[0]))
      .filter((id: number) => id > before);
    expect(order).to.deep.equal(ps.map((p: any) => Number(p.id)));
    const live = await f.c.oracleManager.getRegisteredOracles();
    expect([...live].sort()).to.deep.equal(
      (
        await Promise.all(
          [13, 14, 15].map(async (i) => (await signer(i)).address),
        )
      ).sort(),
    );
    // Nothing left to vote; the audit shows neither deployer-era line.
    expect((await items("")).list).to.deep.equal([]);
    cfg.oracleNodes = [...live];
    out.length = 0;
    await captured(out, () => runHandover(cfg, "audit", cfgPath));
    const text = out.join("\n");
    expect(text).to.not.include("was registered by the deployer");
    expect(text).to.not.include("was trusted by the deployer");
    expect(out).to.include(PASSED);
    expect(
      await f.c.privacyManager.trustedAttestor(
        JUR,
        ethers.keccak256(
          ethers.AbiCoder.defaultAbiCoder().encode(
            ["uint256", "uint256"],
            [Ax, Ay],
          ),
        ),
      ),
    ).to.equal(true);
  });
});
