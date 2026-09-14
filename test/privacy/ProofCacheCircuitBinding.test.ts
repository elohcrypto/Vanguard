import { expect } from "chai";
import { ethers } from "hardhat";

// Every verify* function cached by keccak256(a, b, c, publicSignals) with no
// circuit identifier and checked that shared cache BEFORE its own verifier.
// Four circuits share the identical uint256[1] signal shape, so a proof that
// verified once under whitelist satisfied verifyBlacklistNonMembership on the
// cache hit — the blacklist verifier was never called.
describe("Proof cache is bound to the circuit that verified it", () => {
  const a: [number, number] = [1, 2];
  const b: [[number, number], [number, number]] = [[3, 4], [5, 6]];
  const c: [number, number] = [7, 8];

  async function deployReal() {
    // testingMode=false: only a real verifier accepts. AlwaysTrueVerifier on
    // whitelist ONLY; every other slot keeps the default (rejecting) verifier.
    const zk = await (await ethers.getContractFactory("ZKVerifierIntegrated")).deploy(false);
    const yes = await (await ethers.getContractFactory("AlwaysTrueVerifier")).deploy();
    await zk.updateVerifier("whitelist", await yes.getAddress());
    return zk;
  }

  it("a whitelist-verified proof does NOT satisfy blacklist non-membership", async () => {
    const zk = await deployReal();
    await expect(zk.verifyWhitelistMembership(a, b, c, [1])).to.emit(zk, "ProofCached");
    // Same tuple, same [1] signal, different circuit: must reach the real
    // blacklist verifier, which rejects. Before the fix: cache hit, true.
    expect(await zk.verifyBlacklistNonMembership.staticCall(a, b, c, [1])).to.equal(false);
  });

  it("nor jurisdiction, nor accreditation", async () => {
    const zk = await deployReal();
    await zk.verifyWhitelistMembership(a, b, c, [1]);
    expect(await zk.verifyJurisdictionProof.staticCall(a, b, c, [1])).to.equal(false);
    expect(await zk.verifyAccreditationProof.staticCall(a, b, c, [1])).to.equal(false);
  });

  it("the batch path shares the whitelist cache, not the others", async () => {
    const zk = await deployReal();
    await zk.verifyWhitelistMembership(a, b, c, [1]);
    const [results] = await zk.verifyBatchWhitelistMembership.staticCall([a], [b], [c], [[1]]);
    expect(results[0]).to.equal(true); // same circuit: cache hit is correct
    expect(await zk.verifyBlacklistNonMembership.staticCall(a, b, c, [1])).to.equal(false);
  });

  it("still caches within a circuit: second whitelist call is a cache hit", async () => {
    const zk = await deployReal();
    await zk.verifyWhitelistMembership(a, b, c, [1]);
    await expect(zk.verifyWhitelistMembership(a, b, c, [1])).to.emit(zk, "ProofCacheHit");
  });

  // Augment on PR #9: the key used the tag, not the verifier instance, so a
  // cached proof kept answering true after updateVerifier until expiry.
  it("rotating a verifier invalidates proofs cached under the old one", async () => {
    const zk = await deployReal();
    await zk.verifyWhitelistMembership(a, b, c, [1]);
    const keyBefore = await zk.proofCacheKey("whitelist", a, b, c, [1]);
    // Swap to the default (rejecting) Groth16 verifier: the old acceptance must not survive.
    const strict = await (await ethers.getContractFactory("WhitelistMembershipVerifier")).deploy();
    await zk.updateVerifier("whitelist", await strict.getAddress());
    expect(await zk.proofCacheKey("whitelist", a, b, c, [1])).to.not.equal(keyBefore);
    expect(await zk.verifyWhitelistMembership.staticCall(a, b, c, [1])).to.equal(false);
  });

  it("the compliance-proof tag keys the 2-signal path, separate from compliance", async () => {
    const zk = await deployReal();
    expect(await zk.proofCacheKey("compliance-proof", a, b, c, [1, 2]))
      .to.not.equal(await zk.proofCacheKey("compliance", a, b, c, [1, 2]));
  });

  it("proofCacheKey exposes the bound key so clearExpiredProofs still works", async () => {
    const zk = await deployReal();
    await zk.verifyWhitelistMembership(a, b, c, [1]);
    const key = await zk.proofCacheKey("whitelist", a, b, c, [1]);
    await zk.setProofCacheExpiry(3600);
    await ethers.provider.send("evm_increaseTime", [3601]);
    await ethers.provider.send("evm_mine", []);
    await zk.clearExpiredProofs([key]);
    await expect(zk.verifyWhitelistMembership(a, b, c, [1])).to.emit(zk, "ProofCached");
  });
});
