// D2-2: a verifier swapped and swapped back before the ceremony leaves
// forged PrivacyManager bindings; the preflight, completion and the day-2
// audit scan VerifierUpdated, name the swap block and fail until ops
// republishes the root, which lapses every binding made under the swapped
// verifier. Round 2: the preflight refuses, while the remedy (ops, which
// the deployer can name list operator early, republishes) is cheap.
import { expect } from "chai";
import { ethers } from "hardhat";
import { handoverFixture } from "../helpers/governanceFixture";
import { runHandover } from "../../scripts/handover";
import { handoverArgs } from "../../scripts/handoverConfig";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const { assertHandoverComplete } = require("../../demo/utils/Handover");

describe("D2-2 verifier swap residue", function () {
  this.timeout(600000);
  it("the preflight refuses the swap until ops republishes the root; then the ceremony and the audit pass", async function () {
    const f = await handoverFixture();
    const d = f.deployer;
    const pm = f.c.privacyManager;
    const zk = f.c.zkVerifier;
    const w = f.stranger; // a wallet with no membership proof at all
    // Before the ceremony, as the deploy leaves it: ops publishes the root.
    await (await pm.connect(d).setListOperator(f.ops.address)).wait();
    const root = 12345n;
    await (
      await pm.connect(f.ops).publishWhitelistRoot(ethers.toBeHex(root, 32))
    ).wait();
    // The deployer swaps the whitelist verifier, forges a binding, restores it.
    const original = await zk.whitelistVerifier();
    const rogue = await (
      await ethers.getContractFactory("AlwaysTrueVerifier")
    )
      .connect(d)
      .deploy();
    const rogueAddr = await rogue.getAddress();
    const swap = await (
      await zk.connect(d).updateVerifier("whitelist", rogueAddr)
    ).wait();
    const garbage = Array.from({ length: 24 }, (_, i) => BigInt(i + 1));
    const signals = [777n, root, BigInt(w.address)];
    await (await pm.connect(w).submitWhitelistProof(garbage, signals)).wait();
    const restore = await (
      await zk.connect(d).updateVerifier("whitelist", original)
    ).wait();
    console.log(
      `      verifier restored: ${(await zk.whitelistVerifier()) === original}; the same proof now verifies: ${await zk.verifyWhitelistMembership.staticCall(garbage, signals)}`,
    );

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "d2-2-"));
    const cfgPath = path.join(dir, "handover.json");
    const a = async (k: string) => f.c[k].getAddress();
    const cfg: any = {
      token: await a("token"),
      governanceToken: await a("governanceToken"),
      identityRegistry: await a("identityRegistry"),
      complianceRules: await a("complianceRules"),
      oracleManager: await a("oracleManager"),
      governance: f.govAddr,
      investorTypeRegistry: await a("investorTypeRegistry"),
      dynamicListManager: await a("dynamicListManager"),
      escrowWalletFactory: await a("escrowWalletFactory"),
      onchainIDFactory: await a("onchainIDFactory"),
      privacyManager: await a("privacyManager"),
      zkVerifier: await a("zkVerifier"),
      oracles: [await f.args.oracles[0].getAddress()],
      issuers: [await f.args.issuers[0].getAddress()],
      fromBlock: f.args.fromBlock,
      logChunk: 100,
      feeWallets: [f.feeWallet.address],
      ops: 1,
      guardian: 2,
      issuerAdmin: 7,
      proposer: 4,
      voters: [5, 6],
    };
    const quiet = console.log;
    const out: string[] = [];
    console.log = (...m: any[]) => out.push(m.join(" "));
    const run = async (phase: string) => {
      out.length = 0;
      return runHandover(cfg, phase, cfgPath).then(
        () => "ok",
        (e: any) => e.message,
      );
    };
    const n0 = await ethers.provider.getTransactionCount(d.address);
    let pre = "ok";
    let full = "ok";
    let fullOut: string[] = [];
    let after = "ok";
    let afterOut: string[] = [];
    let audit = "ok";
    let checks: any[] = [];
    let sent = -1;
    try {
      pre = await run("preflight");
      full = await run("full");
      fullOut = [...out];
      sent = (await ethers.provider.getTransactionCount(d.address)) - n0;
      const { args } = await handoverArgs(cfg, "audit", cfgPath);
      checks = (await assertHandoverComplete({ ...args, audit: true })).checks;
      // The remedy, before the ceremony: ops republishes the root.
      await (
        await pm
          .connect(f.ops)
          .publishWhitelistRoot(ethers.toBeHex(root + 1n, 32))
      ).wait();
      after = await run("full");
      afterOut = [...out];
      audit = await run("audit");
    } finally {
      console.log = quiet;
    }
    const pick = (re: RegExp, ls: string[]) => ls.filter((l) => re.test(l));
    const open = `whitelist bindings made up to block ${restore!.blockNumber} (the last whitelist verifier swap) still count: ops must republish the whitelist root (publishWhitelistRoot) after it`;
    console.log(
      `      preflight: ${pre}\n      full phase after ops republished: ${after}; audit: ${audit}`,
    );
    expect(pre).to.contain(open);
    expect(full).to.equal(pre);
    expect(sent).to.equal(0);
    const zkAddr = await zk.getAddress();
    expect(pick(/verifier swap/, fullOut)).to.include.members([
      `   ❌ verifier swaps since fromBlock ${f.args.fromBlock}: 2`,
      `   ❌ verifier swap at block ${swap!.blockNumber}: ZKVerifierIntegrated ${zkAddr} whitelist verifier set to ${rogueAddr} (1 PrivacyManager binding(s) made under it)`,
      `   ❌ verifier swap at block ${restore!.blockNumber}: ZKVerifierIntegrated ${zkAddr} whitelist verifier set to ${original} (0 PrivacyManager binding(s) made under it)`,
    ]);
    // The builder completion and the audit call fails the same line.
    expect(checks).to.deep.include({ label: open, ok: false });
    expect(after).to.equal("ok");
    expect(
      pick(/✅ verifier swaps since fromBlock \d+: 2/, afterOut),
    ).to.have.lengthOf(2);
    expect(audit).to.equal("ok");
    expect(
      pick(/✅ verifier swaps since fromBlock \d+: 2/, out),
    ).to.have.lengthOf(1);
    expect(await pm.owner()).to.equal(f.govAddr);
    const valid = await pm.hasValidWhitelistProof(w.address);
    console.log(
      `      after the republish: stranger holds a valid whitelist binding: ${valid}`,
    );
    expect(valid).to.equal(false);
  });
});
