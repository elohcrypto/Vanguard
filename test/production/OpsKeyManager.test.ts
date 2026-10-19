import { expect } from "chai";
import { ethers } from "hardhat";
import { authorizeKeyManagerOnOps } from "../../scripts/production/opsKeyManager";

/**
 * Task 4.16 (review B L-5): the production deploy's ops-identity step
 * reports every call the ops key still has to send. An identity another
 * wallet owns leaves both the pin and the authorization pending; one the
 * deployer owns gets both sent and reports nothing pending.
 */
describe("opsKeyManager: pending calls (Task 4.16)", function () {
  async function deploy() {
    const [deployer, ops] = await ethers.getSigners();
    const km = await (await ethers.getContractFactory("KeyManager")).deploy();
    const OnchainID = await ethers.getContractFactory("OnchainID");
    return { deployer, ops, km: await km.getAddress(), OnchainID };
  }

  it("another wallet's identity: the pin and the authorization are both pending", async function () {
    const { deployer, ops, km, OnchainID } = await deploy();
    const id = await OnchainID.deploy(ops.address);
    const r = await authorizeKeyManagerOnOps(
      km,
      deployer,
      await id.getAddress(),
    );
    expect(r.authorized).to.equal(false);
    expect(r.pending).to.include(`pinRecoveryManager(${km})`);
    expect(r.pending).to.include(`authorizeManager(${km})`);
    expect(await id.recoveryManager()).to.equal(ethers.ZeroAddress);
    // The owner pins; the authorization alone stays pending.
    await id.connect(ops).pinRecoveryManager(km);
    const r2 = await authorizeKeyManagerOnOps(
      km,
      deployer,
      await id.getAddress(),
    );
    expect(r2.pending).to.not.include("pinRecoveryManager");
    expect(r2.pending).to.include(`authorizeManager(${km})`);
    // The owner authorizes too: nothing pending.
    await id.connect(ops).authorizeManager(km);
    const r3 = await authorizeKeyManagerOnOps(
      km,
      deployer,
      await id.getAddress(),
    );
    expect(r3).to.deep.include({ authorized: true, pending: null });
  });

  it("the deployer's own identity: pinned and authorized, nothing pending", async function () {
    const { deployer, km, OnchainID } = await deploy();
    const id = await OnchainID.deploy(deployer.address);
    const r = await authorizeKeyManagerOnOps(
      km,
      deployer,
      await id.getAddress(),
    );
    expect(r).to.deep.include({ authorized: true, pending: null });
    expect(await id.recoveryManager()).to.equal(km);
    expect(await id.authorizedManagers(km)).to.equal(true);
  });

  it("no OPS_IDENTITY: the placeholder call is pending", async function () {
    const { deployer, km } = await deploy();
    const r = await authorizeKeyManagerOnOps(km, deployer, undefined);
    expect(r.opsIdentity).to.equal(null);
    expect(r.pending).to.include("<ops identity>");
  });
  // Task 5.17 (deep review, ceremony L-1): an identity owned by an
  // external role (the ops multisig) gets both calls as role steps, so
  // the deploy exports them, pauses and proves their effects.
  it("an external owner's identity: both calls are role steps with effect checks", async function () {
    const { deployer, ops, km, OnchainID } = await deploy();
    const id = await OnchainID.deploy(ops.address);
    let steps: any[] = [];
    const roles = {
      ops: ops.address,
      isExternal: (a: string) => a.toLowerCase() === ops.address.toLowerCase(),
      opsIdentity: async (s: any[]) => {
        steps = s;
        const st = await Promise.all(s.map((x) => x.status()));
        if (st.some((x) => x !== "done")) throw new Error("paused");
      },
    };
    await expect(
      authorizeKeyManagerOnOps(km, deployer, await id.getAddress(), {}, roles),
    ).to.be.rejectedWith("paused");
    expect(
      steps.map((x) => [x.id, x.fn, x.args, x.role.address]),
    ).to.deep.equal([
      [
        "deploy.opsIdentity.pinRecoveryManager",
        "pinRecoveryManager",
        [km],
        ops.address,
      ],
      [
        "deploy.opsIdentity.authorizeManager",
        "authorizeManager",
        [km],
        ops.address,
      ],
    ]);
    expect(await Promise.all(steps.map((x) => x.status()))).to.deep.equal([
      "pending",
      "pending",
    ]);
    // The owners execute the batch: both effects hold; nothing is pending.
    await id.connect(ops).pinRecoveryManager(km);
    await id.connect(ops).authorizeManager(km);
    const r = await authorizeKeyManagerOnOps(
      km,
      deployer,
      await id.getAddress(),
      {},
      roles,
    );
    expect(r).to.deep.include({ authorized: true, pending: null });
  });

  // Slice C review L-4: an identity another external role owns is refused.
  it("an identity owned by another external role is refused, naming both", async function () {
    const { deployer, ops, km, OnchainID } = await deploy();
    const [, , , , , , , admin] = await ethers.getSigners();
    const id = await OnchainID.deploy(admin.address);
    let exported = false;
    const roles = {
      ops: ops.address,
      isExternal: () => true, // ops and the issuer-admin multisig
      opsIdentity: async () => {
        exported = true;
      },
    };
    await expect(
      authorizeKeyManagerOnOps(km, deployer, await id.getAddress(), {}, roles),
    ).to.be.rejectedWith(
      `ops identity ${await id.getAddress()} is owned by ${admin.address}, not ops ${ops.address}`,
    );
    expect(exported).to.equal(false);
  });

  // Slice D review LOW-3: a plain key of another role is refused too;
  // the deployer passes (it owns the identity until it transfers it).
  it("an identity owned by another plain role key is refused; the deployer's passes", async function () {
    const { deployer, ops, km, OnchainID } = await deploy();
    const [, , guardian] = await ethers.getSigners();
    const roles = {
      ops: ops.address,
      isExternal: () => false, // every role a key this signer holds
      opsIdentity: async () => {},
    };
    const id = await OnchainID.deploy(guardian.address);
    await expect(
      authorizeKeyManagerOnOps(km, deployer, await id.getAddress(), {}, roles),
    ).to.be.rejectedWith(
      `ops identity ${await id.getAddress()} is owned by ${guardian.address}, not ops ${ops.address}`,
    );
    const mine = await OnchainID.deploy(deployer.address);
    const quiet = console.log;
    console.log = () => {};
    try {
      const r = await authorizeKeyManagerOnOps(
        km,
        deployer,
        await mine.getAddress(),
        {},
        roles,
      );
      expect(r).to.deep.include({ authorized: true, pending: null });
    } finally {
      console.log = quiet;
    }
  });
});
