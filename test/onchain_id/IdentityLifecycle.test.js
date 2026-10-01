const { expect } = require("chai");
const { ethers } = require("hardhat");

// Plan v2 §6F Task 2F.2 (L6, L7, L8), from the reviewer's probe-c/p3.
const MGMT = 1;
const k = (a) => ethers.solidityPackedKeccak256(["address"], [a]);

describe("OnchainID lifecycle (2F.2, L6, L8)", function () {
  let holder, attacker, other, id, idA;

  beforeEach(async function () {
    [holder, attacker, other] = await ethers.getSigners();
    id = await (
      await ethers.getContractFactory("OnchainID")
    ).deploy(holder.address);
    idA = await id.getAddress();
  });

  it("renounceOwnership reverts and initialize cannot be re-run (L6)", async function () {
    await expect(id.connect(holder).renounceOwnership()).to.be.revertedWith(
      "OnchainID: identity needs an owner",
    );
    await expect(
      id.connect(attacker).initialize(attacker.address, k(attacker.address)),
    ).to.be.revertedWith("OnchainID: Already initialized");
    expect(await id.owner()).to.equal(holder.address);
  });

  it("an identity deployed without owner is initialized exactly once", async function () {
    const blank = await (
      await ethers.getContractFactory("OnchainID")
    ).deploy(ethers.ZeroAddress);
    await blank.initialize(holder.address, k(holder.address));
    expect(await blank.owner()).to.equal(holder.address);
    expect(await blank.keyHasPurpose(k(holder.address), MGMT)).to.equal(true);
    await expect(
      blank.connect(attacker).initialize(attacker.address, k(attacker.address)),
    ).to.be.revertedWith("OnchainID: Already initialized");
  });

  it("removeKeyWithProof removes a key whose holder signed (L8)", async function () {
    await id.connect(holder).addKey(k(other.address), MGMT, 1);
    const { chainId } = await ethers.provider.getNetwork();
    const msg = ethers.solidityPackedKeccak256(
      ["string", "address", "bytes32", "uint256", "uint256"],
      ["Remove key from OnchainID", idA, k(other.address), MGMT, chainId],
    );
    const sig = await other.signMessage(ethers.getBytes(msg));
    // The helper returns the same digest the signer signed.
    expect(await id.getRemoveKeyMessage(k(other.address), MGMT)).to.equal(
      ethers.hashMessage(ethers.getBytes(msg)),
    );
    await id.connect(holder).removeKeyWithProof(k(other.address), MGMT, sig);
    expect(await id.keyHasPurpose(k(other.address), MGMT)).to.equal(false);

    // A signature by someone else does not prove ownership.
    await id.connect(holder).addKey(k(attacker.address), MGMT, 1);
    const msg2 = ethers.solidityPackedKeccak256(
      ["string", "address", "bytes32", "uint256", "uint256"],
      ["Remove key from OnchainID", idA, k(attacker.address), MGMT, chainId],
    );
    await expect(
      id
        .connect(holder)
        .removeKeyWithProof(
          k(attacker.address),
          MGMT,
          await other.signMessage(ethers.getBytes(msg2)),
        ),
    ).to.be.revertedWith(
      "OnchainID: Signature does not prove ownership of key",
    );
  });

  it("an ownership transfer retires the old owner's MANAGEMENT key (L8)", async function () {
    await id.connect(holder).transferOwnership(other.address);
    // Two-step: nothing changes until the new owner accepts.
    expect(await id.owner()).to.equal(holder.address);
    expect(await id.keyHasPurpose(k(holder.address), MGMT)).to.equal(true);
    await id.connect(other).acceptOwnership();
    expect(await id.owner()).to.equal(other.address);
    expect(await id.keyHasPurpose(k(holder.address), MGMT)).to.equal(false);
    expect(await id.keyHasPurpose(k(other.address), MGMT)).to.equal(true);
    await expect(
      id.connect(holder).addKey(k(attacker.address), MGMT, 1),
    ).to.be.revertedWith("OnchainID: Sender does not have management key");
  });

  // Review of 2F.2, F4: key swap edge cases.
  it("a new owner holding only an ACTION key ends with MANAGEMENT (F4)", async function () {
    await id.connect(holder).addKey(k(other.address), 2, 1);
    await id.connect(holder).transferOwnership(other.address);
    await id.connect(other).acceptOwnership();
    expect(await id.keyHasPurpose(k(other.address), MGMT)).to.equal(true);
    expect(await id.keyHasPurpose(k(holder.address), MGMT)).to.equal(false);
    expect(await id.getKeysByPurpose(2)).to.not.include(k(other.address));
  });

  it("A -> B -> A: A regains MANAGEMENT (F4)", async function () {
    await id.connect(holder).transferOwnership(other.address);
    await id.connect(other).acceptOwnership();
    await id.connect(other).transferOwnership(holder.address);
    await id.connect(holder).acceptOwnership();
    expect(await id.keyHasPurpose(k(holder.address), MGMT)).to.equal(true);
    expect(await id.keyHasPurpose(k(other.address), MGMT)).to.equal(false);
    const mg = await id.getKeysByPurpose(MGMT);
    expect(mg.filter((x) => x === k(holder.address)).length).to.equal(1);
  });

  it("transferOwnership to self keeps the owner's key (F4)", async function () {
    await id.connect(holder).transferOwnership(holder.address);
    await id.connect(holder).acceptOwnership();
    expect(await id.keyHasPurpose(k(holder.address), MGMT)).to.equal(true);
  });

  it("a revoked key can be added again; an active one cannot (F4)", async function () {
    await id.connect(holder).addKey(k(other.address), 2, 1);
    await expect(
      id.connect(holder).addKey(k(other.address), MGMT, 1),
    ).to.be.revertedWith("OnchainID: Key already exists");
    await id.connect(holder).removeKey(k(other.address), 2);
    await id.connect(holder).addKey(k(other.address), MGMT, 1);
    expect(await id.keyHasPurpose(k(other.address), MGMT)).to.equal(true);
    expect((await id.getKey(k(other.address))).revokedAt).to.equal(0);
    expect(await id.getKeysByPurpose(MGMT)).to.include(k(other.address));
  });

  it("other MANAGEMENT keys survive a handover; the new owner audits them", async function () {
    // Documented, not changed: only the previous owner's key is retired.
    await id.connect(holder).addKey(k(attacker.address), MGMT, 1);
    await id.connect(holder).transferOwnership(other.address);
    await id.connect(other).acceptOwnership();
    expect(await id.keyHasPurpose(k(attacker.address), MGMT)).to.equal(true);
  });
});

