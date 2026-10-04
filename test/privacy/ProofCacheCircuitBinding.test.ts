import { expect } from "chai";
import { ethers } from "hardhat";

// Every verify* function cached by keccak256(a, b, c, publicSignals) with no
// circuit identifier and checked that shared cache BEFORE its own verifier.
// Four circuits shared the identical uint256[1] signal shape, so a proof that
// verified once under whitelist satisfied verifyBlacklistNonMembership on the
// cache hit — the blacklist verifier was never called. Every circuit is
// PLONK now (whitelist 3.1, blacklist 3.7, the attestation circuits 3.7b);
// jurisdiction and accreditation share the 8-signal shape.
describe("Proof cache is bound to the circuit that verified it", () => {
  // Whitelist is PLONK since Task 3.1: 24 proof words, 3 public signals.
  const P = Array.from({ length: 24 }, (_, i) => i + 1);
  const S: [number, number, number] = [1, 2, 3];
  // Blacklist is PLONK since Task 3.7: 24 proof words, 4 public signals.
  const S4: [number, number, number, number] = [1, 2, 3, 4];
  // Jurisdiction and accreditation (Task 3.8 M1, 3.10): 8 signals.
  const S5 = [1, 2, 3, 4, 5, 6, 7, 8] as [
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
  ];

  async function deployReal(accepting: string[] = ["whitelist"]) {
    // testingMode=false: only a real verifier accepts. AlwaysTrueVerifier on
    // the listed slots ONLY; every other slot keeps the default (rejecting)
    // verifier.
    const zk = await (
      await ethers.getContractFactory("ZKVerifierIntegrated")
    ).deploy(false);
    const yes = await (
      await ethers.getContractFactory("AlwaysTrueVerifier")
    ).deploy();
    for (const slot of accepting) {
      await zk.updateVerifier(slot, await yes.getAddress());
    }
    return zk;
  }

  it("a whitelist-verified proof does NOT satisfy blacklist non-membership", async () => {
    const zk = await deployReal();
    await expect(zk.verifyWhitelistMembership(P, S)).to.emit(zk, "ProofCached");
    // Same 24 proof words, different circuit: must reach the real
    // blacklist verifier, which rejects. Before the fix: cache hit, true.
    expect(await zk.verifyBlacklistNonMembership.staticCall(P, S4)).to.equal(
      false,
    );
  });

  // Same shape (24 words, 8 signals) and preimage length, so only the
  // circuit tag in the key keeps these entries apart.
  it("a jurisdiction-verified proof does not satisfy accreditation", async () => {
    const zk = await deployReal(["jurisdiction"]);
    await expect(zk.verifyJurisdictionProof(P, S5)).to.emit(zk, "ProofCached");
    expect(await zk.verifyJurisdictionProof.staticCall(P, S5)).to.equal(true); // same circuit: cache hit is correct
    expect(await zk.verifyAccreditationProof.staticCall(P, S5)).to.equal(false);
  });

  // PLONK vs PLONK: a blacklist entry must not answer the whitelist.
  it("a blacklist-verified PLONK proof does not satisfy the whitelist", async () => {
    const zk = await deployReal(["blacklist"]);
    await expect(zk.verifyBlacklistNonMembership(P, S4)).to.emit(
      zk,
      "ProofCached",
    );
    expect(await zk.verifyBlacklistNonMembership.staticCall(P, S4)).to.equal(
      true,
    );
    expect(await zk.verifyWhitelistMembership.staticCall(P, S)).to.equal(false);
  });

  // Same verifier INSTANCE in two slots (testingMode uses address(0) for all
  // of them): now only the circuit tag separates the keys. A cached
  // accreditation entry must not answer jurisdiction from the cache.
  it("the circuit tag alone keeps two slots apart when they share a verifier", async () => {
    const zk = await deployReal(["accreditation", "jurisdiction"]);
    expect(await zk.proofCacheKey("accreditation", P, S5)).to.not.equal(
      await zk.proofCacheKey("jurisdiction", P, S5),
    );
    await expect(zk.verifyAccreditationProof(P, S5)).to.emit(zk, "ProofCached");
    await expect(zk.verifyJurisdictionProof(P, S5))
      .to.emit(zk, "ProofCached")
      .and.not.to.emit(zk, "ProofCacheHit");
  });

  it("the batch path shares the whitelist cache, not the others", async () => {
    const zk = await deployReal();
    await zk.verifyWhitelistMembership(P, S);
    const [results] = await zk.verifyBatchWhitelistMembership.staticCall(
      [P],
      [S],
    );
    expect(results[0]).to.equal(true); // same circuit: cache hit is correct
    expect(await zk.verifyBlacklistNonMembership.staticCall(P, S4)).to.equal(
      false,
    );
  });

  it("still caches within a circuit: second whitelist call is a cache hit", async () => {
    const zk = await deployReal();
    await zk.verifyWhitelistMembership(P, S);
    await expect(zk.verifyWhitelistMembership(P, S)).to.emit(
      zk,
      "ProofCacheHit",
    );
  });

  // Augment on PR #9: the key used the tag, not the verifier instance, so a
  // cached proof kept answering true after updateVerifier until expiry.
  it("rotating a verifier invalidates proofs cached under the old one", async () => {
    const zk = await deployReal();
    await zk.verifyWhitelistMembership(P, S);
    const keyBefore = await zk.whitelistProofCacheKey(P, S);
    // Swap to the default (rejecting) PLONK verifier: the old acceptance must not survive.
    const strict = await (
      await ethers.getContractFactory("WhitelistMembershipVerifier")
    ).deploy();
    await zk.updateVerifier("whitelist", await strict.getAddress());
    expect(await zk.whitelistProofCacheKey(P, S)).to.not.equal(keyBefore);
    expect(await zk.verifyWhitelistMembership.staticCall(P, S)).to.equal(false);
  });

  it("the routed and typed attestation paths share one key per circuit", async () => {
    const zk = await deployReal(["compliance"]);
    const S9 = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]; // Task 3.10: 12
    const COMP = ethers.id("COMPLIANCE_AGGREGATION");
    await expect(zk.verifyCircuitProof(COMP, P, S9))
      .to.emit(zk, "ProofCached")
      .withArgs(await zk.proofCacheKey("compliance", P, S9), "compliance");
    await expect(zk.verifyComplianceAggregation(P, S9 as never)).to.emit(
      zk,
      "ProofCacheHit",
    );
  });

  it("proofCacheKey exposes the bound key so clearExpiredProofs still works", async () => {
    const zk = await deployReal();
    await zk.verifyWhitelistMembership(P, S);
    const key = await zk.whitelistProofCacheKey(P, S);
    await zk.setProofCacheExpiry(3600);
    await ethers.provider.send("evm_increaseTime", [3601]);
    await ethers.provider.send("evm_mine", []);
    await zk.clearExpiredProofs([key]);
    await expect(zk.verifyWhitelistMembership(P, S)).to.emit(zk, "ProofCached");
  });
});
