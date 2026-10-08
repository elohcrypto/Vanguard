import { expect } from "chai";
import { artifacts, ethers } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";

// Task 4.11 fix round (review H-1, M-1). One recovery manager is pinned
// per identity (R-411-14); other managers hold key powers only and are
// cleared when the recovered wallet accepts. A re-seat of seated agents
// waits 48h and the seated agents can veto it (R-411-16).

const MGMT = 1;
const DAY = 24 * 3600;
const k = (a: string) => ethers.solidityPackedKeccak256(["address"], [a]);

/** The compiled KeyManager's runtime code hash (R-411-19). */
async function kmCodeHash() {
  return ethers.keccak256(
    (await artifacts.readArtifact("KeyManager")).deployedBytecode,
  );
}

async function factoryIdentity() {
  const [deployer, owner, A, B, rescued, anyone, other] =
    await ethers.getSigners();
  const km = await (await ethers.getContractFactory("KeyManager")).deploy();
  const kmA = await km.getAddress();
  const factory = await (
    await ethers.getContractFactory("OnchainIDFactory")
  ).deploy(deployer.address, await kmCodeHash());
  await expect(factory.setRecoveryManager(kmA))
    .to.emit(factory, "RecoveryManagerSet")
    .withArgs(kmA);
  await factory.deployOnchainID(owner.address, ethers.id("p1"));
  const idA = await factory.getIdentityByOwner(owner.address);
  const id = await ethers.getContractAt("OnchainID", idA);
  return {
    deployer,
    owner,
    A,
    B,
    rescued,
    anyone,
    other,
    km,
    kmA,
    factory,
    id,
    idA,
  };
}

