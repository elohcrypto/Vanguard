import { expect } from "chai";
import { ethers } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";

// Plan v2 Task 4.5. removeKeyWithProof: a MANAGEMENT key removes a key
// whose holder signed the getRemoveKeyMessage digest; removeKey is the
// management action without consent. R-45-1: a MANAGEMENT key adds keys
// at once (ERC-734); KeyManager's timelock binds only the rotations sent
// through it.

const MGMT = 1;
const ACTION = 2;
const ECDSA = 1;
const RSA = 2;
const k = (a: string) => ethers.solidityPackedKeccak256(["address"], [a]);

/** The inner message the holder signs (getRemoveKeyMessage before EIP-191). */
async function inner(id: any, key: string, purpose: number) {
  const { chainId } = await ethers.provider.getNetwork();
  return ethers.solidityPackedKeccak256(
    ["string", "address", "bytes32", "uint256", "uint256", "uint256"],
    [
      "Remove key from OnchainID",
      await id.getAddress(),
      key,
      purpose,
      await id.removalNonces(key),
      chainId,
    ],
  );
}

async function setup() {
  const [holder, mgr, stranger] = await ethers.getSigners();
  const id = await (
    await ethers.getContractFactory("OnchainID")
  ).deploy(holder.address);
  const other = await (
    await ethers.getContractFactory("OnchainID")
  ).deploy(holder.address);
  return { holder, mgr, stranger, id, other };
}

