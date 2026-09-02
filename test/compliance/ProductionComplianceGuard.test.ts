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

  it("allows a contract that omits the marker, with a warning", async () => {
    // ComplianceRules is an enforcing implementation predating the marker.
    const [owner] = await ethers.getSigners();
    const factory = await ethers.getContractFactory("ComplianceRules");
    const rules = await factory.deploy(owner.address, [840n], [408n]);
    await rules.waitForDeployment();

    await expect(
      DeploymentHelper.assertProductionCompliance(await rules.getAddress()),
    ).to.not.be.rejected;
  });
});