describe("Recovery manager pinned per identity (4.11 R-411-14/15)", function () {
  it("the factory pins its KeyManager at creation; nobody can re-pin", async function () {
    const f = await factoryIdentity();
    expect(await f.id.recoveryManager()).to.equal(f.kmA);
    const km2 = await (await ethers.getContractFactory("KeyManager")).deploy();
    await expect(
      f.id.connect(f.owner).pinRecoveryManager(await km2.getAddress()),
    ).to.be.revertedWithCustomError(f.id, "RecoveryManagerAlreadyPinned");
  });

  it("H-2: a creator that is not the owner cannot pin after the creating block (R-411-18)", async function () {
    const [creator, owner] = await ethers.getSigners();
    const id = await (
      await ethers.getContractFactory("OnchainID")
    )
      .connect(creator)
      .deploy(owner.address);
    const evil = await (
      await ethers.getContractFactory("EvilRecoveryManager")
    ).deploy();
    await expect(
      id.connect(creator).pinRecoveryManager(await evil.getAddress()),
    ).to.be.revertedWithCustomError(id, "NotCreatorOrOwner");
    expect(await id.recoveryManager()).to.equal(ethers.ZeroAddress);
    // The owner still may.
    const km = await (await ethers.getContractFactory("KeyManager")).deploy();
    await id.connect(owner).pinRecoveryManager(await km.getAddress());
    expect(await id.recoveryManager()).to.equal(await km.getAddress());
  });

  it("the factory accepts only the compiled KeyManager (R-411-19)", async function () {
    const [deployer] = await ethers.getSigners();
    const F = await ethers.getContractFactory("OnchainIDFactory");
    const factory = await F.deploy(deployer.address, await kmCodeHash());
    const evil = await (
      await ethers.getContractFactory("EvilRecoveryManager")
    ).deploy();
    await expect(
      factory.setRecoveryManager(await evil.getAddress()),
    ).to.be.revertedWithCustomError(factory, "RecoveryManagerCodeMismatch");
    await expect(
      factory.setRecoveryManager(deployer.address),
    ).to.be.revertedWithCustomError(factory, "RecoveryManagerCodeMismatch");
    const km = await (await ethers.getContractFactory("KeyManager")).deploy();
    await factory.setRecoveryManager(await km.getAddress());
    await factory.setRecoveryManager(ethers.ZeroAddress); // pinning off
    expect(await factory.recoveryManagerCodeHash()).to.equal(
      await kmCodeHash(),
    );
    // A factory built with no hash accepts no recovery manager at all.
    const none = await F.deploy(deployer.address, ethers.ZeroHash);
    await expect(
      none.setRecoveryManager(await km.getAddress()),
    ).to.be.revertedWithCustomError(none, "RecoveryManagerCodeMismatch");
    // Not even a never-used address, whose code hash is zero (review L-2b).
    await expect(
      none.setRecoveryManager(ethers.Wallet.createRandom().address),
    ).to.be.revertedWithCustomError(none, "RecoveryManagerCodeMismatch");
    expect(await none.recoveryManager()).to.equal(ethers.ZeroAddress);
  });

  it("in the creating block only the creator may pin, not a stranger (review L-2a)", async function () {
    const [creator, owner, stranger] = await ethers.getSigners();
    const km = await (await ethers.getContractFactory("KeyManager")).deploy();
    const evil = await (
      await ethers.getContractFactory("EvilRecoveryManager")
    ).deploy();
    const gwei = (n: number) => ethers.parseUnits(String(n), "gwei");
    // Mempool order by tip: deploy, then the stranger, then the creator.
    const fee = (tip: number) => ({
      gasLimit: 300_000,
      maxPriorityFeePerGas: gwei(tip),
      maxFeePerGas: gwei(100),
    });
    const idA = ethers.getCreateAddress({
      from: creator.address,
      nonce: await creator.getNonce(),
    });
    const id = await ethers.getContractAt("OnchainID", idA);
    await ethers.provider.send("evm_setAutomine", [false]);
    try {
      await (
        await ethers.getContractFactory("OnchainID")
      )
        .connect(creator)
        .deploy(owner.address, { ...fee(30), gasLimit: 8_000_000 });
      const byStranger = await id
        .connect(stranger)
        .pinRecoveryManager(await evil.getAddress(), fee(20));
      const byCreator = await id
        .connect(creator)
        .pinRecoveryManager(await km.getAddress(), fee(10));
      await ethers.provider.send("evm_mine", []);
      const rs = await ethers.provider.getTransactionReceipt(byStranger.hash);
      const rc = await ethers.provider.getTransactionReceipt(byCreator.hash);
      expect(rs!.blockNumber).to.equal(rc!.blockNumber);
      expect(rs!.status).to.equal(0);
      expect(rc!.status).to.equal(1);
    } finally {
      await ethers.provider.send("evm_setAutomine", [true]);
    }
    expect(await id.recoveryManager()).to.equal(await km.getAddress());
  });

  it("a directly deployed identity has no recovery until pinned; a stranger cannot pin", async function () {
    const [owner, stranger, A] = await ethers.getSigners();
    const id = await (
      await ethers.getContractFactory("OnchainID")
    ).deploy(owner.address);
    const km = await (await ethers.getContractFactory("KeyManager")).deploy();
    const idA = await id.getAddress();
    expect(await id.recoveryManager()).to.equal(ethers.ZeroAddress);
    expect(await id.ownershipFrozen()).to.equal(false);
    await expect(
      km.setupKeyRecovery(idA, [A.address], 1),
    ).to.be.revertedWithCustomError(km, "NotRecoveryManager");
    await expect(
      id.connect(stranger).pinRecoveryManager(await km.getAddress()),
    ).to.be.revertedWithCustomError(id, "NotCreatorOrOwner");
    await expect(
      id.pinRecoveryManager(stranger.address),
    ).to.be.revertedWithCustomError(id, "NotAContract");
    await id.pinRecoveryManager(await km.getAddress());
    await km.setupKeyRecovery(idA, [A.address], 1);
  });

  it("P1: a stolen owner's manager can never move ownership or evict; recovery wins", async function () {
    const f = await factoryIdentity();
    await f.km
      .connect(f.owner)
      .setupKeyRecovery(f.idA, [f.A.address, f.B.address], 2);
    // The thief holds the owner key; before any approval it seats its own
    // manager (allowed: key powers only) and plants a MANAGEMENT key.
    const evil = await (
      await ethers.getContractFactory("EvilRecoveryManager")
    ).deploy();
    const evilA = await evil.getAddress();
    const thief = f.other;
    await expect(f.id.connect(f.owner).authorizeManager(evilA))
      .to.emit(f.id, "ManagerAuthorized")
      .withArgs(evilA);
    await f.id.connect(f.owner).addKey(k(thief.address), MGMT, 1);
    expect(await f.id.getManagers()).to.deep.equal([evilA]);
    // Its "always locked" answer freezes nothing: only the pin is asked.
    expect(await f.id.ownershipFrozen()).to.equal(false);
    await expect(
      evil.evict(f.idA, k(thief.address)),
    ).to.be.revertedWithCustomError(f.id, "NotRecoveryManager");
    await expect(
      evil.propose(f.idA, thief.address),
    ).to.be.revertedWithCustomError(f.id, "NotRecoveryManager");

    // The agents recover onto the rescued wallet.
    const key = k(f.rescued.address);
    await f.km.connect(f.A).initiateKeyRecovery(f.idA, key);
    await f.km.connect(f.A).approveKeyRecovery(f.idA, key);
    await f.km.connect(f.B).approveKeyRecovery(f.idA, key);
    const t = BigInt(await time.latest());
    // Frozen now: no new manager, no withdrawal, no new MANAGEMENT key.
    await expect(
      f.id.connect(f.owner).authorizeManager(f.anyone.address),
    ).to.be.revertedWithCustomError(f.id, "FrozenByRecovery");
    await expect(
      f.id.connect(f.owner).deauthorizeManager(f.kmA),
    ).to.be.revertedWithCustomError(f.id, "FrozenByRecovery");
    await expect(
      f.id.connect(thief).addKey(ethers.id("more"), MGMT, 1),
    ).to.be.revertedWithCustomError(f.id, "ManagementAdditionsFrozen");
    await time.increase(2 * DAY + 1);
    await f.km.connect(f.anyone).executeKeyRecovery(f.idA, key);
    expect(await f.id.getKeysByPurpose(MGMT)).to.deep.equal([key]);
    // The evil manager still cannot evict the recovered key or propose.
    await expect(
      evil.evict(f.idA, k(thief.address)),
    ).to.be.revertedWithCustomError(f.id, "NotRecoveryManager");
    await expect(
      evil.propose(f.idA, thief.address),
    ).to.be.revertedWithCustomError(f.id, "NotRecoveryManager");
    await time.setNextBlockTimestamp(t + 7n * BigInt(DAY));
    await f.km.connect(f.anyone).executeOwnerTransfer(f.idA, f.rescued.address);
    await expect(f.id.connect(f.rescued).acceptOwnership())
      .to.emit(f.id, "ManagerDeauthorized")
      .withArgs(evilA);
    expect(await f.id.owner()).to.equal(f.rescued.address);
    expect(await f.id.getKeysByPurpose(MGMT)).to.deep.equal([key]);
    expect(await f.id.getManagers()).to.deep.equal([]);
    expect(await f.id.authorizedManagers(evilA)).to.equal(false);
    expect(await f.id.recoveryManager()).to.equal(f.kmA);
  });

  it("the recovered wallet's acceptance keeps the pinned manager authorized", async function () {
    const f = await factoryIdentity();
    await f.id.connect(f.owner).authorizeManager(f.kmA);
    await f.id.connect(f.owner).authorizeManager(f.anyone.address);
    await f.km.connect(f.owner).setupKeyRecovery(f.idA, [f.A.address], 1);
    const key = k(f.rescued.address);
    await f.km.connect(f.A).initiateKeyRecovery(f.idA, key);
    await f.km.connect(f.A).approveKeyRecovery(f.idA, key);
    await time.increase(7 * DAY);
    await f.km.executeKeyRecovery(f.idA, key);
    await f.km.executeOwnerTransfer(f.idA, f.rescued.address);
    await f.id.connect(f.rescued).acceptOwnership();
    expect(await f.id.getManagers()).to.deep.equal([f.kmA]);
  });

  it("at most 8 managers; getManagers lists them; deauthorize emits", async function () {
    const f = await factoryIdentity();
    const s = await ethers.getSigners();
    for (let i = 0; i < 8; i++) {
      await f.id.connect(f.owner).authorizeManager(s[10 + i].address);
    }
    await expect(
      f.id.connect(f.owner).authorizeManager(s[18].address),
    ).to.be.revertedWithCustomError(f.id, "TooManyManagers");
    expect((await f.id.getManagers()).length).to.equal(8);
    await expect(f.id.connect(f.owner).deauthorizeManager(s[10].address))
      .to.emit(f.id, "ManagerDeauthorized")
      .withArgs(s[10].address);
    expect((await f.id.getManagers()).length).to.equal(7);
  });
});

