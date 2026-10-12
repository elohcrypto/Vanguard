import { expect } from "chai";
import { ethers } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";
const { underCoverage } = require("../helpers/zkProofs") as {
  underCoverage: () => boolean;
};

// Plan v2 Task 4.14 (A2 H-1, D42): a purpose list a rogue key bloated
// cannot block recovery. _removeKey is O(1) through a position index,
// addKey caps every purpose at 64 and KeyManager batches at 50; the
// internal _addKey (eviction, acceptOwnership) stays uncapped, so the
// bloat below is built through a test-only subclass, as a list grown
// before the cap would be. Every fact is read from the chain.
//
// Task 4.15: under coverage (instrumented bytecode, every step traced
// off-chain) the 5,000-key scenario is one of the suite's largest traces
// and its gas bound is the real build's, not the instrumented one's: the
// same path runs with 70 keys (past the 64 cap, the candidate through
// addRaw) and the gas is printed, not bounded. `hardhat test` keeps 5,000.

const MGMT = 1;
const ACTION = 2;
const HOUR = 3600;
const DAY = 24 * HOUR;
const k = (a: string) => ethers.solidityPackedKeccak256(["address"], [a]);
const COVERAGE = underCoverage();
const JUNK = COVERAGE ? 70 : 5_000;
const CHUNK = 90;
const GAS_NOTE = COVERAGE
  ? " (coverage: 70 keys, gas printed, not bounded)"
  : "";

async function setup(bloated: boolean) {
  const [owner, A, B, C, rogue, rescued, anyone] = await ethers.getSigners();
  const id = bloated
    ? await (await ethers.getContractFactory("BloatedOnchainID")).deploy()
    : await (
        await ethers.getContractFactory("OnchainID")
      ).deploy(owner.address);
  if (bloated) await id.initialize(owner.address, k(owner.address));
  const idA = await id.getAddress();
  const km = await (await ethers.getContractFactory("KeyManager")).deploy();
  const kmA = await km.getAddress();
  await id.authorizeManager(kmA);
  await id.pinRecoveryManager(kmA);
  await id.addKey(k(rogue.address), MGMT, 1);
  await km.setupKeyRecovery(idA, [A.address, B.address, C.address], 2);
  return { owner, A, B, C, rogue, rescued, anyone, id, idA, km, kmA };
}

/** Opens (the opener's approval, D39) and approves 2 of 3 onto `key`. */
async function approve(f: Awaited<ReturnType<typeof setup>>, key: string) {
  await f.km.connect(f.A).initiateKeyRecovery(f.idA, key);
  await f.km.connect(f.B).approveKeyRecovery(f.idA, key);
}

