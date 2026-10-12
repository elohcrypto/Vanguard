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
});
