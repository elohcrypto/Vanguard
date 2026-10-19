import { ethers } from "hardhat";
import { expect } from "chai";
import * as fs from "fs";
import { handoverFixture } from "../helpers/governanceFixture";
import { cliConfig } from "../helpers/handoverCli";
import { handoverArgs } from "../../scripts/handoverConfig";

/**
 * Task 5.17 slice C review L-3: handoverArgs accepted wallet 0, the
 * deployer, as a voter, so an accept-phase re-run after VSC's acceptance
 * could vote from it. It is refused as proposer or voter in every phase,
 * by index and by key (a keystore copied under a second name).
 */
describe("Handover config: the deployer never votes (L-3)", function () {
  it("refuses the deployer as proposer or voter, by index or by key", async function () {
    const f = await handoverFixture();
    const { cfg, cfgPath, dir } = await cliConfig(f);
    try {
      const byIndex =
        /wallet 0 is the deployer; it may not be the proposer or a voter/;
      for (const phase of ["full", "accept", "audit", "preflight"]) {
        const keep = cfg.voters;
        cfg.voters = [0, ...keep];
        await expect(handoverArgs(cfg, phase, cfgPath)).to.be.rejectedWith(
          byIndex,
        );
        cfg.voters = keep;
      }
      const keep = cfg.proposer;
      cfg.proposer = 0;
      await expect(handoverArgs(cfg, "full", cfgPath)).to.be.rejectedWith(
        byIndex,
      );
      cfg.proposer = keep;
      const real = ethers.getSigners;
      const list = await real();
      (ethers as any).getSigners = async () =>
        list.map((x, i) => (i === cfg.voters[0] ? list[0] : x));
      try {
        await expect(handoverArgs(cfg, "full", cfgPath)).to.be.rejectedWith(
          `wallet ${cfg.voters[0]} is the deployer ${f.deployer.address}; it may not be the proposer or a voter`,
        );
      } finally {
        (ethers as any).getSigners = real;
      }
      // Slice D review INFO-4: voter onboarding refuses it first too.
      const {
        onboardVoters,
      } = require("../../scripts/production/onboardVoters");
      const keepV = cfg.voters;
      cfg.voters = [0, ...keepV];
      await expect(
        onboardVoters({ complete: true }, cfg, () => {}),
      ).to.be.rejectedWith(byIndex);
      cfg.voters = keepV;
      // The config as written passes.
      await handoverArgs(cfg, "full", cfgPath);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
