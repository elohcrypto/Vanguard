import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import { handoverFixture } from "../helpers/governanceFixture";
import { deployCustody } from "../helpers/custody";

// Plan v2 Task 5.3: governance and custody guards no test reached before
// (4.17 had filed them "defensive"), each asserted by its reason.
describe("Governance and custody guards (Task 5.3)", function () {
  const Z = ethers.ZeroAddress;
  const LIST = 6; // ProposalType.ListUpdate

  it("a ListUpdate whose bound list manager has no code is refused", async function () {
    const f = await loadFixture(handoverFixture);
    const gov = f.c.governance;
    await f.c.governanceToken
      .connect(f.proposer)
      .approve(f.govAddr, ethers.MaxUint256);
    await gov.setDynamicListManager(f.stranger.address); // an EOA
    const data = f.c.dynamicListManager.interface.encodeFunctionData(
      "addToWhitelist",
      [f.stranger.address, 0, 1, 86400, "r"],
    );
    await expect(
      gov
        .connect(f.proposer)
        .createProposal(LIST, "t", "", f.stranger.address, data),
    ).to.be.revertedWith("List manager not bound to governance");
  });

  it("distributeGovernanceTokens refuses a zero recipient and a zero amount", async function () {
    const f = await loadFixture(handoverFixture);
    const vgt = f.c.governanceToken;
    await expect(vgt.distributeGovernanceTokens([Z], [1n])).to.be.revertedWith(
      "Invalid recipient",
    );
    await expect(
      vgt.distributeGovernanceTokens([f.proposer.address], [0n]),
    ).to.be.revertedWith("Amount must be greater than 0");
  });

  it("the VanguardGovernance constructor refuses a zero or codeless token or registry", async function () {
    const f = await loadFixture(handoverFixture);
    const F: any = await ethers.getContractFactory("VanguardGovernance");
    const c = f.c;
    const ok = [
      await c.governanceToken.getAddress(),
      await c.identityRegistry.getAddress(),
      await c.investorTypeRegistry.getAddress(),
      await c.complianceRules.getAddress(),
      await c.oracleManager.getAddress(),
      await c.token.getAddress(),
      1440,
    ];
    const eoa = f.stranger.address;
    const cases: [number, string, string][] = [
      [0, Z, "VanguardGovernance: Governance token is zero address"],
      [0, eoa, "VanguardGovernance: Governance token is not a contract"],
      [1, Z, "VanguardGovernance: Identity registry is zero address"],
      [1, eoa, "VanguardGovernance: Identity registry is not a contract"],
    ];
    for (const [i, bad, reason] of cases) {
      const a = [...ok];
      a[i] = bad;
      await expect(F.deploy(...a)).to.be.revertedWith(reason);
    }
  });

  describe("MultiSigWallet", function () {
    it("the constructor refuses zero parties or token and a bank that is the user", async function () {
      const f = await loadFixture(deployCustody);
      const F: any = await ethers.getContractFactory("MultiSigWallet");
      const [b, u, t] = [f.bank.address, f.user.address, f.token.target];
      for (const [a, reason] of [
        [[Z, u, t], "Invalid bank address"],
        [[b, Z, t], "Invalid user address"],
        [[b, u, Z], "Invalid token address"],
        [[u, u, t], "Bank and user must be different"],
      ] as [unknown[], string][])
        await expect(F.deploy(...a)).to.be.revertedWith(reason);
    });

    it("lockTokens refuses a zero amount", async function () {
      const f = await loadFixture(deployCustody);
      const w = await (
        await ethers.getContractFactory("MultiSigWallet")
      ).deploy(f.bank.address, f.user.address, f.token.target);
      await expect(w.connect(f.user).lockTokens(0n)).to.be.revertedWith(
        "Amount must be greater than 0",
      );
    });
  });
});