describe("OnchainIDFactory identity map (2F.2, L7)", function () {
  let owner, victim, attacker, f;

  beforeEach(async function () {
    [owner, victim, attacker] = await ethers.getSigners();
    f = await (
      await ethers.getContractFactory("OnchainIDFactory")
    ).deploy(owner.address);
  });

  it("the first deployment for a wallet stays open to anyone", async function () {
    await f.connect(attacker).deployOnchainID(victim.address, ethers.id("v"));
    expect(await f.getIdentityByOwner(victim.address)).to.not.equal(
      ethers.ZeroAddress,
    );
  });

  it("a stranger cannot re-point a wallet's identity on any deploy path", async function () {
    await f.connect(victim).deployOnchainID(victim.address, ethers.id("v"));
    const first = await f.getIdentityByOwner(victim.address);
    const msg =
      "OnchainIDFactory: Only the wallet or factory owner may replace";
    await expect(
      f.connect(attacker).deployOnchainID(victim.address, ethers.id("a")),
    ).to.be.revertedWith(msg);
    await expect(
      f
        .connect(attacker)
        .deployOnchainIDWithKey(
          victim.address,
          k(attacker.address),
          ethers.id("b"),
        ),
    ).to.be.revertedWith(msg);
    await expect(
      f
        .connect(attacker)
        .batchDeployOnchainID([victim.address], [ethers.id("c")]),
    ).to.be.revertedWith(msg);
    expect(await f.getIdentityByOwner(victim.address)).to.equal(first);
  });

  it("the wallet itself or the factory owner may re-deploy", async function () {
    await f.connect(attacker).deployOnchainID(victim.address, ethers.id("v"));
    const first = await f.getIdentityByOwner(victim.address);
    await f.connect(victim).deployOnchainID(victim.address, ethers.id("v2"));
    const second = await f.getIdentityByOwner(victim.address);
    expect(second).to.not.equal(first);
    await f.connect(owner).deployOnchainID(victim.address, ethers.id("v3"));
    expect(await f.getIdentityByOwner(victim.address)).to.not.equal(second);
  });
});
