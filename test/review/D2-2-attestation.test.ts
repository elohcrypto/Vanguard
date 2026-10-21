// D2-2, attestation variant: the deployer swaps the jurisdiction,
// accreditation and compliance verifiers to an always-true one, forges
// attestation records for a wallet no issuer attested, and restores them.
// Completion and the day-2 audit name each swap and fail while records
// made under it can still count: the Q20 re-approval vote (trusted ->
// trusted) leaves them valid, an untrust then re-trust vote or a policy
// change lapses them, and the audit passes once all three have lapsed.
import { expect } from "chai";
import { ethers } from "hardhat";
import * as fs from "fs";
import { time } from "@nomicfoundation/hardhat-network-helpers";
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
  it("completion and the audit fail on the swaps until every forged record has lapsed", async function () {
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
    const control = await signer(18); // never touched
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

    // ---- the ceremony (full phase), then the day-2 audit -----------------------------------
    const out: string[] = [];
    const ceremony = () =>
      captured(out, () => runHandover(cfg, "full", cfgPath));
    let full = "ok";
    await ceremony().catch((e: any) => (full = e.message));
    const fullText = out.join("\n");
    const pick = (re: RegExp, text: string) =>
      text.split("\n").filter((l) => re.test(l));
    console.log(`      full phase: ${full}`);
    console.log(
      `      full phase verdict line: ${pick(/Handover complete/, fullText).join(" | ")}`,
    );
    console.log(
      `      full phase lines naming the deployer-trusted issuer key: ${pick(/issuer key/, fullText).length}`,
    );
    console.log(
      `      full phase lines naming a verifier swap / forged record: ${pick(/verifier swap|records made up to block|updateVerifier|VerifierUpdated|forged|AttestationProofBound|attestationRecords/i, fullText).length}`,
    );
    expect(full).to.contain("handover incomplete");
    for (const [name] of CIRCUITS)
      expect(
        pick(new RegExp(`❌ ${name} records made up to block \\d+`), fullText),
      ).to.have.lengthOf(1);
    expect(await pm.owner()).to.equal(f.govAddr);

    out.length = 0;
    let before = "ok";
    await captured(out, () => runHandover(cfg, "audit", cfgPath)).catch(
      (e: any) => (before = e.message),
    );
    console.log(`      audit before the votes: ${before}`);
    expect(before).to.contain("audit failed");
    expect(out.join("\n")).to.contain("was trusted by the deployer"); // the documented residue, Q20

    // ---- the Q20 re-approval votes + D50 rotation, with the real CLI function --------------
    const derive = async () => {
      const { args, wallet } = await handoverArgs(cfg, "audit", cfgPath);
      return { o: await withDerivedContracts(args), wallet };
    };
    const epochBefore = {
      j: await pm.attestorEpoch(JUR, attestor),
      a: await pm.attestorEpoch(ACC, attestor),
      c: await pm.attestorEpoch(COMP, attestor),
    };
    const pEpochBefore = {
      j: await pm.policyEpoch(JUR),
      a: await pm.policyEpoch(ACC),
      c: await pm.policyEpoch(COMP),
    };
    const t0 = (await ethers.provider.getBlock("latest"))!.timestamp;
    const nodes = (await addrs([13, 14, 15]))
      .map((a, k) => `${a}:NODE_${k + 1}`)
      .join(",");
    out.length = 0;
    const { o } = await derive();
    await captured(out, () =>
      runPostCeremony(o, f.proposer, f.voters, parseNodes(nodes), cfg),
    );
    const t1 = (await ethers.provider.getBlock("latest"))!.timestamp;
    console.log(
      `      post-ceremony votes: ${pick(/round [12]:/, out.join("\n"))
        .map((s) => s.trim())
        .join(" | ")}`,
    );
    console.log(
      `      chain time spent in the votes: ${((t1 - t0) / DAY).toFixed(1)} days`,
    );
    const epochAfter = {
      j: await pm.attestorEpoch(JUR, attestor),
      a: await pm.attestorEpoch(ACC, attestor),
      c: await pm.attestorEpoch(COMP, attestor),
    };
    console.log(
      `      attestorEpoch before/after the re-approval vote: ${JSON.stringify([epochBefore, epochAfter], (_, v) => (typeof v === "bigint" ? v.toString() : v))}`,
    );
    expect(epochAfter).to.deep.equal(epochBefore); // setTrustedAttestor(true) on a trusted key changes nothing
    expect(await pm.policyEpoch(JUR)).to.equal(pEpochBefore.j);
    const trusts = await pm.queryFilter(pm.filters.TrustedAttestorSet(JUR));
    console.log(
      `      last TrustedAttestorSet(JURISDICTION).by == governance: ${trusts[trusts.length - 1].args.by === f.govAddr}`,
    );

    cfg.oracleNodes = await addrs([13, 14, 15]);
    out.length = 0;
    let verdict = "ok";
    await captured(out, () => runHandover(cfg, "audit", cfgPath)).catch(
      (e: any) => (verdict = e.message),
    );
    const audit = out.join("\n");
    console.log(`      audit after the votes: ${verdict}`);
    console.log(
      `      audit lines naming the deployer-trusted key: ${pick(/was trusted by the deployer/, audit).length}; any line naming a swap or a forged record: ${pick(/verifier swap|records made up to block|updateVerifier|VerifierUpdated|forged|attestationRecords/i, audit).length}`,
    );
    expect(verdict).to.contain("audit failed");
    for (const [name] of CIRCUITS)
      expect(
        pick(new RegExp(`❌ ${name} records made up to block \\d+`), audit),
      ).to.have.lengthOf(1);

    // ---- afterwards: the forged records still count ----------------------------------------
    const now = (await ethers.provider.getBlock("latest"))!.timestamp;
    for (const [name, id] of CIRCUITS) {
      const info = await pm.getUserProofInfo(w.address, id);
      const left = Number(rec[id].expiresAt) - now;
      console.log(
        `      after ceremony + votes + clean audit: stranger's forged ${name} isValid=${info.isValid}, ${(left / DAY).toFixed(1)} days left (chain now ${new Date(now * 1000).toISOString()})`,
      );
    }
    // The fixture runs governance at TIME_SCALE 1440; at TIME_SCALE 1 the same steps take 1440x the chain time.
    const scale = await f.c.governance.TIME_SCALE();
    for (const [name, id] of CIRCUITS) {
      const full = ((now - marks[id].at) * Number(scale)) / DAY;
      const validity = Number(rec[id].expiresAt - BigInt(marks[id].at)) / DAY;
      console.log(
        `      ${name}: forged ${now - marks[id].at}s of chain time before this audit = ${full.toFixed(1)} days at TIME_SCALE 1; record validity ${validity} days => still valid at TIME_SCALE 1: ${full < validity}`,
      );
    }
    const j = await pm.validatePrivateJurisdiction.staticCall(w.address);
    const a = await pm.validatePrivateAccreditation.staticCall(w.address);
    const c = await pm.validatePrivateCompliance.staticCall(w.address);
    const all = await pm.validateAllPrivateCompliance(w.address);
    console.log(
      `      validatePrivateJurisdiction/Accreditation/Compliance(stranger) = ${j}/${a}/${c}; validateAllPrivateCompliance = [${all.join(", ")}]`,
    );
    const ctrl = await pm.validateAllPrivateCompliance(control.address);
    console.log(
      `      control wallet validateAllPrivateCompliance = [${ctrl.join(", ")}]`,
    );
    expect(ctrl.every((x: boolean) => x === false)).to.equal(true);
    // jurisdiction + compliance were forged at the 30-day default: report whether they outlived the votes; accreditation (365 days) must have
    expect((await pm.getUserProofInfo(w.address, ACC)).isValid).to.equal(true);
    expect(await pm.owner()).to.equal(f.govAddr);
    expect(await zk.owner()).to.equal(f.govAddr);

    // ---- how long it stays valid: expiry, or a policy epoch / attestor epoch change --------
    const stillJ = (await pm.getUserProofInfo(w.address, JUR)).isValid;
    const stillC = (await pm.getUserProofInfo(w.address, COMP)).isValid;
    console.log(
      `      30-day-default records after the votes: jurisdiction ${stillJ}, compliance ${stillC}`,
    );
    const { takeSnapshot } =
      await import("@nomicfoundation/hardhat-network-helpers");
    const snap = await takeSnapshot();
    for (const [name, id] of [
      ["jurisdiction", JUR],
      ["compliance", COMP],
      ["accreditation", ACC],
    ] as [string, string][]) {
      const snap2 = await takeSnapshot();
      await time.increaseTo(Number(rec[id].expiresAt) - 5);
      const before = (await pm.getUserProofInfo(w.address, id)).isValid;
      await time.increaseTo(Number(rec[id].expiresAt) + 1);
      const after = (await pm.getUserProofInfo(w.address, id)).isValid;
      console.log(
        `      ${name}: 5s before its expiresAt ${before}, 1s after ${after}`,
      );
      expect([before, after]).to.deep.equal([true, false]);
      await snap2.restore();
    }
    // What ends it early: a governance vote that changes the attestor's trust or the circuit's policy.
    const calls = (fn: string, ...a: any[]) =>
      pm.interface.encodeFunctionData(fn, a);
    const eBefore = await pm.attestorEpoch(JUR, attestor);
    await byVote(f, 11, pm, calls("setTrustedAttestor", JUR, Ax, Ay, true)); // re-approval again
    console.log(
      `      another re-approval vote (trusted -> trusted): jurisdiction isValid ${(await pm.getUserProofInfo(w.address, JUR)).isValid}, attestorEpoch ${eBefore} -> ${await pm.attestorEpoch(JUR, attestor)}`,
    );
    expect((await pm.getUserProofInfo(w.address, JUR)).isValid).to.equal(true);
    await byVote(f, 11, pm, calls("setTrustedAttestor", JUR, Ax, Ay, false));
    await byVote(f, 11, pm, calls("setTrustedAttestor", JUR, Ax, Ay, true));
    console.log(
      `      untrust vote then re-trust vote: jurisdiction isValid ${(await pm.getUserProofInfo(w.address, JUR)).isValid}, attestorEpoch -> ${await pm.attestorEpoch(JUR, attestor)} (the epoch only grows)`,
    );
    expect((await pm.getUserProofInfo(w.address, JUR)).isValid).to.equal(false);
    await byVote(f, 11, pm, calls("setMinimumAccreditation", 101));
    console.log(
      `      setMinimumAccreditation vote: accreditation isValid ${(await pm.getUserProofInfo(w.address, ACC)).isValid}, policyEpoch -> ${await pm.policyEpoch(ACC)}`,
    );
    expect((await pm.getUserProofInfo(w.address, ACC)).isValid).to.equal(false);
    expect((await pm.getUserProofInfo(w.address, COMP)).isValid).to.equal(true); // compliance untouched by both
    out.length = 0;
    let partial = "ok";
    await captured(out, () => runHandover(cfg, "audit", cfgPath)).catch(
      (e: any) => (partial = e.message),
    );
    const left = pick(/records made up to block/, out.join("\n"));
    console.log(
      `      audit with compliance records still valid: ${partial}; ${left.map((l) => l.trim()).join(" | ")}`,
    );
    expect(partial).to.contain("audit failed");
    expect(left).to.have.lengthOf(1);
    expect(left[0]).to.contain("❌ compliance records made up to block");
    await byVote(f, 11, pm, calls("setTrustedAttestor", COMP, Ax, Ay, false));
    await byVote(f, 11, pm, calls("setTrustedAttestor", COMP, Ax, Ay, true));
    expect((await pm.getUserProofInfo(w.address, COMP)).isValid).to.equal(
      false,
    );
    out.length = 0;
    let lapsed = "ok";
    await captured(out, () => runHandover(cfg, "audit", cfgPath)).catch(
      (e: any) => (lapsed = e.message),
    );
    console.log(
      `      audit once every forged record lapsed: ${lapsed}; ${pick(
        /Audit passed/,
        out.join("\n"),
      )
        .join(" | ")
        .trim()}`,
    );
    expect(lapsed).to.equal("ok");
    expect(
      pick(/✅ verifier swaps since fromBlock \d+: 6/, out.join("\n")),
    ).to.have.lengthOf(1);
    await snap.restore();

    fs.rmSync(dir, { recursive: true, force: true });
  });
});
