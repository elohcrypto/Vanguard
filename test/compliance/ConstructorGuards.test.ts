import { expect } from "chai";
import { ethers } from "hardhat";

/**
 * Runtime proof that the constructor code-length guards actually fire.
 *
 * scripts/audit-setter-guards.js proves the require() text EXISTS. It cannot
 * prove the guard is reachable — a check placed after the cast, or inside a
 * branch that never runs, passes the static audit and protects nothing.
 *
 * For each contract: substitute an EOA for one dependency at a time and assert
 * deployment reverts. Then deploy with every dependency valid and assert it
 * succeeds, so a guard that rejects everything would also be caught.
 */
describe("Constructor guards — runtime behaviour", () => {
  /** A deployed contract usable wherever "some contract address" is needed. */
  async function anyContract(): Promise<string> {
    const c = await (
      await ethers.getContractFactory("AlwaysTrueVerifier")
    ).deploy();
    await c.waitForDeployment();
    return c.getAddress();
  }

  // Each entry: contract name, and a factory for a fully-valid argument list.
  // Only address arguments are probed; non-address args are left as given.
  const CASES: Array<{
    name: string;
    args: (ok: string, owner: string) => unknown[];
    /** indices of address args that carry a code-length guard */
    guarded: number[];
  }> = [
    { name: "PrivacyManager", args: (ok) => [ok, ok, ok], guarded: [0, 1, 2] },
    {
      name: "ComplianceValidator",
      args: (ok, owner) => [ok, ok, ok, owner],
      guarded: [0, 1, 2],
    },
    {
      name: "UTXOCompliance",
      args: (ok, owner) => [ok, ok, ok, owner],
      guarded: [0, 1, 2],
    },
    { name: "RefundManager", args: (ok) => [ok, ok], guarded: [0, 1] },
    // PaymentEscrow arg #1 (_paymentProtocol) is deliberately NOT guarded: it is
    // stored as a plain address and only ever compared against msg.sender for
    // access control, never called. An EOA there is a valid configuration.
    { name: "PaymentEscrow", args: (ok) => [ok, ok], guarded: [0] },
    {
      name: "AccreditationProofValidator",
      args: (ok) => [ok],
      guarded: [0],
    },
    {
      name: "BlacklistProofValidator",
      args: (ok) => [ok, ok],
      guarded: [0, 1],
    },
    {
      name: "ComplianceProofValidator",
      args: (ok) => [ok, ok],
      guarded: [0, 1],
    },
  ];

  for (const { name, args, guarded } of CASES) {
    describe(name, () => {
      it("deploys when every dependency is a contract", async () => {
        const [owner] = await ethers.getSigners();
        const ok = await anyContract();
        const factory = await ethers.getContractFactory(name);
        await expect(factory.deploy(...(args(ok, owner.address) as never[]))).to
          .not.be.reverted;
      });

      for (const idx of guarded) {
        it(`rejects an EOA in address argument #${idx}`, async () => {
          const [owner] = await ethers.getSigners();
          const ok = await anyContract();
          const factory = await ethers.getContractFactory(name);

          const bad = args(ok, owner.address);
          bad[idx] = owner.address; // an EOA: no code

          // Must revert. Asserting only that it reverts (not the exact string)
          // keeps this robust to message wording, while still proving the
          // guard is on the executed path.
          await expect(factory.deploy(...(bad as never[]))).to.be.reverted;
        });
      }
    });
  }
});
