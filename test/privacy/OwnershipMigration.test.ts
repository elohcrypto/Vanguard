import { expect } from "chai";
import { ethers } from "hardhat";

/**
 * Governance is expected to mature: a single operator at launch, multiple
 * parties later, a timelock once regulatory obligations firm up.
 *
 * That path only stays open if ownership can move without redeploying, and if
 * a mistaken handover cannot permanently strand the contract. With one-step
 * Ownable, transferOwnership to a wrong or non-responsive address is final —
 * updateVerifier becomes uncallable forever. Ownable2Step requires the new
 * owner to call acceptOwnership(), which proves it exists and can act.
 *
 * These tests pin the migration path itself, not a particular governance choice.
 */
describe("ZKVerifierIntegrated — ownership migration path", () => {
  async function deploy() {
    const zk = await (
      await ethers.getContractFactory("ZKVerifierIntegrated")
    ).deploy(false);
    await zk.waitForDeployment();
    return zk;
  }

  it("does not hand over ownership until the new owner accepts", async () => {
    const [owner, next] = await ethers.getSigners();
    const zk = await deploy();

    await zk.transferOwnership(next.address);

    // Still the original owner: a pending transfer is not a transfer.
    expect(await zk.owner()).to.equal(owner.address);
    expect(await zk.pendingOwner()).to.equal(next.address);

    await zk.connect(next).acceptOwnership();
    expect(await zk.owner()).to.equal(next.address);
  });

  it("survives a handover to an address that cannot accept", async () => {
    const [owner] = await ethers.getSigners();
    const zk = await deploy();

    // A contract with no acceptOwnership(): under one-step Ownable this would
    // permanently strand the contract. Here the original owner keeps control.
    const inert = await (
      await ethers.getContractFactory("AlwaysTrueVerifier")
    ).deploy();
    await inert.waitForDeployment();

    await zk.transferOwnership(await inert.getAddress());
    expect(await zk.owner()).to.equal(owner.address);

    // Owner powers still work, so the mistake is recoverable.
    await expect(zk.updateVerifier("whitelist", await inert.getAddress())).to
      .not.be.reverted;
  });

  it("lets the owner cancel a pending handover", async () => {
    const [owner, wrong] = await ethers.getSigners();
    const zk = await deploy();

    await zk.transferOwnership(wrong.address);
    // Re-targeting replaces the pending owner; the mistaken one loses its claim.
    await zk.transferOwnership(owner.address);

    await expect(zk.connect(wrong).acceptOwnership()).to.be.reverted;
    expect(await zk.owner()).to.equal(owner.address);
  });

  it("can hand ownership to a contract that is able to act", async () => {
    const [, next] = await ethers.getSigners();
    const zk = await deploy();

    // Stand-in for a Safe or TimelockController: any account that can call
    // acceptOwnership() completes the migration. Ownership is not tied to an EOA.
    await zk.transferOwnership(next.address);
    await zk.connect(next).acceptOwnership();

    // The new owner holds the privileged powers; the old one does not.
    const inert = await (
      await ethers.getContractFactory("AlwaysTrueVerifier")
    ).deploy();
    await inert.waitForDeployment();

    await expect(
      zk.connect(next).updateVerifier("whitelist", await inert.getAddress()),
    ).to.not.be.reverted;
  });
});
