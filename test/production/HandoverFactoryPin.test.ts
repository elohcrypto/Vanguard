import { expect } from "chai";
import { ethers, network } from "hardhat";
import { handoverFixture } from "../helpers/governanceFixture";

const {
  acceptAllByVote,
  assertHandoverComplete,
  handoverDeployerPowers,
} = require("../../demo/utils/Handover");

// Plan v2 Task 5.2 (N-1 / R-411-20): the ceremony pins the
// OnchainIDFactory's own runtime code, and reads its recoveryManager()
// only once the pin holds. The tamper keeps every getter honest (one byte
// of the CBOR metadata tail flipped), so only the pin can refuse it.
describe("Handover pins the OnchainIDFactory's code (Task 5.2)", function () {
  async function tamper(addr: string) {
    const code = ethers.getBytes(await ethers.provider.getCode(addr));
    code[code.length - 3] ^= 0xff;
    await network.provider.send("hardhat_setCode", [
      addr,
      ethers.hexlify(code),
    ]);
  }
  const refusal = (a: string) =>
    new RegExp(
      `OnchainIDFactory ${a} runtime code hash 0x[0-9a-f]{64} is not the compiled OnchainIDFactory \\(0x[0-9a-f]{64}\\)`,
    );

  it("preflight refuses a tampered factory by name; the deployer sent nothing", async function () {
    const f = await handoverFixture();
    const fac = await f.c.onchainIDFactory.getAddress();
    await tamper(fac);
    const nonce = await ethers.provider.getTransactionCount(f.deployer.address);
    await expect(handoverDeployerPowers(f.args)).to.be.rejectedWith(
      refusal(fac),
    );
    expect(
      await ethers.provider.getTransactionCount(f.deployer.address),
    ).to.equal(nonce);
  });

  it("completion names the factory pin and fails once the code is tampered", async function () {
    const f = await handoverFixture();
    const { c, args } = f;
    const report = await handoverDeployerPowers(args);
    await acceptAllByVote({
      governance: c.governance,
      contracts: c,
      proposer: f.proposer,
      voters: f.voters,
      registryProposals: report.registryProposals,
      log: () => {},
    });
    const fac = await c.onchainIDFactory.getAddress();
    const line = `OnchainIDFactory ${fac} code matches the compiled OnchainIDFactory`;
    const before = await assertHandoverComplete(args);
    expect(before.failures).to.deep.equal([]);
    expect(before.checks.map((x: any) => x.label)).to.include(line);
    await tamper(fac);
    const after = await assertHandoverComplete(args);
    expect(after.failures).to.include(line);
    expect(after.failures.join("\n")).to.match(refusal(fac));
    expect(after.failures.join("\n")).to.include(
      "its recoveryManager() is not read",
    );
  });
});
