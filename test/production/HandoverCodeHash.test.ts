import { expect } from "chai";
import { artifacts, ethers } from "hardhat";

const {
  VERIFIERS,
  codeHashChecks,
} = require("../../demo/utils/HandoverCodeHash");

// Review 3.3 MEDIUM-1/2: the ceremony pins the privacy contracts by an exact
// runtime code hash. That is sound only if no pinned contract carries an
// immutable that differs between the artifact and an honest deployment.
describe("Handover code-hash pins (3.3 review MEDIUM-1/2)", function () {
  const source = (name: string) =>
    name === "PrivacyManager" || name === "ZKVerifierIntegrated"
      ? `contracts/privacy/${name}.sol`
      : `contracts/privacy/verifiers/${
          {
            WhitelistMembershipVerifier: "whitelist_membership",
            BlacklistMembershipVerifier: "blacklist_membership",
            JurisdictionProofVerifier: "jurisdiction_proof",
            AccreditationProofVerifier: "accreditation_proof",
            ComplianceAggregationVerifier: "compliance_aggregation",
          }[name]
        }Verifier.sol`;
  async function immutableRanges(name: string) {
    const src = source(name);
    const info = await artifacts.getBuildInfo(`${src}:${name}`);
    const refs = (info!.output.contracts[src][name] as any).evm.deployedBytecode
      .immutableReferences;
    return refs as Record<string, { start: number; length: number }[]>;
  }

  it("PrivacyManager and the five circuit verifiers have no immutables", async function () {
    for (const name of [
      "PrivacyManager",
      ...VERIFIERS.map(([, n]: string[]) => n),
    ]) {
      expect(await immutableRanges(name), name).to.deep.equal({});
    }
  });

  it("a real-mode wrapper matches the artifact exactly; testingMode differs only in its immutable", async function () {
    const refs = await immutableRanges("ZKVerifierIntegrated");
    // testingMode is the only immutable.
    expect(Object.keys(refs)).to.have.length(1);
    const ranges = Object.values(refs)[0];
    expect(ranges.length).to.be.greaterThan(0);
    const art = ethers.getBytes(
      (await artifacts.readArtifact("ZKVerifierIntegrated")).deployedBytecode,
    );
    const inside = (i: number) =>
      ranges.some((r) => i >= r.start && i < r.start + r.length);
    // The artifact holds a zero word where the immutable goes.
    for (const r of ranges) {
      expect(art.slice(r.start, r.start + r.length).every((b) => b === 0)).to.be
        .true;
    }
    const F = await ethers.getContractFactory("ZKVerifierIntegrated");
    const real = await F.deploy(false);
    const testing = await F.deploy(true);
    const code = async (x: any) =>
      ethers.getBytes(await ethers.provider.getCode(await x.getAddress()));
    expect(ethers.hexlify(await code(real))).to.equal(ethers.hexlify(art));
    const t = await code(testing);
    expect(t.length).to.equal(art.length);
    let diffs = 0;
    for (let i = 0; i < art.length; i++) {
      if (t[i] === art[i]) continue;
      expect(inside(i), `byte ${i} differs outside the immutable`).to.be.true;
      diffs++;
    }
    expect(diffs).to.equal(ranges.length); // one byte (0x01) per reference

    // (d) so a testingMode wrapper fails the pin as well as the flag.
    const [real1, ...verifiers] = await codeHashChecks(null, [real]);
    expect(real1.ok).to.equal(true);
    expect(verifiers.map((c: any) => c.ok)).to.deep.equal([
      true,
      true,
      true,
      true,
      true,
    ]);
    const [bad, ...rest] = await codeHashChecks(null, [testing]);
    expect(bad.ok).to.equal(false);
    expect(bad.label).to.equal("ZKVerifierIntegrated");
    // A wrapper that failed its own pin is not asked for its verifiers.
    expect(rest).to.deep.equal([]);
  });
});