describe("Recovery against a bloated key list (4.14, H-1)", function () {
  this.timeout(600_000);

  it(`executeKeyRecovery stays under 400k gas with ${JUNK} ACTION keys and the candidate at the tail${GAS_NOTE}`, async function () {
    const f = await setup(true);
    const bloated = await ethers.getContractAt("BloatedOnchainID", f.idA);
    for (let done = 0; done < JUNK; done += CHUNK) {
      await bloated.bloat(ACTION, Math.min(CHUNK, JUNK - done), done);
    }
    expect((await f.id.getKeysByPurpose(ACTION)).length).to.equal(JUNK);
    const key = k(f.rescued.address);
    await approve(f, key);
    // The thief parks the candidate under ACTION at the tail of the list
    // (the capped addKey would refuse it; the uncapped path stands in).
    await bloated.addRaw(key, ACTION);
    expect(await f.id.keyHasPurpose(key, ACTION)).to.equal(true);
    await time.increase(2 * DAY + 1);
    const receipt = await (
      await f.km.connect(f.anyone).executeKeyRecovery(f.idA, key)
    ).wait();
    console.log(
      `      executeKeyRecovery gasUsed ${receipt!.gasUsed} (${JUNK} keys)`,
    );
    if (!COVERAGE) expect(receipt!.gasUsed).to.be.lt(400_000n);
    expect(await f.id.keyHasPurpose(key, MGMT)).to.equal(true);
    expect(await f.id.keyHasPurpose(key, ACTION)).to.equal(false);
    expect(await f.id.keyHasPurpose(k(f.rogue.address), MGMT)).to.equal(false);
    expect((await f.id.getKeysByPurpose(ACTION)).length).to.equal(JUNK);
    expect((await f.id.getKeysByPurpose(MGMT)).length).to.equal(1);
    // The owner transfer walks the same list and stays bounded too.
    await time.increase(5 * DAY);
    const t = await (
      await f.km
        .connect(f.anyone)
        .executeOwnerTransfer(f.idA, f.rescued.address)
    ).wait();
    console.log(
      `      executeOwnerTransfer gasUsed ${t!.gasUsed} (${JUNK} keys)`,
    );
    if (!COVERAGE) expect(t!.gasUsed).to.be.lt(400_000n);
    await f.id.connect(f.rescued).acceptOwnership();
    expect(await f.id.owner()).to.equal(f.rescued.address);
  });

  it("swap-and-pop keeps the list and the index consistent", async function () {
    const f = await setup(false);
    const [x, y, z] = ["x", "y", "z"].map((s) => ethers.id(s));
    for (const key of [x, y, z]) await f.id.addKey(key, ACTION, 1);
    await f.id.removeKey(x, ACTION); // the middle: z moves to x's slot
    expect(await f.id.getKeysByPurpose(ACTION)).to.deep.equal([z, y]);
    await f.id.removeKey(z, ACTION); // the moved key, at its new slot
    expect(await f.id.getKeysByPurpose(ACTION)).to.deep.equal([y]);
    await f.id.addKey(x, ACTION, 1); // a revoked key re-activates
    await f.id.removeKey(y, ACTION);
    expect(await f.id.getKeysByPurpose(ACTION)).to.deep.equal([x]);
    expect(await f.id.keyHasPurpose(y, ACTION)).to.equal(false);
    expect(await f.id.keyHasPurpose(x, ACTION)).to.equal(true);
    await expect(f.id.removeKey(y, ACTION)).to.be.revertedWith(
      "OnchainID: Key already revoked",
    );
  });

  it("addKey refuses the 65th key of a purpose; a removal frees a slot", async function () {
    const f = await setup(false);
    expect(await f.id.MAX_KEYS_PER_PURPOSE()).to.equal(64n);
    for (let i = 0; i < 64; i++)
      await f.id.addKey(ethers.id(`a${i}`), ACTION, 1);
    await expect(f.id.addKey(ethers.id("a64"), ACTION, 1))
      .to.be.revertedWithCustomError(f.id, "TooManyKeys")
      .withArgs(ACTION);
    // MANAGEMENT holds owner + rogue: its own count, not ACTION's.
    await f.id.addKey(ethers.id("m"), MGMT, 1);
    await f.id.removeKey(ethers.id("a0"), ACTION);
    await f.id.addKey(ethers.id("a64"), ACTION, 1);
    expect((await f.id.getKeysByPurpose(ACTION)).length).to.equal(64);
  });

  it("a rotation at the cap succeeds and the count stays 64 (N-3)", async function () {
    const f = await setup(false);
    for (let i = 0; i < 64; i++)
      await f.id.addKey(ethers.id(`r${i}`), ACTION, 1);
    const oldKey = ethers.id("r63");
    const newKey = ethers.id("r64");
    await f.km.initiateKeyRotation(f.idA, oldKey, newKey, ACTION);
    await time.increase(DAY + 1);
    await f.km
      .connect(f.anyone)
      .executeKeyRotation(f.idA, oldKey, newKey, ACTION);
    expect(await f.id.keyHasPurpose(newKey, ACTION)).to.equal(true);
    expect(await f.id.keyHasPurpose(oldKey, ACTION)).to.equal(false);
    expect((await f.id.getKeysByPurpose(ACTION)).length).to.equal(64);
  });

  it("KeyManager batches are capped at 50 and inherit the per-purpose cap", async function () {
    const f = await setup(false);
    expect(await f.km.MAX_BATCH_SIZE()).to.equal(50n);
    const keys = Array.from({ length: 51 }, (_, i) => ethers.id(`b${i}`));
    const purposes = keys.map(() => ACTION);
    const types = keys.map(() => 1);
    await expect(f.km.batchAddKeys(f.idA, keys, purposes, types))
      .to.be.revertedWithCustomError(f.km, "BatchTooLarge")
      .withArgs(51);
    await expect(f.km.batchRemoveKeys(f.idA, keys, purposes))
      .to.be.revertedWithCustomError(f.km, "BatchTooLarge")
      .withArgs(51);
    await f.km.batchAddKeys(
      f.idA,
      keys.slice(0, 50),
      purposes.slice(0, 50),
      types.slice(0, 50),
    );
    const more = Array.from({ length: 15 }, (_, i) => ethers.id(`c${i}`));
    await expect(
      f.km.batchAddKeys(
        f.idA,
        more,
        more.map(() => ACTION),
        more.map(() => 1),
      ),
    )
      .to.be.revertedWithCustomError(f.id, "TooManyKeys")
      .withArgs(ACTION);
    await f.km.batchAddKeys(
      f.idA,
      more.slice(0, 14),
      more.slice(0, 14).map(() => ACTION),
      more.slice(0, 14).map(() => 1),
    );
    expect((await f.id.getKeysByPurpose(ACTION)).length).to.equal(64);
  });
});
