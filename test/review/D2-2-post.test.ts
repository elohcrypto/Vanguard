// D2-2 after the ceremony (round 3, B): governance swaps a verifier by
// vote, a stranger binds forged proofs under it, a second vote restores
// it. The day-2 audit (HANDOVER_PHASE=audit) fails with the swap blocks
// and the "made up to block N" line, and the remedies the runbook quotes
// (04-after-ceremony.md) make it pass and every forged record invalid:
// ops republishes the whitelist root; for the attestation circuits the
// Q20 re-approval vote (trusted -> trusted) changes no epoch, an untrust
// then re-trust vote or a policy-change vote lapses the records.
import { expect } from "chai";
import { ethers } from "hardhat";
import * as fs from "fs";
import { time, takeSnapshot } from "@nomicfoundation/hardhat-network-helpers";
import { handoverFixture } from "../helpers/governanceFixture";
import { byVote, captured, cliConfig } from "../helpers/handoverCli";
import { runHandover } from "../../scripts/handover";
import { handoverArgs } from "../../scripts/handoverConfig";
import {
  parseNodes,
  runPostCeremony,
} from "../../scripts/production/postCeremonyVotes";

const { withDerivedContracts } = require("../../demo/utils/HandoverDerive");
const {
  attestorPublicKey,
  newAttestorKey,
} = require("../../scripts/zk/attest");

const PRIVACY = 11; // PrivacyManager's owner surface
const ZK = 12; // ZKVerifierIntegrated's
const CIRCUITS: [string, string][] = [
  ["jurisdiction", ethers.id("JURISDICTION_PROOF")],
  ["accreditation", ethers.id("ACCREDITATION_PROOF")],
  ["compliance", ethers.id("COMPLIANCE_AGGREGATION")],
];
const [JUR, ACC, COMP] = CIRCUITS.map((c) => c[1]);
const garbage = Array.from({ length: 24 }, (_, i) => BigInt(i + 1));
const pick = (re: RegExp, ls: string[]) => ls.filter((l) => re.test(l));

/** Runs `phase`, returning its verdict ("ok" or the error) and its lines. */
async function phaseOf(cfg: any, cfgPath: string, phase: string) {
  const out: string[] = [];
  const verdict = await captured(out, () =>
    runHandover(cfg, phase, cfgPath),
  ).then(
    () => "ok",
    (e: any) => e.message,
  );
  return { verdict, out };
}

/** The block of the last VerifierUpdated of `proofType`. */
async function lastSwap(zk: any, proofType: string) {
  const evs = await zk.queryFilter(zk.filters.VerifierUpdated(proofType));
  return evs[evs.length - 1].blockNumber as number;
}

