import { expect } from "chai";
import { ethers } from "hardhat";

// Task 4.17 slice D (review A2 A2F-1): an identity cannot be seated as
// its own recovery agent (a MANAGEMENT key would vote as it through
// execute and recover to itself), nor can the KeyManager be an agent.
describe("Recovery agents exclude the identity and the KeyManager (A2F-1)", function () {
  it("setupKeyRecovery refuses the identity itself and the KeyManager", async function () {
    const [owner, B, C] = await ethers.getSigners();
    const id = await (
      await ethers.getContractFactory("OnchainID")
    ).deploy(owner.address);
    const km = await (await ethers.getContractFactory("KeyManager")).deploy();
    const [idA, kmA] = [await id.getAddress(), await km.getAddress()];
    await id.authorizeManager(kmA);
    await id.pinRecoveryManager(kmA);
    for (const bad of [idA, kmA])
      await expect(km.setupKeyRecovery(idA, [bad, B.address], 2))
        .to.be.revertedWithCustomError(km, "AgentControlsIdentity")
        .withArgs(bad);
    await km.setupKeyRecovery(idA, [B.address, C.address], 2);
    expect((await km.getKeyRecovery(idA)).recoveryAgents).to.deep.equal([
      B.address,
      C.address,
    ]);
  });
});
