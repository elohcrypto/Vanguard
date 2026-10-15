import { expect } from "chai";
import { ethers } from "hardhat";
import { handoverFixture } from "../helpers/governanceFixture";
import { preflightOnly, runHandover } from "../../scripts/handover";

/**
 * Plan v2 Task 5.7: HANDOVER_PHASE=preflight runs the full phase's checks
 * up to the ceremony's first transaction and sends nothing. It passes
 * only when the run stops at its own refusal (PreflightStop, by class):
 * a refusal, an error dressed as the stop, or a run that never reached a
 * transaction is no pass.
 */
describe("Handover CLI preflight phase (Task 5.7)", function () {
  let f: Awaited<ReturnType<typeof handoverFixture>>;
  let cfg: Record<string, any>;
  let quiet: typeof console.log;
  let out: string[];

  beforeEach(async function () {
    f = await handoverFixture();
    const a = async (k: string) => f.c[k].getAddress();
    cfg = {
      governance: f.govAddr,
      escrowWalletFactory: await a("escrowWalletFactory"),
      onchainIDFactory: await a("onchainIDFactory"),
      privacyManager: await a("privacyManager"),
      zkVerifier: await a("zkVerifier"),
      fromBlock: f.args.fromBlock,
      logChunk: 100,
      feeWallets: [f.feeWallet.address],
      ops: 1,
      guardian: 2,
      issuerAdmin: 7,
      proposer: 4,
      voters: [5, 6],
    };
    out = [];
    quiet = console.log;
    console.log = (m: string) => void out.push(String(m));
  });
  afterEach(function () {
    console.log = quiet;
  });

  it("passes on a ready deploy and sends nothing", async function () {
    const nonce = await ethers.provider.getTransactionCount(f.deployer);
    await runHandover(cfg, "preflight", "handover.json");
    expect(out.join("\n")).to.include("✅ Preflight passed");
    expect(await ethers.provider.getTransactionCount(f.deployer)).to.equal(
      nonce,
    );
    expect(await f.c.token.owner()).to.equal(f.deployer.address);
    expect(await f.c.token.isAgent(f.ops.address)).to.equal(false);
  });

  it("a refusal is the verdict, not a pass", async function () {
    cfg.token = "0x000000000000000000000000000000000000dEaD";
    await expect(runHandover(cfg, "preflight", "h.json")).to.be.rejectedWith(
      /config "token" names 0x000000000000000000000000000000000000dEaD/,
    );
    expect(out.join("\n")).to.not.include("Preflight passed");
  });

  it("passes only at its own stop: no send, or a look-alike error, fails", async function () {
    const args = { deployer: f.deployer };
    await expect(preflightOnly(args, async () => undefined)).to.be.rejectedWith(
      "the deployer steps ended without a transaction",
    );
    await expect(
      preflightOnly(args, async () => {
        const e = new Error("stopped before the first transaction");
        e.name = "PreflightStop";
        throw e;
      }),
    ).to.be.rejectedWith("stopped before the first transaction");
    // The real stop: the deployer handed to the steps refuses to send.
    await preflightOnly(args, async (o: any) => {
      await o.deployer.sendTransaction({ to: f.ops.address });
    });
    expect(out.join("\n")).to.include("✅ Preflight passed");
    expect(out.filter((l) => l.includes("Preflight passed"))).to.have.length(1);
  });
});
