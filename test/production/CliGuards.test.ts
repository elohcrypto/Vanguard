import { expect } from "chai";
import { ethers, network } from "hardhat";
import { handoverFixture } from "../helpers/governanceFixture";
import { cliConfig, captured } from "../helpers/handoverCli";
import { runHandover } from "../../scripts/handover";
import { guardDeployer } from "../../scripts/production/cliGuards";

/**
 * Task 5.17 slice C (R-56-5 in the production CLIs): handover.ts's audit
 * phase, postCeremonyVotes, claimSigners and onboardVoters install
 * guardDeployer in main(), as demo/index.js does: once governance owns
 * VSC, a transaction from wallet 0 is refused at the provider; before,
 * it passes.
 */
describe("Production CLIs refuse the deployer key after the ceremony (R-56-5)", function () {
  this.timeout(600_000);
  it("passes the deployer before the ceremony and refuses it after", async function () {
    const f = await handoverFixture();
    const { cfg, cfgPath } = await cliConfig(f);
    const p: any = network.provider;
    const [request, send] = [p.request, p.send];
    const [deployer, other] = await ethers.getSigners();
    try {
      guardDeployer(deployer, f.c.governance);
      await (
        await deployer.sendTransaction({ to: other.address, value: 1 })
      ).wait();
      p.request = request;
      p.send = send;
      await captured([], () => runHandover(cfg, "full", cfgPath));
      guardDeployer(deployer, f.c.governance);
      await expect(
        deployer.sendTransaction({ to: other.address, value: 1 }),
      ).to.be.rejectedWith(
        "R-56-5: wallet 0 (the deployer) sends nothing after the ceremony",
      );
      await (
        await other.sendTransaction({ to: other.address, value: 1 })
      ).wait();
    } finally {
      p.request = request;
      p.send = send;
    }
  });
});
