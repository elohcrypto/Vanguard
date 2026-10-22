// D2-2, attestation variant: the deployer swaps the jurisdiction,
// accreditation and compliance verifiers to an always-true one, forges
// attestation records for a wallet no issuer attested, and restores them.
// The preflight, completion and the day-2 audit name each swap and fail
// while records made under it can still count. Round 2: the preflight
// refuses, because before the ceremony the deployer lapses them in one
// transaction each (a trusted -> trusted re-approval leaves them valid;
// untrust then re-trust, or a policy change, lapses them); after it each
// is a PrivacyParameters vote. Then the ceremony and the audit pass.
import { expect } from "chai";
import { ethers } from "hardhat";
import * as fs from "fs";
import { handoverFixture } from "../helpers/governanceFixture";
import { captured, cliConfig } from "../helpers/handoverCli";
import { runHandover } from "../../scripts/handover";
import { handoverArgs } from "../../scripts/handoverConfig";

const { assertHandoverComplete } = require("../../demo/utils/Handover");
const {
  attestorPublicKey,
  newAttestorKey,
} = require("../../scripts/zk/attest");

const DAY = 86400;
const CIRCUITS: [string, string][] = [
  ["jurisdiction", ethers.id("JURISDICTION_PROOF")],
  ["accreditation", ethers.id("ACCREDITATION_PROOF")],
  ["compliance", ethers.id("COMPLIANCE_AGGREGATION")],
];
const [JUR, ACC, COMP] = CIRCUITS.map((c) => c[1]);
const abi = ethers.AbiCoder.defaultAbiCoder();

