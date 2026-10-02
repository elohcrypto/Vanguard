import { expect } from "chai";
import { ethers } from "hardhat";

// Every verify* function cached by keccak256(a, b, c, publicSignals) with no
// circuit identifier and checked that shared cache BEFORE its own verifier.
// Four circuits share the identical uint256[1] signal shape, so a proof that
// verified once under whitelist satisfied verifyBlacklistNonMembership on the
// cache hit — the blacklist verifier was never called.
describe("Proof cache is bound to the circuit that verified it", () => {
  const a: [number, number] = [1, 2];
  const b: [[number, number], [number, number]] = [
    [3, 4],
    [5, 6],
  ];
  const c: [number, number] = [7, 8];
  // Whitelist is PLONK since Task 3.1: 24 proof words, 3 public signals.
  const P = Array.from({ length: 24 }, (_, i) => i + 1);
  const S: [number, number, number] = [1, 2, 3];

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
    await expect(zk.verifyWhitelistMembership(P, S)).to.emit(
      zk,
      "ProofCached",
    );
    // Same [1] signal, different circuit: must reach the real
    // blacklist verifier, which rejects. Before the fix: cache hit, true.
    expect(
      await zk.verifyBlacklistNonMembership.staticCall(a, b, c, [1]),
    ).to.equal(false);
  });

  // Groth16 vs Groth16: the same (a, b, c, [1]) tuple and preimage length,
  // so only the circuit tag in the key keeps these entries apart.
  it("a blacklist-verified Groth16 proof satisfies neither jurisdiction nor accreditation", async () => {
    const zk = await deployReal(["blacklist"]);
    await expect(zk.verifyBlacklistNonMembership(a, b, c, [1])).to.emit(
      zk,
      "ProofCached",
    );
    expect(
      await zk.verifyBlacklistNonMembership.staticCall(a, b, c, [1]),
    ).to.equal(true); // same circuit: cache hit is correct
    expect(await zk.verifyJurisdictionProof.staticCall(a, b, c, [1])).to.equal(
      false,
    );
    expect(await zk.verifyAccreditationProof.staticCall(a, b, c, [1])).to.equal(
      false,
    );
  });

  it("the batch path shares the whitelist cache, not the others", async () => {
    const zk = await deployReal();
    await zk.verifyWhitelistMembership(P, S);
    const [results] = await zk.verifyBatchWhitelistMembership.staticCall(
      [P],
      [S],
    );
    expect(results[0]).to.equal(true); // same circuit: cache hit is correct
    expect(
      await zk.verifyBlacklistNonMembership.staticCall(a, b, c, [1]),
    ).to.equal(false);
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
    expect(await zk.whitelistProofCacheKey(P, S)).to.not.equal(
      keyBefore,
    );
    expect(
      await zk.verifyWhitelistMembership.staticCall(P, S),
    ).to.equal(false);
  });

  it("the compliance-proof tag keys the 2-signal path, separate from compliance", async () => {
    const zk = await deployReal();
    expect(
      await zk.proofCacheKey("compliance-proof", a, b, c, [1, 2]),
    ).to.not.equal(await zk.proofCacheKey("compliance", a, b, c, [1, 2]));
  });

  it("proofCacheKey exposes the bound key so clearExpiredProofs still works", async () => {
    const zk = await deployReal();
    await zk.verifyWhitelistMembership(P, S);
    const key = await zk.whitelistProofCacheKey(P, S);
    await zk.setProofCacheExpiry(3600);
    await ethers.provider.send("evm_increaseTime", [3601]);
    await ethers.provider.send("evm_mine", []);
    await zk.clearExpiredProofs([key]);
    await expect(zk.verifyWhitelistMembership(P, S)).to.emit(
      zk,
      "ProofCached",
    );
  });
});
