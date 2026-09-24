import { expect } from "chai";
import { ethers } from "hardhat";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";

// Guard test from .omc/plans/2026-09-23-zk-kyc-ownership-cleanup.md, Task 0.3.
// After the handover ceremony (Phase 2, Task 2.4) the deploying key must hold
// no power at all, governance must own the core contracts, an ops multisig
// must hold the operational roles, and a guardian must be able to pause but
// not unpause. Today the deployer keeps everything, so this fails.
//
// Phase 2 replaces the `handover` stub below with `scripts/handover.ts`.
// PENDING until Phase 2: observed RED on 2026-09-23 (4 of 4 fail: deployer owns
// everything, guardian cannot pause). Change `describe.skip` to `describe` in Task 2.4.
describe.skip("Deployer holds no power after handover (plan Task 0.3)", function () {
  let deployer: SignerWithAddress;
  let governance: SignerWithAddress; // stands in for VanguardGovernance until Task 2.4
  let ops: SignerWithAddress;
  let guardian: SignerWithAddress;
  let token: any;
  let identityRegistry: any;
  let complianceRules: any;
  let oracleManager: any;

  async function handover(): Promise<void> {
    // Task 2.4 wires the real ceremony here. Intentionally empty so the
    // assertions below describe the target state, not today's state.
  }

  beforeEach(async function () {
    [deployer, governance, ops, guardian] = await ethers.getSigners();

    identityRegistry = await (
      await ethers.getContractFactory("IdentityRegistry")
    ).deploy();
    complianceRules = await (
      await ethers.getContractFactory("ComplianceRules")
    ).deploy(deployer.address, [840, 344], []);
    token = await (
      await ethers.getContractFactory("Token")
    ).deploy(
      "Vanguard StableCoin",
      "VSC",
      await identityRegistry.getAddress(),
      await complianceRules.getAddress(),
    );
    oracleManager = await (
      await ethers.getContractFactory("OracleManager")
    ).deploy();

    await handover();
  });

  it("governance owns Token, IdentityRegistry, ComplianceRules and OracleManager", async function () {
    for (const c of [token, identityRegistry, complianceRules, oracleManager]) {
      expect(await c.owner()).to.equal(governance.address);
    }
  });

  it("the deployer is no longer an agent or rule administrator", async function () {
    expect(await token.isAgent(deployer.address)).to.equal(false);
    expect(await identityRegistry.isAgent(deployer.address)).to.equal(false);
    expect(await complianceRules.ruleAdministrators(deployer.address)).to.equal(
      false,
    );
  });

  it("the ops multisig holds the agent roles", async function () {
    expect(await token.isAgent(ops.address)).to.equal(true);
    expect(await identityRegistry.isAgent(ops.address)).to.equal(true);
  });

  it("the guardian can pause the token but cannot unpause it", async function () {
    await token.connect(guardian).pause();
    expect(await token.paused()).to.equal(true);
    await expect(token.connect(guardian).unpause()).to.be.reverted;
  });
});