describe("D2-2 verifier swap residue, attestation circuits", function () {
  this.timeout(900000);
  it("the preflight refuses the swaps until the deployer lapses every forged record; then the ceremony and the audit pass", async function () {
    const f = await handoverFixture();
    const { cfg, cfgPath, dir } = await cliConfig(f);
    const d = f.deployer;
    const pm = f.c.privacyManager;
    const zk = f.c.zkVerifier;
    const pmAddr = await pm.getAddress();
    const signer = async (i: number) => (await ethers.getSigners())[i];
    const addrs = async (is: number[]) =>
      Promise.all(is.map(async (i) => (await signer(i)).address));
    const chainId = (await ethers.provider.getNetwork()).chainId;

    // ---- the deployer era, as a production deploy leaves it --------------------------------
    const om = f.c.oracleManager.connect(d);
    for (const a of await addrs([9, 10, 11]))
      await om.registerOracle(a, `DEP_${a.slice(2, 6)}`, "deployer era", 500);
    cfg.oracleNodes = await addrs([9, 10, 11]);
    // The deploy trusts the issuer's PUBLIC key for the three circuits and sets the policies.
    const { Ax, Ay } = await attestorPublicKey(newAttestorKey());
    cfg.attestors = [Ax.toString()];
    for (const [, id] of CIRCUITS)
      await (await pm.connect(d).setTrustedAttestor(id, Ax, Ay, true)).wait();
    await (await pm.connect(d).registerJurisdictionCode(840)).wait();
    await (await pm.connect(d).registerJurisdictionCode(344)).wait();
    await (await pm.connect(d).setMinimumAccreditation(100)).wait();
    await (await pm.connect(d).setCompliancePolicy(70, 25, 25, 25, 25)).wait();
    const mask = await pm.allowedJurisdictionMask();
    console.log(
      `      deploy state: policyToken=VSC, jurisdiction mask ${mask}, minimumAccreditation ${await pm.minimumAccreditation()}, compliance policy 70/25/25/25/25, issuer key trusted for 3 circuits by the deployer`,
    );
    const attestor = ethers.keccak256(
      abi.encode(["uint256", "uint256"], [Ax, Ay]),
    );

    const w = f.stranger; // holds no issuer-signed attestation at all
    const garbage = Array.from({ length: 24 }, (_, i) => BigInt(i + 1));
    const BIG = 2n ** 64n - 1n; // forged validUntil, the largest the contract accepts
    const signalsFor = (id: string, nullifier: bigint, policy: bigint[]) => [
      nullifier,
      Ax,
      Ay,
      chainId,
      BigInt(pmAddr),
      BIG,
      ...policy,
      BigInt(w.address),
    ];
    const policyOf = async (id: string) =>
      (await pm.currentPolicy(id)).map(BigInt);
    const sig = {
      [JUR]: signalsFor(JUR, 1001n, await policyOf(JUR)),
      [ACC]: signalsFor(ACC, 1002n, await policyOf(ACC)),
      [COMP]: signalsFor(COMP, 1003n, await policyOf(COMP)),
    } as Record<string, bigint[]>;

    // ---- control: with the real verifiers the same submission is refused -------------------
    const refused = await pm
      .connect(w)
      .submitAttestationProof(JUR, garbage, sig[JUR])
      .then(
        () => "ACCEPTED",
        (e: any) => (e.shortMessage || e.message).split("\n")[0],
      );
    console.log(`      control, real verifier, garbage proof: ${refused}`);
    expect(refused).to.not.equal("ACCEPTED");

    // ---- the swap, the forgery, the restore (the deployer's only transactions) -------------
    const rogue = await (
      await ethers.getContractFactory("AlwaysTrueVerifier")
    )
      .connect(d)
      .deploy();
    const rogueAddr = await rogue.getAddress();
    const originals = {
      jurisdiction: await zk.jurisdictionVerifier(),
      accreditation: await zk.accreditationVerifier(),
      compliance: await zk.complianceVerifier(),
    } as Record<string, string>;
    for (const t of ["jurisdiction", "accreditation", "compliance"]) {
      const rc = await (
        await zk.connect(d).updateVerifier(t, rogueAddr)
      ).wait();
      console.log(
        `      setter: ZKVerifierIntegrated.updateVerifier("${t}", AlwaysTrueVerifier)  tx ${rc!.hash.slice(0, 12)}...  (inherited from ZKVerifierAdmin, onlyOwner)`,
      );
    }
    // jurisdiction and compliance at the default validity (30 days), accreditation after raising it to 365 days
    const defaultPeriod = await pm.proofValidityPeriod();
    const marks: Record<string, { at: number; period: bigint }> = {};
    const forge = async (id: string, period: bigint) => {
      const rc = await (
        await pm.connect(w).submitAttestationProof(id, garbage, sig[id])
      ).wait();
      const blk = await ethers.provider.getBlock(rc!.blockNumber);
      marks[id] = { at: blk!.timestamp, period };
    };
    await forge(JUR, defaultPeriod);
    await forge(COMP, defaultPeriod);
    await (await pm.connect(d).setProofValidityPeriod(365 * DAY)).wait();
    await forge(ACC, 365n * BigInt(DAY));
    await (await pm.connect(d).setProofValidityPeriod(defaultPeriod)).wait();
    for (const t of ["jurisdiction", "accreditation", "compliance"])
      await (await zk.connect(d).updateVerifier(t, originals[t])).wait();
    expect(await zk.jurisdictionVerifier()).to.equal(originals.jurisdiction);
    expect(await zk.accreditationVerifier()).to.equal(originals.accreditation);
    expect(await zk.complianceVerifier()).to.equal(originals.compliance);
    expect(await pm.proofValidityPeriod()).to.equal(defaultPeriod);
    const reproof = await zk.verifyCircuitProof
      .staticCall(JUR, garbage, sig[JUR])
      .catch(() => false);
    console.log(
      `      verifiers restored; the same forged proof verifies now: ${reproof}; PrivacyManager.proofValidityPeriod back to ${await pm.proofValidityPeriod()}s`,
    );
    expect(reproof).to.equal(false);

    // ---- the forged records, and the exact storage that holds them -------------------------
    const rec: Record<string, any> = {};
    for (const [name, id] of CIRCUITS) {
      rec[id] = await pm.attestationRecords(w.address, id);
      const info = await pm.getUserProofInfo(w.address, id);
      console.log(
        `      forged ${name}: expiresAt ${new Date(Number(rec[id].expiresAt) * 1000).toISOString()} (submit + ${Number(rec[id].expiresAt) - marks[id].at}s), policyEpoch ${rec[id].policyEpoch}, attestorEpoch ${rec[id].attestorEpoch}, isValid ${info.isValid}`,
      );
      expect(info.isValid).to.equal(true);
      expect(rec[id].attestor).to.equal(attestor);
    }
    // locate attestationRecords' base slot and read the raw words
    let base = -1;
    const slotOf = (user: string, id: string, b: number) => {
      const inner = ethers.keccak256(
        abi.encode(["address", "uint256"], [user, b]),
      );
      return BigInt(
        ethers.keccak256(abi.encode(["bytes32", "bytes32"], [id, inner])),
      );
    };
    for (let b = 0; b < 40 && base < 0; b++) {
      const raw = await ethers.provider.getStorage(
        pmAddr,
        slotOf(w.address, JUR, b) + 3n,
      );
      if (BigInt(raw) === rec[JUR].expiresAt && rec[JUR].expiresAt !== 0n)
        base = b;
    }
    expect(base).to.be.greaterThan(-1);
    const words = [] as string[];
    for (let k = 0n; k < 6n; k++)
      words.push(
        await ethers.provider.getStorage(
          pmAddr,
          slotOf(w.address, JUR, base) + k,
        ),
      );
    console.log(
      `      storage: PrivacyManager.attestationRecords is at storage slot ${base}; record(w, JURISDICTION) starts at keccak256(abi.encode(circuitId, keccak256(abi.encode(w, ${base})))) = ${ethers.toBeHex(slotOf(w.address, JUR, base), 32)}, 6 words [policyHash, attestor, nullifier, expiresAt, policyEpoch, attestorEpoch]`,
    );
    console.log(
      `      raw words: ${words.map((x) => x.slice(0, 12) + "...").join(" ")}`,
    );
    const nw = await pm.attestationNullifierWallet(
      rec[JUR].policyHash,
      rec[JUR].nullifier,
    );
    console.log(
      `      attestationNullifierWallet[policyHash][nullifier] = ${nw} (the forged wallet)`,
    );
    expect(nw).to.equal(w.address);
    // and the nullifier reservation, raw: mapping(bytes32 policyHash => mapping(uint256 nullifier => address)) at slot 16
    const nslot = BigInt(
      ethers.keccak256(
        abi.encode(
          ["uint256", "bytes32"],
          [
            rec[JUR].nullifier,
            ethers.keccak256(
              abi.encode(["bytes32", "uint256"], [rec[JUR].policyHash, 16]),
            ),
          ],
        ),
      ),
    );
    const nraw = await ethers.provider.getStorage(pmAddr, nslot);
    console.log(
      `      attestationNullifierWallet is at storage slot 16; raw word at keccak256(abi.encode(nullifier, keccak256(abi.encode(policyHash, 16)))) = ${nraw}`,
    );
    expect(ethers.getAddress("0x" + nraw.slice(26))).to.equal(w.address);
    // what a detector could scan (the ceremony and the audit scan none of it): zk-side counters and events
    console.log(
      `      traces: ZKVerifierIntegrated VerifierUpdated events ${(await zk.queryFilter(zk.filters.VerifierUpdated())).length}, validProofs(jurisdiction/accreditation/compliance) = ${await zk.validProofs("jurisdiction")}/${await zk.validProofs("accreditation")}/${await zk.validProofs("compliance")}, PrivacyManager AttestationProofBound events ${(await pm.queryFilter(pm.filters.AttestationProofBound())).length}`,
    );

    // ---- before the ceremony: the preflight refuses; completion and the audit fail the same lines
    const out: string[] = [];
    const pick = (re: RegExp, text: string) =>
      text.split("\n").filter((l) => re.test(l));
    const stuck = (v: string) =>
      CIRCUITS.map(([n]) => n).filter((n) =>
        new RegExp(
          `${n} records made up to block \\d+ \\(the last ${n} verifier swap\\) still count`,
        ).test(v),
      );
    const preflight = async () => {
      out.length = 0;
      return captured(out, () => runHandover(cfg, "preflight", cfgPath)).then(
        () => "ok",
        (e: any) => e.message,
      );
    };
    const n0 = await ethers.provider.getTransactionCount(d.address);
    const pre = await preflight();
    console.log(`      preflight refuses: ${stuck(pre).join(", ")}`);
    expect(stuck(pre)).to.deep.equal([
      "jurisdiction",
      "accreditation",
      "compliance",
    ]);
    let full = "ok";
    await captured(out, () => runHandover(cfg, "full", cfgPath)).catch(
      (e: any) => (full = e.message),
    );
    expect(full).to.equal(pre);
    expect(await ethers.provider.getTransactionCount(d.address)).to.equal(n0);
    expect(await pm.owner()).to.equal(d.address);
    const { args } = await handoverArgs(cfg, "audit", cfgPath);
    const { checks } = await assertHandoverComplete({ ...args, audit: true });
    for (const [name] of CIRCUITS)
      expect(
        checks.filter(
          (c: any) =>
            !c.ok && c.label.startsWith(`${name} records made up to block`),
        ),
      ).to.have.lengthOf(1);

    // ---- a re-approval (trusted -> trusted) leaves the epochs, so every forged record still counts
    const epochs = async () =>
      Promise.all(CIRCUITS.map(([, id]) => pm.attestorEpoch(id, attestor)));
    const e0 = await epochs();
    for (const [, id] of CIRCUITS)
      await (await pm.connect(d).setTrustedAttestor(id, Ax, Ay, true)).wait();
    expect(await epochs()).to.deep.equal(e0);
    expect(stuck(await preflight())).to.have.lengthOf(3);

    // ---- the deployer's remedies before the run: untrust then re-trust, or a policy change
    for (const id of [JUR, COMP]) {
      await (await pm.connect(d).setTrustedAttestor(id, Ax, Ay, false)).wait();
      await (await pm.connect(d).setTrustedAttestor(id, Ax, Ay, true)).wait();
    }
    const left = await preflight();
    console.log(
      `      after untrust/re-trust of jurisdiction and compliance: ${stuck(left).join(", ")}`,
    );
    expect(stuck(left)).to.deep.equal(["accreditation"]);
    await (await pm.connect(d).setMinimumAccreditation(101)).wait();
    expect(await preflight()).to.equal("ok");
    expect(out.join("\n")).to.contain("✅ Preflight passed");
    for (const [name, id] of CIRCUITS) {
      const valid = (await pm.getUserProofInfo(w.address, id)).isValid;
      console.log(`      forged ${name} after the remedies: isValid ${valid}`);
      expect(valid).to.equal(false);
    }

    // ---- the ceremony completes and the day-2 audit passes, both naming the six swaps
    out.length = 0;
    full = "ok";
    await captured(out, () => runHandover(cfg, "full", cfgPath)).catch(
      (e: any) => (full = e.message),
    );
    console.log(`      full phase: ${full}`);
    expect(full).to.equal("ok");
    expect(
      pick(/✅ verifier swaps since fromBlock \d+: 6/, out.join("\n")),
    ).to.have.lengthOf(2);
    expect(await pm.owner()).to.equal(f.govAddr);
    out.length = 0;
    let audit = "ok";
    await captured(out, () => runHandover(cfg, "audit", cfgPath)).catch(
      (e: any) => (audit = e.message),
    );
    console.log(`      audit: ${audit}`);
    expect(audit).to.equal("ok");
    expect(
      pick(/✅ verifier swaps since fromBlock \d+: 6/, out.join("\n")),
    ).to.have.lengthOf(1);

    fs.rmSync(dir, { recursive: true, force: true });
  });
});
