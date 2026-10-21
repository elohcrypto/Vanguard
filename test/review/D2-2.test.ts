// D2-2: a verifier swapped and swapped back before the ceremony leaves
// forged PrivacyManager bindings; completion and the day-2 audit scan
// VerifierUpdated, name the swap block and fail until ops republishes the
// root, which lapses every binding made under the swapped verifier.
import { expect } from "chai";
import { ethers } from "hardhat";
import { handoverFixture } from "../helpers/governanceFixture";
import { runHandover } from "../../scripts/handover";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

describe("D2-2 verifier swap residue", function () {
  this.timeout(600000);
  it("completion and the audit fail on the swap until ops republishes the root", async function () {
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
    let full = "ok";
    let audit = "ok";
    let after = "ok";
    let fullOut: string[] = [];
    let auditOut: string[] = [];
    try {
      await runHandover(cfg, "full", cfgPath).catch(
        (e: any) => (full = e.message),
      );
      fullOut = out.splice(0);
      await runHandover(cfg, "audit", cfgPath).catch(
        (e: any) => (audit = e.message),
      );
      auditOut = out.splice(0);
      // The remedy: ops republishes the root after the swap.
      await (
        await pm
          .connect(f.ops)
          .publishWhitelistRoot(ethers.toBeHex(root + 1n, 32))
      ).wait();
      await runHandover(cfg, "audit", cfgPath).catch(
        (e: any) => (after = e.message),
      );
    } finally {
      console.log = quiet;
    }
    const pick = (re: RegExp, ls: string[]) => ls.filter((l) => re.test(l));
    const swapLines = pick(/verifier swap/, auditOut);
    console.log(
      `      full phase: ${full}; audit: ${audit}\n      ${swapLines.join("\n      ")}\n      audit after ops republished: ${after}`,
    );
    expect(full).to.contain("handover incomplete");
    expect(
      pick(/⚠️  whitelist bindings made up to block/, fullOut),
    ).to.have.lengthOf(1);
    expect(
      pick(/❌ whitelist bindings made up to block/, fullOut),
    ).to.have.lengthOf(1);
    expect(audit).to.contain("audit failed");
    const zkAddr = await zk.getAddress();
    expect(swapLines).to.include(
      `   ❌ verifier swaps since fromBlock ${f.args.fromBlock}: 2`,
    );
    expect(swapLines).to.include(
      `   ❌ verifier swap at block ${swap!.blockNumber}: ZKVerifierIntegrated ${zkAddr} whitelist verifier set to ${rogueAddr} (1 PrivacyManager binding(s) made under it)`,
    );
    expect(swapLines).to.include(
      `   ❌ verifier swap at block ${restore!.blockNumber}: ZKVerifierIntegrated ${zkAddr} whitelist verifier set to ${original} (0 PrivacyManager binding(s) made under it)`,
    );
    expect(
      pick(/whitelist bindings made up to block/, auditOut),
    ).to.have.lengthOf(1);
    expect(after).to.equal("ok");
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
