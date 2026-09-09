import { expect } from "chai";
import { ethers } from "hardhat";
import { DeploymentHelper } from "../../scripts/deploy-helpers";

/**
 * Guards against binding a permissive compliance contract to a live deployment.
 *
 * ComplianceRegistry's canTransfer always returns true, so a Token bound to it
 * enforces nothing. It satisfies ICompliance, so only a runtime check can catch it.
 */
describe("Production compliance guard", () => {
  it("rejects ComplianceRegistry, the permissive test double", async () => {
    const factory = await ethers.getContractFactory("ComplianceRegistry");
    const permissive = await factory.deploy();
    await permissive.waitForDeployment();
    const address = await permissive.getAddress();

    // Confirm the premise: it really does allow any transfer.
    expect(
      await permissive.canTransfer(ethers.ZeroAddress, ethers.ZeroAddress, 0),
    ).to.equal(true);

    await expect(
      DeploymentHelper.assertProductionCompliance(address),
    ).to.be.rejectedWith(/isProductionCompliance\(\) == false/);
  });

  it("accepts ComplianceRules, which carries the marker", async () => {
    const [owner] = await ethers.getSigners();
    const factory = await ethers.getContractFactory("ComplianceRules");
    const rules = await factory.deploy(owner.address, [840n], [408n]);
    await rules.waitForDeployment();

    expect(await rules.isProductionCompliance()).to.equal(true);
    await expect(
      DeploymentHelper.assertProductionCompliance(await rules.getAddress()),
    ).to.not.be.rejected;
  });

  it("rejects a contract that omits the marker", async () => {
    // Any contract with code but no isProductionCompliance(). An earlier
    // version of the guard warned and let these through, which meant an
    // unmarked permissive implementation passed.
    const factory = await ethers.getContractFactory("IdentityRegistry");
    const unmarked = await factory.deploy();
    await unmarked.waitForDeployment();

    await expect(
      DeploymentHelper.assertProductionCompliance(await unmarked.getAddress()),
    ).to.be.rejectedWith(/does not implement isProductionCompliance/);
  });
});
