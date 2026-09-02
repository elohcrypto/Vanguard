import { expect } from "chai";
import { ethers } from "hardhat";

/**
 * Demonstrates the trust assumption behind ZKVerifierIntegrated.updateVerifier().
 *
 * `testingMode` is immutable, so a mainnet instance cannot be flipped into
 * mock-verification mode. But in production mode verification delegates to a
 * swappable verifier address (ZKVerifierIntegrated.sol:101), and updateVerifier()
 * (line 407) lets the owner replace it with any contract exposing verifyProof.
 *
 * The immutability of testingMode therefore does NOT bound the owner's power:
 * a single key can install an accept-everything verifier and reach the same
 * outcome. This test pins that behaviour so it is a documented, tested property
 * rather than a surprise during audit.
 */
describe("ZKVerifierIntegrated — updateVerifier trust assumption", () => {
  // The rogue verifier lives in contracts/test/mocks/AlwaysTrueVerifier.sol.
  // It is not duplicated here: a copy of the source in this file would drift
  // silently if the contract changed.

  it("owner can swap in a verifier that accepts any proof, even with testingMode=false", async () => {
    const [owner] = await ethers.getSigners();

    // Production mode: no mock shortcut, real Groth16 verification.
    const Integrated = await ethers.getContractFactory("ZKVerifierIntegrated");
    const zk = await Integrated.deploy(false);
    await zk.waitForDeployment();
    expect(await zk.testingMode()).to.equal(false);

    // A garbage proof must be rejected by the genuine verifier.
    const a: [bigint, bigint] = [1n, 2n];
    const b: [[bigint, bigint], [bigint, bigint]] = [
      [3n, 4n],
      [5n, 6n],
    ];
    const c: [bigint, bigint] = [7n, 8n];
    const signals: [bigint] = [9n];

    expect(
      await zk.verifyWhitelistMembership.staticCall(a, b, c, signals),
    ).to.equal(false);

    // Owner installs a verifier that returns true unconditionally.
    const rogue = await (
      await ethers.getContractFactory("AlwaysTrueVerifier")
    ).deploy();
    await rogue.waitForDeployment();
    await zk
      .connect(owner)
      .updateVerifier("whitelist", await rogue.getAddress());

    // The same garbage proof is now accepted. Compliance is bypassed with one tx.
    expect(
      await zk.verifyWhitelistMembership.staticCall(a, b, c, signals),
    ).to.equal(true);
  });

  it("rejects an address with no code, instead of bricking the proof type", async () => {
    const [owner] = await ethers.getSigners();
    const zk = await (
      await ethers.getContractFactory("ZKVerifierIntegrated")
    ).deploy(false);
    await zk.waitForDeployment();

    // An EOA is not a verifier. Before this guard the setter accepted it and
    // every later verify* call reverted with no reason string.
    await expect(
      zk.updateVerifier("whitelist", owner.address),
    ).to.be.revertedWith("ZKVerifierIntegrated: Verifier is not a contract");

    // The real verifier still works, so the guard is not over-broad.
    const rogue = await (
      await ethers.getContractFactory("AlwaysTrueVerifier")
    ).deploy();
    await rogue.waitForDeployment();
    await expect(zk.updateVerifier("whitelist", await rogue.getAddress())).to
      .not.be.reverted;
  });

  it("updateVerifier is restricted to the owner", async () => {
    const [, attacker] = await ethers.getSigners();
    const zk = await (
      await ethers.getContractFactory("ZKVerifierIntegrated")
    ).deploy(false);
    await zk.waitForDeployment();

    const rogue = await (
      await ethers.getContractFactory("AlwaysTrueVerifier")
    ).deploy();
    await rogue.waitForDeployment();

    await expect(
      zk
        .connect(attacker)
        .updateVerifier("whitelist", await rogue.getAddress()),
    ).to.be.reverted;
  });

  it("the swapped-in verifier accepts arbitrary proofs, not one crafted case", async () => {
    const zk = await (
      await ethers.getContractFactory("ZKVerifierIntegrated")
    ).deploy(false);
    await zk.waitForDeployment();

    const rogue = await (
      await ethers.getContractFactory("AlwaysTrueVerifier")
    ).deploy();
    await rogue.waitForDeployment();
    await zk.updateVerifier("whitelist", await rogue.getAddress());

    // Random proofs across several rounds: the bypass is total, not input-specific.
    const rand = () =>
      BigInt("0x" + ethers.hexlify(ethers.randomBytes(31)).slice(2));
    for (let i = 0; i < 5; i++) {
      const accepted = await zk.verifyWhitelistMembership.staticCall(
        [rand(), rand()],
        [
          [rand(), rand()],
          [rand(), rand()],
        ],
        [rand(), rand()],
        [rand()],
      );
      expect(accepted, `random proof #${i} should have been accepted`).to.equal(
        true,
      );
    }
  });
});
