import { expect } from "chai";
import { ethers } from "hardhat";

/**
 * Plan v2 Task 4.2: demo options 12, 12a, 12b and 5 -> 2/3 drive the
 * identity key lifecycle through the KeyManager option 1 deploys. Every
 * value below is read from the chain.
 */
describe("Key lifecycle flow (demo options 12, 12a, 12b, 5)", function () {
  this.timeout(300_000);

  const MGMT = 1;
  const k = (a: string) => ethers.solidityPackedKeccak256(["address"], [a]);
  let state: any;
  let flow: any;
  let logged: string[];

  async function quiet(fn: () => Promise<any>): Promise<any> {
    const orig = console.log;
    console.log = (...a: unknown[]) => void logged.push(a.join(" "));
    try {
      return await fn();
    } finally {
      console.log = orig;
    }
  }

  beforeEach(async function () {
    const ContractDeployer = require("../../demo/core/ContractDeployer");
    const DemoState = require("../../demo/core/DemoState");
    const { EnhancedLogger } = require("../../demo/logging");
    flow = require("../../demo/utils/KeyLifecycleFlow");
    state = new DemoState();
    if (state.initialize) await state.initialize();
    state.signers = await ethers.getSigners();
    logged = [];
    const deployer = new ContractDeployer(state, new EnhancedLogger());
    await quiet(() => deployer.deployAllContracts());
  });

  it("option 1 deploys KeyManager; option 12 authorizes, rotates and recovers", async function () {
    const km = state.getContract("keyManager");
    expect(km, "option 1 registers keyManager").to.not.equal(undefined);
    const kmAddr = await km.getAddress();
    expect(await ethers.provider.getCode(kmAddr)).to.not.equal("0x");

    const r = await quiet(() => flow.runKeyLifecycle(state));
    const out = logged.join("\n");
    expect(r, out).to.be.an("object");
    const s = state.signers;
    const factory = state.getContract("onchainIDFactory");
    expect(r.identity).to.equal(await factory.getIdentityByOwner(s[1].address));
    const id = await ethers.getContractAt("OnchainID", r.identity);

    expect(await id.authorizedManagers(kmAddr)).to.equal(true);
    expect(r.rotation.executed && r.recovery.executed).to.equal(true);
    // Rotation: the old key is gone, the new one is MANAGEMENT.
    expect(await id.keyHasPurpose(r.oldKey, MGMT)).to.equal(false);
    expect((await id.getKey(r.oldKey)).revokedAt).to.be.greaterThan(0n);
    expect(await id.keyHasPurpose(r.newKey, MGMT)).to.equal(true);
    // Recovery: agents 2 and 3 added the recovery key as MANAGEMENT.
    expect(await id.keyHasPurpose(r.recoveryKey, MGMT)).to.equal(true);
    const rec = await km.getKeyRecovery(r.identity);
    expect(rec.recoveryAgents).to.deep.equal([s[2].address, s[3].address]);
    expect(rec.completed).to.equal(true);
    expect(rec.lastKey).to.equal(r.recoveryKey);
    // Wallet 1 keeps control of its identity.
    expect(await id.keyHasPurpose(k(s[1].address), MGMT)).to.equal(true);
    expect(out).to.contain("KeyManager authorized: yes");

    // A second run starts over with fresh keys on the same identity.
    const again = await quiet(() => flow.runKeyLifecycle(state));
    expect(again.identity).to.equal(r.identity);
    expect(again.newKey).to.not.equal(r.newKey);
    expect(await id.keyHasPurpose(again.recoveryKey, MGMT)).to.equal(true);
  });

  it("option 12a withdraws and restores the authorization; KeyManager obeys it", async function () {
    const km = state.getContract("keyManager");
    const kmAddr = await km.getAddress();
    await quiet(() => flow.runKeyLifecycle(state));
    const idAddr = state.keyLifecycle.identity;
    const id = await ethers.getContractAt("OnchainID", idAddr);

    expect(await quiet(() => flow.toggleAuthorization(state))).to.equal(false);
    expect(await id.authorizedManagers(kmAddr)).to.equal(false);
    expect(logged.join("\n")).to.contain(
      "Identity has not authorized KeyManager",
    );
    const owner = state.signers[1];
    await expect(
      km.connect(owner).batchAddKeys(idAddr, [ethers.id("x")], [MGMT], [MGMT]),
    ).to.be.revertedWith("KeyManager: Identity has not authorized KeyManager");

    expect(await quiet(() => flow.toggleAuthorization(state))).to.equal(true);
    expect(await id.authorizedManagers(kmAddr)).to.equal(true);
  });

  it("option 12b sets the identity's rotation timelock; option 12 uses it", async function () {
    const km = state.getContract("keyManager");
    const set = await quiet(() =>
      flow.setTimelockInteractive(state, async () => "2"),
    );
    expect(set).to.equal(7200);
    const r = await quiet(() => flow.runKeyLifecycle(state));
    expect(await km.customTimelocks(r.identity)).to.equal(7200n);
    expect(logged.join("\n")).to.contain("timelock 2h");
    // A refused value changes nothing.
    await quiet(() => flow.setTimelockInteractive(state, async () => "200"));
    expect(await km.customTimelocks(r.identity)).to.equal(7200n);
  });

  it("option 5 -> 2 recovers and 5 -> 3 replaces a key through KeyManager", async function () {
    const s = state.signers;
    const owner = s[4];
    const id = await flow.demoIdentity(state, owner);
    const record = state.identities.get(await id.getAddress());
    expect(record.owner).to.equal(owner.address);

    // Recovery onto wallet 7's key, agents 2 and 3.
    await quiet(() => flow.recoverInteractive(state, record, async () => "7"));
    expect(await id.keyHasPurpose(k(s[7].address), MGMT)).to.equal(true);

    // Replace wallet 7's key (index 1 after the owner's) by a passphrase.
    const keys = await id.getKeysByPurpose(MGMT);
    const idx = keys.indexOf(k(s[7].address));
    const answers = [String(idx), "a new passphrase"];
    await quiet(() =>
      flow.replaceInteractive(state, record, async () => answers.shift()),
    );
    expect(await id.keyHasPurpose(k(s[7].address), MGMT)).to.equal(false);
    expect(
      await id.keyHasPurpose(ethers.id("a new passphrase"), MGMT),
    ).to.equal(true);
    expect(await id.keyHasPurpose(k(owner.address), MGMT)).to.equal(true);
  });

  it("prints a come-back time instead of jumping where the clock cannot move", async function () {
    const ChainTime = require("../../demo/utils/ChainTime");
    const real = ChainTime.canJumpTime;
    ChainTime.canJumpTime = async () => false;
    try {
      const r = await quiet(() => flow.runKeyLifecycle(state));
      expect(r.done).to.equal(false);
      expect(r.rotation.executed).to.equal(false);
      expect(logged.join("\n")).to.contain("option 12 resumes from this step");
    } finally {
      ChainTime.canJumpTime = real;
    }
    // Back on a dev node, option 12 resumes the same rotation.
    const resumed: any = await quiet(() => flow.runKeyLifecycle(state));
    expect(resumed.done).to.equal(true);
    const id = await ethers.getContractAt("OnchainID", resumed.identity);
    expect(await id.keyHasPurpose(resumed.newKey, MGMT)).to.equal(true);
  });
});