describe("OnchainID key removal (plan v2 Task 4.5)", function () {
  it("add a key, remove it with its holder's signature, it is gone", async function () {
    const { holder, id } = await setup();
    const w = ethers.Wallet.createRandom();
    const key = k(w.address);
    await id.connect(holder).addKey(key, ACTION, ECDSA);
    expect(await id.keyHasPurpose(key, ACTION)).to.equal(true);

    const msg = await inner(id, key, ACTION);
    const sig = await w.signMessage(ethers.getBytes(msg));
    const digest = await id.getRemoveKeyMessage(key, ACTION);
    expect(digest).to.equal(ethers.hashMessage(ethers.getBytes(msg)));
    expect(ethers.recoverAddress(digest, sig)).to.equal(w.address);

    await expect(id.connect(holder).removeKeyWithProof(key, ACTION, sig))
      .to.emit(id, "KeyRemoved")
      .withArgs(key, ACTION, ECDSA);
    expect(await id.keyHasPurpose(key, ACTION)).to.equal(false);
    expect((await id.getKey(key)).revokedAt).to.be.gt(0n);
    expect(await id.getKeysByPurpose(ACTION)).to.not.include(key);
  });

  it("refuses a wrong signer, a wrong purpose and a double prefix", async function () {
    const { holder, id } = await setup();
    const w = ethers.Wallet.createRandom();
    const thief = ethers.Wallet.createRandom();
    const key = k(w.address);
    await id.connect(holder).addKey(key, ACTION, ECDSA);
    const msg = await inner(id, key, ACTION);
    await expect(
      id
        .connect(holder)
        .removeKeyWithProof(
          key,
          ACTION,
          await thief.signMessage(ethers.getBytes(msg)),
        ),
    ).to.be.revertedWith(
      "OnchainID: Signature does not prove ownership of key",
    );
    await expect(
      id
        .connect(holder)
        .removeKeyWithProof(
          key,
          MGMT,
          await w.signMessage(ethers.getBytes(msg)),
        ),
    ).to.be.revertedWith("OnchainID: Purpose mismatch");
    // personal_sign of the already-prefixed digest prefixes twice.
    const digest = await id.getRemoveKeyMessage(key, ACTION);
    await expect(
      id
        .connect(holder)
        .removeKeyWithProof(
          key,
          ACTION,
          await w.signMessage(ethers.getBytes(digest)),
        ),
    ).to.be.revertedWith(
      "OnchainID: Signature does not prove ownership of key",
    );
    expect(await id.keyHasPurpose(key, ACTION)).to.equal(true);
  });

  it("a signature for one identity does not remove the key from another", async function () {
    const { holder, id, other } = await setup();
    const w = ethers.Wallet.createRandom();
    const key = k(w.address);
    await id.connect(holder).addKey(key, ACTION, ECDSA);
    await other.connect(holder).addKey(key, ACTION, ECDSA);
    const sig = await w.signMessage(
      ethers.getBytes(await inner(id, key, ACTION)),
    );
    await expect(
      other.connect(holder).removeKeyWithProof(key, ACTION, sig),
    ).to.be.revertedWith(
      "OnchainID: Signature does not prove ownership of key",
    );
    await id.connect(holder).removeKeyWithProof(key, ACTION, sig);
    expect(await other.keyHasPurpose(key, ACTION)).to.equal(true);
  });

  it("only a MANAGEMENT key sends it; a non-ECDSA key goes through removeKey", async function () {
    const { holder, stranger, id } = await setup();
    const w = ethers.Wallet.createRandom();
    const key = k(w.address);
    await id.connect(holder).addKey(key, ACTION, ECDSA);
    const sig = await w.signMessage(
      ethers.getBytes(await inner(id, key, ACTION)),
    );
    await expect(
      id.connect(stranger).removeKeyWithProof(key, ACTION, sig),
    ).to.be.revertedWith("OnchainID: Sender does not have management key");

    const label = ethers.id("backup passphrase");
    await id.connect(holder).addKey(label, ACTION, RSA);
    await expect(
      id.connect(holder).removeKeyWithProof(label, ACTION, sig),
    ).to.be.revertedWith("OnchainID: Only ECDSA keys support proof");
    await id.connect(holder).removeKey(label, ACTION);
    expect(await id.keyHasPurpose(label, ACTION)).to.equal(false);
  });

  // R-45-1: the doc sentence. A MANAGEMENT key adds a MANAGEMENT key at
  // once; the same change through KeyManager waits for its timelock.
  it("a second MANAGEMENT key adds a third at once; a rotation still waits", async function () {
    const { holder, mgr, id } = await setup();
    const idA = await id.getAddress();
    const km = await (await ethers.getContractFactory("KeyManager")).deploy();
    await id.connect(holder).authorizeManager(await km.getAddress());

    await id.connect(holder).addKey(k(mgr.address), MGMT, ECDSA);
    const third = k(ethers.Wallet.createRandom().address);
    await id.connect(mgr).addKey(third, MGMT, ECDSA);
    expect(await id.keyHasPurpose(third, MGMT)).to.equal(true);

    const fourth = k(ethers.Wallet.createRandom().address);
    await km.connect(mgr).initiateKeyRotation(idA, third, fourth, MGMT);
    await expect(km.connect(mgr).executeKeyRotation(idA, third, fourth, MGMT))
      .to.be.reverted;
    expect(await id.keyHasPurpose(fourth, MGMT)).to.equal(false);
    await time.increase(Number(await km.DEFAULT_TIMELOCK()) + 1);
    await km.connect(mgr).executeKeyRotation(idA, third, fourth, MGMT);
    expect(await id.keyHasPurpose(fourth, MGMT)).to.equal(true);
    expect(await id.keyHasPurpose(third, MGMT)).to.equal(false);
  });

  // M-1 (review of 4.5): recovery is no defence against a rogue MANAGEMENT
  // key (it can cancel or re-seat recovery); the owner is.
  it("the owner evicts a rogue MANAGEMENT key; the rogue cannot take control", async function () {
    const { holder, mgr: rogue, stranger, id } = await setup();
    const km = await (await ethers.getContractFactory("KeyManager")).deploy();
    const kmAddr = await km.getAddress();
    await id.connect(holder).authorizeManager(kmAddr);
    await id.connect(holder).addKey(k(rogue.address), MGMT, ECDSA);

    await expect(
      id.connect(rogue).transferOwnership(rogue.address),
    ).to.be.revertedWithCustomError(id, "OwnableUnauthorizedAccount");
    await expect(
      id.connect(rogue).deauthorizeManager(kmAddr),
    ).to.be.revertedWith("OnchainID: Only owner can deauthorize managers");
    await expect(
      id.connect(rogue).authorizeManager(stranger.address),
    ).to.be.revertedWith("OnchainID: Only owner can authorize managers");
    // Even with the owner's own MANAGEMENT key removed by the rogue, the
    // owner still passes onlyManagementKey and evicts the rogue.
    await id.connect(rogue).removeKey(k(holder.address), MGMT);
    expect(await id.keyHasPurpose(k(holder.address), MGMT)).to.equal(false);
    await id.connect(holder).removeKey(k(rogue.address), MGMT);
    expect(await id.keyHasPurpose(k(rogue.address), MGMT)).to.equal(false);
    await expect(
      id.connect(rogue).addKey(k(rogue.address), MGMT, ECDSA),
    ).to.be.revertedWith("OnchainID: Sender does not have management key");
    await id.connect(holder).addKey(k(holder.address), MGMT, ECDSA);
    expect(await id.owner()).to.equal(holder.address);
    expect(await id.authorizedManagers(kmAddr)).to.equal(true);
  });

  // N-1 (review of 4.5): a revoked key is not removed twice, so its
  // revokedAt is not re-stamped and KeyRemoved is not emitted again.
  it("a revoked key cannot be removed again by either path", async function () {
    const { holder, id } = await setup();
    const w = ethers.Wallet.createRandom();
    const key = k(w.address);
    await id.connect(holder).addKey(key, ACTION, ECDSA);
    await id.connect(holder).removeKey(key, ACTION);
    const at = (await id.getKey(key)).revokedAt;
    await expect(id.connect(holder).removeKey(key, ACTION)).to.be.revertedWith(
      "OnchainID: Key already revoked",
    );
    const sig = await w.signMessage(
      ethers.getBytes(await inner(id, key, ACTION)),
    );
    await expect(
      id.connect(holder).removeKeyWithProof(key, ACTION, sig),
    ).to.be.revertedWith("OnchainID: Key already revoked");
    expect((await id.getKey(key)).revokedAt).to.equal(at);
  });

  // L-1 (review of 4.5): the removal nonce makes a holder's signature good
  // for one removal; after the key is re-added the old one is stale.
  it("a removal signature is not replayed after the key is re-added", async function () {
    const { holder, id } = await setup();
    const w = ethers.Wallet.createRandom();
    const key = k(w.address);
    await id.connect(holder).addKey(key, ACTION, ECDSA);
    expect(await id.removalNonces(key)).to.equal(0n);
    const old = await w.signMessage(
      ethers.getBytes(await inner(id, key, ACTION)),
    );
    await id.connect(holder).removeKeyWithProof(key, ACTION, old);
    expect(await id.removalNonces(key)).to.equal(1n);

    await id.connect(holder).addKey(key, ACTION, ECDSA);
    await expect(
      id.connect(holder).removeKeyWithProof(key, ACTION, old),
    ).to.be.revertedWith(
      "OnchainID: Signature does not prove ownership of key",
    );
    expect(await id.keyHasPurpose(key, ACTION)).to.equal(true);

    const fresh = await w.signMessage(
      ethers.getBytes(await inner(id, key, ACTION)),
    );
    await id.connect(holder).removeKeyWithProof(key, ACTION, fresh);
    expect(await id.keyHasPurpose(key, ACTION)).to.equal(false);
    expect(await id.removalNonces(key)).to.equal(2n);
  });

  // L-2 (review of 4.5): an ACTION or CLAIM_SIGNER key is not a manager.
  it("ACTION and CLAIM_SIGNER keys cannot manage keys or the threshold", async function () {
    const [holder, actor, claimer] = await ethers.getSigners();
    const id = await (
      await ethers.getContractFactory("OnchainID")
    ).deploy(holder.address);
    await id.connect(holder).addKey(k(actor.address), ACTION, ECDSA);
    await id.connect(holder).addKey(k(claimer.address), 3, ECDSA);
    const w = ethers.Wallet.createRandom();
    const key = k(w.address);
    await id.connect(holder).addKey(key, ACTION, ECDSA);
    const sig = await w.signMessage(
      ethers.getBytes(await inner(id, key, ACTION)),
    );
    const refusal = "OnchainID: Sender does not have management key";
    for (const s of [actor, claimer]) {
      const c = id.connect(s);
      await expect(
        c.addKey(k(ethers.Wallet.createRandom().address), MGMT, ECDSA),
      ).to.be.revertedWith(refusal);
      await expect(c.removeKey(key, ACTION)).to.be.revertedWith(refusal);
      await expect(c.removeKeyWithProof(key, ACTION, sig)).to.be.revertedWith(
        refusal,
      );
      await expect(c.setExecutionThreshold(3)).to.be.revertedWith(refusal);
    }
    expect(await id.keyHasPurpose(key, ACTION)).to.equal(true);
    expect(await id.executionThreshold()).to.equal(2n);
  });
});
