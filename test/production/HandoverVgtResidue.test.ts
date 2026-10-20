import { expect } from "chai";
import { ethers } from "hardhat";
import { handoverFixture } from "../helpers/governanceFixture";

const {
  acceptAllByVote,
  assertHandoverComplete,
  handoverDeployerPowers,
} = require("../../demo/utils/Handover");

/**
 * Task 5.17 slice C (deep review L-2): the deployer's leftover VGT (it pays
 * proposal and voting deposits) is a residual warning in completion and
 * the audit, as its leftover VSC is.
 */
describe("Handover residue: the deployer's VGT (L-2)", function () {
  this.timeout(300_000);
  it("warns while the deployer holds VGT, with its share of the supply", async function () {
    const f = await handoverFixture();
    const report = await handoverDeployerPowers(f.args);
    await acceptAllByVote({
      governance: f.c.governance,
      contracts: f.c,
      proposer: f.proposer,
      voters: f.voters,
      registryProposals: report.registryProposals,
      log: () => {},
    });
    const vgt = f.c.governanceToken;
    const held = await vgt.balanceOf(f.deployer.address);
    expect(held).to.be.greaterThan(0n);
    const line = (w: string[]) =>
      w.find((x) => x.startsWith("deployer still holds "));
    const { warnings } = await assertHandoverComplete(f.args);
    expect(line(warnings)).to.match(
      new RegExp(
        `^deployer still holds ${ethers.formatEther(held).replace(".", "\\.")} VGT \\([0-9.]+% of the supply\\): it pays proposal and voting deposits; the deployer should have burned it before the ceremony \\(it sends nothing after it\\); the remaining path is ops \\(a VGT agent\\): burn\\(deployer, amount\\) or setAddressFrozen\\(deployer, true\\), and ops mints the treasury what it needs$`,
      ),
    );
    const audit = await assertHandoverComplete({ ...f.args, audit: true });
    expect(line(audit.warnings)).to.not.equal(undefined);
    // Task 5.16: the path the warning names holds: ops, a VGT agent after
    // the ceremony, burns the deployer's VGT (no forced transfer exists).
    await (
      await vgt
        .connect(f.ops)
        ["burn(address,uint256)"](f.deployer.address, held)
    ).wait();
    expect(await vgt.balanceOf(f.deployer.address)).to.equal(0n);
    const after = await assertHandoverComplete({ ...f.args, audit: true });
    expect(line(after.warnings)).to.equal(undefined);
  });
});
