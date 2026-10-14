import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import { T, deployCustody, setNormalCaps } from "../helpers/custody";

// Plan v2 Task 5.3: every InvestorRequestManager guard a caller can
// reach, each asserted by its reason (the manager's branch floor is 80).
describe("InvestorRequestManager guards (Task 5.3)", function () {
  const Z = ethers.ZeroAddress;
  const IRM = () => ethers.getContractFactory("InvestorRequestManager");

  it("the constructor refuses a zero bank, token or registry and a codeless registry", async function () {
    const f = await loadFixture(deployCustody);
    const F: any = await IRM();
    const eoa = f.stranger.address;
    const ok = [
      f.bank.address,
      f.token.target,
      f.types.target,
      f.registry.target,
    ];
    const cases: [number, string, string][] = [
      [0, Z, "Invalid bank address"],
      [1, Z, "Invalid token address"],
      [2, Z, "Invalid investor registry"],
      [2, eoa, "InvestorRequestManager: Investor registry is not a contract"],
      [3, Z, "Invalid identity registry"],
      [3, eoa, "InvestorRequestManager: Identity registry is not a contract"],
    ];
    for (const [i, bad, reason] of cases) {
      const a = [...ok];
      a[i] = bad;
      await expect(F.deploy(...a)).to.be.revertedWith(reason);
    }
  });

  it("a token with no code: the manager reads its own registry", async function () {
    const f = await loadFixture(deployCustody);
    const m = await (
      await IRM()
    ).deploy(
      f.bank.address,
      f.stranger.address,
      f.types.target,
      f.registry.target,
    );
    await m.connect(f.user).requestInvestorStatus(T.Retail);
    expect((await m.requests(f.user.address)).status).to.equal(1); // Pending
  });

  it("requestInvestorStatus refuses the Normal type", async function () {
    const f = await loadFixture(deployCustody);
    await expect(
      f.m.connect(f.user).requestInvestorStatus(T.Normal),
    ).to.be.revertedWith("Cannot request Normal type");
  });

  it("requestInvestorStatus refuses a type whose default lock rounds to zero", async function () {
    // Defaults are a quarter, a half and all of the Normal cap; a Normal
    // cap of 3 units leaves Retail's quarter at 0.
    const f = await loadFixture(deployCustody);
    await setNormalCaps(f.types, 3n, 3n);
    const m = await (
      await IRM()
    ).deploy(f.bank.address, f.token.target, f.types.target, f.registry.target);
    expect(await m.lockRequirements(T.Retail)).to.equal(0);
    await expect(
      m.connect(f.user).requestInvestorStatus(T.Retail),
    ).to.be.revertedWith("Lock requirement not set");
  });

  it("createMultiSigWallet refuses a user with no request", async function () {
    const f = await loadFixture(deployCustody);
    await expect(
      f.m.connect(f.bank).createMultiSigWallet(f.other.address),
    ).to.be.revertedWith("Invalid request status");
  });

  it("confirmTokensLocked refuses before the wallet exists", async function () {
    const f = await loadFixture(deployCustody);
    await f.m.connect(f.user).requestInvestorStatus(T.Retail);
    await expect(f.m.connect(f.user).confirmTokensLocked()).to.be.revertedWith(
      "Wallet not created yet",
    );
  });

  it("approveRequest refuses before the lock is confirmed", async function () {
    const f = await loadFixture(deployCustody);
    await f.m.connect(f.user).requestInvestorStatus(T.Retail);
    await expect(
      f.m.connect(f.bank).approveRequest(f.user.address),
    ).to.be.revertedWith("Tokens not locked");
  });

  it("rejectRequest needs a reason and an open request", async function () {
    const f = await loadFixture(deployCustody);
    await f.m.connect(f.user).requestInvestorStatus(T.Retail);
    await expect(
      f.m.connect(f.bank).rejectRequest(f.user.address, ""),
    ).to.be.revertedWith("Reason required");
    await expect(
      f.m.connect(f.bank).rejectRequest(f.other.address, "none open"),
    ).to.be.revertedWith("Cannot reject this request");
  });

  it("updateLockRequirement refuses the Normal type and a zero amount", async function () {
    const f = await loadFixture(deployCustody);
    await expect(f.m.updateLockRequirement(T.Normal, 1n)).to.be.revertedWith(
      "Cannot set for Normal type",
    );
    await expect(f.m.updateLockRequirement(T.Retail, 0n)).to.be.revertedWith(
      "Amount must be greater than 0",
    );
  });

  it("getRequestByIndex reads a request and refuses past the end", async function () {
    const f = await loadFixture(deployCustody);
    await f.m.connect(f.user).requestInvestorStatus(T.Retail);
    expect(await f.m.getRequestByIndex(0)).to.equal(f.user.address);
    await expect(f.m.getRequestByIndex(1)).to.be.revertedWith(
      "Index out of bounds",
    );
  });
});
