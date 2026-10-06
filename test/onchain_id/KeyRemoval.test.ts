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
    ["string", "address", "bytes32", "uint256", "uint256"],
    ["Remove key from OnchainID", await id.getAddress(), key, purpose, chainId],
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
});