describe("A re-seat of seated agents waits 48h and can be vetoed (4.11 R-411-16)", function () {
  it("the thief's re-seat is pending, the agents veto it, their recovery executes", async function () {
    const f = await factoryIdentity();
    await f.km
      .connect(f.owner)
      .setupKeyRecovery(f.idA, [f.A.address, f.B.address], 2);
    const thief = f.other;
    await expect(
      f.km.connect(f.owner).setupKeyRecovery(f.idA, [thief.address], 1),
    ).to.emit(f.km, "KeyRecoverySetupPending");
    expect((await f.km.getKeyRecovery(f.idA)).recoveryAgents).to.deep.equal([
      f.A.address,
      f.B.address,
    ]);
    await expect(f.km.applyKeyRecoverySetup(f.idA)).to.be.revertedWith(
      "KeyManager: Timelock not expired",
    );
    await expect(
      f.km.connect(thief).vetoKeyRecoverySetup(f.idA),
    ).to.be.revertedWith("KeyManager: Not a recovery agent");
    await f.km.connect(f.A).vetoKeyRecoverySetup(f.idA);
    await expect(
      f.km.connect(f.A).vetoKeyRecoverySetup(f.idA),
    ).to.be.revertedWithCustomError(f.km, "AlreadyVetoed");
    await expect(f.km.connect(f.B).vetoKeyRecoverySetup(f.idA)).to.emit(
      f.km,
      "KeyRecoverySetupVetoed",
    );
    await time.increase(2 * DAY + 1);
    await expect(
      f.km.applyKeyRecoverySetup(f.idA),
    ).to.be.revertedWithCustomError(f.km, "NoPendingSetup");
    // The honest agents' candidate approves and executes.
    const key = k(f.rescued.address);
    await f.km.connect(f.A).initiateKeyRecovery(f.idA, key);
    await f.km.connect(f.A).approveKeyRecovery(f.idA, key);
    await f.km.connect(f.B).approveKeyRecovery(f.idA, key);
    await time.increase(2 * DAY + 1);
    await f.km.executeKeyRecovery(f.idA, key);
    expect(await f.id.getKeysByPurpose(MGMT)).to.deep.equal([key]);
  });

  it("an approved recovery blocks a pending re-seat, and its execution drops it", async function () {
    const f = await factoryIdentity();
    await f.km.connect(f.owner).setupKeyRecovery(f.idA, [f.A.address], 1);
    await f.km.connect(f.owner).setupKeyRecovery(f.idA, [f.other.address], 1);
    const key = k(f.rescued.address);
    await f.km.connect(f.A).initiateKeyRecovery(f.idA, key);
    await f.km.connect(f.A).approveKeyRecovery(f.idA, key);
    await time.increase(2 * DAY + 1);
    await expect(
      f.km.applyKeyRecoverySetup(f.idA),
    ).to.be.revertedWithCustomError(f.km, "RecoveryLocked");
    await f.km.executeKeyRecovery(f.idA, key);
    expect((await f.km.getPendingRecoverySetup(f.idA)).effectiveAt).to.equal(
      0n,
    );
  });

  it("an honest owner's re-seat applies after 48h when nobody vetoes", async function () {
    const f = await factoryIdentity();
    await f.km.connect(f.owner).setupKeyRecovery(f.idA, [f.A.address], 1);
    await f.km.connect(f.owner).setupKeyRecovery(f.idA, [f.B.address], 1);
    await time.increase(2 * DAY + 1);
    await expect(f.km.connect(f.anyone).applyKeyRecoverySetup(f.idA)).to.emit(
      f.km,
      "KeyRecoverySetUp",
    );
    expect((await f.km.getKeyRecovery(f.idA)).recoveryAgents).to.deep.equal([
      f.B.address,
    ]);
  });
});
