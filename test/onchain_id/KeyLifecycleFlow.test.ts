import { expect } from "chai";
import { ethers } from "hardhat";

/**
 * Plan v2 Task 4.2: demo options 12, 12a, 12b and 5 -> 2/3 drive the
 * identity key lifecycle through the KeyManager option 1 deploys; Task
 * 4.11: their recovery evicts a planted rogue MANAGEMENT key and moves the
 * ownership to the recovered wallet. Every value below is read from the
 * chain.
 */
describe("Key lifecycle flow (demo options 12, 12a, 12b, 5)", function () {
  this.timeout(300_000);

  const MGMT = 1;
  const DAY = 24 * 3600;
  const k = (a: string) => ethers.solidityPackedKeccak256(["address"], [a]);
  let state: any;
  let flow: any;
  let opts: any;
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
  const jump = async (s: number) => {
    await ethers.provider.send("evm_increaseTime", [s]);
    await ethers.provider.send("evm_mine", []);
  };

  beforeEach(async function () {
    const ContractDeployer = require("../../demo/core/ContractDeployer");
    const DemoState = require("../../demo/core/DemoState");
    const { EnhancedLogger } = require("../../demo/logging");
    flow = require("../../demo/utils/KeyLifecycleFlow");
    opts = require("../../demo/utils/KeyLifecycleOptions");
    state = new DemoState();
    if (state.initialize) await state.initialize();
    state.signers = await ethers.getSigners();
    logged = [];
    const deployer = new ContractDeployer(state, new EnhancedLogger());
    await quiet(() => deployer.deployAllContracts());
  });

  it("option 1 deploys KeyManager; option 12 authorizes, rotates, cleans up and runs the recovery drill", async function () {
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
    expect(r.rotation.executed && r.recovery.done).to.equal(true);
    // The two fresh keys were MANAGEMENT and are both revoked now (N4).
    for (const key of [r.oldKey, r.newKey]) {
      const info = await id.getKey(key);
      expect(info.purpose).to.equal(1n);
      expect(info.revokedAt).to.be.greaterThan(0n);
    }
    expect(await id.getKeysByPurpose(MGMT)).to.deep.equal([k(s[1].address)]);
    // The drill: agents 7 and 8 (no issuer role) recovered wallet 6's key
    // on a drill identity wallet 1 owned; the rogue key and wallet 1's key
    // were evicted and wallet 6 owns it.
    const d = await ethers.getContractAt("OnchainID", r.recovery.identity);
    const rec = await km.getKeyRecovery(r.recovery.identity);
    expect(rec.recoveryAgents).to.deep.equal([s[7].address, s[8].address]);
    expect(rec.completed).to.equal(true);
    expect(rec.lastKey).to.equal(k(s[6].address));
    expect(await d.getKeysByPurpose(MGMT)).to.deep.equal([k(s[6].address)]);
    expect((await d.getKey(k(r.recovery.rogue))).revokedAt).to.be.gt(0n);
    expect(await d.owner()).to.equal(s[6].address);
    expect(r.recovery.refused && r.recovery.oldOwnerRefused).to.equal(true);
    expect(r.recovery.oldOwnerLocked).to.equal(true);
    expect(out).to.contain("⛔ rogue key cancels: refused");
    expect(out).to.not.contain("❌");
    expect(out).to.contain("wallet 7 (investor Bob)");
    expect(out).to.contain("wallet 1 (fee wallet, compliance officer)");
    expect(out).to.contain("KeyManager authorized: yes");
    expect(out).to.contain("🧹 batchRemoveKeys");

    // A second run starts over with fresh keys on the same identity.
    const again = await quiet(() => flow.runKeyLifecycle(state));
    expect(again.identity).to.equal(r.identity);
    expect(again.newKey).to.not.equal(r.newKey);
    expect(again.recovery.identity).to.not.equal(r.recovery.identity);
    expect(again.done).to.equal(true);
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

  it("before re-authorizing, pending items are listed; a prompted option asks", async function () {
    const km = state.getContract("keyManager");
    const kmAddr = await km.getAddress();
    const s = state.signers;
    const id = await flow.demoIdentity(state, s[1]);
    const idAddr = await id.getAddress();
    await id.authorizeManager(kmAddr);
    await km.connect(s[1]).setupKeyRecovery(idAddr, [s[7].address], 1);
    const key = k(s[6].address);
    await km.connect(s[7]).initiateKeyRecovery(idAddr, key);
    await id.deauthorizeManager(kmAddr);

    // 12b with "no": stays withdrawn, nothing set.
    const answers = ["3", "no"];
    const set = await quiet(() =>
      opts.setTimelockInteractive(state, async () => answers.shift()),
    );
    expect(set).to.equal(null);
    expect(await id.authorizedManagers(kmAddr)).to.equal(false);
    const out = logged.join("\n");
    expect(out).to.contain("Re-authorizing re-arms these paused items");
    expect(out).to.contain("recovery candidate");
    expect(await km.customTimelocks(idAddr)).to.equal(0n);
    // Option 12 (no prompts) prints the same list and continues.
    logged = [];
    const r = await quiet(() => flow.runKeyLifecycle(state));
    expect(logged.join("\n")).to.contain("recovery candidate");
    expect(r.done).to.equal(true);
  });

  it("option 12b sets the identity's rotation timelock; option 12 uses it", async function () {
    const km = state.getContract("keyManager");
    const set = await quiet(() =>
      opts.setTimelockInteractive(state, async () => "2"),
    );
    expect(set).to.equal(7200);
    const r = await quiet(() => flow.runKeyLifecycle(state));
    expect(await km.customTimelocks(r.identity)).to.equal(7200n);
    expect(logged.join("\n")).to.contain("timelock 2h");
    // A refused value changes nothing.
    await quiet(() => opts.setTimelockInteractive(state, async () => "200"));
    expect(await km.customTimelocks(r.identity)).to.equal(7200n);
  });

  it("option 5 -> 2 recovers and 5 -> 3 replaces a key through KeyManager", async function () {
    const s = state.signers;
    const owner = s[4];
    const id = await flow.demoIdentity(state, owner);
    const record = state.identities.get(await id.getAddress());
    expect(record.owner).to.equal(owner.address);

    // Recovery onto wallet 6, agents 7 and 8: wallet 4's key and a
    // planted rogue key are evicted and wallet 6 becomes the owner.
    await quiet(() => opts.recoverInteractive(state, record, async () => "6"));
    expect(await id.owner()).to.equal(s[6].address);
    expect(await id.getKeysByPurpose(MGMT)).to.deep.equal([k(s[6].address)]);
    expect(record.owner).to.equal(s[6].address);
    expect(logged.join("\n")).to.contain("⛔ owner cancels: refused");
    expect(logged.join("\n")).to.not.contain("❌");

    // 5 -> 3 by the new owner: its own key replaced by a passphrase (a
    // label, said so); the warning names what stops working.
    const answers = ["0", "a new passphrase"];
    await quiet(() =>
      opts.replaceInteractive(state, record, async () => answers.shift()),
    );
    expect(await id.keyHasPurpose(k(s[6].address), MGMT)).to.equal(false);
    expect(
      await id.keyHasPurpose(ethers.id("a new passphrase"), MGMT),
    ).to.equal(true);
    const out = logged.join("\n");
    expect(out).to.contain("nobody can sign with it");
    expect(out).to.contain("options 12, 12b and 5 -> 3 will refuse this");
  });

  it("where the clock cannot move it prints a come-back time; resume reuses the same keys", async function () {
    const ChainTime = require("../../demo/utils/ChainTime");
    const real = ChainTime.canJumpTime;
    ChainTime.canJumpTime = async () => false;
    let first: any;
    let second: any;
    try {
      first = await quiet(() => flow.runKeyLifecycle(state));
      expect(first.done).to.equal(false);
      expect(first.rotation.executed).to.equal(false);
      expect(logged.join("\n")).to.contain(
        "option 12 resumes from this step (same session)",
      );
      // Wait out the rotation by hand: the rotation runs, recovery waits.
      await jump(DAY + 1);
      second = await quiet(() => flow.runKeyLifecycle(state));
      expect(second.rotation.executed).to.equal(true);
      expect(second.recovery.executed).to.equal(false);
    } finally {
      ChainTime.canJumpTime = real;
    }
    for (const key of ["oldKey", "newKey"]) {
      expect(second[key]).to.equal(first[key]);
    }
    // Back on a dev node, option 12 finishes the same recovery.
    const third: any = await quiet(() => flow.runKeyLifecycle(state));
    expect(third.done).to.equal(true);
    expect(third.recovery.identity).to.equal(second.recovery.identity);
    const km = state.getContract("keyManager");
    const drill = third.recovery.identity;
    expect((await km.getKeyRecovery(drill)).lastKey).to.equal(
      k(state.signers[6].address),
    );
  });
});