describe("D2-2 verifier swap residue after the ceremony", function () {
  this.timeout(900000);

  it("a whitelist swap by vote fails the audit until ops republishes the root", async function () {
    const f = await handoverFixture();
    const { cfg, cfgPath, dir } = await cliConfig(f);
    const pm = f.c.privacyManager;
    const zk = f.c.zkVerifier;
    const w = f.stranger;
    expect((await phaseOf(cfg, cfgPath, "full")).verdict).to.equal("ok");
    const root = 12345n;
    await (
      await pm.connect(f.ops).publishWhitelistRoot(ethers.toBeHex(root, 32))
    ).wait();
    const original = await zk.whitelistVerifier();
    const rogue = await (
      await (await ethers.getContractFactory("AlwaysTrueVerifier")).deploy()
    ).getAddress();
    const call = (a: string) =>
      zk.interface.encodeFunctionData("updateVerifier", ["whitelist", a]);
    await byVote(f, ZK, zk, call(rogue));
    const swap = await lastSwap(zk, "whitelist");
    const signals = [777n, root, BigInt(w.address)];
    await (await pm.connect(w).submitWhitelistProof(garbage, signals)).wait();
    await byVote(f, ZK, zk, call(original));
    const restore = await lastSwap(zk, "whitelist");
    expect(await pm.hasValidWhitelistProof(w.address)).to.equal(true);
    const before = await phaseOf(cfg, cfgPath, "audit");
    console.log(`      audit after the swap: ${before.verdict}`);
    expect(before.verdict).to.contain("audit failed");
    const zkAddr = await zk.getAddress();
    expect(
      pick(/verifier swap|whitelist bindings/, before.out),
    ).to.include.members([
      `   ❌ verifier swaps since fromBlock ${f.args.fromBlock}: 2`,
      `   ❌ verifier swap at block ${swap}: ZKVerifierIntegrated ${zkAddr} whitelist verifier set to ${rogue} (1 PrivacyManager binding(s) made under it)`,
      `   ❌ verifier swap at block ${restore}: ZKVerifierIntegrated ${zkAddr} whitelist verifier set to ${original} (0 PrivacyManager binding(s) made under it)`,
      `   ❌ whitelist bindings made up to block ${restore} (the last whitelist verifier swap) still count: ops must republish the whitelist root (publishWhitelistRoot) after it`,
    ]);
    await (
      await pm
        .connect(f.ops)
        .publishWhitelistRoot(ethers.toBeHex(root + 1n, 32))
    ).wait();
    const after = await phaseOf(cfg, cfgPath, "audit");
    console.log(`      audit after ops republished: ${after.verdict}`);
    expect(after.verdict).to.equal("ok");
    expect(
      pick(/✅ verifier swaps since fromBlock \d+: 2/, after.out),
    ).to.have.lengthOf(1);
    expect(await pm.hasValidWhitelistProof(w.address)).to.equal(false);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("attestation swaps by vote fail the audit through the Q20 votes until untrust/re-trust or a policy vote lapses every forged record", async function () {
    const f = await handoverFixture();
    const { cfg, cfgPath, dir } = await cliConfig(f);
    const d = f.deployer;
    const pm = f.c.privacyManager;
    const zk = f.c.zkVerifier;
    const s = await ethers.getSigners();
    const addrs = (is: number[]) => is.map((i) => s[i].address);
    const chainId = (await ethers.provider.getNetwork()).chainId;
    // The deploy era: nodes, the issuer key trusted for 3 circuits, policies.
    for (const a of addrs([9, 10, 11]))
      await f.c.oracleManager
        .connect(d)
        .registerOracle(a, `DEP_${a.slice(2, 6)}`, "deployer era", 500);
    cfg.oracleNodes = addrs([9, 10, 11]);
    const { Ax, Ay } = await attestorPublicKey(newAttestorKey());
    cfg.attestors = [Ax.toString()];
    for (const [, id] of CIRCUITS)
      await (await pm.connect(d).setTrustedAttestor(id, Ax, Ay, true)).wait();
    await (await pm.connect(d).registerJurisdictionCode(840)).wait();
    await (await pm.connect(d).setMinimumAccreditation(100)).wait();
    await (await pm.connect(d).setCompliancePolicy(70, 25, 25, 25, 25)).wait();
    const attestor = ethers.keccak256(
      ethers.AbiCoder.defaultAbiCoder().encode(
        ["uint256", "uint256"],
        [Ax, Ay],
      ),
    );
    expect((await phaseOf(cfg, cfgPath, "full")).verdict).to.equal("ok");
    expect(await pm.owner()).to.equal(f.govAddr);
    expect(await zk.owner()).to.equal(f.govAddr);

    // Governance swaps the three verifiers by vote; a stranger no issuer
    // attested forges records; votes restore them.
    const w = f.stranger;
    const control = s[18]; // never touched
    const rogue = await (
      await (await ethers.getContractFactory("AlwaysTrueVerifier")).deploy()
    ).getAddress();
    const zkCall = (t: string, a: string) =>
      zk.interface.encodeFunctionData("updateVerifier", [t, a]);
    const pmCall = (fn: string, ...a: any[]) =>
      pm.interface.encodeFunctionData(fn, a);
    const originals: Record<string, string> = {};
    for (const [t] of CIRCUITS) {
      originals[t] = await zk[`${t}Verifier`]();
      await byVote(f, ZK, zk, zkCall(t, rogue));
    }
    const signals = async (id: string, nullifier: bigint) => [
      nullifier,
      Ax,
      Ay,
      chainId,
      BigInt(await pm.getAddress()),
      2n ** 64n - 1n,
      ...(await pm.currentPolicy(id)).map(BigInt),
      BigInt(w.address),
    ];
    const forge = async (id: string, n: bigint) =>
      (
        await pm
          .connect(w)
          .submitAttestationProof(id, garbage, await signals(id, n))
      ).wait();
    await forge(JUR, 1001n);
    await forge(COMP, 1003n);
    const period = await pm.proofValidityPeriod();
    await byVote(f, PRIVACY, pm, pmCall("setProofValidityPeriod", 365 * 86400));
    await forge(ACC, 1002n);
    await byVote(f, PRIVACY, pm, pmCall("setProofValidityPeriod", period));
    for (const [t] of CIRCUITS)
      await byVote(f, ZK, zk, zkCall(t, originals[t]));
    const rec: Record<string, any> = {};
    for (const [, id] of CIRCUITS) {
      rec[id] = await pm.attestationRecords(w.address, id);
      expect((await pm.getUserProofInfo(w.address, id)).isValid).to.equal(true);
      expect(rec[id].attestor).to.equal(attestor);
    }
    const open = async () =>
      Promise.all(
        CIRCUITS.map(
          async ([n]) =>
            `   ❌ ${n} records made up to block ${await lastSwap(zk, n)} (the last ${n} verifier swap) still count`,
        ),
      );
    const stuck = (out: string[], lines: string[]) =>
      lines.filter((l) => out.some((x) => x.startsWith(l)));
    const audit0 = await phaseOf(cfg, cfgPath, "audit");
    console.log(`      audit after the swaps: ${audit0.verdict}`);
    expect(audit0.verdict).to.contain("audit failed");
    expect(stuck(audit0.out, await open())).to.have.lengthOf(3);
    expect(audit0.out.join("\n")).to.contain("was trusted by the deployer"); // Q20

    // The Q20 re-approval and D50 rotation votes, with the real CLI function.
    const epochs = async () =>
      Promise.all(CIRCUITS.map(([, id]) => pm.attestorEpoch(id, attestor)));
    const policyEpochs = async () =>
      Promise.all(CIRCUITS.map(([, id]) => pm.policyEpoch(id)));
    const [e0, p0] = [await epochs(), await policyEpochs()];
    const { args } = await handoverArgs(cfg, "audit", cfgPath);
    const nodes = addrs([13, 14, 15])
      .map((a, k) => `${a}:NODE_${k + 1}`)
      .join(",");
    await captured([], async () =>
      runPostCeremony(
        await withDerivedContracts(args),
        f.proposer,
        f.voters,
        parseNodes(nodes),
        cfg,
      ),
    );
    expect(await epochs()).to.deep.equal(e0); // trusted -> trusted changes nothing
    expect(await policyEpochs()).to.deep.equal(p0);
    const trusts = await pm.queryFilter(pm.filters.TrustedAttestorSet(JUR));
    expect(trusts[trusts.length - 1].args.by).to.equal(f.govAddr);
    cfg.oracleNodes = addrs([13, 14, 15]);
    const audit1 = await phaseOf(cfg, cfgPath, "audit");
    console.log(`      audit after the Q20 votes: ${audit1.verdict}`);
    expect(audit1.verdict).to.contain("audit failed");
    expect(stuck(audit1.out, await open())).to.have.lengthOf(3);
    expect(audit1.out.join("\n")).to.not.contain("was trusted by the deployer");

    // The forged records still count, for the stranger only, until they expire.
    expect(await pm.validatePrivateJurisdiction.staticCall(w.address)).to.equal(
      true,
    );
    expect(
      await pm.validatePrivateAccreditation.staticCall(w.address),
    ).to.equal(true);
    expect(await pm.validatePrivateCompliance.staticCall(w.address)).to.equal(
      true,
    );
    const ctrl = await pm.validateAllPrivateCompliance(control.address);
    expect(ctrl.every((x: boolean) => x === false)).to.equal(true);
    for (const [name, id] of CIRCUITS) {
      const snap = await takeSnapshot();
      await time.increaseTo(Number(rec[id].expiresAt) - 5);
      const live = (await pm.getUserProofInfo(w.address, id)).isValid;
      await time.increaseTo(Number(rec[id].expiresAt) + 1);
      const gone = (await pm.getUserProofInfo(w.address, id)).isValid;
      console.log(
        `      ${name}: 5 s before expiresAt ${live}, 1 s after ${gone}`,
      );
      expect([live, gone]).to.deep.equal([true, false]);
      await snap.restore();
    }

    // The remedies by vote: another re-approval changes nothing; untrust
    // then re-trust, or a policy change, lapses the records.
    await byVote(
      f,
      PRIVACY,
      pm,
      pmCall("setTrustedAttestor", JUR, Ax, Ay, true),
    );
    expect((await pm.getUserProofInfo(w.address, JUR)).isValid).to.equal(true);
    await byVote(
      f,
      PRIVACY,
      pm,
      pmCall("setTrustedAttestor", JUR, Ax, Ay, false),
    );
    await byVote(
      f,
      PRIVACY,
      pm,
      pmCall("setTrustedAttestor", JUR, Ax, Ay, true),
    );
    expect((await pm.getUserProofInfo(w.address, JUR)).isValid).to.equal(false);
    await byVote(f, PRIVACY, pm, pmCall("setMinimumAccreditation", 101));
    expect((await pm.getUserProofInfo(w.address, ACC)).isValid).to.equal(false);
    expect((await pm.getUserProofInfo(w.address, COMP)).isValid).to.equal(true);
    const audit2 = await phaseOf(cfg, cfgPath, "audit");
    console.log(
      `      audit with compliance records still valid: ${audit2.verdict}`,
    );
    expect(audit2.verdict).to.contain("audit failed");
    expect(stuck(audit2.out, await open())).to.deep.equal([(await open())[2]]);
    await byVote(
      f,
      PRIVACY,
      pm,
      pmCall("setTrustedAttestor", COMP, Ax, Ay, false),
    );
    await byVote(
      f,
      PRIVACY,
      pm,
      pmCall("setTrustedAttestor", COMP, Ax, Ay, true),
    );
    const audit3 = await phaseOf(cfg, cfgPath, "audit");
    console.log(
      `      audit once every forged record lapsed: ${audit3.verdict}`,
    );
    expect(audit3.verdict).to.equal("ok");
    expect(
      pick(/✅ verifier swaps since fromBlock \d+: 6/, audit3.out),
    ).to.have.lengthOf(1);
    for (const [, id] of CIRCUITS)
      expect((await pm.getUserProofInfo(w.address, id)).isValid).to.equal(
        false,
      );
    expect(
      (await pm.validateAllPrivateCompliance(w.address)).some(
        (x: boolean) => x,
      ),
    ).to.equal(false);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
